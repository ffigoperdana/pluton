import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Writable } from 'stream';
import Database from 'better-sqlite3';
import { AppError, NotFoundError } from '../utils/AppError';
import { appPaths } from '../utils/AppPaths';
import { planLogger } from '../utils/logger';
import { managedSnapshotPath } from '../utils/managedSnapshotPath';
import type { Backup } from '../db/schema/backups';
import type { Plan } from '../db/schema/plans';
import type { ManagedSnapshotIndex } from '../utils/restic/ManagedSnapshotIndex';
import type { SelectedDownloadHeaders } from '../utils/restic/SelectedSnapshotDownload';
import { PgCopyParseError, PgCopyTableReader } from '../utils/attachmentCatalog/pgCopyParser';
import {
	ODOO_ATTACHMENT_TARGET,
	attachmentDownloadNames,
	odooAttachmentFromRow,
} from '../utils/attachmentCatalog/odooAttachments';
import { catalogDatabase, planSourceRoot } from '../utils/attachmentCatalog/config';
import { BRAND_NAME } from '../utils/brand';

export const ATTACHMENT_CATALOG_LIMITS = Object.freeze({
	maxAttachments: 2_000_000,
	/** One catalog row is about 250 bytes with its indexes. */
	maxBytes: 512 * 1024 ** 2,
	/** Free space a catalog needs to start; it grows up to maxBytes while space remains. */
	startBytes: 128 * 1024 ** 2,
	diskReserve: 64 * 1024 ** 2,
	maxCatalogs: 3,
	/** Catalogs are expensive to rebuild (they read a database dump); keep them for a working day. */
	idleMs: 12 * 3_600_000,
	maxPageSize: 200,
	pageSize: 50,
	pairingCandidates: 8,
});

export type AttachmentCatalogQuery = {
	search?: string;
	model?: string;
	status?: 'all' | 'present' | 'missing';
	sort?: 'name' | 'created' | 'size';
	order?: 'asc' | 'desc';
	offset?: number;
	limit?: number;
	retry?: boolean;
};

export type AttachmentCatalogPairing = {
	adapter: 'odoo';
	databasePlanId: string;
	databasePlanName: string | null;
	databaseBackupId: string;
	databaseBackupCompleted: string | null;
	database: string;
	filestoreRoot: string;
};

type Counts = {
	attachments: number;
	present: number;
	missing: number;
	notInFilestore: number;
	invalid: number;
};

type Phase = 'waiting' | 'database-dump' | 'filestore-index' | 'matching';

type Entry = {
	key: string;
	status: 'building' | 'ready' | 'failed';
	phase: Phase;
	dumpBytes: number;
	dumpTotal: number;
	attachments: number;
	matched: number;
	started: number;
	used: number;
	directory?: string;
	db?: Database.Database;
	counts?: Counts;
	models?: { model: string; count: number }[];
	error?: AppError;
	controller: AbortController;
};

type Pairing = AttachmentCatalogPairing & {
	key: string;
	filestoreBackupId: string;
	dumpPath: string;
	dumpBytes: number;
};

type Row = {
	id: number;
	name: string;
	stored: string;
	mimetype: string | null;
	size: number | null;
	model: string | null;
	record: number | null;
	field: string | null;
	created: string | null;
	present: number;
	snapshotSize: number | null;
};

export type AttachmentCatalogRecovery = {
	downloadItem(
		backupId: string,
		itemPath: string,
		output: Writable,
		signal: AbortSignal,
		headers: (value: SelectedDownloadHeaders) => void,
		headOnly?: boolean
	): Promise<void>;
	withSnapshotIndex<T>(
		backupId: string,
		consume: (index: ManagedSnapshotIndex) => Promise<T> | T,
		signal?: AbortSignal
	): Promise<T>;
};

type Artifact = { databaseId?: string; path?: string; bytes?: number; sha256?: string; engine?: string };

const parseFailure: Record<PgCopyParseError['reason'], string> = {
	'table-missing':
		'The paired database dump has no ir_attachment table. Check that the paired database is the Odoo database of this filestore.',
	'columns-missing': 'The ir_attachment table in the database dump lacks id, name or store_fname.',
	'row-malformed': 'The database dump is malformed and its attachment list cannot be read.',
	truncated: 'The database dump ends inside the attachment list.',
};

