/** Disposable generated metadata only. Run each size in a fresh Node process. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ManagedSnapshotIndexCache } from '../../src/utils/restic/ManagedSnapshotIndex';
import { consumeMetadataLines } from '../../src/utils/restic/ManagedSftpRepositorySession';

const count = Number(process.argv[2] || 100000);
assert([22, 5000, 79300, 100000].includes(count));
const fileBytes =
	count === 5000
		? Math.ceil((3.16 * 1024 ** 3) / count)
		: count === 79300
			? Math.ceil((77.49 * 1024 ** 3) / count)
			: 832000;
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-metadata-load-'));
const cache = new ManagedSnapshotIndexCache(path.join(scratch, 'indexes'));
const key = ManagedSnapshotIndexCache.key({ backup: 'backup-01', snapshot: 'a'.repeat(64) });
let inputBytes = 0,
	peakHeap = 0;
const start = performance.now(),
	baselineRss = process.memoryUsage().rss;
const stamp = '2026-01-01T00:00:00.123456789Z';
async function* listing() {
	for (let i = 0; i < count; i++) {
		const name = `file-${String(i).padStart(6, '0')}-${'x'.repeat(80)}.txt`;
		const record = {
			struct_type: 'node',
			message_type: 'node',
			path: `/srv/example-app/${name}`,
			name,
			type: 'file',
			size: fileBytes,
			mtime: stamp,
			atime: stamp,
			ctime: stamp,
			uid: 1000,
			gid: 1000,
			mode: 420,
			permissions: '-rw-r--r--',
			inode: i,
		};
		const bytes = Buffer.from(JSON.stringify(record) + '\n');
		inputBytes += bytes.length;
		yield bytes.subarray(0, 37);
		yield bytes.subarray(37);
		if (i % 1000 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	}
}
try {
	await cache.use(
		key,
		async append => {
			for (const value of ['/srv', '/srv/example-app'])
				append({
					struct_type: 'node',
					path: value,
					name: path.posix.basename(value),
					type: 'dir',
					size: 0,
					mtime: stamp,
				});
			await consumeMetadataLines(listing(), async line => append(JSON.parse(line)));
		},
		async index => {
			assert.equal(index.count, count + 2);
			assert.equal(index.stats.total_files, count);
			if (count >= 100000) assert(inputBytes > 32 * 1024 ** 2);
			const indexingMs = performance.now() - start;
			const latencies: number[] = [];
			for (let i = 0; i < 50; i++) {
				const t = performance.now();
				const page = index.page({
					path: '/srv/example-app',
					offset: Math.min(i * 200, Math.max(0, count - 200)),
					limit: 200,
					sort: i % 2 ? 'size' : 'name',
					order: i % 3 ? 'asc' : 'desc',
				});
				assert(page.files.length <= 200);
				latencies.push(performance.now() - t);
			}
			latencies.sort((a, b) => a - b);
			let diskBytes = 0;
			for (const directory of await fs.readdir(path.join(scratch, 'indexes')))
				for (const file of await fs.readdir(path.join(scratch, 'indexes', directory)))
					diskBytes += (await fs.stat(path.join(scratch, 'indexes', directory, file))).size;
			console.log(
				JSON.stringify({
					files: count,
					inputBytes,
					logicalBytes: index.stats.total_bytes,
					indexingMs: Math.round(indexingMs),
					baselineRssBytes: baselineRss,
					peakRssBytes: process.resourceUsage().maxRSS * 1024,
					peakHeapBytes: peakHeap,
					diskBytes,
					pageP50Ms: +latencies[25].toFixed(2),
					pageP95Ms: +latencies[47].toFixed(2),
				})
			);
		}
	);
} finally {
	await cache.close();
	await fs.rm(scratch, { recursive: true, force: true });
}
