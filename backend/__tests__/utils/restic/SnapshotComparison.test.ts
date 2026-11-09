import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
	SnapshotComparison,
	SnapshotComparisonCache,
	comparisonFailure,
	type SnapshotDiffRecord,
} from '../../../src/utils/restic/SnapshotComparison';
const binding = {
	currentBackupId: 'backup-new',
	previousBackupId: 'backup-old',
	currentSnapshotId: 'a'.repeat(64),
	previousSnapshotId: 'b'.repeat(64),
};
const node = (name: string, type = 'file') => ({
	path: '/srv/' + name,
	name,
	type,
	size: type === 'file' ? 7 : 0,
	modifiedAt: '2026-01-01T00:00:00Z',
});
const index = (rows: Iterable<ReturnType<typeof node>>, count: number) =>
	({ count, [Symbol.iterator]: () => rows[Symbol.iterator]() }) as any;
const diff =
	(changes: { path: string; modifier: string }[]) =>
	async (consume: (record: SnapshotDiffRecord) => void) => {
		for (const change of changes) consume({ message_type: 'change', ...change });
		consume({
			message_type: 'statistics',
			source_snapshot: binding.previousSnapshotId,
			target_snapshot: binding.currentSnapshotId,
		});
	};
describe('verified bounded snapshot comparisons', () => {
	let root: string, comparison: SnapshotComparison | undefined;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-comparison-test-'));
	});
	afterEach(async () => {
		comparison?.close();
		comparison = undefined;
		await fs.rm(root, { recursive: true, force: true });
	});
	test('multi-GiB file size is metadata, not a content buffer or comparison size cap', async () => {
		comparison = new SnapshotComparison(path.join(root, 'large.sqlite'), binding);
		const rows = [{ ...node('database.sql'), size: 8 * 1024 ** 3 }, node('config')];
		await comparison.populate(
			index(rows, 2),
			index(rows, 2),
			diff([{ path: '/srv/database.sql', modifier: 'M' }]),
			new AbortController().signal
		);
		expect(comparison.summary()).toMatchObject({ modified: 1, unchanged: 1 });
		expect(comparison.page({ path: '/srv' }).files.find(f => f.name === 'database.sql')?.size).toBe(
			8 * 1024 ** 3
		);
	});
	test('failure categories are fixed and never copy provider details', () => {
		for (const [error, expected] of [
			[{ code: 'timeout' }, 'timeout'],
			[{ code: 'SQLITE_FULL' }, 'resource-limit'],
			[{ statusCode: 429 }, 'busy'],
			[{ code: 'invalid-output' }, 'metadata-invalid'],
			[{ statusCode: 409 }, 'validation-conflict'],
			[{ code: 'wrong-password' }, 'repository-unavailable'],
			[{ message: 'private-provider-body', code: 'private-provider-body' }, 'unavailable'],
		] as const)
			expect(comparisonFailure(error)).toBe(expected);
	});

	test('identical snapshots become unchanged only after authoritative diff completion', async () => {
		comparison = new SnapshotComparison(path.join(root, 'index.sqlite'), binding);
		const rows = [node('same.txt'), node('folder', 'dir')];
		await comparison.populate(
			index(rows, 2),
			index(rows, 2),
			diff([]),
			new AbortController().signal
		);
		expect(comparison.summary()).toEqual({
			added: 0,
			modified: 0,
			unchanged: 1,
			deleted: 0,
			addedLogicalBytes: 0,
			removedLogicalBytes: 0,
		});
		expect(comparison.page({ path: '/srv' }).files.every(row => row.change === 'unchanged')).toBe(
			true
		);
	});
	test('native Restic directory suffixes require indexed directory evidence; file paths and traversal are never normalized', async () => {
		comparison = new SnapshotComparison(path.join(root, 'index.sqlite'), binding);
		const rows = [node('folder', 'dir')];
		await comparison.populate(
			index(rows, 1),
			index(rows, 1),
			diff([{ path: '/srv/folder/', modifier: 'U' }]),
			new AbortController().signal
		);
		expect(comparison.page({ path: '/srv' }).files[0]).toMatchObject({
			path: '/srv/folder',
			change: 'modified',
		});
		comparison.close();
		comparison = new SnapshotComparison(path.join(root, 'invalid.sqlite'), binding);
		await expect(
			comparison.populate(
				index([node('file')], 1),
				index([node('file')], 1),
				diff([{ path: '/srv/file/', modifier: 'U' }]),
				new AbortController().signal
			)
		).rejects.toThrow('Directory comparison evidence');
	});
	test('same size and mtime do not hide modifications; deleted rows bind only the previous snapshot', async () => {
		comparison = new SnapshotComparison(path.join(root, 'index.sqlite'), binding);
		await comparison.populate(
			index([node('same'), node('modified'), node('new & ü.txt'), node('link', 'symlink')], 4),
			index([node('same'), node('modified'), node('deleted'), node('link', 'symlink')], 4),
			diff([
				{ path: '/srv/modified', modifier: 'M' },
				{ path: '/srv/new & ü.txt', modifier: '+' },
				{ path: '/srv/deleted', modifier: '-' },
				{ path: '/srv/link', modifier: 'U' },
			]),
			new AbortController().signal
		);
		expect(comparison.summary()).toEqual({
			added: 1,
			modified: 1,
			unchanged: 1,
			deleted: 1,
			addedLogicalBytes: 7,
			removedLogicalBytes: 7,
		});
		const deleted = comparison.page({ change: 'deleted', recursive: true }).files;
		expect(deleted).toHaveLength(1);
		expect(deleted[0]).toMatchObject({
			backupId: 'backup-old',
			snapshotId: binding.previousSnapshotId,
			isAvailable: false,
			change: 'deleted',
		});
		expect(comparison.page({ path: '/srv' }).files.some(row => row.path === '/srv/deleted')).toBe(
			false
		);
		expect(comparison.page({ change: 'added', recursive: true }).entries).toBe(4);
		expect(
			comparison
				.page({ change: 'modified', recursive: true })
				.files.find(row => row.type === 'symlink')?.change
		).toBe('modified');
	});
	test.each([
		'missing-summary',
		'wrong-identities',
		'unknown-path',
		'bitrot',
		'incomplete-added-evidence',
		'duplicate-evidence',
	])('refuses insufficient evidence: %s', async failure => {
		comparison = new SnapshotComparison(path.join(root, 'index.sqlite'), binding);
		const populate = async (consume: (record: SnapshotDiffRecord) => void) => {
			if (failure === 'unknown-path')
				consume({ message_type: 'change', path: '/foreign/file', modifier: 'M' });
			if (failure === 'bitrot')
				consume({ message_type: 'change', path: '/srv/same', modifier: '?' });
			if (failure === 'duplicate-evidence')
				for (let i = 0; i < 2; i++)
					consume({ message_type: 'change', path: '/srv/same', modifier: 'M' });
			if (failure !== 'missing-summary')
				consume({
					message_type: 'statistics',
					source_snapshot:
						failure === 'wrong-identities' ? 'c'.repeat(64) : binding.previousSnapshotId,
					target_snapshot: binding.currentSnapshotId,
				});
		};
		await expect(
			comparison.populate(
				index(
					[node('same'), ...(failure === 'incomplete-added-evidence' ? [node('unreported')] : [])],
					2
				),
				index([node('same')], 1),
				populate,
				new AbortController().signal
			)
		).rejects.toThrow();
		expect(comparison.summary()).toBeUndefined();
		expect(() => comparison!.page({})).toThrow('not ready');
	});
	test('100,005 entries remain disk-backed, sorted, searchable and paginated at 200', async () => {
		comparison = new SnapshotComparison(path.join(root, 'index.sqlite'), binding);
		function* rows() {
			for (let i = 0; i < 100005; i++) yield node(`file-${String(i).padStart(6, '0')}`);
		}
		await comparison.populate(
			index(rows(), 100005),
			index(rows(), 100005),
			diff([]),
			new AbortController().signal
		);
		const page = comparison.page({ path: '/srv', offset: 400, limit: 200 });
		expect(page.files).toHaveLength(200);
		expect(page.files[0].name).toBe('file-000400');
		expect(page.total).toBe(100005);
		expect(comparison.page({ path: '/srv', search: '100004' }).files[0].name).toBe('file-100004');
		expect((await fs.stat(path.join(root, 'index.sqlite'))).size).toBeLessThan(128 * 1024 ** 2);
		expect(() => comparison!.page({ limit: 201 })).toThrow();
		expect(() => comparison!.page({ path: '/srv/../escape' })).toThrow();
	}, 30000);

	test('a late successful callback after the bounded deadline never becomes Ready and exposes only safe timeout diagnostics', async () => {
		const cache = new SnapshotComparisonCache(path.join(root, 'deadline-jobs'));
		const deadline = new AbortController();
		const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
		try {
			await cache.start('late', binding, async (value, signal) => {
				await value.populate(index([node('same')], 1), index([node('same')], 1), diff([]), signal);
				deadline.abort(new DOMException('synthetic-private-detail', 'TimeoutError'));
			});
			const until = Date.now() + 10000;
			while (cache.status('late').state === 'preparing') {
				if (Date.now() > until) throw new Error('Comparison did not settle.');
				await new Promise<void>(resolve => setImmediate(resolve));
			}
			const result = cache.status('late');
			expect(result).toMatchObject({ state: 'failed', failureCategory: 'timeout' });
			expect(result.summary).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain('synthetic-private-detail');
		} finally {
			timeout.mockRestore();
			await cache.close();
		}
	});
	test('one worker, cached reuse, cancellation, retry and cleanup are enforced', async () => {
		const cache = new SnapshotComparisonCache(path.join(root, 'jobs'));
		let entered!: () => void;
		const ready = new Promise<void>(resolve => {
			entered = resolve;
		});
		const work = jest.fn(async (_index: SnapshotComparison, signal: AbortSignal) => {
			entered();
			await new Promise<void>((_r, reject) =>
				signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
			);
		});
		try {
			expect((await cache.start('first', binding, work)).state).toBe('preparing');
			await ready;
			const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
			try {
				expect(cache.find(binding.currentBackupId)?.key).toBe('first');
				expect(Object.isFrozen(cache.find(binding.currentBackupId)?.binding)).toBe(true);
				expect(cache.status('first').state).toBe('preparing');
				expect((await cache.start('first', binding, work)).state).toBe('preparing');
			} finally {
				clock.mockRestore();
			}
			expect((await cache.start('first', binding, work)).state).toBe('preparing');
			expect(work).toHaveBeenCalledTimes(1);
			await expect(
				cache.start('second', { ...binding, currentBackupId: 'backup-other' }, work)
			).rejects.toThrow('Another snapshot');
			expect((await cache.cancel('first')).state).toBe('cancelled');
			await cache.start(
				'first',
				binding,
				async (value, signal) =>
					value.populate(index([node('same')], 1), index([node('same')], 1), diff([]), signal),
				true
			);
			const deadline = Date.now() + 10000;
			while (cache.status('first').state === 'preparing') {
				if (Date.now() > deadline) throw new Error('Comparison did not settle.');
				await new Promise<void>(resolve => setImmediate(resolve));
			}
			expect(cache.status('first').state).toBe('ready');
			const competing = jest.fn(async () => undefined);
			await expect(
				cache.start('raced-key', { ...binding, previousBackupId: 'backup-raced' }, competing)
			).rejects.toMatchObject({ diagnostic: 'comparison-context-changed' });
			expect(competing).not.toHaveBeenCalled();
			expect(cache.find(binding.currentBackupId)?.key).toBe('first');
			expect(cache.page('first', { path: '/srv' }).files).toHaveLength(1);
		} finally {
			await cache.close();
		}
		expect(await fs.readdir(path.join(root, 'jobs'))).toEqual([]);
	});
});