/**
 * Names the files of a filestore snapshot from the database dump of a paired plan
 * (Odoo: ir_attachment). The catalog is read-only: it reads the dump through the
 * verified snapshot item stream and checks presence against the verified
 * filestore index. Nothing in either repository is written.
 */
export class AttachmentCatalogService {
	private readonly entries = new Map<string, Entry>();
	private building?: string;
	private initialized?: Promise<void>;

	constructor(
		private readonly plans: { getById(id: string): Promise<Plan | null> },
		private readonly backups: {
			getById(id: string): Promise<Backup | null>;
			completedNear(planId: string, at: Date, limit?: number): Promise<Backup[]>;
		},
		private readonly recovery: AttachmentCatalogRecovery,
		private readonly root = path.join(appPaths.getDataDir(), 'attachment-catalogs'),
		private readonly limits = ATTACHMENT_CATALOG_LIMITS
	) {}

	/** Whether the plan of a backup has an attachment catalog configured. */
	async configured(backup: Pick<Backup, 'planId'>): Promise<boolean> {
		if (!backup.planId) return false;
		const plan = await this.plans.getById(backup.planId);
		return !!plan?.settings?.attachmentCatalog;
	}

	async page(backupId: string, query: AttachmentCatalogQuery) {
		const pairing = await this.pairing(backupId);
		const summary = this.summary(pairing);
		await this.expire();
		let entry = this.entries.get(pairing.key);
		if (entry?.status === 'failed' && query.retry) {
			await this.discard(entry);
			entry = undefined;
		}
		if (!entry) entry = await this.start(pairing);
		if (entry.status === 'failed') throw entry.error!;
		if (entry.status === 'building' || !entry.db) {
			return {
				status: 'indexing' as const,
				retryAfterMs: 2000,
				pairing: summary,
				progress: {
					phase: entry.phase,
					dumpBytes: entry.dumpBytes,
					dumpTotal: entry.dumpTotal,
					attachments: entry.attachments,
					matched: entry.matched,
					elapsedMs: Date.now() - entry.started,
				},
			};
		}
		entry.used = Date.now();
		return { status: 'ready' as const, pairing: summary, ...this.select(entry, query) };
	}

	/** The snapshot path and download names of one present attachment of a ready catalog. */
	async attachmentDownload(backupId: string, attachmentId: number) {
		if (!Number.isSafeInteger(attachmentId) || attachmentId < 0)
			throw new AppError(400, 'Select one attachment.');
		const pairing = await this.pairing(backupId);
		const entry = this.entries.get(pairing.key);
		if (entry?.status !== 'ready' || !entry.db)
			throw new AppError(409, 'Open the attachment list again; its catalog is not ready.');
		entry.used = Date.now();
		const row = entry.db.prepare('SELECT * FROM attachments WHERE id=?').get(attachmentId) as
			| Row
			| undefined;
		if (!row) throw new NotFoundError('Attachment not found in this catalog.');
		if (!row.present) throw new AppError(404, 'This attachment is not in the filestore snapshot.');
		const itemPath = managedSnapshotPath(`${pairing.filestoreRoot}/${row.stored}`);
		return { itemPath, names: attachmentDownloadNames(row.name) };
	}

	async close() {
		for (const entry of [...this.entries.values()]) {
			entry.controller.abort();
			if (entry.status !== 'building') await this.discard(entry);
		}
	}

	private summary(pairing: Pairing): AttachmentCatalogPairing {
		return {
			adapter: pairing.adapter,
			databasePlanId: pairing.databasePlanId,
			databasePlanName: pairing.databasePlanName,
			databaseBackupId: pairing.databaseBackupId,
			databaseBackupCompleted: pairing.databaseBackupCompleted,
			database: pairing.database,
			filestoreRoot: pairing.filestoreRoot,
		};
	}

