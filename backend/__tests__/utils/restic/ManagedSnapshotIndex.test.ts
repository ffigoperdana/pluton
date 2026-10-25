import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
	ManagedSnapshotIndexCache,
	SNAPSHOT_INDEX_LIMITS,
} from '../../../src/utils/restic/ManagedSnapshotIndex';
import {
	consumeMetadataLines,
	ManagedRepositoryAccessError,
} from '../../../src/utils/restic/ManagedSftpRepositorySession';

const node = (i: number) => ({
	struct_type: 'node' as const,
	path: `/srv/example-app/file-${String(i).padStart(6, '0')}.txt`,
	name: `file-${String(i).padStart(6, '0')}.txt`,
	type: 'file' as const,
	size: 7,
	mtime: '2026-01-01T00:00:00Z',
	mode: 420,
});
const dir = (value: string) => ({
	...node(0),
	path: value,
	name: path.posix.basename(value),
	type: 'dir' as const,
	size: 0,
});
const key = ManagedSnapshotIndexCache.key({
	plan: 'plan-01',
	backup: 'backup-01',
	snapshot: 'a'.repeat(64),
});
describe('bounded managed snapshot metadata index', () => {
	let root: string, cache: ManagedSnapshotIndexCache;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-index-test-'));
		cache = new ManagedSnapshotIndexCache(path.join(root, 'indexes'));
	});
	afterEach(async () => {
		await cache.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const populate =
		(count: number) =>
		async (append: (value: ReturnType<typeof node> | ReturnType<typeof dir>) => void) => {
			append(dir('/srv'));
			append(dir('/srv/example-app'));
			for (let i = 0; i < count; i++) append(node(i));
		};
	it.each([22, 5000, 100000])(
		'indexes and pages a complete %i-file snapshot',
		async count => {
			await cache.use(key, populate(count), index => {
				expect(index.count).toBe(count + 2);
				expect(index.stats.total_bytes).toBe(count * 7);
				const page = index.page({ path: '/srv/example-app', limit: 200 });
				expect(page.files.length).toBe(Math.min(200, count));
				expect(page.total).toBe(count);
				expect(index.get(node(count - 1).path)?.size).toBe(7);
				expect(
					index.page({ path: '/srv/example-app', search: '000021', limit: 10 }).files
				).toHaveLength(1);
				index.assertSafe();
			});
		},
		30000
	);
	it('streams over 32 MiB of fragmented JSON without retaining a complete listing', async () => {
		let bytes = 0,
			records = 0;
		async function* listing() {
			for (let i = 0; i < 100000; i++) {
				const line = Buffer.from(JSON.stringify({ ...node(i), atime: 'x'.repeat(180) }) + '\n');
				bytes += line.length;
				yield line.subarray(0, 17);
				yield line.subarray(17);
			}
		}
		await cache.use(
			key,
			async append => {
				await consumeMetadataLines(listing(), async line => {
					append(JSON.parse(line));
					records++;
				});
			},
			index => expect(index.count).toBe(100000)
		);
		expect(bytes).toBeGreaterThan(32 * 1024 ** 2);
		expect(records).toBe(100000);
	}, 30000);
	it('deduplicates concurrent requests and never publishes partial/failed construction', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const build = jest.fn(async append => {
			append(node(0));
			await gate;
			append(node(1));
		});
		const a = cache.use(key, build, index => index.count),
			b = cache.use(key, build, index => index.count);
		await new Promise(resolve => setImmediate(resolve));
		expect(cache.status(key)).toBe('indexing');
		release();
		await expect(Promise.all([a, b])).resolves.toEqual([2, 2]);
		expect(build).toHaveBeenCalledTimes(1);
	});
	it('cleans up a failed build and supports a complete retry', async () => {
		await expect(
			cache.use(
				key,
				async append => {
					append(node(0));
					throw new ManagedRepositoryAccessError('timeout');
				},
				() => undefined
			)
		).rejects.toMatchObject({ code: 'timeout' });
		expect(cache.status(key)).toBe('failed');
		expect(await fs.readdir(path.join(root, 'indexes'))).toEqual([]);
		await expect(cache.use(key, populate(22), index => index.count)).resolves.toBe(24);
	});
	it.each([
		[
			'duplicate',
			(append: any) => {
				append(node(0));
				append(node(0));
			},
		],
		['traversal', (append: any) => append({ ...node(0), path: '/srv/../escape' })],
		['relative', (append: any) => append({ ...node(0), path: 'srv/file' })],
		['missing file size', (append: any) => append({ ...node(0), size: undefined })],
		['unknown type', (append: any) => append({ ...node(0), type: 'unknown' })],
		[
			'symlink ancestor',
			(append: any) => {
				append({ ...dir('/srv'), type: 'symlink' });
				append(node(0));
			},
		],
	])('rejects %s records and exposes no completed index', async (_, populateUnsafe) => {
		await expect(
			cache.use(
				key,
				async append => populateUnsafe(append),
				() => undefined
			)
		).rejects.toMatchObject({ code: 'metadata-invalid' });
		expect(cache.status(key)).toBe('failed');
	});
	it.each(['symlink', 'dev', 'chardev', 'fifo', 'socket'])(
		'browses %s metadata but rejects unsafe full manifests',
		async type => {
			await cache.use(
				key,
				async append => append({ ...node(0), type } as any),
				index => {
					expect(index.count).toBe(1);
					expect(() => index.assertSafe()).toThrow('unsupported file type');
				}
			);
		}
	);
	it('enforces entry and global construction concurrency limits', async () => {
		await cache.close();
		cache = new ManagedSnapshotIndexCache(path.join(root, 'indexes'), {
			...SNAPSHOT_INDEX_LIMITS,
			maxEntries: 2,
		});
		await expect(cache.use(key, populate(22), () => undefined)).rejects.toMatchObject({
			code: 'index-resource-limit',
		});
		await cache.retry(key);
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		cache.start(key, async () => gate, true);
		expect(() =>
			cache.start(ManagedSnapshotIndexCache.key('other'), async () => undefined)
		).toThrow('resource limit');
		release();
	});
	it('cancels a waiter without exposing partial data to another request', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const build = jest.fn(async append => {
			await gate;
			append(node(0));
		});
		const controller = new AbortController();
		const a = cache.use(key, build, index => index.count, controller.signal);
		const b = cache.use(key, build, index => index.count);
		await new Promise(resolve => setImmediate(resolve));
		controller.abort();
		await expect(a).rejects.toMatchObject({ code: 'cancelled' });
		release();
		await expect(b).resolves.toBe(1);
	});
	it('fails safely on exhausted disk capacity and retries after capacity returns', async () => {
		const disk = jest.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 0, bsize: 4096 } as any);
		await expect(cache.use(key, populate(22), () => undefined)).rejects.toMatchObject({
			code: 'index-resource-limit',
		});
		disk.mockRestore();
		await expect(cache.use(key, populate(22), index => index.count)).resolves.toBe(24);
	});
	it('bounds SQLite pages and cleans an index that hits SQLITE_FULL', async () => {
		await cache.close();
		cache = new ManagedSnapshotIndexCache(path.join(root, 'indexes'), {
			...SNAPSHOT_INDEX_LIMITS,
			maxBytes: 65536,
		});
		await expect(cache.use(key, populate(5000), () => undefined)).rejects.toMatchObject({
			code: 'index-resource-limit',
		});
		expect(await fs.readdir(path.join(root, 'indexes'))).toEqual([]);
	});
	it('expires inactive metadata and deduplicates concurrent retry cleanup', async () => {
		await cache.use(key, populate(22), () => undefined);
		const now = jest
			.spyOn(Date, 'now')
			.mockReturnValue(Date.now() + SNAPSHOT_INDEX_LIMITS.ttlMs + 1);
		try {
			await Promise.all([cache.retry(key), cache.retry(key)]);
			expect(cache.status(key)).toBe('missing');
		} finally {
			now.mockRestore();
		}
	});
});

