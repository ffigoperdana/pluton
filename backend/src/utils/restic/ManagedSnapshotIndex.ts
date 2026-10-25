import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import { AppError } from '../AppError';
import { normalizeLegacySnapshotPath } from '../legacySnapshotPath';
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
			| 'cancelled'
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
			code === 'index-resource-limit'
				? 429
				: code === 'metadata-invalid'
					? 422
					: code === 'snapshot-indexing'
						? 202
						: code === 'index-unavailable'
							? 503
							: 409,
			messages[code]
		);
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

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
	assertSafe() {
		if (
			this.db
				.prepare(
					"SELECT 1 FROM nodes WHERE type NOT IN ('file','dir') OR instr(path,':')>0 LIMIT 1"
				)
				.get()
		)
			throw new SnapshotIndexError('unsupported-snapshot-file');
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
			(query.order !== undefined && !['asc', 'desc'].includes(query.order))
		)
			throw new AppError(400, 'Invalid snapshot page parameters.');
		const directory = query.path || '';
		if (directory) {
			if (!directory.startsWith('/')) throw new AppError(400, 'Invalid snapshot directory.');
			normalizeLegacySnapshotPath(directory.slice(1), false);
		}
		if (directory && this.get(directory)?.type !== 'dir')
			throw new AppError(404, 'Snapshot directory not found.');
		const where = 'parent=? AND instr(lower(name),lower(?))>0';
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

type Entry = {
	promise: Promise<ManagedSnapshotIndex>;
	controller: AbortController;
	background: boolean;
	index?: ManagedSnapshotIndex;
	error?: AppError;
	updated: number;
	readers: number;
	directory?: string;
	removing?: Promise<void>;
};

