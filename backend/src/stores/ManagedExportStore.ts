import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
	EXPORT_LIMITS,
	TemporaryExportError,
	activeExport,
	bindingDigest,
	type ExportBinding,
	type ExportConfig,
	type ExportJob,
} from '../utils/managedExport/ExportPolicy';

/** Private durable METADATA only. No archive, credential, presigned URL or SQL content. */
export class ManagedExportStore {
	readonly db: Database.Database;
	private readonly ownership: Database.Database;
	constructor(file: string) {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const stat = fs.lstatSync(path.dirname(file));
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new TemporaryExportError('configuration-invalid');
		if (!fs.existsSync(file)) {
			fs.closeSync(fs.openSync(file, 'wx', 0o600));
		}
		if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
			throw new TemporaryExportError('configuration-invalid');
		const lock = file + '.owner';
		if (!fs.existsSync(lock)) fs.closeSync(fs.openSync(lock, 'wx', 0o600));
		if (!fs.lstatSync(lock).isFile() || fs.lstatSync(lock).isSymbolicLink())
			throw new TemporaryExportError('configuration-invalid');
		fs.chmodSync(lock, 0o600);
		this.ownership = new Database(lock, { timeout: 0 });
		try {
			this.ownership.exec('BEGIN EXCLUSIVE');
		} catch {
			this.ownership.close();
			throw new TemporaryExportError('queue-full');
		}
		let opened: Database.Database | undefined;
		try {
			fs.chmodSync(file, 0o600);
			this.db = opened = new Database(file);
			this.db.pragma('journal_mode=DELETE');
			this.db.pragma('synchronous=FULL');
			this.db.pragma('max_page_count=2048');
			this.db.pragma('cache_size=-2048');
			this.db.exec(
				'CREATE TABLE IF NOT EXISTS temporary_exports(id TEXT PRIMARY KEY, job TEXT NOT NULL) WITHOUT ROWID'
			);
		} catch {
			opened?.close();
			this.ownership.close();
			throw new TemporaryExportError('configuration-invalid');
		}
	}
	all(): ExportJob[] {
		return (
			this.db
				.prepare("SELECT job FROM temporary_exports ORDER BY json_extract(job,'$.createdAt'),id")
				.all() as { job: string }[]
		).map(r => JSON.parse(r.job));
	}
	get(id: string): ExportJob | undefined {
		const r = this.db.prepare('SELECT job FROM temporary_exports WHERE id=?').get(id) as
			| { job: string }
			| undefined;
		return r && JSON.parse(r.job);
	}
	save(job: ExportJob) {
		if (Buffer.byteLength(JSON.stringify(job)) > 32 * 1024)
			throw new TemporaryExportError('quota-exceeded');
		this.db
			.prepare('INSERT OR REPLACE INTO temporary_exports VALUES (?,?)')
			.run(job.id, JSON.stringify(job));
	}
	update(id: string, fields: Partial<ExportJob>): ExportJob {
		const j = this.get(id);
		if (!j) throw new TemporaryExportError('binding-changed');
		Object.assign(j, fields, { updatedAt: Date.now() });
		this.save(j);
		return j;
	}
	admit(owner: string, binding: ExportBinding, config: ExportConfig): ExportJob {
		return this.db.transaction(() => {
			const jobs = this.all();
			const existing = jobs.find(
				j =>
					j.owner === owner &&
					j.destination === config.fingerprint &&
					bindingDigest(j.binding) === bindingDigest(binding) &&
					(activeExport(j.state) || (j.state === 'ready' && (j.expiresAt || 0) > Date.now()))
			);
			if (existing) return existing;
			if (jobs.filter(j => activeExport(j.state)).length >= EXPORT_LIMITS.maxAdmitted)
				throw new TemporaryExportError('queue-full');
			if (jobs.filter(j => !j.cleaned).length >= EXPORT_LIMITS.maxObjects)
				throw new TemporaryExportError('quota-exceeded');
			if (jobs.length >= EXPORT_LIMITS.maxJobs) {
				const old = jobs.find(j => j.cleaned && !activeExport(j.state));
				if (!old) throw new TemporaryExportError('quota-exceeded');
				this.db.prepare('DELETE FROM temporary_exports WHERE id=?').run(old.id);
			}
			const id = crypto.randomUUID();
			const now = Date.now();
			const job: ExportJob = {
				id,
				owner,
				binding,
				destination: config.fingerprint,
				key: `${config.prefix}/${id}.tar`,
				state: 'queued',
				createdAt: now,
				updatedAt: now,
				uploadedBytes: 0,
				processedBytes: 0,
				reservedBytes: 0,
				cleaned: false,
				cleanupAttempts: 0,
			};
			this.save(job);
			return job;
		})();
	}
	reserve(id: string, bytes: number) {
		if (
			!Number.isSafeInteger(bytes) ||
			bytes < 1024 ||
			bytes > EXPORT_LIMITS.maxObjectBytes ||
			this.all()
				.filter(j => j.id !== id && !j.cleaned)
				.reduce((n, j) => n + j.reservedBytes, 0) +
				bytes >
				EXPORT_LIMITS.quotaBytes
		)
			throw new TemporaryExportError('quota-exceeded');
		return this.update(id, { reservedBytes: bytes });
	}
	close() {
		this.db.close();
		this.ownership.close();
	}
}