describe('bounded NDJSON framing', () => {
	async function* chunks(values: Buffer[]) {
		yield* values;
	}
	it('preserves split multibyte names and CRLF', async () => {
		const bytes = Buffer.from('{"name":"résumé"}\r\n');
		const seen: string[] = [];
		await consumeMetadataLines(chunks([...bytes].map(byte => Buffer.from([byte]))), async line => {
			seen.push(JSON.parse(line).name);
		});
		expect(seen).toEqual(['résumé']);
	});
	it.each([Buffer.from('{"bad"'), Buffer.from('\n'), Buffer.from([0xff, 10])])(
		'rejects truncated/empty/invalid UTF-8 records',
		async bytes => {
			await expect(
				consumeMetadataLines(chunks([bytes]), async () => undefined)
			).rejects.toMatchObject({ code: 'invalid-output' });
		}
	);
	it('bounds a single record and the entire stream', async () => {
		await expect(
			consumeMetadataLines(chunks([Buffer.from('x'.repeat(101))]), async () => undefined, 100)
		).rejects.toMatchObject({ code: 'output-limit' });
		await expect(
			consumeMetadataLines(chunks([Buffer.from('{}\n{}\n')]), async () => undefined, 100, 5)
		).rejects.toMatchObject({ code: 'output-limit' });
	});
});