/** Single server process owns the cache. No persisted index is trusted on restart. */
export class ManagedSnapshotIndexCache {
	private readonly entries = new Map<string, Entry>();
	private initialized?: Promise<void>;
	private builds = 0;
	private readonly timer: ReturnType<typeof setInterval>;
	constructor(
		private readonly root: string,
		private readonly limits = SNAPSHOT_INDEX_LIMITS
	) {
		this.timer = setInterval(() => {
			void this.expire().catch(() => undefined);
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
	start(
		key: string,
		populate: (append: (node: ManagedSnapshotNode) => void, signal: AbortSignal) => Promise<void>,
		background = false
	) {
		let entry = this.entries.get(key);
		if (
			entry &&
			!entry.error &&
			(entry.readers || Date.now() - entry.updated < this.limits.ttlMs)
		) {
			entry.background ||= background;
			return entry;
		}
		if (entry) {
			// Removal finishes before a new index reserves this slot.
			throw new SnapshotIndexError('index-unavailable');
		}
		if (this.builds >= this.limits.maxBuilds || this.entries.size >= this.limits.maxIndexes)
			throw new SnapshotIndexError('index-resource-limit');
		entry = {
			promise: undefined!,
			controller: new AbortController(),
			background,
			updated: Date.now(),
			readers: 0,
		};
		this.entries.set(key, entry);
		this.builds++;
		const owned = entry;
		owned.promise = this.build(key, owned, populate)
			.then(index => {
				owned.index = index;
				owned.updated = Date.now();
				return index;
			})
			.catch(error => {
				owned.error =
					error instanceof AppError ? error : new SnapshotIndexError('index-unavailable');
				owned.updated = Date.now();
				throw owned.error;
			})
			.finally(() => {
				this.builds--;
			});
		void owned.promise.catch(() => undefined);
		return owned;
	}
	async retry(key: string) {
		const entry = this.entries.get(key);
		if (entry?.removing) await entry.removing;
		if (entry?.error && !entry.readers) await this.remove(key, entry);
		await this.expire();
	}
	async use<T>(
		key: string,
		populate: (append: (node: ManagedSnapshotNode) => void, signal: AbortSignal) => Promise<void>,
		consume: (index: ManagedSnapshotIndex) => Promise<T> | T,
		signal?: AbortSignal
	) {
		if (signal?.aborted) throw new SnapshotIndexError('cancelled');
		await this.retry(key);
		const entry = this.start(key, populate);
		entry.readers++;
		let abort: (() => void) | undefined;
		try {
			const cancelled = new Promise<never>((_, reject) => {
				abort = () => reject(new SnapshotIndexError('cancelled'));
				signal?.addEventListener('abort', abort, { once: true });
				if (signal?.aborted) abort();
			});
			const index = await Promise.race([entry.promise, cancelled]);
			return await consume(index);
		} finally {
			if (abort) signal?.removeEventListener('abort', abort);
			entry.readers--;
			entry.updated = Date.now();
			if (!entry.readers && !entry.background && !entry.index && !entry.error && signal?.aborted)
				entry.controller.abort();
			// An indexing request is background work. The fixed timeout/disk cap own
			// its lifetime even if one browser or download disconnects.
		}
	}
	private async initialize() {
		this.initialized ||= (async () => {
			await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
			const stat = await fs.lstat(this.root);
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new SnapshotIndexError('index-unavailable');
			await fs.chmod(this.root, 0o700);
			// Exact generated names only; no application DB, restored data or secrets.
			for (const name of await fs.readdir(this.root)) {
				if (/^index-[a-f0-9]{64}-[a-f0-9]{24}$/.test(name))
					await this.removeDirectory(path.join(this.root, name));
			}
		})();
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
				throw new SnapshotIndexError('index-resource-limit');
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
				if (++count > this.limits.maxEntries) throw new SnapshotIndexError('index-resource-limit');
				if (!node.path.startsWith('/')) throw new SnapshotIndexError('metadata-invalid');
				let relative: string;
				try {
					relative = normalizeLegacySnapshotPath(node.path.slice(1), false);
				} catch {
					throw new SnapshotIndexError('metadata-invalid');
				}
				if (
					node.name !== path.posix.basename(node.path) ||
					!Number.isSafeInteger(node.size) ||
					node.size < 0 ||
					typeof node.mtime !== 'string' ||
					node.mtime.length > 64 ||
					!Number.isFinite(Date.parse(node.mtime)) ||
					!['file', 'dir', 'symlink', 'dev', 'chardev', 'fifo', 'socket'].includes(node.type)
				)
					throw new SnapshotIndexError('metadata-invalid');
				logicalBytes += node.type === 'file' ? node.size : 0;
				if (!Number.isSafeInteger(logicalBytes)) throw new SnapshotIndexError('metadata-invalid');
				const parent = path.posix.dirname(`/${relative}`);
				try {
					insert.run(
						`/${relative}`,
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
						throw new SnapshotIndexError('metadata-invalid');
					throw error;
				}
				let parentPath = parent;
				while (parentPath !== '/') {
					ancestor.run(parentPath);
					parentPath = path.posix.dirname(parentPath);
				}
			};
			await populate(node => {
				try {
					appendNode(node);
				} catch (error) {
					if (error instanceof AppError) throw error;
					throw new SnapshotIndexError(
						(error as { code?: string }).code === 'SQLITE_FULL'
							? 'index-resource-limit'
							: 'index-unavailable'
					);
				}
			}, entry.controller.signal);
			if (entry.controller.signal.aborted) throw new SnapshotIndexError('cancelled');
			if (
				db
					.prepare("SELECT 1 FROM ancestors JOIN nodes USING(path) WHERE nodes.type!='dir' LIMIT 1")
					.get()
			)
				throw new SnapshotIndexError('metadata-invalid');
			db.exec('DROP TABLE ancestors; COMMIT;');
			return new ManagedSnapshotIndex(db);
		} catch (error) {
			db?.close();
			if (entry.directory) await this.removeDirectory(entry.directory);
			if ((error as { code?: string }).code === 'SQLITE_FULL')
				throw new SnapshotIndexError('index-resource-limit');
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
	private remove(key: string, entry: Entry): Promise<void> {
		if (entry.removing) return entry.removing;
		entry.removing = (async () => {
			entry.index?.close();
			entry.index = undefined;
			try {
				if (entry.directory) await this.removeDirectory(entry.directory);
			} catch {
				entry.error = new SnapshotIndexError('index-unavailable');
				throw entry.error;
			}
			if (this.entries.get(key) === entry) this.entries.delete(key);
		})().finally(() => {
			entry.removing = undefined;
		});
		return entry.removing;
	}
	private async expire() {
		for (const [key, entry] of this.entries) {
			if (
				!entry.readers &&
				(entry.index || entry.error) &&
				Date.now() - entry.updated >= this.limits.ttlMs
			)
				await this.remove(key, entry);
		}
	}
	async close() {
		clearInterval(this.timer);
		for (const entry of this.entries.values()) entry.controller.abort();
		await Promise.allSettled([...this.entries.values()].map(entry => entry.promise));
		for (const [key, entry] of this.entries) await this.remove(key, entry);
	}
}
