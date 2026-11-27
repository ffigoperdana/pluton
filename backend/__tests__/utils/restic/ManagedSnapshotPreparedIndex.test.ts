import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
	ManagedSnapshotIndexCache,
	SNAPSHOT_INDEX_LIMITS,
	type SnapshotIndexDiagnostic,
} from '../../../src/utils/restic/ManagedSnapshotIndex';

const key = (id: string) =>
	ManagedSnapshotIndexCache.key({ repository: 'repository-01', backup: id });
const node = (value: string, type = 'dir') => ({
	struct_type: 'node' as const,
	path: value,
	name: path.posix.basename(value),
	type: type as 'dir' | 'file',
	size: type === 'file' ? 7 : 0,
	mtime: '2026-01-01T00:00:00Z',
});
const populate = async (append: (value: ReturnType<typeof node>) => void) => {
	append(node('/srv'));
	append(node('/srv/file.txt', 'file'));
};
/** A build that runs until it is aborted, like a long Restic listing. */
const endless = (started?: () => void) => async (_append: unknown, signal: AbortSignal) => {
	started?.();
	await new Promise<void>((_resolve, reject) => {
		const stop = () => reject(Object.assign(new Error('listing stopped'), { code: 'cancelled' }));
		if (signal.aborted) stop();
		signal.addEventListener('abort', stop, { once: true });
	});
};
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe('prepared snapshot indexes', () => {
	let root: string, cache: ManagedSnapshotIndexCache, records: SnapshotIndexDiagnostic[];
	const create = (limits: Partial<typeof SNAPSHOT_INDEX_LIMITS> = {}) => {
		records = [];
		cache = new ManagedSnapshotIndexCache(
			path.join(root, 'indexes'),
			{ ...SNAPSHOT_INDEX_LIMITS, ...limits },
			record => records.push(record)
		);
	};
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'prepared-index-'));
		create();
	});
	afterEach(async () => {
		jest.restoreAllMocks();
		await cache.close();
		await fs.rm(root, { recursive: true, force: true });
	});

	it('keeps a ready prepared index past the idle lifetime until its retention ends', async () => {
		await cache.close();
		create({ ttlMs: 1, preparedRetainMs: 60_000 });
		const { result } = await cache.prepare(key('P'), populate);
		await expect(result).resolves.toBe('ready');
		await settle();
		await cache.retry(key('other')); // runs expiry
		expect(cache.status(key('P'))).toBe('ready');
		expect(cache.inspect(key('P'))).toMatchObject({ state: 'ready', entries: 2 });
		// Browse reuses it without building again.
		const build = jest.fn(populate);
		await expect(cache.use(key('P'), build, index => index.count)).resolves.toBe(2);
		expect(build).not.toHaveBeenCalled();

		await cache.close();
		create({ ttlMs: 1, preparedRetainMs: 1 });
		await (
			await cache.prepare(key('Q'), populate)
		).result;
		await settle();
		await cache.retry(key('other'));
		expect(cache.status(key('Q'))).toBe('missing');
	});

	it('holds prepared indexes in their own slots, apart from on-demand LRU eviction', async () => {
		await (
			await cache.prepare(key('P'), populate)
		).result;
		await cache.use(key('A'), populate, index => index.count);
		await cache.use(key('B'), populate, index => index.count);
		// A third on-demand index evicts the oldest on-demand one, never the prepared one.
		await cache.use(key('C'), populate, index => index.count);
		expect(cache.status(key('P'))).toBe('ready');
		expect(cache.status(key('A'))).toBe('missing');
		expect(cache.status(key('B'))).toBe('ready');
		expect(cache.status(key('C'))).toBe('ready');
	});

	it('evicts the prepared index whose retention ends first when prepared slots are full', async () => {
		await cache.close();
		create({ maxPrepared: 2 });
		await (
			await cache.prepare(key('P1'), populate)
		).result;
		await (
			await cache.prepare(key('P2'), populate)
		).result;
		await (
			await cache.prepare(key('P3'), populate)
		).result;
		expect(cache.status(key('P1'))).toBe('missing');
		expect(cache.status(key('P2'))).toBe('ready');
		expect(cache.status(key('P3'))).toBe('ready');
		// Preparing an existing index only extends it.
		await (
			await cache.prepare(key('P2'), populate)
		).result;
		await (
			await cache.prepare(key('P4'), populate)
		).result;
		expect(cache.status(key('P2'))).toBe('ready');
		expect(cache.status(key('P3'))).toBe('missing');
	});

	it('promotes an index opened on demand instead of building it again', async () => {
		await cache.use(key('A'), populate, index => index.count);
		const build = jest.fn(populate);
		await expect((await cache.prepare(key('A'), build)).result).resolves.toBe('ready');
		expect(build).not.toHaveBeenCalled();
		expect(records).toEqual(
			expect.arrayContaining([expect.objectContaining({ stage: 'prepared', prepared: 1 })])
		);
	});

	it('yields an unclaimed prepared build to a request from Browse, a download or a restore', async () => {
		let started!: () => void;
		const running = new Promise<void>(resolve => (started = resolve));
		const { result } = await cache.prepare(key('P'), endless(started));
		await running;
		// A different snapshot opened in Browse takes the build slot at once.
		await expect(cache.use(key('A'), populate, index => index.count)).resolves.toBe(2);
		await expect(result).resolves.toBe('cancelled');
		expect(cache.status(key('P'))).toBe('missing');
		expect(records).toEqual(
			expect.arrayContaining([expect.objectContaining({ stage: 'preempted' })])
		);
		// Its partial index is gone; only the on-demand index remains on disk.
		expect(
			(await fs.readdir(path.join(root, 'indexes'))).filter(name => name.startsWith('index-'))
		).toHaveLength(1);
	});

	it('never preempts a prepared build that Browse is already waiting for', async () => {
		let started!: () => void;
		const running = new Promise<void>(resolve => (started = resolve));
		const { result } = await cache.prepare(key('P'), endless(started));
		await running;
		// Browse polls the same snapshot: it shares the build and claims it.
		await cache.start(key('P'), populate, true);
		await expect(cache.start(key('A'), populate, true)).rejects.toMatchObject({
			reason: 'build-busy',
		});
		expect(cache.status(key('P'))).toBe('indexing');
		await expect(cache.preempt(key('P'))).resolves.toBe(false);
		await cache.close();
		await expect(result).resolves.toBe('cancelled');
		create();
	});

	it('stops an unclaimed prepared build on request, for example when a backup starts', async () => {
		let started!: () => void;
		const running = new Promise<void>(resolve => (started = resolve));
		const { result } = await cache.prepare(key('P'), endless(started));
		await running;
		await expect(cache.preempt(key('P'))).resolves.toBe(true);
		await expect(result).resolves.toBe('cancelled');
		expect(cache.status(key('P'))).toBe('missing');
		await expect(cache.preempt(key('missing'))).resolves.toBe(false);
	});

	it('refuses a second build while one runs, so the queue can retry later', async () => {
		let started!: () => void;
		const running = new Promise<void>(resolve => (started = resolve));
		await cache.prepare(key('P'), endless(started));
		await running;
		await expect(cache.prepare(key('Q'), populate)).rejects.toMatchObject({
			reason: 'build-busy',
		});
	});

	it('releases a replaced prepared index at once, or after use when it is open', async () => {
		await (
			await cache.prepare(key('P'), populate)
		).result;
		await cache.release(key('P'));
		expect(cache.status(key('P'))).toBe('missing');

		await (
			await cache.prepare(key('Q'), populate)
		).result;
		let release!: () => void;
		const reading = cache.use(
			key('Q'),
			populate,
			() => new Promise<void>(resolve => (release = resolve))
		);
		await settle();
		await cache.release(key('Q'));
		expect(cache.status(key('Q'))).toBe('ready');
		release();
		await reading;
		await cache.release(key('not-prepared'));
	});

	it('retries a failed attempt when the next backup prepares it', async () => {
		await expect(
			(
				await cache.prepare(key('P'), async () => {
					throw Object.assign(new Error('private provider output'), { code: 'invalid-output' });
				})
			).result
		).resolves.toBe('failed');
		expect(cache.status(key('P'))).toBe('failed');
		await expect((await cache.prepare(key('P'), populate)).result).resolves.toBe('ready');
	});
});
