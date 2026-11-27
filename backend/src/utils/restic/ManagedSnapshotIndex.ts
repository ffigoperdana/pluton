import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import { openSync, closeSync } from 'fs';
import { ManagedExportProof } from './ManagedExportProof';
import {
	ManagedExportError,
	MANAGED_EXPORT_LIMITS,
	type ManagedExportBinding,
	type ManagedExportMode,
} from './ManagedExportPolicy';
import { AppError } from '../AppError';
import { managedSnapshotPath, assertManagedRestorePath } from '../managedSnapshotPath';
import type { SnapShotFile } from '../../types/restic';
import {
	ManagedRepositoryAccessError,
	type ManagedSnapshotNode,
	type RepositoryOperationDiagnostic,
} from './ManagedSftpRepositorySession';

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
				: 'unavailable',
		readonly diagnostic?: RepositoryOperationDiagnostic
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
/**
 * One entry with its six child-order indexes takes about 0.5 to 1.5 KiB, depending
 * on path and name length: the indexes key on an integer parent and the name, and
 * only the row and the path index hold the full path. A 650,000-file snapshot whose
 * paths averaged about 170 characters needed 2.7 KiB per entry with the former
 * full-path indexes and ran out of the former 1 GiB cap at about 400,000 entries.
 * 4 GiB holds 2,000,000 long-path entries; free space is sampled while it grows.
 */
export const SNAPSHOT_INDEX_LIMITS = Object.freeze({
	maxEntries: 2_000_000,
	maxBytes: 4 * 1024 ** 3,
	/**
	 * Free space an index needs before it starts (plus the reserve). An index only
	 * grows as large as its snapshot needs, up to maxBytes; running out of disk on
	 * the way is reported as disk-capacity. Requiring the whole cap up front would
	 * refuse even small snapshots on a modest cache filesystem.
	 */
	startBytes: 256 * 1024 ** 2,
	/** Indexes opened on demand (Browse, downloads, restores). */
	maxIndexes: 2,
	ttlMs: 15 * 60_000,
	/**
	 * Indexes prepared in the background after a backup, in their own slots. A
	 * prepared index outlives the idle lifetime until it is released for a newer
	 * snapshot of its plan or this retention ends.
	 */
	maxPrepared: 3,
	preparedRetainMs: 36 * 60 * 60_000,
	maxBuilds: 1,
	pageSize: 200,
	maxPageSize: 500,
	compatibilityEntries: 5000,
});
/** Free space kept on the cache filesystem in addition to one index reservation. */
const SNAPSHOT_INDEX_DISK_RESERVE = 64 * 1024 ** 2;
/** A growing index samples free space every this many entries (a few MiB of index). */
export const DISK_SAMPLE_ROWS = 4096;
/** Within this distance of the page cap the allocation is sampled after every row. */
const PAGE_CAP_SAMPLING_WINDOW = 16 * 1024 ** 2;
/**
 * SQLite rolls the build back on FULL, so the cap can only be recognised from the
 * last sample. One row with its index pages adds far less than this, so a FULL
 * within it of the cap is the page cap, not a quota.
 */
