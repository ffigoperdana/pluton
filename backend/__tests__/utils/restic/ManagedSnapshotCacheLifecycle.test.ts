import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
	DISK_SAMPLE_ROWS,
	ManagedSnapshotIndexCache,
	SNAPSHOT_INDEX_LIMITS,
	SnapshotIndexError,
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
const gate = () => {
	let release!: () => void;
	const wait = new Promise<void>(resolve => {
		release = resolve;
	});
	return { wait, release };
};

describe('managed index cache lifecycle and bounded admission', () => {
	let root: string, cache: ManagedSnapshotIndexCache;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'index-lifecycle-'));
		cache = new ManagedSnapshotIndexCache(path.join(root, 'indexes'));
	});
	afterEach(async () => {
		jest.restoreAllMocks();
		await cache.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const fill = (id: string) => cache.use(key(id), populate, index => index.count);
	it('keeps a cancelled construction owned until cleanup settles before a retry', async () => {
		const started = gate(),
			stopping = gate(),
			cleaned = gate();
		const controller = new AbortController();
		let finished = false;
		const work = cache
			.use(
				key('A'),
				async (_append, signal) => {
					started.release();
					await new Promise<void>(resolve =>
						signal.addEventListener(
							'abort',
							() => {
								stopping.release();
								resolve();
							},
							{ once: true }
						)
					);
					await cleaned.wait;
					throw new SnapshotIndexError('cancelled');
				},
				index => index.count,
				controller.signal
			)
			.finally(() => {
				finished = true;
			});
		const cancelled = expect(work).rejects.toMatchObject({ code: 'cancelled' });
		await started.wait;
		controller.abort();
		await stopping.wait;
		expect(finished).toBe(false);
		cleaned.release();
		await cancelled;
		expect(cache.status(key('A'))).toBe('failed');
		expect(await fill('A')).toBe(2);
	});
	it.each([1000, 900])(
		'keeps the most recently used index when the clock subsequently reads %i',
		async next => {
			const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
			const build = jest.fn(populate);
			const access = (id: string) => cache.use(key(id), build, index => index.count);
			await access('A');
			await access('B');
			clock.mockReturnValue(next);
			await access('A');
			await access('C');
			expect(cache.status(key('A'))).toBe('ready');
			expect(cache.status(key('B'))).toBe('missing');
			expect(cache.status(key('C'))).toBe('ready');
			await access('A');
			expect(build).toHaveBeenCalledTimes(3);
		}
	);

	it('opens A then B then C with two slots and deterministically evicts the least recently used idle index', async () => {
		await fill('A');
		await fill('B');
		expect(await fill('C')).toBe(2);
		expect(cache.status(key('A'))).toBe('missing');
		expect(cache.status(key('B'))).toBe('ready');
		expect((await fs.readdir(path.join(root, 'indexes'))).length).toBe(2);
		await fill('B');
		await fill('A');
		expect(cache.status(key('C'))).toBe('missing');
	});
	it('keeps a download reader pinned while browse C evicts idle B, and refuses only when both slots are active', async () => {
		await fill('A');
		await fill('B');
		const a = gate(),
			b = gate(),
			entered = gate();
		const readerA = cache.use(key('A'), populate, async index => {
			entered.release();
			await a.wait;
			expect(index.get('/srv')).toBeDefined();
		});
		await entered.wait;
		await fill('C');
		expect(cache.status(key('B'))).toBe('missing');
		const enteredB = gate();
		const readerB = cache.use(key('C'), populate, async () => {
			enteredB.release();
			await b.wait;
		});
		await enteredB.wait;
		try {
			await expect(fill('D')).rejects.toMatchObject({ reason: 'cache-active', statusCode: 429 });
		} finally {
			a.release();
			b.release();
			await Promise.all([readerA, readerB]);
		}
		await expect(fill('D')).resolves.toBe(2);
	});
	it('preserves one build, deduplicates background polling, and allows another snapshot after completion', async () => {
		const buildGate = gate();
		const build = jest.fn(async append => {
			append(node('/srv'));
			await buildGate.wait;
		});
		const first = await cache.start(key('A'), build, true);
		try {
			for (let i = 0; i < 20; i++) expect(await cache.start(key('A'), build, true)).toBe(first);
			await expect(cache.start(key('B'), populate, true)).rejects.toMatchObject({
				reason: 'build-busy',
			});
		} finally {
			buildGate.release();
			await first.promise;
		}
		expect(build).toHaveBeenCalledTimes(1);
		await expect(fill('B')).resolves.toBe(2);
	});
	it('clears a failed attempt once and deduplicates simultaneous explicit retries', async () => {
		const failure = new SnapshotIndexError('metadata-invalid');
		const first = await cache.start(
			key('A'),
			async () => {
				throw failure;
			},
			true
		);
		await expect(first.promise).rejects.toBe(failure);
		expect(cache.failure(key('A'))).toBe(failure);
		await Promise.all([cache.retry(key('A')), cache.retry(key('A'))]);
		expect(cache.failure(key('A'))).toBeUndefined();
		const build = jest.fn(populate);
		const [a, b] = await Promise.all([
			cache.start(key('A'), build, true),
			cache.start(key('A'), build, true),
		]);
		expect(a).toBe(b);
		await a.promise;
		expect(build).toHaveBeenCalledTimes(1);
	});
	it('serializes eviction and lease acquisition so a concurrent request never uses a closed SQLite handle', async () => {
		await fill('A');
		await fill('B');
		const deleted = gate(),
			unblock = gate(),
			original = fs.rm;
		const removal = jest.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
			deleted.release();
			await unblock.wait;
			return original(target, options);
		});
		const c = fill('C');
		await deleted.wait;
		const old = expect(fill('A')).rejects.toMatchObject({ reason: 'build-busy' });
		unblock.release();
		await expect(c).resolves.toBe(2);
		await old;
		await expect(fill('A')).resolves.toBe(2);
		removal.mockRestore();
	});
	it('bounds queued admissions while cleanup is pending', async () => {
		await fill('A');
		await fill('B');
		const deleted = gate(),
			unblock = gate(),
			original = fs.rm;
		jest.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
			deleted.release();
			await unblock.wait;
			return original(target, options);
		});
		const c = fill('C');
		await deleted.wait;
		const waiters = Array.from({ length: 15 }, () => cache.start(key('C'), populate, true));
		await expect(cache.start(key('C'), populate, true)).rejects.toMatchObject({
			reason: 'admission-busy',
		});
		unblock.release();
		await c;
		await Promise.all(waiters);
	});
	it('waits for active consumers before closing handles during shutdown', async () => {
		await fill('A');
		const consuming = gate(),
			finish = gate();
		const reader = cache.use(key('A'), populate, async index => {
			consuming.release();
			await finish.wait;
			expect(index.count).toBe(2);
		});
		await consuming.wait;
		let closed = false;
		const close = cache.close().then(() => {
			closed = true;
		});
		await new Promise(resolve => setImmediate(resolve));
		expect(closed).toBe(false);
		finish.release();
		await reader;
		await close;
	});
	it('retains a failed cleanup slot and allows retry when filesystem access returns', async () => {
		await fill('A');
		await fill('B');
		const remove = jest.spyOn(fs, 'rm').mockRejectedValue(new Error('private fixture path'));
		await expect(fill('C')).rejects.toMatchObject({ reason: 'cleanup-failed', statusCode: 503 });
		expect(cache.status(key('A'))).toBe('failed');
		remove.mockRestore();
		await cache.retry(key('A'));
		await expect(fill('C')).resolves.toBe(2);
	});
	it('removes only generated orphan directories on restart and preserves unrelated data', async () => {
		const orphan = path.join(root, 'indexes', `index-${key('A')}-${'a'.repeat(24)}`);
		await fs.mkdir(orphan, { recursive: true });
		await fs.writeFile(path.join(orphan, 'metadata.sqlite'), 'partial');
		await fs.writeFile(path.join(root, 'indexes', 'application.sqlite'), 'do not touch');
		await fill('A');
		await expect(fs.stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await fs.readFile(path.join(root, 'indexes', 'application.sqlite'), 'utf8')).toBe(
			'do not touch'
		);
	});
	it('classifies disk capacity, database size, entry count, invalid metadata, cancellation and timeout safely', async () => {
		const disk = jest.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 0, bsize: 4096 } as any);
		await expect(fill('A')).rejects.toMatchObject({ reason: 'disk-capacity', statusCode: 507 });
		disk.mockRestore();
		await cache.close();
		cache = new ManagedSnapshotIndexCache(path.join(root, 'indexes'), {
			...SNAPSHOT_INDEX_LIMITS,
			maxEntries: 1,
		});
		await expect(fill('A')).rejects.toMatchObject({ reason: 'entry-count', statusCode: 413 });
		await cache.close();
		cache = new ManagedSnapshotIndexCache(path.join(root, 'indexes'), {
			...SNAPSHOT_INDEX_LIMITS,
			maxBytes: 4096,
		});
		await expect(fill('A')).rejects.toMatchObject({ reason: 'database-size', statusCode: 413 });
		await cache.close();
		cache = new ManagedSnapshotIndexCache(path.join(root, 'indexes'));
		for (const code of ['timeout', 'cancelled', 'invalid-output']) {
			await expect(
				cache.use(
					key(code),
					async () => {
						throw Object.assign(new Error('private provider output'), { code });
					},
					() => {}
				)
			).rejects.toMatchObject({
				reason: code === 'invalid-output' ? 'repository-output-invalid' : code,
			});
		}
	});
	it('projects untrusted provider reasons to a closed diagnostic category', async () => {
		await expect(
			cache.use(
				key('invalid'),
				async () => {
					throw Object.assign(new Error('private provider output'), {
						code: 'invalid-output',
						reason: '/private/raw-filename',
					});
				},
				() => {}
			)
		).rejects.toMatchObject({
			code: 'metadata-invalid',
			reason: 'repository-output-invalid',
			statusCode: 422,
		});
	});
	it('releases idle disk occupancy even before the second cache slot is full', async () => {
		await fill('A');
		const disk = jest
			.spyOn(fs, 'statfs')
			.mockImplementation(
				async () =>
					({ bavail: cache.status(key('A')) === 'ready' ? 0 : 200000, bsize: 4096 }) as any
			);
		await expect(fill('B')).resolves.toBe(2);
		expect(cache.status(key('A'))).toBe('missing');
		disk.mockRestore();
	});
	it('starts an index with less free space than the full page cap', async () => {
		// 500 MiB free: above the 320 MiB start requirement, below the 4 GiB cap plus reserve.
		const disk = jest
			.spyOn(fs, 'statfs')
			.mockResolvedValue({ bavail: (500 * 1024 ** 2) / 4096, bsize: 4096 } as any);
		await expect(fill('A')).resolves.toBe(2);
		disk.mockResolvedValue({ bavail: (300 * 1024 ** 2) / 4096, bsize: 4096 } as any);
		await expect(fill('B')).rejects.toMatchObject({ reason: 'disk-capacity', statusCode: 507 });
		disk.mockRestore();
	});
	it('sanitizes unavailable filesystem admission as 503 and permits retry after access returns', async () => {
		const disk = jest.spyOn(fs, 'statfs').mockRejectedValue(new Error('private filesystem detail'));
		await expect(fill('A')).rejects.toMatchObject({ reason: 'unavailable', statusCode: 503 });
		disk.mockRestore();
		await expect(fill('A')).resolves.toBe(2);
	});
	it('does not mislabel a SQLite quota/full error as the configured page cap without evidence', async () => {
		await expect(
			cache.use(
				key('quota'),
				async () => {
					throw Object.assign(new Error('private SQLite detail'), { code: 'SQLITE_FULL' });
				},
				() => {}
			)
		).rejects.toMatchObject({ reason: 'storage-full', statusCode: 507 });
	});
	it('attributes FULL at the page cap to the database size, not to a quota', async () => {
		// Above 1 MiB the allocation is sampled every 256 rows, and SQLite rolls the
		// build back on FULL, so the last periodic sample alone is below the cap.
		await cache.close();
		cache = new ManagedSnapshotIndexCache(path.join(root, 'indexes'), {
			...SNAPSHOT_INDEX_LIMITS,
			maxBytes: 4 * 1024 ** 2,
		});
		const hex = (n: number) => n.toString(16).padStart(40, '0');
		await expect(
			cache.use(
				key('cap'),
				async append => {
					append(node('/srv'));
					append(node('/srv/example-filestore'));
					for (let dir = 0; dir < 256; dir++)
						append(node(`/srv/example-filestore/${dir.toString(16).padStart(2, '0')}`));
					for (let n = 0; n < 100_000; n++) {
						const name = hex(n);
						append(node(`/srv/example-filestore/${name.slice(-2)}/${name}`, 'file'));
					}
				},
				index => index.count
			)
		).rejects.toMatchObject({ reason: 'database-size', statusCode: 413 });
	});
	it('names the default bounds in its client messages', () => {
		expect(SNAPSHOT_INDEX_LIMITS).toMatchObject({ maxEntries: 2_000_000, maxBytes: 4 * 1024 ** 3 });
		const message = (reason: 'disk-capacity' | 'database-size' | 'entry-count') =>
			new SnapshotIndexError('index-resource-limit', reason).message;
		expect(message('disk-capacity')).toContain('320 MiB');
		expect(message('disk-capacity')).toContain('grows up to 4,096 MiB');
		expect(message('database-size')).toContain('4,096 MiB');
		expect(message('entry-count')).toContain('2,000,000');
	});
	it('stops a growing index before it takes the last free space of its filesystem', async () => {
		let free = 10 * 1024 ** 3;
		jest
			.spyOn(fs, 'statfs')
			.mockImplementation(async () => ({ bavail: free / 4096, bsize: 4096 }) as any);
		await expect(
			cache.use(
				key('grow'),
				async append => {
					append(node('/srv'));
					for (let n = 1; n < DISK_SAMPLE_ROWS - 1; n++) append(node(`/srv/f${n}`, 'file'));
					// The filesystem fills from elsewhere while the index grows.
					free = 32 * 1024 ** 2;
					append(node('/srv/sampled', 'file'));
					await new Promise(resolve => setImmediate(resolve));
					append(node('/srv/after-sample', 'file'));
				},
				index => index.count
			)
		).rejects.toMatchObject({ reason: 'disk-capacity', statusCode: 507 });
		// The partial index is removed, and a retry with space succeeds.
		expect(
			(await fs.readdir(path.join(root, 'indexes'))).filter(name => name.startsWith('index-'))
		).toEqual([]);
		free = 10 * 1024 ** 3;
		await expect(cache.use(key('grow'), populate, index => index.count)).resolves.toBe(2);
	});
	it('keeps a long-path index well below the former full-path layout', async () => {
		await cache.close();
		const records: { stage: string; entries: number; databaseBytes: number }[] = [];
		cache = new ManagedSnapshotIndexCache(
			path.join(root, 'indexes'),
			SNAPSHOT_INDEX_LIMITS,
			record => records.push(record as any)
		);
		const base = '/srv/example-app/storage/app/public/uploads/employee-documents';
		let entries = 0;
		await cache.use(
			key('size'),
			async append => {
				const parts = base.split('/').filter(Boolean);
				for (let n = 1; n <= parts.length; n++) append(node('/' + parts.slice(0, n).join('/')));
				for (let dir = 0; dir < 1000; dir++) {
					const directory = `${base}/employee-${String(100000 + dir)}/certificates`;
					append(node(directory.slice(0, directory.lastIndexOf('/'))));
					append(node(directory));
					for (let file = 0; file < 18; file++)
						append(
							node(`${directory}/${String(file).padStart(2, '0')}-scanned-document.pdf`, 'file')
						);
				}
			},
			index => (entries = index.count)
		);
		const ready = records.find(record => record.stage === 'ready')!;
		// About 120-character paths: the former layout needed about 2 KiB per entry.
		expect(entries).toBe(20_007);
		expect(ready.databaseBytes / entries).toBeLessThan(1200);
	});
	it('emits only bounded structured diagnostics and tolerates an unavailable logger', async () => {
		await cache.close();
		const records: unknown[] = [];
		cache = new ManagedSnapshotIndexCache(
			path.join(root, 'indexes'),
			SNAPSHOT_INDEX_LIMITS,
			record => {
				records.push(record);
			}
		);
		await fill('A');
		await fill('B');
		await fill('C');
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: 'ready', entries: 2, databaseBytes: expect.any(Number) }),
				expect.objectContaining({ stage: 'evicted' }),
			])
		);
		expect(JSON.stringify(records)).not.toMatch(
			/srv|repository-01|backup|password|metadata.sqlite/
		);
		await cache.close();
		cache = new ManagedSnapshotIndexCache(path.join(root, 'indexes'), SNAPSHOT_INDEX_LIMITS, () => {
			throw new Error('logger offline');
		});
		await expect(fill('A')).resolves.toBe(2);
	});
	it('pages more than 500 sibling directories independently of files and retains deep/empty folders', async () => {
		await cache.use(
			key('A'),
			async append => {
				append(node('/srv'));
				for (let i = 0; i < 601; i++) append(node(`/srv/dir-${String(i).padStart(4, '0')}`));
				for (let i = 0; i < 400; i++) append(node(`/srv/file-${i}.txt`, 'file'));
				let deep = '/deep';
				for (let i = 0; i < 100; i++) {
					append(node(deep));
					deep += '/d';
				}
			},
			index => {
				const names: string[] = [];
				for (let offset = 0; offset < 601; offset += 200) {
					const page = index.page({ path: '/srv', directoriesOnly: true, offset, limit: 200 });
					expect(page.total).toBe(601);
					names.push(...page.files.map(file => file.path));
				}
				expect(new Set(names).size).toBe(601);
				expect(index.page({ path: '/srv/dir-0000', directoriesOnly: true }).total).toBe(0);
				expect(index.page({ path: '/deep' + '/d'.repeat(99) }).total).toBe(0);
				expect(
					index
						.page({ path: '/srv', search: 'file-1', sort: 'size', order: 'desc' })
						.files.every(file => file.type === 'file')
				).toBe(true);
			}
		);
	});
	it('sorts and searches the current folder deterministically with directories first and stable path ties', async () => {
		await cache.use(
			key('sort'),
			async append => {
				append(node('/srv'));
				append(node('/srv/d'));
				append({ ...node('/srv/alpha.txt', 'file'), size: 20, mtime: '2026-01-02T01:00:00+07:00' });
				append({ ...node('/srv/Beta.txt', 'file'), size: 20, mtime: '2026-01-01T18:00:00Z' });
				append({ ...node('/srv/Zeta.txt', 'file'), size: 1, mtime: '2026-01-01T21:00:00Z' });
			},
			index => {
				const names = (sort: 'name' | 'size' | 'modifiedAt', order: 'asc' | 'desc') =>
					index.page({ path: '/srv', sort, order }).files.map(file => file.name);
				expect(names('name', 'asc')).toEqual(['d', 'alpha.txt', 'Beta.txt', 'Zeta.txt']);
				expect(names('name', 'desc')).toEqual(['d', 'Zeta.txt', 'Beta.txt', 'alpha.txt']);
				expect(names('size', 'asc')).toEqual(['d', 'Zeta.txt', 'Beta.txt', 'alpha.txt']);
				expect(names('size', 'desc')).toEqual(['d', 'Beta.txt', 'alpha.txt', 'Zeta.txt']);
				expect(names('modifiedAt', 'asc')).toEqual(['d', 'Beta.txt', 'alpha.txt', 'Zeta.txt']);
				expect(names('modifiedAt', 'desc')).toEqual(['d', 'Zeta.txt', 'Beta.txt', 'alpha.txt']);
				expect(
					index.page({ path: '/srv', offset: 1, limit: 2 }).files.map(file => file.name)
				).toEqual(['alpha.txt', 'Beta.txt']);
				expect(index.page({ path: '/srv', search: '.TXT' }).total).toBe(3);
				expect(index.page({ path: '/srv', search: '%_' }).total).toBe(0);
				expect(
					index.page({ path: '/srv', directoriesOnly: true }).files.map(file => file.name)
				).toEqual(['d']);
			}
		);
	});
});