	private async pairing(backupId: string): Promise<Pairing> {
		const backup = await this.backups.getById(backupId);
		if (!backup?.planId) throw new NotFoundError('Backup not found.');
		const snapshotId = backup.completionStats?.snapshot_id;
		if (backup.status !== 'completed' || !/^[a-f0-9]{64}$/.test(snapshotId || ''))
			throw new AppError(409, 'Attachment names are available for completed snapshots only.');
		const plan = await this.plans.getById(backup.planId);
		const settings = plan?.settings?.attachmentCatalog;
		if (!plan || !settings) throw new NotFoundError('This plan has no attachment catalog.');
		const databasePlan = await this.plans.getById(settings.databasePlanId);
		const database = databasePlan && catalogDatabase(databasePlan, settings.databaseId);
		if (!databasePlan || !database)
			throw new AppError(409, 'The paired database plan no longer has this database.');
		const filestoreRoot = settings.filestoreRoot || planSourceRoot(plan);
		if (!filestoreRoot) throw new AppError(409, 'The filestore folder of the catalog is not set.');
		const at = backup.ended || backup.started || backup.createdAt;
		const dumpPath = `/pluton/database/${database.dumpFilename}`;
		const candidates = await this.backups.completedNear(
			databasePlan.id,
			at,
			this.limits.pairingCandidates
		);
		const paired = candidates
			.map(candidate => {
				const lifecycle = candidate.completionStats?.lifecycle as
					| { databases?: Artifact[]; database?: Artifact }
					| undefined;
				const artifacts = lifecycle?.databases || (lifecycle?.database ? [lifecycle.database] : []);
				const artifact = artifacts.find(
					item =>
						item?.path === dumpPath &&
						(item.databaseId === undefined || item.databaseId === settings.databaseId) &&
						Number.isSafeInteger(item.bytes) &&
						(item.bytes as number) > 0
				);
				const when = candidate.ended || candidate.started || candidate.createdAt;
				return artifact &&
					/^[a-f0-9]{64}$/.test(candidate.completionStats?.snapshot_id || '')
					? { candidate, artifact, distance: Math.abs(when.getTime() - at.getTime()) }
					: undefined;
			})
			.filter(value => !!value)
			.sort((a, b) => a!.distance - b!.distance)[0];
		if (!paired)
			throw new AppError(
				409,
				'No completed backup of the paired database plan holds this database dump yet.'
			);
		const key = crypto
			.createHash('sha256')
			.update(
				JSON.stringify([
					backup.id,
					snapshotId,
					paired.candidate.id,
					paired.candidate.completionStats?.snapshot_id,
					paired.artifact.sha256 || null,
					dumpPath,
					filestoreRoot,
				])
			)
			.digest('hex');
		return {
			key,
			adapter: 'odoo',
			filestoreBackupId: backup.id,
			databasePlanId: databasePlan.id,
			databasePlanName: databasePlan.title || null,
			databaseBackupId: paired.candidate.id,
			databaseBackupCompleted: (paired.candidate.ended || paired.candidate.started)?.toISOString() || null,
			database: database.database,
			filestoreRoot,
			dumpPath,
			dumpBytes: paired.artifact.bytes as number,
		};
	}

	private async initialize() {
		this.initialized ||= (async () => {
			await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
			// Catalogs do not survive a restart; remove only directories this service generates.
			for (const name of await fs.readdir(this.root))
				if (/^catalog-[a-f0-9]{24}$/.test(name))
					await fs.rm(path.join(this.root, name), { recursive: true, force: true });
		})().catch(error => {
			this.initialized = undefined;
			throw error;
		});
		return this.initialized;
	}

	private async start(pairing: Pairing): Promise<Entry> {
		const entry: Entry = {
			key: pairing.key,
			status: 'building',
			phase: 'waiting',
			dumpBytes: 0,
			dumpTotal: pairing.dumpBytes,
			attachments: 0,
			matched: 0,
			started: Date.now(),
			used: Date.now(),
			controller: new AbortController(),
		};
		if (this.building) {
			// One build at a time; this request waits and is started by a later poll.
			return entry;
		}
		this.entries.set(entry.key, entry);
		this.building = entry.key;
		void this.build(entry, pairing)
			.catch(error => {
				entry.status = 'failed';
				entry.error = this.safeError(error);
				entry.db?.close();
				entry.db = undefined;
				if (entry.directory) void fs.rm(entry.directory, { recursive: true, force: true });
				planLogger('attachment-catalog').warn(
					{ reason: entry.error.message, status: entry.error.statusCode },
					'Attachment catalog build failed.'
				);
			})
			.finally(() => {
				if (this.building === entry.key) this.building = undefined;
			});
		return entry;
	}