const PAGE_CAP_ATTRIBUTION_MARGIN = 1024 ** 2;
const mib = (bytes: number) => `${Math.round(bytes / 1024 ** 2).toLocaleString('en-US')} MiB`;

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
	'disk-capacity': `Snapshot indexing needs ${mib(SNAPSHOT_INDEX_LIMITS.startBytes + SNAPSHOT_INDEX_DISK_RESERVE)} of available cache filesystem space to start, and the index of a large snapshot grows up to ${mib(SNAPSHOT_INDEX_LIMITS.maxBytes)}. Free cache filesystem space and retry.`,
	'database-size': `Snapshot metadata index exceeds the bounded database size limit (${mib(SNAPSHOT_INDEX_LIMITS.maxBytes)}): the snapshot has too many entries or too long paths to index.`,
	'entry-count': `Snapshot metadata exceeds the maximum entry count (${SNAPSHOT_INDEX_LIMITS.maxEntries.toLocaleString('en-US')}).`,
	'cleanup-failed': 'Snapshot index cleanup failed. Check cache filesystem access and retry.',
	'storage-full':
		'SQLite index storage is full or quota-limited. Check available cache capacity and filesystem quota before retrying.',
	'timeout': 'Snapshot indexing timed out. Retry indexing.',
};

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
	private proofDb?: Database.Database;
	constructor(private readonly db: Database.Database) {}
	typeCounts(): Record<string, number> {
		return Object.fromEntries(
			(
				this.db
					.prepare('SELECT type,count(*) AS n FROM nodes GROUP BY type ORDER BY type')
					.all() as { type: string; n: number }[]
			).map(row => [row.type, row.n])
		);
	}
	exportProof(binding: ManagedExportBinding, mode: ManagedExportMode) {
		try {
			if (!this.proofDb) {
				const file = this.db.name === ':memory:' ? ':memory:' : this.db.name + '.exports';
				if (file !== ':memory:') {
					if (!path.isAbsolute(file)) throw new ManagedExportError('export-proof-missing');
					closeSync(openSync(file, 'wx', 0o600));
				}
				const db = new Database(file);
				try {
					db.pragma('cache_size=-4096');
					db.pragma('temp_store=FILE');
					db.pragma('journal_mode=MEMORY');
					db.pragma('synchronous=OFF');
					db.pragma(`max_page_count=${MANAGED_EXPORT_LIMITS.maxProofBytes / 4096}`);
					this.proofDb = db;
				} catch (error) {
					db.close();
					throw error;
				}
			}
			return new ManagedExportProof(this.proofDb, binding, mode, this.typeCounts());
		} catch (error) {
			throw error instanceof ManagedExportError
				? error
				: new ManagedExportError('export-resource-limit');
		}
	}
	/** Structural permission only. Symlink target/content proof is mandatory before
	 * export or restore execution; assertSafe() retains its strict legacy default. */
	assertExportEntries(mode: ManagedExportMode, restore = false) {
		const counts = this.typeCounts();
		if (
			mode === 'full' &&
			Object.keys(counts).some(type => !['file', 'dir', 'symlink'].includes(type))
		)
			throw new ManagedExportError('unsupported-node-type');
		if (restore && process.platform === 'win32') {
			if (counts.symlink) throw new ManagedExportError('posix-restore-required');
			for (const file of this) assertManagedRestorePath(file.path);
		}
	}
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
	/** Regular files with this exact name anywhere in the snapshot (a bounded scan). */
	filesNamed(name: string, limit: number): SnapShotFile[] {
		return (
			this.db
				.prepare("SELECT * FROM nodes WHERE name=? AND type='file' ORDER BY path LIMIT ?")
				.all(name, limit) as Row[]
		).map(asFile);
	}
	/**
	 * Integer key of a parent path ('' is the snapshot root), or -1 when no entry has
	 * that parent. Child-order indexes store this key instead of the full parent path.
	 */
	private parentKey(parent: string): number {
		return (
			(
				this.db.prepare('SELECT id FROM parents WHERE path=?').get(parent) as
					| { id: number }
					| undefined
			)?.id ?? -1
		);
	}
	/** Direct child directories of a directory, by name. */
	childDirectories(parent: string, limit: number): SnapShotFile[] {
		// Within one parent, name order (binary) is exactly path order.
		return (
			this.db
				.prepare(
					"SELECT * FROM nodes WHERE parentId=? AND type='dir' ORDER BY name COLLATE NOCASE, name LIMIT ?"
				)
				.all(this.parentKey(parent), limit) as Row[]
		).map(asFile);
	}
	/** Entries named `name` anywhere below a directory, counted by type. */
	namedBelow(directory: string, name: string) {
		const rows = this.db
			.prepare(
				'SELECT type, count(*) AS n, coalesce(sum(size),0) AS bytes FROM nodes WHERE path >= ? AND path < ? AND name=? GROUP BY type'
			)
			.all(`${directory}/`, `${directory}0`, name) as { type: string; n: number; bytes: number }[];
		const file = rows.find(row => row.type === 'file');
		return {
			files: file?.n || 0,
			bytes: file?.bytes || 0,
			other: rows.filter(row => row.type !== 'file').reduce((total, row) => total + row.n, 0),
		};
	}
	/**
	 * One page of regular files named `name` below a directory, in path order
	 * after `after`. Pages keep no statement open between calls, so callers may
	 * await in between while other readers use this index.
	 */
	filesNamedBelow(
		directory: string,
		name: string,
		after: string | undefined,
		limit: number
	): SnapShotFile[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM nodes WHERE path > ? AND path < ? AND name=? AND type='file' ORDER BY path LIMIT ?"
				)
				.all(after ?? `${directory}/`, `${directory}0`, name, limit) as Row[]
		).map(asFile);
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
			'parentId=? AND instr(lower(name),lower(?))>0' +
			(query.directoriesOnly ? " AND type='dir'" : '');
		const params = [this.parentKey(directory), query.search || ''];
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
					// Siblings share the parent, so the binary name tie-break is the path order.
					`SELECT * FROM nodes INDEXED BY ${scan} WHERE ${where} ORDER BY isDirectory DESC, ${sort} ${order}, name ASC LIMIT ? OFFSET ?`
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
		this.proofDb?.close();
		this.db.close();
	}
}

