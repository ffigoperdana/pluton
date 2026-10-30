import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import { AppError } from '../AppError';
import { managedSnapshotPath } from '../managedSnapshotPath';
import type { ManagedSnapshotIndex, SnapshotPageQuery } from './ManagedSnapshotIndex';

export const COMPARISON_LIMITS = Object.freeze({
	maxJobs: 2,
	maxEntries: 1_000_000,
	maxBytes: 128 * 1024 ** 2,
	ttlMs: 15 * 60_000,
	deadlineMs: 15 * 60_000,
});
export type SnapshotChange = 'added' | 'modified' | 'unchanged' | 'deleted';
export type ComparisonQuery = SnapshotPageQuery & { change?: SnapshotChange; recursive?: boolean };
export type SnapshotDiffRecord =
	| { message_type: 'change'; path: string; modifier: string }
	| { message_type: 'statistics'; source_snapshot: string; target_snapshot: string };
export type ComparisonBinding = {
	currentBackupId: string;
	previousBackupId: string;
	currentSnapshotId: string;
	previousSnapshotId: string;
};
type Row = {
	path: string;
	parent: string;
	name: string;
	type: string;
	size: number;
	modifiedAt: string;
	change: SnapshotChange;
};

/** Private, bounded disposable metadata. No content, credentials or schema migration.
 * Common paths become Unchanged only after a complete, validated restic diff. */
