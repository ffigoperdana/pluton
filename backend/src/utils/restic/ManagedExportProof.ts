import crypto from 'crypto';
import type Database from 'better-sqlite3';
import {
	ManagedExportError,
	assertManagedLinkGraph,
	exportIncludes,
	type ManagedExportBinding,
	type ManagedExportCounts,
	type ManagedExportEntry,
	type ManagedExportMode,
	type ManagedExportSummary,
} from './ManagedExportPolicy';

/** Metadata only, in a capped private SQLite sidecar owned by the index.
 * It shares the index's generation, leases and eviction/restart lifetime.
 * There is no TAR staging file or unbounded in-memory path/hash inventory. */
export class ManagedExportProof {
	private readonly pending = new Map<string, string>();
	private pendingBytes = 0;
	private readonly cursors = new Map<string, Set<string>>();
	private readonly entryQuery: Database.Statement;
	private readonly seenQuery: Database.Statement;
	constructor(
		private readonly db: Database.Database,
		readonly binding: ManagedExportBinding,
		readonly mode: ManagedExportMode,
		readonly counts: ManagedExportCounts
	) {
		this.binding = {
			backupId: binding.backupId,
			repositoryId: binding.repositoryId,
			snapshotId: binding.snapshotId,
		};
		db.exec(`CREATE TABLE IF NOT EXISTS export_entries(
			path TEXT PRIMARY KEY, entry TEXT NOT NULL) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS export_proofs(mode TEXT PRIMARY KEY, summary TEXT NOT NULL) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS export_seen(cursor TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(cursor,path)) WITHOUT ROWID;`);
		this.entryQuery = db.prepare('SELECT entry FROM export_entries WHERE path=?');
		this.seenQuery = db.prepare('SELECT 1 FROM export_seen WHERE cursor=? AND path=?');
	}
	get summary(): ManagedExportSummary | undefined {
		const row = this.db.prepare('SELECT summary FROM export_proofs WHERE mode=?').get(this.mode) as
			| { summary: string }
			| undefined;
		if (!row) return;
		const value = JSON.parse(row.summary) as ManagedExportSummary;
		return JSON.stringify(value.binding) === JSON.stringify(this.binding) ? value : undefined;
	}
	reset() {
		if (this.summary) throw new ManagedExportError('export-proof-missing'); // completed proofs are immutable
		this.db.prepare('DELETE FROM export_proofs WHERE mode=?').run(this.mode);
		// Common immutable file metadata is shared between modes. It is not an
		// authorization proof: each mode still needs its own complete stream scan.
	}
	createCursor() {
		const cursor = crypto.randomBytes(12).toString('hex');
		this.cursors.set(cursor, new Set());
		return cursor;
	}
	seen(cursor: string, filePath: string) {
		const pending = this.cursors.get(cursor)!;
		if (pending.has(filePath) || this.seenQuery.get(cursor, filePath))
			throw new ManagedExportError('archive-entry-mismatch');
		pending.add(filePath);
		if (pending.size >= 256) this.flush();
	}
	releaseCursor(cursor: string) {
		this.cursors.delete(cursor);
		this.db.prepare('DELETE FROM export_seen WHERE cursor=?').run(cursor);
	}
	/** Batch a fixed maximum of 256 rows. Transactions are entirely synchronous:
	 * none spans an await or rolls back another stream's duplicate-path cursor. */
	flush() {
		try {
			const insertEntry = this.db.prepare('INSERT INTO export_entries VALUES(?,?)');
			const insertSeen = this.db.prepare('INSERT INTO export_seen VALUES(?,?)');
			this.db.transaction(() => {
				for (const [filePath, entry] of this.pending) insertEntry.run(filePath, entry);
				for (const [cursor, paths] of this.cursors)
					for (const filePath of paths) insertSeen.run(cursor, filePath);
			})();
			this.pending.clear();
			this.pendingBytes = 0;
			for (const paths of this.cursors.values()) paths.clear();
		} catch (error) {
			throw new ManagedExportError(
				(error as { code?: string }).code === 'SQLITE_FULL'
					? 'export-resource-limit'
					: 'archive-entry-mismatch'
			);
		}
	}
	get(filePath: string): ManagedExportEntry | undefined {
		const row =
			this.pending.get(filePath) ??
			(this.entryQuery.get(filePath) as { entry: string } | undefined)?.entry;
		const entry = row && ({ ...JSON.parse(row), path: filePath } as ManagedExportEntry);
		return entry && exportIncludes(this.mode, entry.type) ? entry : undefined;
	}
	append(entry: ManagedExportEntry) {
		const encoded = JSON.stringify({ ...entry, path: undefined });
		const existing =
			this.pending.get(entry.path) ??
			(this.entryQuery.get(entry.path) as { entry: string } | undefined)?.entry;
		if (existing) {
			if (existing !== encoded) throw new ManagedExportError('archive-content-mismatch');
			return;
		}
		this.pending.set(entry.path, encoded);
		this.pendingBytes += Buffer.byteLength(encoded);
		if (this.pending.size >= 256 || this.pendingBytes >= 1024 * 1024) this.flush();
	}
	*entries(): IterableIterator<ManagedExportEntry> {
		this.flush();
		for (const row of this.db
			.prepare('SELECT path,entry FROM export_entries ORDER BY path')
			.iterate()) {
			const value = row as { path: string; entry: string };
			const entry = { ...JSON.parse(value.entry), path: value.path } as ManagedExportEntry;
			if (exportIncludes(this.mode, entry.type)) yield entry;
		}
	}
	*manifestLines(): IterableIterator<string> {
		yield JSON.stringify({ version: 1, binding: this.binding, mode: this.mode }) + '\n';
		for (const entry of this.entries()) yield JSON.stringify(entry) + '\n';
		const { includedByType, excludedByType } = this.selectionCounts();
		yield JSON.stringify({ includedByType, excludedByType }) + '\n';
	}
	private selectionCounts() {
		const includedByType: ManagedExportCounts = {},
			excludedByType: ManagedExportCounts = {};
		for (const type of Object.keys(this.counts).sort())
			(exportIncludes(this.mode, type) ? includedByType : excludedByType)[type] = this.counts[type];
		return { includedByType, excludedByType };
	}
	validateCompleteness() {
		const measured: ManagedExportCounts = {};
		for (const entry of this.entries()) {
			measured[entry.type] = (measured[entry.type] || 0) + 1;
			if (entry.type === 'symlink') assertManagedLinkGraph(entry, value => this.get(value));
		}
		for (const [type, n] of Object.entries(this.selectionCounts().includedByType))
			if ((measured[type] || 0) !== n) throw new ManagedExportError('archive-incomplete');
	}
	finish(archiveSha256: string, archiveBytes: number): ManagedExportSummary {
		this.validateCompleteness();
		const hash = crypto.createHash('sha256');
		for (const line of this.manifestLines()) hash.update(line);
		const { includedByType, excludedByType } = this.selectionCounts();
		const summary: ManagedExportSummary = {
			version: 1,
			binding: this.binding,
			mode: this.mode,
			includedEntries: Object.values(includedByType).reduce((a, b) => a + b, 0),
			excludedEntries: Object.values(excludedByType).reduce((a, b) => a + b, 0),
			includedByType,
			excludedByType,
			manifestSha256: hash.digest('hex'),
			archiveSha256,
			archiveBytes,
		};
		try {
			this.db
				.prepare('INSERT OR REPLACE INTO export_proofs VALUES(?,?)')
				.run(this.mode, JSON.stringify(summary));
		} catch {
			throw new ManagedExportError('export-resource-limit');
		}
		return summary;
	}
}
