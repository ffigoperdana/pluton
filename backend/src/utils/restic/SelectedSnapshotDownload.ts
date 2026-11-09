import path from 'path';
import { Writable } from 'stream';
import { finished } from 'stream/promises';
import Database from 'better-sqlite3';
import type { ManagedSnapshotIndex } from './ManagedSnapshotIndex';
import type { ManagedRepositorySession } from './ManagedSftpRepositorySession';
import type { ManagedExportBinding, ManagedExportCounts } from './ManagedExportPolicy';
import { ManagedExportError, MANAGED_EXPORT_LIMITS } from './ManagedExportPolicy';
import { ManagedExportProof } from './ManagedExportProof';
import { streamSelectedManagedArchive } from './ManagedTarExport';
import { managedSnapshotPath } from '../managedSnapshotPath';
import { AppError } from '../AppError';

export type SelectedDownloadHeaders = { fileName: string; contentType: string; length?: number };
/** No repository writes, staging restore or archive buffer. The caller holds the exact index lease. */
export async function streamSelectedSnapshot(
	index: ManagedSnapshotIndex,
	session: ManagedRepositorySession,
	binding: ManagedExportBinding,
	selected: string,
	output: Writable,
	signal: AbortSignal,
	headers: (value: SelectedDownloadHeaders) => void,
	headOnly = false
) {
	signal.throwIfAborted();
	managedSnapshotPath(selected);
	const item = index.get(selected);
	if (!item) throw new AppError(404, 'Selected snapshot item not found.');
	if (!['file', 'dir'].includes(item.type))
		throw new AppError(
			409,
			'Download a regular file or directory. Symbolic links cannot be followed.'
		);
	if (!session.dump) throw new AppError(501, 'Selected snapshot downloads are unavailable.');
	const name =
		path.posix
			.basename(selected)
			.replace(/[^A-Za-z0-9._-]/g, '_')
			.slice(0, 100) || 'snapshot';
	if (item.type === 'file') {
		headers({ fileName: name, contentType: 'application/octet-stream', length: item.size });
		if (headOnly) return;
		let bytes = 0;
		const sink = new Writable({
			write(chunk: Buffer, _encoding, done) {
				bytes += chunk.length;
				if (!Number.isSafeInteger(bytes) || bytes > item.size)
					return done(new ManagedExportError('archive-entry-mismatch'));
				output.write(chunk, done);
			},
		});
		sink.on('error', () => undefined);
		try {
			await session.dump(binding.snapshotId, selected, sink);
			sink.end();
			await finished(sink);
			signal.throwIfAborted();
			if (bytes !== item.size) throw new ManagedExportError('archive-incomplete');
		} finally {
			sink.destroy();
		}
		return;
	}
	const within = (value: string) => value.startsWith(selected + '/');
	const counts: ManagedExportCounts = {};
	let n = 0;
	for (const entry of index) {
		signal.throwIfAborted();
		if (within(entry.path)) counts[entry.type] = (counts[entry.type] || 0) + 1;
		if (++n % 512 === 0) await new Promise<void>(resolve => setImmediate(resolve));
	}
	const view = {
		get: (value: string) => (within(value) ? index.get(value) : undefined),
		assertExportEntries: () => {
			if (Object.keys(counts).some(type => !['file', 'dir', 'symlink'].includes(type)))
				throw new ManagedExportError('unsupported-node-type');
		},
	};
	view.assertExportEntries();
	headers({ fileName: name + '.tar', contentType: 'application/x-tar' });
	if (headOnly) return;
	// SQLite temporary database is deleted on close/crash; metadata only, capped
	// exactly like existing proof sidecars. No TAR or plaintext is written to disk.
	const db = new Database('');
	try {
		db.pragma('cache_size=-2048');
		db.pragma('temp_store=FILE');
		db.pragma('journal_mode=MEMORY');
		db.pragma('synchronous=OFF');
		db.pragma('max_page_count=' + MANAGED_EXPORT_LIMITS.maxProofBytes / 4096);
		const proof = new ManagedExportProof(db, binding, 'full', counts);
		await streamSelectedManagedArchive(
			view,
			{ ...session, archive: (id, sink) => session.dump!(id, selected, sink) },
			proof,
			output,
			signal
		);
	} finally {
		db.close();
	}
}