export class SnapshotComparison {
	private db: Database.Database;
	processedEntries = 0;
	currentEntries = 0;
	totalEntries = 0;
	phase: 'preparing' | 'indexing' | 'comparing' | 'ready' = 'preparing';
	constructor(
		file: string,
		readonly binding: ComparisonBinding
	) {
		this.db = new Database(file);
		this.db.pragma('cache_size=-2048');
		this.db.pragma('temp_store=FILE');
		this.db.pragma('journal_mode=MEMORY');
		this.db.pragma('synchronous=OFF');
		this.db.pragma(`max_page_count=${COMPARISON_LIMITS.maxBytes / 4096}`);
		this.db
			.exec(`CREATE TABLE entries(path TEXT PRIMARY KEY,parent TEXT,name TEXT,type TEXT,size INTEGER,modifiedAt TEXT,change TEXT) WITHOUT ROWID;
			CREATE INDEX children ON entries(parent,change,name); CREATE INDEX changes ON entries(change,path);
			CREATE TABLE observed(path TEXT PRIMARY KEY,modifier TEXT) WITHOUT ROWID;`);
	}
	async populate(
		current: ManagedSnapshotIndex,
		previous: ManagedSnapshotIndex,
		diff: (consume: (record: SnapshotDiffRecord) => void) => Promise<void>,
		signal: AbortSignal
	) {
		this.phase = 'indexing';
		this.currentEntries = current.count;
		this.totalEntries = current.count + previous.count;
		const insert = this.db.prepare(
			"INSERT INTO entries VALUES(?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET change='unchanged'"
		);
		for (const [index, change] of [
			[current, 'added'],
			[previous, 'deleted'],
		] as const) {
			let batch: unknown[][] = [];
			const flush = this.db.transaction(() => {
				for (const row of batch) insert.run(...row);
			});
			for (const file of index) {
				signal.throwIfAborted();
				if (++this.processedEntries > COMPARISON_LIMITS.maxEntries)
					throw new AppError(413, 'Snapshot comparison entry limit reached.');
				batch.push([
					file.path,
					file.path.slice(0, file.path.lastIndexOf('/')),
					file.name,
					file.type,
					file.size,
					file.modifiedAt,
					change,
				]);
				if (batch.length === 512) {
					flush();
					batch = [];
					await new Promise<void>(resolve => setImmediate(resolve));
				}
			}
			flush();
		}
		this.phase = 'comparing';
		const record = this.db.prepare('INSERT INTO observed VALUES(?,?)');
		const findRow = this.db.prepare('SELECT change,type FROM entries WHERE path=?');
		const findObserved = this.db.prepare('SELECT 1 FROM observed WHERE path=?');
		const modify = this.db.prepare("UPDATE entries SET change='modified' WHERE path=?");
		let summary = false,
			changes = 0;
		await diff(value => {
			signal.throwIfAborted();
			if (summary) throw new AppError(422, 'Incomplete or ambiguous snapshot comparison.');
			if (value.message_type === 'statistics') {
				if (
					value.source_snapshot !== this.binding.previousSnapshotId ||
					value.target_snapshot !== this.binding.currentSnapshotId
				)
					throw new AppError(409, 'Snapshot comparison identity mismatch.');
				summary = true;
				return;
			}
			// restic diff decorates directory paths with one trailing slash,
			// unlike restic ls. Remove it only with indexed directory evidence;
			// the canonical path policy remains unchanged for API/restore inputs.
			const exactPath = value.path.endsWith('/') ? value.path.slice(0, -1) : value.path;
			managedSnapshotPath(exactPath);
			if (++changes > COMPARISON_LIMITS.maxEntries || !/^[+\-TMU]+$/.test(value.modifier))
				throw new AppError(422, 'Unsupported snapshot comparison evidence.');
			const row = findRow.get(exactPath) as { change: string; type: string } | undefined;
			if (
				value.path.endsWith('/') &&
				row?.type !== 'dir' &&
				previous.get?.(exactPath)?.type !== 'dir'
			)
				throw new AppError(422, 'Directory comparison evidence does not match indexed metadata.');
			if (
				!row ||
				(value.modifier === '+' && row.change !== 'added') ||
				(value.modifier === '-' && row.change !== 'deleted')
			)
				throw new AppError(422, 'Snapshot comparison disagrees with indexed paths.');
			// Type changes may contain both +/- in one modifier. Never turn the
			// current object into a historical restore target.
			if (findObserved.get(exactPath))
				throw new AppError(422, 'Duplicate snapshot comparison evidence.');
			record.run(exactPath, value.modifier);
			if (row.change === 'unchanged') modify.run(exactPath);
		});
		if (
			!summary ||
			this.db
				.prepare(
					"SELECT 1 FROM entries e WHERE change IN ('added','deleted') AND NOT EXISTS(SELECT 1 FROM observed o WHERE o.path=e.path) LIMIT 1"
				)
				.get()
		)
			throw new AppError(422, 'Incomplete snapshot comparison evidence.');
		this.phase = 'ready';
	}
	page(query: ComparisonQuery) {
		if (this.phase !== 'ready') throw new AppError(409, 'Snapshot comparison is not ready.');
		const offset = query.offset || 0,
			limit = query.limit || 200,
			directory = query.path || '';
		if (
			!Number.isInteger(offset) ||
			offset < 0 ||
			offset > COMPARISON_LIMITS.maxEntries ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 200 ||
			(query.search?.length || 0) > 128 ||
			(query.change && !['added', 'modified', 'unchanged', 'deleted'].includes(query.change)) ||
			(query.sort && !['name', 'size', 'modifiedAt'].includes(query.sort)) ||
			(query.order && !['asc', 'desc'].includes(query.order))
		)
			throw new AppError(400, 'Invalid comparison page.');
		if (directory) managedSnapshotPath(directory);
		const where = [
			query.recursive ? '1=1' : 'parent=?',
			'instr(lower(name),lower(?))>0',
			...(query.change ? ['change=?'] : ["change!='deleted'"]),
		].join(' AND ');
		const args = [
			...(query.recursive ? [] : [directory]),
			query.search || '',
			...(query.change ? [query.change] : []),
		];
		const total = (
			this.db.prepare(`SELECT count(*) AS n FROM entries WHERE ${where}`).get(...args) as {
				n: number;
			}
		).n;
		const sort =
			query.sort === 'size'
				? 'size'
				: query.sort === 'modifiedAt'
					? 'julianday(modifiedAt)'
					: 'name COLLATE NOCASE';
		const rows = this.db
			.prepare(
				`SELECT * FROM entries WHERE ${where} ORDER BY (type='dir') DESC,${sort} ${query.order === 'desc' ? 'DESC' : 'ASC'},path LIMIT ? OFFSET ?`
			)
			.all(...args, limit, offset) as Row[];
		return {
			status: 'ready' as const,
			entries: this.currentEntries,
			...this.binding,
			total,
			offset,
			limit,
			nextOffset: offset + rows.length < total ? offset + rows.length : null,
			files: rows.map(row => ({
				...row,
				isDirectory: row.type === 'dir',
				isAvailable: row.change !== 'deleted',
				srcPath: row.path,
				owner: '',
				permissions: '',
				snapshotId:
					row.change === 'deleted'
						? this.binding.previousSnapshotId
						: this.binding.currentSnapshotId,
				backupId:
					row.change === 'deleted' ? this.binding.previousBackupId : this.binding.currentBackupId,
			})),
		};
	}
	summary() {
		if (this.phase !== 'ready') return undefined;
		const counts = Object.fromEntries(
			(
				this.db
					.prepare("SELECT change,count(*) AS n FROM entries WHERE type='file' GROUP BY change")
					.all() as { change: string; n: number }[]
			).map(row => [row.change, row.n])
		);
		const bytes = (change: string) =>
			(
				this.db
					.prepare("SELECT coalesce(sum(size),0) AS n FROM entries WHERE type='file' AND change=?")
					.get(change) as { n: number }
			).n;
		return {
			added: counts.added || 0,
			modified: counts.modified || 0,
			unchanged: counts.unchanged || 0,
			deleted: counts.deleted || 0,
			addedLogicalBytes: bytes('added'),
			removedLogicalBytes: bytes('deleted'),
		};
	}
	close() {
		this.db.close();
	}
}

