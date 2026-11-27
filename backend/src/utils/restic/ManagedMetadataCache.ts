import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { ManagedSftpAccess } from './ManagedSftpRepositorySession';

/**
 * Persistent Restic cache for reads of managed repositories (Browse, downloads and
 * restores; docs/MANAGED_SNAPSHOT_STREAMING.md "Restic metadata cache").
 *
 * Without a cache, `restic ls` of a large snapshot fetches every tree blob with its
 * own ranged read and downloads the whole index again on every attempt. Restic caches
 * only index, snapshot and tree-pack files, encrypted and authenticated with the
 * repository key; data packs are never cached, and Restic falls back to the backend
 * when a cache write fails. Reads keep `--no-lock`, so nothing is written to the
 * repository.
 */
export const MANAGED_METADATA_CACHE_LIMITS = Object.freeze({
	/** Free space the cache filesystem must keep; below it the session runs with `--no-cache`. */
	minFreeBytes: 2 * 1024 ** 3,
	/** A binding directory unused this long is removed. */
	staleMs: 30 * 24 * 60 * 60_000,
	/** Sibling directories are checked for staleness at most this often. */
	pruneIntervalMs: 60 * 60_000,
});

const SECRET_OPTION = /pass|secret|key|token/i;
const BINDING_DIRECTORY = /^[a-f0-9]{64}$/;

/**
 * One directory per repository binding (storage options without credentials, plus the
 * repository path), so two repositories never share cache files, even with a forged
 * Restic repository ID. Rotated credentials keep the same directory.
 */
export function managedMetadataCacheKey(access: ManagedSftpAccess): string {
	const options = Object.entries(access.options)
		.filter(([key]) => !SECRET_OPTION.test(key))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return crypto
		.createHash('sha256')
		.update(JSON.stringify(['pluton-managed-restic-cache-v1', access.repositoryPath, options]))
		.digest('hex');
}

export class ManagedMetadataCache {
	private lastPrune = -Infinity;

	constructor(
		private readonly root: string,
		private readonly limits: typeof MANAGED_METADATA_CACHE_LIMITS = MANAGED_METADATA_CACHE_LIMITS,
		private readonly now: () => number = () => Date.now()
	) {}

	/**
	 * The binding's private cache directory, or undefined when it cannot be used (low
	 * disk, unexpected file type, any filesystem error). The caller then passes
	 * `--no-cache`: slower, never less safe.
	 */
	async directory(access: ManagedSftpAccess): Promise<string | undefined> {
		try {
			await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
			const disk = await fs.statfs(this.root);
			if (disk.bavail * disk.bsize < this.limits.minFreeBytes) return undefined;
			const directory = path.join(this.root, managedMetadataCacheKey(access));
			try {
				await fs.mkdir(directory, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}
			// Never follow a link planted in place of the binding directory.
			if (!(await fs.lstat(directory)).isDirectory()) return undefined;
			const touched = new Date(this.now());
			await fs.utimes(directory, touched, touched);
			await this.prune(directory);
			return directory;
		} catch {
			return undefined;
		}
	}

	/** Removes binding directories unused for `staleMs`; only names this cache creates. */
	private async prune(keep: string) {
		const now = this.now();
		if (now - this.lastPrune < this.limits.pruneIntervalMs) return;
		this.lastPrune = now;
		for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
			const directory = path.join(this.root, entry.name);
			if (!entry.isDirectory() || !BINDING_DIRECTORY.test(entry.name) || directory === keep) continue;
			try {
				if (now - (await fs.lstat(directory)).mtimeMs >= this.limits.staleMs)
					await fs.rm(directory, { recursive: true, force: true });
			} catch {
				/* A directory in use by another session is retried at the next prune. */
			}
		}
	}
}