	private safeError(error: unknown): AppError {
		if (error instanceof PgCopyParseError) return new AppError(422, parseFailure[error.reason]);
		if (error instanceof AppError) return error;
		if ((error as { code?: string })?.code === 'SQLITE_FULL')
			return new AppError(
				507,
				`The attachment catalog ran out of disk space or reached its size limit on the ${BRAND_NAME} server.`
			);
		return new AppError(503, 'The attachment catalog is unavailable. Retry.');
	}

	private async build(entry: Entry, pairing: Pairing) {
		await this.initialize();
		await this.makeRoom(entry.key);
		const disk = await fs.statfs(this.root);
		const required = Math.min(this.limits.maxBytes, this.limits.startBytes) + this.limits.diskReserve;
		if (disk.bavail * disk.bsize < required)
			throw new AppError(507, `The attachment catalog needs more free disk space on the ${BRAND_NAME} server.`);
		entry.directory = path.join(this.root, `catalog-${crypto.randomBytes(12).toString('hex')}`);
		await fs.mkdir(entry.directory, { mode: 0o700 });
		const db = new Database(path.join(entry.directory, 'catalog.sqlite'));
		entry.db = db;
		db.pragma('page_size=4096');
		db.pragma(`max_page_count=${Math.floor(this.limits.maxBytes / 4096)}`);
		db.pragma('journal_mode=OFF');
		db.pragma('synchronous=OFF');
		db.pragma('temp_store=FILE');
		db.exec(`CREATE TABLE attachments(id INTEGER PRIMARY KEY, name TEXT NOT NULL, stored TEXT NOT NULL,
			mimetype TEXT, size INTEGER, model TEXT, record INTEGER, field TEXT, created TEXT,
			present INTEGER NOT NULL DEFAULT 0, snapshotSize INTEGER); BEGIN;`);
		const insert = db.prepare(
			'INSERT OR IGNORE INTO attachments(id,name,stored,mimetype,size,model,record,field,created) VALUES (?,?,?,?,?,?,?,?,?)'
		);
		const counts: Counts = { attachments: 0, present: 0, missing: 0, notInFilestore: 0, invalid: 0 };
		const reader = new PgCopyTableReader(ODOO_ATTACHMENT_TARGET, row => {
			const outcome = odooAttachmentFromRow(row);
			if (outcome.kind === 'not-in-filestore') counts.notInFilestore++;
			else if (outcome.kind === 'invalid') counts.invalid++;
			else {
				if (++counts.attachments > this.limits.maxAttachments)
					throw new AppError(413, 'The database lists too many attachments for a catalog.');
				const value = outcome.value;
				insert.run(
					value.id,
					value.name,
					value.storedPath,
					value.mimetype,
					value.size,
					value.model,
					value.recordId,
					value.field,
					value.created
				);
				entry.attachments = counts.attachments;
			}
		});

		// Read the dump only until the attachment table ends, then stop the stream.
		entry.phase = 'database-dump';
		const dump = new AbortController();
		const stop = () => dump.abort();
		entry.controller.signal.addEventListener('abort', stop, { once: true });
		let failure: unknown;
		const sink = new Writable({
			write(chunk: Buffer, _encoding, done) {
				if (reader.done) return done();
				entry.dumpBytes += chunk.length;
				try {
					reader.write(chunk);
				} catch (error) {
					failure = error;
					dump.abort();
					return done();
				}
				if (reader.done) dump.abort();
				done();
			},
		});
		try {
			await this.recovery.downloadItem(
				pairing.databaseBackupId,
				pairing.dumpPath,
				sink,
				dump.signal,
				() => undefined
			);
		} catch (error) {
			// Stopping the stream after the table is the expected end of a successful read.
			if (!reader.done && !failure) throw error;
		} finally {
			entry.controller.signal.removeEventListener('abort', stop);
		}
		if (failure) throw failure;
		if (entry.controller.signal.aborted) throw new AppError(409, 'The attachment catalog was cancelled.');
		reader.end();
		db.exec(`COMMIT;
			CREATE INDEX byName ON attachments(name COLLATE NOCASE, id);
			CREATE INDEX byModel ON attachments(model, name COLLATE NOCASE, id);
			CREATE INDEX byPresent ON attachments(present, name COLLATE NOCASE, id);`);

		entry.phase = 'filestore-index';
		await this.recovery.withSnapshotIndex(
			pairing.filestoreBackupId,
			async index => {
				entry.phase = 'matching';
				const update = db.prepare('UPDATE attachments SET present=?, snapshotSize=? WHERE id=?');
				const rows = db.prepare('SELECT id, stored FROM attachments ORDER BY id').all() as {
					id: number;
					stored: string;
				}[];
				db.exec('BEGIN');
				for (let i = 0; i < rows.length; i++) {
					if (entry.controller.signal.aborted) throw new AppError(409, 'The attachment catalog was cancelled.');
					const item = index.get(`${pairing.filestoreRoot}/${rows[i].stored}`);
					const present = item?.type === 'file';
					update.run(present ? 1 : 0, present ? item!.size : null, rows[i].id);
					if (present) counts.present++;
					entry.matched = i + 1;
					if (i % 2048 === 2047) await new Promise<void>(resolve => setImmediate(resolve));
				}
				db.exec('COMMIT');
			},
			entry.controller.signal
		);
		counts.attachments = Math.min(counts.attachments, this.limits.maxAttachments);
		counts.missing = counts.attachments - counts.present;
		entry.counts = counts;
		entry.models = db
			.prepare(
				'SELECT model, count(*) AS count FROM attachments WHERE model IS NOT NULL GROUP BY model ORDER BY count DESC, model LIMIT 50'
			)
			.all() as { model: string; count: number }[];
		entry.status = 'ready';
		entry.used = Date.now();
		planLogger('attachment-catalog').info(
			{ ...counts, elapsedMs: Date.now() - entry.started },
			'Attachment catalog ready.'
		);
	}

