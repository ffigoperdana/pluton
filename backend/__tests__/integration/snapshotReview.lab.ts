/** Real read-only SFTP/Restic comparison. Fresh synthetic inputs only; no external endpoints. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import jwt from 'jsonwebtoken';
import { configService } from '../../src/services/ConfigService';
import { ManagedSftpRepositorySession } from '../../src/utils/restic/ManagedSftpRepositorySession';
import { startLinkFixture } from './managedSymlinkRecovery.runtime';
import {
	run,
	restic,
	rclone,
	port,
	ready,
	hashTree,
	measureProcesses,
} from './managedDownloadRecovery.helpers';
assert.equal(process.getuid?.(), 1000);
assert.equal(
	(await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(),
	String(4 * 1024 ** 3)
);
assert.equal((await fs.readFile('/sys/fs/cgroup/memory.swap.max', 'utf8')).trim(), '0');
const [quota, period] = (await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8'))
	.trim()
	.split(/\s+/)
	.map(Number);
assert.equal(quota / period, 2);
const root = await fs.mkdtemp('/lab/snapshot-review-'),
	source = path.join(root, 'source'),
	repository = path.join(root, 'sftp', 'application');
const password = crypto.randomBytes(32).toString('hex'),
	sftpPassword = crypto.randomBytes(32).toString('hex'),
	secret = crypto.randomBytes(32).toString('hex');
const monitor = measureProcesses();
let sftp: ReturnType<typeof spawn> | undefined,
	app: Awaited<ReturnType<typeof startLinkFixture>> | undefined;
const snapshots: Record<string, string> = {};
const fileCount = process.argv[2] === 'small' ? 3 : 100005;
let archives = 0,
	diffs = 0;
const command = async (args: string[]) =>
	(await run(restic, ['--no-cache', '-r', repository, ...args], password)).toString();
try {
	await fs.mkdir(source, { recursive: true });
	await fs.mkdir(repository, { recursive: true });
	for (let i = 0; i < fileCount; i++)
		await fs.writeFile(path.join(source, `file-${String(i).padStart(6, '0')}`), 'same\n');
	await fs.writeFile(path.join(source, 'modified.txt'), 'before\n');
	await fs.writeFile(path.join(source, 'deleted.txt'), 'remove\n');
	await fs.symlink('modified.txt', path.join(source, 'relative-link'));
	await command(['init']);
	const backup = async (id: string) => {
		snapshots[id] = JSON.parse(
			(
				await command([
					'--json',
					'backup',
					source,
					'--tag',
					'pluton-plan-plan-01',
					'--tag',
					`pluton-backup-${id}`,
				])
			)
				.trim()
				.split('\n')
				.at(-1)!
		).snapshot_id;
	};
	await backup('before');
	const stat = await fs.stat(path.join(source, 'modified.txt'));
	await fs.writeFile(path.join(source, 'modified.txt'), 'after!\n');
	await fs.utimes(path.join(source, 'modified.txt'), stat.atime, stat.mtime);
	await fs.rm(path.join(source, 'deleted.txt'));
	await fs.writeFile(path.join(source, 'new & 雪.txt'), 'added\n');
	await fs.unlink(path.join(source, 'relative-link'));
	await fs.symlink('new & 雪.txt', path.join(source, 'relative-link'));
	await backup('after');
	const before = await hashTree(repository),
		sourceBefore = await hashTree(source);
	const sftpPort = await port();
	sftp = spawn(
		rclone,
		[
			'serve',
			'sftp',
			path.dirname(repository),
			'--addr',
			`127.0.0.1:${sftpPort}`,
			'--user',
			'fixture-user',
			'--pass',
			sftpPassword,
			'--read-only',
			'--cache-dir',
			path.join(root, 'rclone-cache'),
		],
		{ stdio: 'ignore' }
	);
	await ready(sftpPort);
	const native = new ManagedSftpRepositorySession();
	app = await startLinkFixture(
		{
			snapshots,
			source,
			secret,
			password,
			sftpPassword,
			port: sftpPort,
			staging: path.join(root, 'staging'),
		},
		{
			withSession: (access, consume, signal, limits) =>
				native.withSession(
					access,
					session =>
						consume({
							...session,
							archive: async () => {
								archives++;
								throw new Error('Comparisons must never read archives.');
							},
							diff: async (previous, current, consume) => {
								diffs++;
								return session.diff!(previous, current, record => {
									if (record.message_type === 'change')
										console.log(
											JSON.stringify({
												event: 'native_diff_evidence',
												modifier: record.modifier,
												trailingSlash: record.path.endsWith('/'),
												root: record.path === '/',
											})
										);
									consume(record);
								});
							},
						}),
					signal,
					limits
				),
		}
	);
	const headers = {
		'Cookie': `token=${jwt.sign({ user: 'fixture-admin' }, configService.config.SECRET!, { expiresIn: '1h' })}`,
		'Content-Type': 'application/json',
	};
	const endpoint = `${app.base}/after/comparison`;
	const started = performance.now();
	let response = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
	assert.equal(response.status, 202);
	const admissionMs = performance.now() - started;
	assert(admissionMs < 4000);
	let state: any;
	const deadline = Date.now() + 15 * 60000;
	do {
		response = await fetch(endpoint, { headers });
		assert.equal(response.status, 200);
		state = ((await response.json()) as any).result;
		if (state.state !== 'preparing') break;
		assert(Date.now() < deadline);
		await new Promise(r => setTimeout(r, 100));
	} while (true);
	if (state.state !== 'ready')
		console.log(
			JSON.stringify({ phase: 'comparison-failure', failureCode: state.failureCode, diffs })
		);
	assert.equal(state.state, 'ready', state.reason);
	const comparisonMs = Math.round(performance.now() - started);
	assert.deepEqual(state.summary, {
		added: 1,
		modified: 1,
		unchanged: fileCount,
		deleted: 1,
		addedLogicalBytes: 6,
		removedLogicalBytes: 7,
	});
	response = await fetch(endpoint + '?view=files&change=deleted&recursive=true', { headers });
	const deleted = ((await response.json()) as any).result.files;
	assert.equal(deleted.length, 1);
	assert.equal(deleted[0].snapshotId, snapshots.before);
	assert.equal(deleted[0].isAvailable, false);
	response = await fetch(
		endpoint + `?view=files&path=${encodeURIComponent(source)}&offset=400&limit=200`,
		{ headers }
	);
	assert.equal(((await response.json()) as any).result.files.length, fileCount === 3 ? 0 : 200);
	response = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
	assert.equal(((await response.json()) as any).result.state, 'ready');
	assert.equal(diffs, 1);
	assert.equal(archives, 0);
	assert.equal((await app.recovery.comparison('before', 'status')).state, 'unavailable');
	assert.deepEqual(await hashTree(repository), before);
	assert.deepEqual(await hashTree(source), sourceBefore);
	await command(['--no-lock', 'check', '--read-data']);
	monitor.stop();
	const usage = {
		...monitor.result(),
		cgroupPeakBytes: Number((await fs.readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim()),
		cacheBytes:
			(await fs.statfs(root)).blocks * (await fs.statfs(root)).bsize -
			(await fs.statfs(root)).bfree * (await fs.statfs(root)).bsize,
	};
	console.log(
		JSON.stringify({
			event: 'snapshot_review_native_pass',
			entries: fileCount + 3,
			admissionMs: Math.round(admissionMs),
			comparisonMs,
			archives,
			diffs,
			usage,
		})
	);
} finally {
	await app?.close();
	sftp?.kill('SIGTERM');
	await monitor.stop();
	await fs.rm(root, { recursive: true, force: true });
}
