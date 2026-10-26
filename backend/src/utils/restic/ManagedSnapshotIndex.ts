import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import { AppError } from '../AppError';
import { managedSnapshotPath, assertManagedRestorePath } from '../managedSnapshotPath';
import type { SnapShotFile } from '../../types/restic';
import type { ManagedSnapshotNode } from './ManagedSftpRepositorySession';

export class SnapshotIndexError extends AppError {
	constructor(
		readonly code:
			| 'index-resource-limit'
			| 'index-unavailable'
			| 'metadata-invalid'
			| 'unsupported-snapshot-file'
			| 'snapshot-indexing'
			| 'pagination-required'
			| 'cancelled',
		readonly reason: SnapshotIndexReason = code === 'metadata-invalid'
			? 'metadata-invalid'
			: code === 'cancelled'
				? 'cancelled'
				: 'unavailable'
	) {
		const messages = {
			'index-resource-limit':
				'Snapshot index resource limit reached. Retry after other operations finish or free cache space.',
			'index-unavailable': 'Snapshot metadata is unavailable. Retry indexing.',
			'metadata-invalid': 'Snapshot metadata contains invalid or ambiguous records.',
			'unsupported-snapshot-file':
				'This snapshot contains an unsafe path or unsupported file type. Only regular files and directories can be downloaded or recovered.',
			'snapshot-indexing': 'Snapshot indexing is in progress. Retry shortly.',
			'pagination-required': 'Use paginated browsing for this snapshot.',
			'cancelled': 'Snapshot operation was cancelled.',
		};
		super(
			reason === 'database-size' || reason === 'entry-count'
				? 413
				: reason === 'disk-capacity' || reason === 'storage-full'
					? 507
					: reason === 'timeout'
						? 504
						: code === 'index-resource-limit'
							? 429
							: code === 'metadata-invalid'
								? 422
								: code === 'snapshot-indexing'
									? 202
									: code === 'index-unavailable'
										? 503
										: 409,
			reasonMessages[reason] || messages[code]
		);
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export type SnapshotIndexReason =
	| 'cache-active'
	| 'build-busy'
	| 'admission-busy'
	| 'disk-capacity'
	| 'storage-full'
	| 'database-size'
	| 'entry-count'
	| 'cleanup-failed'
	| 'unavailable'
	| 'metadata-invalid'
	| 'timeout'
	| 'cancelled'
	| 'unsafe-path'
	| 'invalid-node-name'
	| 'duplicate-entry'
	| 'invalid-timestamp'
	| 'ancestor-conflict'
	| 'invalid-size'
	| 'metadata-schema-invalid'
	| 'repository-output-invalid'
	| 'unsupported-node-type'
	| 'symlink-target-unverified'
	| 'host-path-unsupported';
const reasonMessages: Partial<Record<SnapshotIndexReason, string>> = {
	'unsafe-path': 'Snapshot metadata contains an unsafe or ambiguous path. Export was refused.',
	'invalid-node-name': 'Snapshot node name does not match its exact path.',
	'duplicate-entry': 'Snapshot metadata contains a duplicate path. Export was refused.',
	'invalid-timestamp': 'Snapshot metadata contains an invalid timestamp.',
	'ancestor-conflict': 'Snapshot metadata places entries below a non-directory node.',
	'invalid-size': 'Snapshot metadata contains an invalid file size.',
	'metadata-schema-invalid': 'Snapshot metadata does not match the supported Restic schema.',
	'repository-output-invalid': 'Repository metadata output is malformed or incomplete.',
	'unsupported-node-type':
		'This snapshot contains an unsupported file type (device, FIFO or socket). Complete export and recovery were refused; no entries were omitted.',
	'symlink-target-unverified':
		'This snapshot contains symbolic links. The Restic listing does not expose their targets, so safe complete export or recovery cannot be verified. No entries were omitted.',
	'host-path-unsupported': 'Snapshot filenames require a POSIX restore destination.',
	'cache-active':
		'Snapshot cache is busy with active readers. Retry after those operations finish.',
	'build-busy': 'Another snapshot is being indexed. Retry shortly.',
	'admission-busy': 'Snapshot cache is busy handling requests. Retry shortly.',
	'disk-capacity':
		'Snapshot indexing needs 320 MiB of available cache filesystem space. Free cache filesystem space and retry.',
	'database-size':
		'Snapshot metadata index exceeds the bounded database size limit (256 MiB by default).',
	'entry-count': 'Snapshot metadata exceeds the maximum entry count (500,000 by default).',
	'cleanup-failed': 'Snapshot index cleanup failed. Check cache filesystem access and retry.',
	'storage-full':
		'SQLite index storage is full or quota-limited. Check available cache capacity and filesystem quota before retrying.',
	'timeout': 'Snapshot indexing timed out. Retry indexing.',
};

export const SNAPSHOT_INDEX_LIMITS = Object.freeze({
	maxEntries: 500_000,
	maxBytes: 256 * 1024 ** 2,
	maxIndexes: 2,
	ttlMs: 15 * 60_000,
	maxBuilds: 1,
	pageSize: 200,
	maxPageSize: 500,
	compatibilityEntries: 5000,
});
export type SnapshotPageQuery = {
	path?: string;
	search?: string;
	offset?: number;
	limit?: number;
	sort?: 'name' | 'size' | 'modifiedAt';
	order?: 'asc' | 'desc';
	directoriesOnly?: boolean;
	retry?: boolean;
};
type Row = {
	path: string;
	name: string;
	type: string;
	size: number;
	modifiedAt: string;
	permissions: string;
};
const asFile = (row: Row): SnapShotFile => ({
	path: row.path,
	name: row.name,
	type: row.type,
	size: row.size,
	modifiedAt: row.modifiedAt,
	permissions: row.permissions,
	srcPath: row.path,
	isDirectory: row.type === 'dir',
	owner: '',
	isAvailable: true,
});

/** A completed, immutable manifest. Iteration/lookup do not load the full tree. */
export class ManagedSnapshotIndex implements Iterable<SnapShotFile> {
	constructor(private readonly db: Database.Database) {}
	get count(): number {
		return (this.db.prepare('SELECT count(*) AS n FROM nodes').get() as { n: number }).n;
	}
	get stats() {
		const row = this.db
			.prepare("SELECT count(*) AS n, coalesce(sum(size),0) AS bytes FROM nodes WHERE type='file'")
			.get() as { n: number; bytes: number };
		if (!Number.isSafeInteger(row.bytes)) throw new SnapshotIndexError('metadata-invalid');
		return {
			total_files: row.n,
			files_restored: row.n,
			total_bytes: row.bytes,
			bytes_restored: row.bytes,
		};
	}
	get(filePath: string): SnapShotFile | undefined {
		const row = this.db.prepare('SELECT * FROM nodes WHERE path=?').get(filePath) as
			| Row
			| undefined;
		return row && asFile(row);
	}
	hasDescendant(filePath: string): boolean {
		return !!this.db
			.prepare('SELECT 1 FROM nodes WHERE path >= ? AND path < ? LIMIT 1')
			.get(`${filePath}/`, `${filePath}0`);
	}
	*[Symbol.iterator](): IterableIterator<SnapShotFile> {
		for (const row of this.db.prepare('SELECT * FROM nodes ORDER BY path').iterate())
			yield asFile(row as Row);
	}
	*databaseFiles(): IterableIterator<SnapShotFile> {
		const query = this.db.prepare(
			"SELECT * FROM nodes WHERE type='file' AND path >= '/pluton/database/' AND path < '/pluton/database0' LIMIT 9"
		);
		let count = 0;
		for (const row of query.iterate()) {
			if (++count > 8) throw new SnapshotIndexError('metadata-invalid');
			yield asFile(row as Row);
		}
	}
	assertSafe(operation: 'archive' | 'restore' = 'archive') {
		if (
			this.db
				.prepare("SELECT 1 FROM nodes WHERE type NOT IN ('file','dir','symlink') LIMIT 1")
				.get()
		)
			throw new SnapshotIndexError('unsupported-snapshot-file', 'unsupported-node-type');
		if (this.db.prepare("SELECT 1 FROM nodes WHERE type='symlink' LIMIT 1").get())
			throw new SnapshotIndexError('unsupported-snapshot-file', 'symlink-target-unverified');
		if (operation === 'restore' && process.platform === 'win32') {
			for (const file of this) {
				try {
					assertManagedRestorePath(file.path);
				} catch {
					throw new SnapshotIndexError('unsupported-snapshot-file', 'host-path-unsupported');
				}
			}
		}
	}
	page(query: SnapshotPageQuery) {
		if (
			(query.limit !== undefined &&
				(!Number.isInteger(query.limit) ||
					query.limit < 1 ||
					query.limit > SNAPSHOT_INDEX_LIMITS.maxPageSize)) ||
			(query.offset !== undefined &&
				(!Number.isInteger(query.offset) ||
					query.offset < 0 ||
					query.offset > SNAPSHOT_INDEX_LIMITS.maxEntries)) ||
			(query.search !== undefined &&
				(typeof query.search !== 'string' || query.search.length > 128)) ||
			(query.sort !== undefined && !['name', 'size', 'modifiedAt'].includes(query.sort)) ||
			(query.order !== undefined && !['asc', 'desc'].includes(query.order)) ||
			(query.directoriesOnly !== undefined && typeof query.directoriesOnly !== 'boolean') ||
			(query.retry !== undefined && typeof query.retry !== 'boolean')
		)
			throw new AppError(400, 'Invalid snapshot page parameters.');
		const directory = query.path || '';
		if (directory) {
			if (!directory.startsWith('/')) throw new AppError(400, 'Invalid snapshot directory.');
			managedSnapshotPath(directory);
		}
		if (directory && this.get(directory)?.type !== 'dir')
			throw new AppError(404, 'Snapshot directory not found.');
		const where =
			'parent=? AND instr(lower(name),lower(?))>0' +
			(query.directoriesOnly ? " AND type='dir'" : '');
		const params = [directory, query.search || ''];
		const total = (
			this.db.prepare(`SELECT count(*) AS n FROM nodes WHERE ${where}`).get(...params) as {
				n: number;
			}
		).n;
		const sort =
			query.sort === 'size'
				? 'size'
				: query.sort === 'modifiedAt'
					? 'modifiedTime'
					: 'name COLLATE NOCASE';
		const order = query.order === 'desc' ? 'DESC' : 'ASC';
		const scan =
			(query.sort === 'size'
				? 'childSize'
				: query.sort === 'modifiedAt'
					? 'childTime'
					: 'children') + (order === 'DESC' ? 'Desc' : '');
		const offset = query.offset || 0,
			limit = query.limit || SNAPSHOT_INDEX_LIMITS.pageSize;
		const files = (
			this.db
				.prepare(
					`SELECT * FROM nodes INDEXED BY ${scan} WHERE ${where} ORDER BY isDirectory DESC, ${sort} ${order}, path ASC LIMIT ? OFFSET ?`
				)
				.all(...params, limit, offset) as Row[]
		).map(asFile);
		return {
			status: 'ready' as const,
			files,
			total,
			offset,
			limit,
			nextOffset: offset + files.length < total ? offset + files.length : null,
			entries: this.count,
		};
	}
	close() {
		this.db.close();
	}
}

type Populate = (append: (node: ManagedSnapshotNode) => void, signal: AbortSignal) => Promise<void>;
type Entry = {
	promise: Promise<ManagedSnapshotIndex>;
	controller: AbortController;
	background: boolean;
	index?: ManagedSnapshotIndex;
	error?: AppError;
	updated: number;
	used: number;
	readers: number;
	settled: boolean;
	directory?: string;
	count: number;
	bytes: number;
	started: number;
	idle?: () => void;
};
export type SnapshotIndexDiagnostic = {
	event: 'snapshot_index';
	stage: 'building' | 'ready' | 'failed' | 'evicted' | 'refused';
	reason?: SnapshotIndexReason;
	indexes: number;
	builds: number;
	readers: number;
	entries: number;
	databaseBytes: number;
	availableBytes: number;
	durationMs: number;
};

/** Single server process owns the cache. No persisted index is trusted on restart. */
export class ManagedSnapshotIndexCache {
	private readonly entries = new Map<string, Entry>();
	private sequence = 0;
	private initialized?: Promise<void>;
	private builds = 0;
	private availableBytes = 0;
	private closed = false;
	private admissions = 0;
	private admission: Promise<unknown> = Promise.resolve();
	private readonly timer: ReturnType<typeof setInterval>;
	constructor(
		private readonly root: string,
		private readonly limits = SNAPSHOT_INDEX_LIMITS,
		private readonly diagnostic: (record: SnapshotIndexDiagnostic) => void = () => {}
	) {
		this.timer = setInterval(() => {
			void this.exclusive(() => this.expire()).catch(() => undefined);
		}, 60_000);
		this.timer.unref();
	}
	static key(binding: unknown) {
		return crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex');
	}
	status(key: string) {
		const entry = this.entries.get(key);
		return entry?.index ? 'ready' : entry?.error ? 'failed' : entry ? 'indexing' : 'missing';
	}
	failure(key: string) {
		return this.entries.get(key)?.error;
	}
	private report(
		stage: SnapshotIndexDiagnostic['stage'],
		entry?: Entry,
		reason?: SnapshotIndexReason
	) {
		// Closed numeric projection: no key, paths, binding, credentials or raw errors.
		try {
			this.diagnostic({
				event: 'snapshot_index',
				stage,
				reason,
				indexes: this.entries.size,
				builds: this.builds,
				readers: [...this.entries.values()].reduce((n, value) => n + value.readers, 0),
				entries: entry?.count || 0,
				databaseBytes: entry?.bytes || 0,
				availableBytes: this.availableBytes,
				durationMs: entry ? Math.max(0, Date.now() - entry.started) : 0,
			});
		} catch {
			/* Observability must never leak a lease or fail an otherwise valid build. */
		}
	}
	private exclusive<T>(action: () => Promise<T>): Promise<T> {
		// Serialize admission/cleanup only, never a build or consumer; bound the queue.
		if (this.closed) return Promise.reject(new SnapshotIndexError('index-unavailable'));
		if (this.admissions >= 16) {
			this.report('refused', undefined, 'admission-busy');
			return Promise.reject(new SnapshotIndexError('index-resource-limit', 'admission-busy'));
		}
		this.admissions++;
		const next = this.admission.then(action).finally(() => {
			this.admissions--;
		});
		this.admission = next.catch(() => undefined);
		return next;
	}
	async start(key: string, populate: Populate, background = false) {
		return this.acquire(key, populate, background, false, false);
	}
	private acquire(
		key: string,
		populate: Populate,
		background: boolean,
		lease: boolean,
		retry: boolean
	) {
		return this.exclusive(async () => {
			if (!/^[a-f0-9]{64}$/.test(key)) throw new SnapshotIndexError('index-unavailable');
			try {
				await this.expire();
				let entry = this.entries.get(key);
				if (entry?.error && retry && !entry.readers && entry.settled) {
					await this.remove(key, entry);
					entry = undefined;
				}
				if (entry?.error) throw entry.error;
				if (!entry) {
					if (this.builds >= this.limits.maxBuilds)
						throw new SnapshotIndexError('index-resource-limit', 'build-busy');
					if (this.entries.size >= this.limits.maxIndexes) {
						// Wall clocks can tie or move backwards. Use access order for LRU;
						// wall time is only for TTL. Readers and builds remain pinned.
						const victim = [...this.entries]
							.filter(([, value]) => value.settled && !value.readers)
							.sort((a, b) => a[1].used - b[1].used)[0];
						if (!victim) throw new SnapshotIndexError('index-resource-limit', 'cache-active');
						await this.remove(...victim);
					}
					await this.initialize();
					let disk = await fs.statfs(this.root);
					this.availableBytes = disk.bavail * disk.bsize;
					while (disk.bavail * disk.bsize < this.limits.maxBytes + 64 * 1024 ** 2) {
						const victim = [...this.entries]
							.filter(([, value]) => value.settled && !value.readers)
							.sort((a, b) => a[1].used - b[1].used)[0];
						if (!victim) throw new SnapshotIndexError('index-resource-limit', 'disk-capacity');
						await this.remove(...victim);
						disk = await fs.statfs(this.root);
						this.availableBytes = disk.bavail * disk.bsize;
					}
					entry = {
						promise: undefined!,
						controller: new AbortController(),
						background,
						updated: Date.now(),
						used: ++this.sequence,
						started: Date.now(),
						readers: 0,
						settled: false,
						count: 0,
						bytes: 0,
					};
					this.entries.set(key, entry);
					this.builds++;
					const owned = entry;
					owned.promise = this.build(key, owned, populate)
						.then(index => {
							owned.index = index;
							this.report('ready', owned);
							return index;
						})
						.catch(error => {
							owned.error =
								error instanceof AppError ? error : new SnapshotIndexError('index-unavailable');
							this.report(
								'failed',
								owned,
								error instanceof SnapshotIndexError ? error.reason : 'unavailable'
							);
							throw owned.error;
						})
						.finally(() => {
							owned.settled = true;
							owned.updated = Date.now();
							owned.used = ++this.sequence;
							this.builds--;
						});
					void owned.promise.catch(() => undefined);
					this.report('building', owned);
				}
				entry.background ||= background;
				entry.updated = Date.now();
				entry.used = ++this.sequence;
				if (lease) entry.readers++; // Atomic with eviction/admission.
				return entry;
			} catch (error) {
				const failure =
					error instanceof AppError ? error : new SnapshotIndexError('index-unavailable');
				if (failure instanceof SnapshotIndexError)
					this.report('refused', undefined, failure.reason);
				throw failure;
			}
		});
	}
	async retry(key: string) {
		await this.exclusive(async () => {
			const entry = this.entries.get(key);
			if (entry?.error && !entry.readers && entry.settled) await this.remove(key, entry);
			await this.expire();
		});
	}
	async use<T>(
		key: string,
		populate: Populate,
		consume: (index: ManagedSnapshotIndex) => Promise<T> | T,
		signal?: AbortSignal
	) {
		if (signal?.aborted) throw new SnapshotIndexError('cancelled');
		const entry = await this.acquire(key, populate, false, true, true);
		let abort: (() => void) | undefined;
		try {
			const cancelled = new Promise<never>((_, reject) => {
				abort = () => reject(new SnapshotIndexError('cancelled'));
				signal?.addEventListener('abort', abort, { once: true });
				if (signal?.aborted) abort();
			});
			const index = await Promise.race([entry.promise, cancelled]);
			if (signal?.aborted) throw new SnapshotIndexError('cancelled');
			return await consume(index);
		} finally {
			if (abort) signal?.removeEventListener('abort', abort);
			entry.readers--;
			entry.updated = Date.now();
			entry.used = ++this.sequence;
			if (!entry.readers) entry.idle?.();
			if (!entry.readers && !entry.background && !entry.settled && signal?.aborted)
				entry.controller.abort();
		}
	}
	private async initialize() {
		this.initialized ||= (async () => {
			await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
			const stat = await fs.lstat(this.root);
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new SnapshotIndexError('index-unavailable');
			await fs.chmod(this.root, 0o700);
			// Exact generated names only; never application DB, restored data or secrets.
			for await (const item of await fs.opendir(this.root)) {
				if (/^index-[a-f0-9]{64}-[a-f0-9]{24}$/.test(item.name))
					await this.removeDirectory(path.join(this.root, item.name));
			}
		})().catch(() => {
			this.initialized = undefined;
			throw new SnapshotIndexError('index-unavailable', 'cleanup-failed');
		});
		return this.initialized;
	}
	private async build(
		key: string,
		entry: Entry,
		populate: (append: (node: ManagedSnapshotNode) => void, signal: AbortSignal) => Promise<void>
	) {
		let db: Database.Database | undefined;
		try {
			await this.initialize();
			const disk = await fs.statfs(this.root);
			if (disk.bavail * disk.bsize < this.limits.maxBytes + 64 * 1024 ** 2)
				throw new SnapshotIndexError('index-resource-limit', 'disk-capacity');
			entry.directory = path.join(
				this.root,
				`index-${key}-${crypto.randomBytes(12).toString('hex')}`
			);
			await fs.mkdir(entry.directory, { mode: 0o700 });
			const file = path.join(entry.directory, 'metadata.sqlite');
			db = new Database(file);
			await fs.chmod(file, 0o600);
			db.pragma('page_size=4096');
			db.pragma(`max_page_count=${Math.floor(this.limits.maxBytes / 4096)}`);
			db.pragma('cache_size=-8192');
			db.pragma('temp_store=FILE');
			db.pragma('journal_mode=OFF');
			db.pragma('synchronous=OFF');
			// Even one non-empty SQLite table needs the schema and a table page.
			if (this.limits.maxBytes < 2 * 4096)
				throw new SnapshotIndexError('index-resource-limit', 'database-size');
			db.exec(`CREATE TABLE nodes(path TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL,
				type TEXT NOT NULL, size INTEGER NOT NULL, modifiedAt TEXT NOT NULL, permissions TEXT NOT NULL, modifiedTime INTEGER NOT NULL,
				isDirectory INTEGER NOT NULL) WITHOUT ROWID;
				CREATE TABLE ancestors(path TEXT PRIMARY KEY) WITHOUT ROWID;
				CREATE INDEX children ON nodes(parent,isDirectory DESC,name COLLATE NOCASE,path);
				CREATE INDEX childSize ON nodes(parent,isDirectory DESC,size,path);
				CREATE INDEX childTime ON nodes(parent,isDirectory DESC,modifiedTime,path);
				CREATE INDEX childrenDesc ON nodes(parent,isDirectory DESC,name COLLATE NOCASE DESC,path);
				CREATE INDEX childSizeDesc ON nodes(parent,isDirectory DESC,size DESC,path);
				CREATE INDEX childTimeDesc ON nodes(parent,isDirectory DESC,modifiedTime DESC,path);
				BEGIN;`);
			const insert = db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)');
			const ancestor = db.prepare('INSERT OR IGNORE INTO ancestors VALUES (?)');
			let count = 0,
				logicalBytes = 0;
			const appendNode = (node: ManagedSnapshotNode) => {
				if (entry.controller.signal.aborted) throw new SnapshotIndexError('cancelled');
				if (entry.bytes >= this.limits.maxBytes)
					throw new SnapshotIndexError('index-resource-limit', 'database-size');
				entry.count = ++count;
				if (count > this.limits.maxEntries)
					throw new SnapshotIndexError('index-resource-limit', 'entry-count');
				let exactPath: string;
				try {
					exactPath = managedSnapshotPath(node.path);
				} catch {
					throw new SnapshotIndexError('metadata-invalid', 'unsafe-path');
				}
				if (node.name !== path.posix.basename(exactPath))
					throw new SnapshotIndexError('metadata-invalid', 'invalid-node-name');
				if (!Number.isSafeInteger(node.size) || node.size < 0)
					throw new SnapshotIndexError('metadata-invalid', 'invalid-size');
				if (
					typeof node.mtime !== 'string' ||
					node.mtime.length > 64 ||
					!Number.isFinite(Date.parse(node.mtime))
				)
					throw new SnapshotIndexError('metadata-invalid', 'invalid-timestamp');
				if (!['file', 'dir', 'symlink', 'dev', 'chardev', 'fifo', 'socket'].includes(node.type))
					throw new SnapshotIndexError('metadata-invalid', 'metadata-schema-invalid');
				logicalBytes += node.type === 'file' ? node.size : 0;
				if (!Number.isSafeInteger(logicalBytes))
					throw new SnapshotIndexError('metadata-invalid', 'invalid-size');
				const parent = path.posix.dirname(exactPath);
				try {
					insert.run(
						exactPath,
						parent === '/' ? '' : parent,
						node.name,
						node.type,
						node.size,
						node.mtime,
						String(node.mode || ''),
						Date.parse(node.mtime),
						Number(node.type === 'dir')
					);
				} catch (error) {
					if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
						throw new SnapshotIndexError('metadata-invalid', 'duplicate-entry');
					throw error;
				}
				let parentPath = parent;
				while (parentPath !== '/') {
					ancestor.run(parentPath);
					parentPath = path.posix.dirname(parentPath);
				}
				// Preserve a bounded allocation sample before SQLite can roll back on FULL.
				if (count % 256 === 0 || this.limits.maxBytes < 1024 ** 2)
					entry.bytes = (db!.pragma('page_count', { simple: true }) as number) * 4096;
			};
			await populate(node => {
				try {
					appendNode(node);
				} catch (error) {
					if (error instanceof AppError) throw error;
					throw new SnapshotIndexError(
						(error as { code?: string }).code === 'SQLITE_FULL'
							? 'index-resource-limit'
							: 'index-unavailable',
						(error as { code?: string }).code === 'SQLITE_FULL' ? 'storage-full' : 'unavailable'
					);
				}
			}, entry.controller.signal);
			if (entry.controller.signal.aborted) throw new SnapshotIndexError('cancelled');
			if (
				db
					.prepare("SELECT 1 FROM ancestors JOIN nodes USING(path) WHERE nodes.type!='dir' LIMIT 1")
					.get()
			)
				throw new SnapshotIndexError('metadata-invalid', 'ancestor-conflict');
			db.exec('DROP TABLE ancestors; COMMIT;');
			entry.bytes = (db.pragma('page_count', { simple: true }) as number) * 4096;
			return new ManagedSnapshotIndex(db);
		} catch (error) {
			if (db?.open) {
				entry.bytes = Math.max(
					entry.bytes,
					(db.pragma('page_count', { simple: true }) as number) * 4096
				);
				db.close();
			}
			try {
				if (entry.directory) await this.removeDirectory(entry.directory);
			} catch {
				throw new SnapshotIndexError('index-unavailable', 'cleanup-failed');
			}
			if (
				(error as { code?: string }).code === 'SQLITE_FULL' ||
				(error instanceof SnapshotIndexError && error.reason === 'storage-full')
			) {
				const disk = await fs.statfs(this.root).catch(() => undefined);
				if (disk) this.availableBytes = disk.bavail * disk.bsize;
				throw new SnapshotIndexError(
					'index-resource-limit',
					entry.bytes >= this.limits.maxBytes
						? 'database-size'
						: disk && this.availableBytes < 64 * 1024 ** 2
							? 'disk-capacity'
							: 'storage-full'
				);
			}
			if ((error as { code?: string }).code === 'timeout')
				throw new SnapshotIndexError('index-unavailable', 'timeout');
			if ((error as { code?: string }).code === 'cancelled')
				throw new SnapshotIndexError('cancelled');
			if ((error as { code?: string }).code === 'invalid-output') {
				const reason = (error as { reason?: SnapshotIndexReason }).reason;
				throw new SnapshotIndexError(
					'metadata-invalid',
					reason &&
					[
						'invalid-size',
						'invalid-timestamp',
						'metadata-schema-invalid',
						'repository-output-invalid',
					].includes(reason)
						? reason
						: 'repository-output-invalid'
				);
			}
			throw error;
		}
	}
	private async removeDirectory(directory: string) {
		if (
			path.dirname(path.resolve(directory)) !== path.resolve(this.root) ||
			!/^index-[a-f0-9]{64}-[a-f0-9]{24}$/.test(path.basename(directory))
		)
			throw new SnapshotIndexError('index-unavailable');
		await fs.rm(directory, { recursive: true, force: true });
	}
	private async remove(key: string, entry: Entry) {
		if (entry.readers || !entry.settled)
			throw new SnapshotIndexError('index-resource-limit', 'cache-active');
		try {
			entry.index?.close(); // Release native handle before deleting generated files.
			entry.index = undefined;
			if (entry.directory) await this.removeDirectory(entry.directory);
		} catch {
			entry.error = new SnapshotIndexError('index-unavailable', 'cleanup-failed');
			throw entry.error;
		}
		if (this.entries.get(key) === entry) this.entries.delete(key);
		this.report('evicted', entry);
	}
	private async expire() {
		for (const [key, entry] of this.entries) {
			if (!entry.readers && entry.settled && Date.now() - entry.updated >= this.limits.ttlMs)
				await this.remove(key, entry);
		}
	}
	async close() {
		clearInterval(this.timer);
		this.closed = true;
		await this.admission;
		for (const entry of this.entries.values()) entry.controller.abort();
		await Promise.allSettled([...this.entries.values()].map(entry => entry.promise));
		for (const [key, entry] of this.entries) {
			if (entry.readers)
				await new Promise<void>(resolve => {
					entry.idle = resolve;
				});
			await this.remove(key, entry);
		}
	}
}