	private select(entry: Entry, query: AttachmentCatalogQuery) {
		const limit = query.limit ?? this.limits.pageSize;
		const offset = query.offset ?? 0;
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (query.search) {
			where.push(`name LIKE ? ESCAPE '\\'`);
			params.push(`%${query.search.replace(/[\\%_]/g, character => `\\${character}`)}%`);
		}
		if (query.model) {
			where.push('model = ?');
			params.push(query.model);
		}
		if (query.status === 'present') where.push('present = 1');
		if (query.status === 'missing') where.push('present = 0');
		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const order = query.order === 'desc' ? 'DESC' : 'ASC';
		const sort =
			query.sort === 'size'
				? `coalesce(size, -1) ${order}, id`
				: query.sort === 'created'
					? `coalesce(created, '') ${order}, id`
					: `name COLLATE NOCASE ${order}, id`;
		const db = entry.db!;
		const total = (db.prepare(`SELECT count(*) AS n FROM attachments ${clause}`).get(...params) as { n: number }).n;
		const rows = db
			.prepare(`SELECT * FROM attachments ${clause} ORDER BY ${sort} LIMIT ? OFFSET ?`)
			.all(...params, limit, offset) as Row[];
		return {
			counts: entry.counts!,
			models: entry.models!,
			total,
			offset,
			limit,
			nextOffset: offset + rows.length < total ? offset + rows.length : null,
			items: rows.map(row => ({
				id: row.id,
				name: row.name,
				mimetype: row.mimetype,
				size: row.size,
				model: row.model,
				recordId: row.record,
				field: row.field,
				created: row.created,
				storedPath: row.stored,
				present: !!row.present,
				snapshotSize: row.snapshotSize,
			})),
		};
	}

	private async makeRoom(keep: string) {
		const others = [...this.entries.values()]
			.filter(entry => entry.key !== keep && entry.status !== 'building')
			.sort((a, b) => a.used - b.used);
		while (others.length && this.entries.size > this.limits.maxCatalogs) await this.discard(others.shift()!);
	}

	private async expire() {
		const now = Date.now();
		for (const entry of [...this.entries.values()])
			if (entry.status !== 'building' && now - entry.used > this.limits.idleMs) await this.discard(entry);
	}

	private async discard(entry: Entry) {
		this.entries.delete(entry.key);
		entry.db?.close();
		entry.db = undefined;
		if (entry.directory) await fs.rm(entry.directory, { recursive: true, force: true });
	}
}
