import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
	MANAGED_METADATA_CACHE_LIMITS,
	ManagedMetadataCache,
	managedMetadataCacheKey,
} from '../../../src/utils/restic/ManagedMetadataCache';

const sftp = {
	options: {
		host: '192.0.2.10',
		port: '22',
		user: 'fixture-user',
		pass: 'synthetic-sftp-password',
	},
	repositoryPath: 'repositories/app-01',
	password: 'synthetic-repository-password',
};
const s3 = {
	options: {
		type: 's3',
		provider: 'Other',
		endpoint: 'https://s3.example.internal',
		access_key_id: 'synthetic-access-key',
		secret_access_key: 'synthetic-secret-key',
		session_token: 'synthetic-session-token',
		force_path_style: 'true',
	},
	repositoryPath: 'bucket-01/repositories/app-01',
	password: 'synthetic-repository-password',
};

describe('ManagedMetadataCache', () => {
	let root: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'pluton-metadata-cache-'));
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it('keys a directory by repository binding without credentials', () => {
		const key = managedMetadataCacheKey(sftp);
		expect(key).toMatch(/^[a-f0-9]{64}$/);
		// Rotated SFTP or S3 credentials and repository passwords keep the cache.
		expect(
			managedMetadataCacheKey({
				...sftp,
				password: 'rotated-repository-password',
				options: { ...sftp.options, pass: 'rotated-sftp-password' },
			})
		).toBe(key);
		expect(
			managedMetadataCacheKey({
				...s3,
				options: {
					...s3.options,
					access_key_id: 'other',
					secret_access_key: 'other',
					session_token: 'x',
				},
			})
		).toBe(managedMetadataCacheKey(s3));
		// Another repository, host or endpoint never shares it.
		expect(managedMetadataCacheKey({ ...sftp, repositoryPath: 'repositories/app-02' })).not.toBe(
			key
		);
		expect(
			managedMetadataCacheKey({ ...sftp, options: { ...sftp.options, host: '192.0.2.11' } })
		).not.toBe(key);
		expect(
			managedMetadataCacheKey({
				...s3,
				options: { ...s3.options, endpoint: 'https://s3-b.example.internal' },
			})
		).not.toBe(managedMetadataCacheKey(s3));
		// Option order does not matter.
		expect(
			managedMetadataCacheKey({
				...sftp,
				options: { user: 'fixture-user', pass: 'x', port: '22', host: '192.0.2.10' },
			})
		).toBe(key);
	});

	it('creates one private directory per binding and reuses it', async () => {
		const cache = new ManagedMetadataCache(path.join(root, 'managed-restic'));
		const directory = await cache.directory(sftp);
		expect(directory).toBe(path.join(root, 'managed-restic', managedMetadataCacheKey(sftp)));
		expect((await fs.stat(directory!)).isDirectory()).toBe(true);
		if (process.platform !== 'win32') {
			expect((await fs.stat(directory!)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(root, 'managed-restic'))).mode & 0o777).toBe(0o700);
		}
		await fs.writeFile(path.join(directory!, 'kept'), 'cached');
		expect(await cache.directory(sftp)).toBe(directory);
		expect(await fs.readFile(path.join(directory!, 'kept'), 'utf8')).toBe('cached');
		expect(await cache.directory(s3)).not.toBe(directory);
	});

	it('falls back to no cache when the filesystem is short of space, and reports it', async () => {
		const report = jest.fn();
		const cache = new ManagedMetadataCache(
			root,
			{ ...MANAGED_METADATA_CACHE_LIMITS, minFreeBytes: Number.MAX_SAFE_INTEGER },
			undefined,
			report
		);
		await expect(cache.directory(sftp)).resolves.toBeUndefined();
		expect(await fs.readdir(root)).toEqual([]);
		expect(report).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenCalledWith({
			event: 'managed_restic_cache',
			stage: 'unavailable',
			reason: 'disk-capacity',
			availableBytes: expect.any(Number),
		});
	});

	it('refuses a file planted in place of the binding directory, and reports it', async () => {
		const report = jest.fn();
		await fs.writeFile(path.join(root, managedMetadataCacheKey(sftp)), 'not a directory');
		await expect(
			new ManagedMetadataCache(root, undefined, undefined, report).directory(sftp)
		).resolves.toBeUndefined();
		expect(report).toHaveBeenCalledWith({
			event: 'managed_restic_cache',
			stage: 'unavailable',
			reason: 'not-directory',
		});
	});

	it('reports a filesystem failure with only its errno code', async () => {
		// A file where the cache root should be: mkdir fails.
		const blocked = path.join(root, 'blocked-root');
		await fs.writeFile(blocked, 'not a directory');
		const report = jest.fn();
		await expect(
			new ManagedMetadataCache(blocked, undefined, undefined, report).directory(sftp)
		).resolves.toBeUndefined();
		expect(report).toHaveBeenCalledTimes(1);
		const [record] = report.mock.calls[0];
		expect(record).toEqual({
			event: 'managed_restic_cache',
			stage: 'unavailable',
			reason: 'filesystem',
			code: expect.stringMatching(/^E[A-Z]+$/),
		});
		// No path, binding or credential reaches the log record.
		const text = JSON.stringify(record);
		for (const secret of [root, managedMetadataCacheKey(sftp), sftp.password, sftp.options.pass])
			expect(text).not.toContain(secret);
	});

	it('still falls back when the report itself throws', async () => {
		const cache = new ManagedMetadataCache(
			root,
			{ ...MANAGED_METADATA_CACHE_LIMITS, minFreeBytes: Number.MAX_SAFE_INTEGER },
			undefined,
			() => {
				throw new Error('logger down');
			}
		);
		await expect(cache.directory(sftp)).resolves.toBeUndefined();
	});

	it('removes only stale binding directories it created, at most once per interval', async () => {
		let now = Date.now();
		const cache = new ManagedMetadataCache(root, MANAGED_METADATA_CACHE_LIMITS, () => now);
		const stale = path.join(root, 'c'.repeat(64));
		const fresh = path.join(root, 'd'.repeat(64));
		const foreign = path.join(root, 'operator-notes');
		for (const directory of [stale, fresh, foreign]) await fs.mkdir(directory);
		const old = new Date(now - MANAGED_METADATA_CACHE_LIMITS.staleMs - 1000);
		await fs.utimes(stale, old, old);
		await fs.utimes(foreign, old, old);
		const own = await cache.directory(sftp);
		await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
		expect((await fs.stat(fresh)).isDirectory()).toBe(true);
		expect((await fs.stat(foreign)).isDirectory()).toBe(true);
		expect((await fs.stat(own!)).isDirectory()).toBe(true);

		// The next prune waits for the interval, even if a directory became stale meanwhile.
		await fs.utimes(fresh, old, old);
		now += 1000;
		await cache.directory(sftp);
		expect((await fs.stat(fresh)).isDirectory()).toBe(true);
		now += MANAGED_METADATA_CACHE_LIMITS.pruneIntervalMs;
		await cache.directory(sftp);
		await expect(fs.stat(fresh)).rejects.toMatchObject({ code: 'ENOENT' });
		// Its own directory is touched on every use, so it never goes stale while used.
		expect((await fs.stat(own!)).isDirectory()).toBe(true);
	});
});