type Job = {
	binding: ComparisonBinding;
	state: 'preparing' | 'failed' | 'cancelled' | 'ready';
	started: number;
	updated: number;
	controller: AbortController;
	done: Promise<void>;
	index?: SnapshotComparison;
	directory?: string;
	reason?: string;
	failureCode?: string;
};
export class SnapshotComparisonCache {
	private jobs = new Map<string, Job>();
	private closed = false;
	private admission: Promise<unknown> = Promise.resolve();
	private initialized?: Promise<void>;
	private readonly timer: ReturnType<typeof setInterval>;
	constructor(private readonly root: string) {
		this.timer = setInterval(() => {
			this.admission = this.admission
				.then(async () => {
					for (const [key, job] of this.jobs)
						if (job.state !== 'preparing' && Date.now() - job.updated > COMPARISON_LIMITS.ttlMs)
							await this.remove(key, job);
				})
				.catch(() => undefined);
		}, 60_000);
		this.timer.unref();
	}
	private initialize() {
		return (this.initialized ||= (async () => {
			await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
			const stat = await fs.lstat(this.root);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
			const entries = await fs.readdir(this.root, { withFileTypes: true });
			if (entries.length > 16) throw new Error();
			for (const entry of entries) {
				if (
					!/^compare-[A-Za-z0-9]{6}$/.test(entry.name) ||
					!entry.isDirectory() ||
					entry.isSymbolicLink()
				)
					throw new Error();
				await fs.rm(path.join(this.root, entry.name), { recursive: true, force: true });
			}
		})());
	}
	status(key: string) {
		const job = this.jobs.get(key);
		if (!job || Date.now() - job.updated > COMPARISON_LIMITS.ttlMs)
			return { state: 'missing' as const };
		return {
			...job.binding,
			state: job.state,
			phase: job.state === 'preparing' ? job.index?.phase || 'preparing' : job.state,
			processedEntries: job.index?.processedEntries || 0,
			totalEntries: job.index?.totalEntries || undefined,
			elapsedMs: Math.max(0, (job.state === 'preparing' ? Date.now() : job.updated) - job.started),
			summary: job.state === 'ready' ? job.index?.summary() : undefined,
			reason: job.reason,
			failureCode: job.failureCode,
			retryAfterMs: 2000,
		};
	}
	start(
		key: string,
		binding: ComparisonBinding,
		populate: (index: SnapshotComparison, signal: AbortSignal) => Promise<void>,
		retry = false
	) {
		const result = this.admission.then(() => this.admit(key, binding, populate, retry));
		this.admission = result.catch(() => undefined);
		return result;
	}
	private async admit(
		key: string,
		binding: ComparisonBinding,
		populate: (index: SnapshotComparison, signal: AbortSignal) => Promise<void>,
		retry = false
	) {
		if (this.closed) throw new AppError(503, 'Snapshot comparisons are unavailable.');
		const old = this.jobs.get(key);
		if (
			old &&
			Date.now() - old.updated < COMPARISON_LIMITS.ttlMs &&
			!(retry && ['failed', 'cancelled'].includes(old.state))
		)
			return this.status(key);
		if ([...this.jobs.values()].some(j => j.state === 'preparing'))
			throw new AppError(429, 'Another snapshot comparison is running. Retry shortly.');
		if (old) await this.remove(key, old);
		for (const [id, job] of this.jobs)
			if (Date.now() - job.updated > COMPARISON_LIMITS.ttlMs) await this.remove(id, job);
		if (this.jobs.size >= COMPARISON_LIMITS.maxJobs) {
			const [id, job] = this.jobs.entries().next().value!;
			await this.remove(id, job);
		}
		const controller = new AbortController();
		const job: Job = {
			binding,
			state: 'preparing',
			started: Date.now(),
			updated: Date.now(),
			controller,
			done: Promise.resolve(),
		};
		this.jobs.set(key, job);
		job.done = (async () => {
			try {
				await this.initialize();
				const capacity = await fs.statfs(this.root);
				if (capacity.bavail * capacity.bsize < 160 * 1024 ** 2)
					throw new AppError(507, 'Insufficient comparison cache space.');
				job.directory = await fs.mkdtemp(path.join(this.root, 'compare-'));
				const file = path.join(job.directory, 'metadata.sqlite');
				await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
				job.index = new SnapshotComparison(file, binding);
				await populate(
					job.index,
					AbortSignal.any([controller.signal, AbortSignal.timeout(COMPARISON_LIMITS.deadlineMs)])
				);
				controller.signal.throwIfAborted();
				job.state = 'ready';
			} catch (error) {
				job.state = controller.signal.aborted ? 'cancelled' : 'failed';
				job.failureCode = `${job.index?.phase || 'preparing'}-${error instanceof AppError ? error.statusCode : error instanceof Error && error.name === 'SqliteError' ? 'sqlite' : 'unavailable'}`;
				job.reason =
					'Comparison unavailable; ordinary browsing remains available. Retry comparison.';
			} finally {
				job.updated = Date.now();
			}
		})();
		return this.status(key);
	}
	page(key: string, query: ComparisonQuery) {
		const job = this.jobs.get(key);
		if (!job || job.state !== 'ready' || Date.now() - job.updated > COMPARISON_LIMITS.ttlMs)
			throw new AppError(409, 'Snapshot comparison expired or unavailable.');
		return job.index!.page(query);
	}
	async cancel(key: string) {
		const job = this.jobs.get(key);
		if (job?.state === 'preparing') {
			job.controller.abort();
			await job.done;
		}
		return this.status(key);
	}
	private async remove(key: string, job: Job) {
		job.controller.abort();
		await job.done;
		job.index?.close();
		if (job.directory) await fs.rm(job.directory, { recursive: true, force: true });
		this.jobs.delete(key);
	}
	async close() {
		this.closed = true;
		clearInterval(this.timer);
		await this.admission;
		for (const [key, job] of this.jobs) await this.remove(key, job);
	}
}