type Populate = (append: (node: ManagedSnapshotNode) => void, signal: AbortSignal) => Promise<void>;
type Entry = {
	generation: string;
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
	/** Held in a prepared slot; retained while ready until `retainUntil`. */
	prepared?: boolean;
	retainUntil?: number;
	/** Requested by Browse, a download or a restore, so never preempted. */
	claimed?: boolean;
};
/** Outcome of a background preparation, as its queue needs it. */
export type PreparedIndexResult = 'ready' | 'failed' | 'cancelled';
export type SnapshotIndexDiagnostic = {
	event: 'snapshot_index';
	stage: 'building' | 'ready' | 'failed' | 'evicted' | 'refused' | 'prepared' | 'preempted';
	reason?: SnapshotIndexReason;
	indexes: number;
	prepared: number;
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
	/** Free space required before a build: its starting allowance plus the reserve. */
	private requiredFreeBytes() {
		return Math.min(this.limits.maxBytes, this.limits.startBytes) + SNAPSHOT_INDEX_DISK_RESERVE;
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
	private preparedCount() {
		return [...this.entries.values()].filter(entry => entry.prepared).length;
	}
	/** A ready prepared index within its retention is kept past the idle lifetime. */
	private retained(entry: Entry, now = Date.now()) {
		return !!(entry.prepared && entry.index && entry.retainUntil && now < entry.retainUntil);
	}
	/** Read-only telemetry: polling neither touches TTL/LRU nor starts work. */
	inspect(key: string) {
		const entry = this.entries.get(key);
		const live =
			entry &&
			(entry.readers > 0 ||
				!entry.settled ||
				this.retained(entry) ||
				Date.now() - entry.updated < this.limits.ttlMs);
		return live
			? {
					state: this.status(key),
					entries: entry.count,
					generation: entry.generation,
					elapsedMs: Math.max(0, (entry.settled ? entry.updated : Date.now()) - entry.started),
				}
			: undefined;
	}
	/** Atomic cache-only handoff. Missing/expired/replaced indexes never rebuild on GET. */
	async useReady<T>(
		key: string,
		generation: string,
		consume: (index: ManagedSnapshotIndex) => Promise<T>
	) {
		const entry = await this.exclusive(async () => {
			await this.expire();
			const value = this.entries.get(key);
			if (!value?.index || value.generation !== generation)
				throw new AppError(409, 'Download preparation expired. Prepare this snapshot again.');
			value.readers++;
			value.used = ++this.sequence;
			return value;
		});
		try {
			return await consume(entry.index!);
		} finally {
			entry.readers--;
			entry.updated = Date.now();
			entry.used = ++this.sequence;
			if (!entry.readers) entry.idle?.();
		}
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
				prepared: this.preparedCount(),
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
					// A request from Browse, a download or a restore comes before background
					// preparation: an unclaimed prepared build yields its build slot.
					if (this.builds >= this.limits.maxBuilds) await this.yieldPreparedBuild();
					if (this.builds >= this.limits.maxBuilds)
						throw new SnapshotIndexError('index-resource-limit', 'build-busy');
					const onDemand = [...this.entries].filter(([, value]) => !value.prepared);
					if (onDemand.length >= this.limits.maxIndexes) {
						// Wall clocks can tie or move backwards. Use access order for LRU;
						// wall time is only for TTL. Readers and builds remain pinned.
						const victim = onDemand
							.filter(([, value]) => value.settled && !value.readers)
							.sort((a, b) => a[1].used - b[1].used)[0];
						if (!victim) throw new SnapshotIndexError('index-resource-limit', 'cache-active');
						await this.remove(...victim);
					}
					entry = await this.admit(key, populate, background);
				}
				entry.claimed = true;
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
	/** Disk admission and construction of a new entry. Callers hold the admission lock. */
	private async admit(key: string, populate: Populate, background: boolean) {
		await this.initialize();
		let disk = await fs.statfs(this.root);
		this.availableBytes = disk.bavail * disk.bsize;
		while (disk.bavail * disk.bsize < this.requiredFreeBytes()) {
			// Idle on-demand indexes go first; prepared ones only when nothing else frees space.
			const victim = [...this.entries]
				.filter(([, value]) => value.settled && !value.readers)
				.sort(
					(a, b) => Number(!!a[1].prepared) - Number(!!b[1].prepared) || a[1].used - b[1].used
				)[0];
			if (!victim) throw new SnapshotIndexError('index-resource-limit', 'disk-capacity');
			await this.remove(...victim);
			disk = await fs.statfs(this.root);
			this.availableBytes = disk.bavail * disk.bsize;
		}
		const entry: Entry = {
			generation: crypto.randomUUID(),
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
		entry.promise = this.build(key, entry, populate)
			.then(index => {
				entry.index = index;
				this.report('ready', entry);
				return index;
			})
			.catch(error => {
				entry.error =
					error instanceof AppError ? error : new SnapshotIndexError('index-unavailable');
				this.report(
					'failed',
					entry,
					error instanceof SnapshotIndexError ? error.reason : 'unavailable'
				);
				throw entry.error;
			})
			.finally(() => {
				entry.settled = true;
				entry.updated = Date.now();
				entry.used = ++this.sequence;
				this.builds--;
			});
		void entry.promise.catch(() => undefined);
		this.report('building', entry);
		return entry;
	}
	/** Stops an unclaimed prepared build and discards it. Callers hold the admission lock. */
	private async stopPrepared(key: string, entry: Entry) {
		if (!entry.prepared || entry.claimed || entry.settled || entry.readers) return false;
		entry.controller.abort();
		await entry.promise.catch(() => undefined);
		this.report('preempted', entry);
		if (this.entries.get(key) === entry && !entry.readers) await this.remove(key, entry);
		return true;
	}
	private async yieldPreparedBuild() {
		for (const [key, entry] of [...this.entries]) if (await this.stopPrepared(key, entry)) return;
	}
	/**
	 * Starts (never waits for) a background index in a prepared slot, or marks an
	 * existing one prepared, and extends its retention. A failed attempt is retried.
	 * Returns the construction outcome for the caller's queue.
	 */
	async prepare(
		key: string,
		populate: Populate
	): Promise<{ result: Promise<PreparedIndexResult> }> {
		return this.exclusive(async () => {
			if (!/^[a-f0-9]{64}$/.test(key)) throw new SnapshotIndexError('index-unavailable');
			try {
				await this.expire();
				let entry = this.entries.get(key);
				if (entry?.error && !entry.readers && entry.settled) {
					await this.remove(key, entry);
					entry = undefined;
				}
				if (entry?.error) throw entry.error;
				if (!entry?.prepared) {
					const prepared = [...this.entries].filter(([, value]) => value.prepared);
					if (prepared.length >= this.limits.maxPrepared) {
						const victim = prepared
							.filter(([, value]) => value.settled && !value.readers)
							.sort((a, b) => (a[1].retainUntil || 0) - (b[1].retainUntil || 0))[0];
						if (!victim) throw new SnapshotIndexError('index-resource-limit', 'cache-active');
						await this.remove(...victim);
					}
				}
				if (!entry) {
					if (this.builds >= this.limits.maxBuilds)
						throw new SnapshotIndexError('index-resource-limit', 'build-busy');
					entry = await this.admit(key, populate, true);
				}
				entry.prepared = true;
				entry.background = true;
				entry.retainUntil = Date.now() + this.limits.preparedRetainMs;
				entry.updated = Date.now();
				this.report('prepared', entry);
				const owned = entry;
				return {
					result: owned.promise.then(
						(): PreparedIndexResult => 'ready',
						(error): PreparedIndexResult =>
							(error as { code?: string })?.code === 'cancelled' ? 'cancelled' : 'failed'
					),
				};
			} catch (error) {
				const failure =
					error instanceof AppError ? error : new SnapshotIndexError('index-unavailable');
				if (failure instanceof SnapshotIndexError)
					this.report('refused', undefined, failure.reason);
				throw failure;
			}
		});
	}
	/**
	 * Gives up a prepared slot (a newer snapshot of the plan is prepared). An idle
	 * index is removed at once; one in use falls back to the idle lifetime.
	 */
	async release(key: string) {
		await this.exclusive(async () => {
			const entry = this.entries.get(key);
			if (!entry?.prepared) return;
			entry.prepared = false;
			entry.retainUntil = undefined;
			if (entry.settled && !entry.readers) await this.remove(key, entry);
		});
	}
	/** Stops a prepared build nobody has asked for (a backup started). */
	async preempt(key: string) {
		return this.exclusive(async () => {
			const entry = this.entries.get(key);
			return entry ? this.stopPrepared(key, entry) : false;
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
			if (!entry.readers && !entry.background && !entry.settled && signal?.aborted) {
				entry.controller.abort();
				// The preparation worker owns this construction. Do not admit its next
				// job until the cancelled process/config/index cleanup has settled.
				// Shared Browse-owned work remains independent and is not aborted.
				await entry.promise.catch(() => undefined);
			}
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
			if (disk.bavail * disk.bsize < this.requiredFreeBytes())
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
			// The six child-order indexes key on an integer parent and the short name, not
			// on the full parent path and path: a long-path snapshot needs about half the
			// space it did, and siblings still sort exactly in path order (name, binary).
			db.exec(`CREATE TABLE parents(path TEXT PRIMARY KEY, id INTEGER NOT NULL) WITHOUT ROWID;
				CREATE TABLE nodes(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, parentId INTEGER NOT NULL,
				name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, modifiedAt TEXT NOT NULL, permissions TEXT NOT NULL,
				modifiedTime INTEGER NOT NULL, isDirectory INTEGER NOT NULL);
				CREATE TABLE ancestors(path TEXT PRIMARY KEY) WITHOUT ROWID;
				CREATE INDEX children ON nodes(parentId,isDirectory DESC,name COLLATE NOCASE,name);
				CREATE INDEX childSize ON nodes(parentId,isDirectory DESC,size,name);
				CREATE INDEX childTime ON nodes(parentId,isDirectory DESC,modifiedTime,name);
				CREATE INDEX childrenDesc ON nodes(parentId,isDirectory DESC,name COLLATE NOCASE DESC,name);
				CREATE INDEX childSizeDesc ON nodes(parentId,isDirectory DESC,size DESC,name);
				CREATE INDEX childTimeDesc ON nodes(parentId,isDirectory DESC,modifiedTime DESC,name);
				BEGIN;`);
			const insert = db.prepare(
				'INSERT INTO nodes(path,parentId,name,type,size,modifiedAt,permissions,modifiedTime,isDirectory) VALUES (?,?,?,?,?,?,?,?,?)'
			);
			const ancestor = db.prepare('INSERT OR IGNORE INTO ancestors VALUES (?)');
			const findParent = db.prepare('SELECT id FROM parents WHERE path=?');
			const addParent = db.prepare('INSERT INTO parents VALUES (?,?)');
			// Siblings arrive together, so one remembered parent avoids most lookups.
			let lastParent: { path: string; id: number } | undefined,
				parents = 0;
			const parentKey = (parent: string) => {
				if (lastParent?.path !== parent) {
					const row = findParent.get(parent) as { id: number } | undefined;
					const id = row?.id ?? ++parents;
					if (!row) addParent.run(parent, id);
					lastParent = { path: parent, id };
				}
				return lastParent.id;
			};
			// The page cap bounds one index, not the filesystem. Sample free space while
			// the index grows, so a build stops before it takes the disk the application
			// database and logs share with it.
			let diskLow = false,
				diskSample: Promise<void> | undefined;
			const sampleDisk = () => {
				diskSample ||= fs
					.statfs(this.root)
					.then(
						disk => {
							this.availableBytes = disk.bavail * disk.bsize;
							if (this.availableBytes < SNAPSHOT_INDEX_DISK_RESERVE) diskLow = true;
						},
						() => undefined
					)
					.finally(() => {
						diskSample = undefined;
					});
			};
			let count = 0,
				logicalBytes = 0;
			const appendNode = (node: ManagedSnapshotNode) => {
				if (entry.controller.signal.aborted) throw new SnapshotIndexError('cancelled');
				if (diskLow) throw new SnapshotIndexError('index-resource-limit', 'disk-capacity');
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
						parentKey(parent === '/' ? '' : parent),
						node.name,
						node.type,
						node.size,
						node.mtime,
						String(node.mode || ''),
						Date.parse(node.mtime),
						Number(node.type === 'dir')
					);
				} catch (error) {
					const code = (error as { code?: string }).code;
					if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
						throw new SnapshotIndexError('metadata-invalid', 'duplicate-entry');
					throw error;
				}
				// An ancestor already recorded has its own ancestors recorded too.
				let parentPath = parent;
				while (parentPath !== '/' && ancestor.run(parentPath).changes > 0)
					parentPath = path.posix.dirname(parentPath);
				if (count % DISK_SAMPLE_ROWS === 0) sampleDisk();
				// Preserve a bounded allocation sample before SQLite can roll back on FULL.
				// Near the page cap every row is sampled, so the last sample is one row
				// below the cap when SQLite reports FULL there.
				if (
					count % 256 === 0 ||
					entry.bytes >= this.limits.maxBytes - PAGE_CAP_SAMPLING_WINDOW ||
					this.limits.maxBytes < 1024 ** 2
				)
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
				const capMargin = Math.min(PAGE_CAP_ATTRIBUTION_MARGIN, this.limits.maxBytes / 4);
				throw new SnapshotIndexError(
					'index-resource-limit',
					entry.bytes >= this.limits.maxBytes - capMargin
						? 'database-size'
						: disk && this.availableBytes < SNAPSHOT_INDEX_DISK_RESERVE
							? 'disk-capacity'
							: 'storage-full'
				);
			}
			if ((error as { code?: string }).code === 'timeout')
				throw new SnapshotIndexError(
					'index-unavailable',
					'timeout',
					error instanceof ManagedRepositoryAccessError ? error.diagnostic : undefined
				);
			if ((error as { code?: string }).code === 'cancelled')
				throw new SnapshotIndexError(
					'cancelled',
					'cancelled',
					error instanceof ManagedRepositoryAccessError ? error.diagnostic : undefined
				);
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
		const now = Date.now();
		for (const [key, entry] of this.entries) {
			if (
				!entry.readers &&
				entry.settled &&
				!this.retained(entry, now) &&
				now - Math.max(entry.updated, entry.retainUntil || 0) >= this.limits.ttlMs
			)
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
