/* Real per-job SQL workspace reproduction; fresh synthetic data, loopback SFTP only. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { configService } from '../../src/services/ConfigService';
import { ManagedSftpRepositorySession } from '../../src/utils/restic/ManagedSftpRepositorySession';
import { startLinkFixture, type LinkFixtureConfig } from './managedSymlinkRecovery.runtime';
import { restic, rclone, port, ready, hashTree } from './managedDownloadRecovery.helpers';
const exec = promisify(execFile);
assert.equal(process.getuid?.(), 1000);
assert.equal(
	(await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(),
	String(4 * 1024 ** 3)
);
const [quota, period] = (await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8'))
	.trim()
	.split(/\s+/)
	.map(Number);
assert.equal(quota / period, 2);
const root = await fs.mkdtemp('/lab/snapshot-db-');
const source = path.join(root, 'source'),
	repository = path.join(root, 'sftp', 'application');
const password = crypto.randomBytes(32).toString('hex'),
	sftpPassword = crypto.randomBytes(32).toString('hex');
const config: LinkFixtureConfig = {
	snapshots: {},
	receipts: {},
	source,
	password,
	sftpPassword,
	secret: crypto.randomBytes(32).toString('hex'),
	port: await port(),
	staging: path.join(root, 'staging'),
};
let sftp: ReturnType<typeof spawn> | undefined,
	app: Awaited<ReturnType<typeof startLinkFixture>> | undefined;
const command = async (args: string[], cwd?: string) => {
	try {
		return (
			await exec(restic, ['--no-cache', '-r', repository, ...args], {
				env: { ...process.env, RESTIC_PASSWORD: password },
				cwd,
				encoding: 'utf8',
				timeout: 180000,
				maxBuffer: 8 * 1024 ** 2,
			})
		).stdout;
	} catch {
		throw new Error('Synthetic Restic fixture process failed.');
	}
};
try {
	await fs.mkdir(source, { recursive: true });
	await fs.mkdir(repository, { recursive: true });
	await fs.mkdir(path.join(root, 'jobs'), { recursive: true });
	await fs.writeFile(path.join(source, 'unchanged.txt'), 'unchanged\n');
	await command(['init']);
	const backup = async (id: string, name?: string, sql = 'SELECT 1;\n', large = false) => {
		const workspace = await fs.mkdtemp(path.join(root, 'jobs', 'job-'));
		const inputs = [source];
		if (name) {
			const directory = path.join(workspace, 'pluton', 'database'),
				file = path.join(directory, name);
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(file, sql);
			if (large) await fs.truncate(file, 8 * 1024 ** 3);
			const hash = crypto.createHash('sha256');
			for await (const chunk of createReadStream(file)) hash.update(chunk);
			config.receipts![id] = {
				lifecycle: {
					database: {
						path: '/pluton/database/' + name,
						...(id === 'before'
							? {}
							: { databaseId: 'db_app', engine: 'mariadb', database: 'app' }),
						bytes: (await fs.stat(file)).size,
						sha256: hash.digest('hex'),
					},
				},
			} as any;
			inputs.push('pluton/database/' + name);
		}
		const summary = (
			await command(
				[
					'--json',
					'backup',
					...inputs,
					'--tag',
					'pluton-plan-plan-01',
					'--tag',
					'pluton-backup-' + id,
				],
				workspace
			)
		)
			.trim()
			.split('\n')
			.at(-1)!;
		config.snapshots[id] = JSON.parse(summary).snapshot_id;
	};
	await backup('before', 'app.sql', 'SELECT 1;\n');
	await backup('after', 'app.sql', 'SELECT 2;\n');
	const scenarios: {
		id: string;
		previous: string;
		added: number;
		modified: number;
		deleted: number;
	}[] = [];
	if (process.env.PLUTON_EXPECT_COMPARE_FAILURE !== '1') {
		await backup('fs-before');
		await backup('fs-after');
		scenarios.push({ id: 'fs-after', previous: 'fs-before', added: 0, modified: 0, deleted: 0 });
		await backup('db-added', 'app.sql');
		scenarios.push({ id: 'db-added', previous: 'fs-after', added: 1, modified: 0, deleted: 0 });
		await backup('db-changed', 'app.sql', 'SELECT 3;\n');
		scenarios.push({ id: 'db-changed', previous: 'db-added', added: 0, modified: 1, deleted: 0 });
		await backup('db-renamed', 'renamed.sql', 'SELECT 4;\n');
		scenarios.push({ id: 'db-renamed', previous: 'db-changed', added: 1, modified: 0, deleted: 1 });
		await backup('db-removed');
		scenarios.push({ id: 'db-removed', previous: 'db-renamed', added: 0, modified: 0, deleted: 1 });
		if (process.env.PLUTON_COMPARE_LARGE_FIXTURE === '1') {
			await backup('large-before', 'app.sql', 'SELECT 5;\n', true);
			await backup('large-after', 'app.sql', 'SELECT 6;\n', true);
			scenarios.push({
				id: 'large-after',
				previous: 'large-before',
				added: 0,
				modified: 1,
				deleted: 0,
			});
		}
	}
	const metadata = JSON.parse(await command(['--no-lock', 'snapshots', '--json']));
	const rootsDiffer =
		JSON.stringify(
			metadata
				.find((s: any) => s.id === config.snapshots.before)
				.paths.slice()
				.sort()
		) !==
		JSON.stringify(
			metadata
				.find((s: any) => s.id === config.snapshots.after)
				.paths.slice()
				.sort()
		);
	assert(rootsDiffer);
	const listing = (await command(['--no-lock', 'ls', '--json', config.snapshots.after]))
		.trim()
		.split('\n')
		.map(line => JSON.parse(line));
	assert(listing.some(node => node.path === '/pluton/database/app.sql' && node.type === 'file'));
	const before = await hashTree(repository),
		original = await hashTree(source);
	sftp = spawn(
		rclone,
		[
			'serve',
			'sftp',
			path.dirname(repository),
			'--addr',
			'127.0.0.1:' + config.port,
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
	await ready(config.port);
	const native = new ManagedSftpRepositorySession();
	let archives = 0,
		diffs = 0;
	app = await startLinkFixture(config, {
		withSession: (access, consume, signal, limits) =>
			native.withSession(
				access,
				session =>
					consume({
						...session,
						archive: async () => {
							archives++;
							throw new Error('Comparison must not read an archive.');
						},
						diff: async (previous, current, onRecord) => {
							diffs++;
							return session.diff!(previous, current, onRecord);
						},
					}),
				signal,
				limits
			),
	});
	const headers = {
		'Cookie':
			'token=' +
			jwt.sign({ user: 'fixture-admin' }, configService.config.SECRET!, { expiresIn: '1h' }),
		'Content-Type': 'application/json',
	};
	const endpoint = app.base + '/after/comparison';
	assert.equal((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
	assert.equal((await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({previousBackupId:'other'})})).status,400);
	assert.equal(diffs,0);
	const get = async () => {
		const response = await fetch(endpoint, { headers });
		assert.equal(response.status, 200);
		return ((await response.json()) as any).result;
	};
	assert.equal((await get()).state, 'missing');
	assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{}' })).status, 202);
	const deadline = Date.now() + 120000;
	let result: any;
	do {
		result = await get();
		if (result.state !== 'preparing') break;
		assert(Date.now() < deadline);
		await new Promise(r => setTimeout(r, 100));
	} while (true);
	if (process.env.PLUTON_EXPECT_COMPARE_FAILURE === '1') {
		assert.equal(result.state, 'failed');
		assert.equal(result.failureCode, 'preparing-409');
		assert.equal(result.failureCategory, 'binding-mismatch');
		assert.equal(result.processedEntries, 0);
		assert.equal(diffs, 0);
	} else {
		assert.equal(
			result.state,
			'ready',
			JSON.stringify({
				failureCode: result.failureCode,
				failureCategory: result.failureCategory,
				failureDetail: result.failureDetail,
			})
		);
		assert.deepEqual(result.summary, {
			added: 0,
			modified: 1,
			unchanged: 1,
			deleted: 0,
			addedLogicalBytes: 0,
			removedLogicalBytes: 0,
		});
		const page = await fetch(endpoint + '?view=files&path=%2Fpluton%2Fdatabase&change=modified', {
			headers,
		});
		assert.equal(page.status, 200);
		assert.deepEqual(
			((await page.json()) as any).result.files.map((file: any) => file.path),
			['/pluton/database/app.sql']
		);
		assert.equal(diffs, 1);
	}
	for (const scenario of scenarios) {
		const url = app.base + '/' + scenario.id + '/comparison';
		const initial = await fetch(url, { headers });
		assert.equal(((await initial.json()) as any).result.state, 'missing');
		assert.equal((await fetch(url, { headers, method: 'POST', body: '{}' })).status, 202);
		const until = Date.now() + 120000;
		let state: any;
		do {
			const response = await fetch(url, { headers });
			assert.equal(response.status, 200);
			state = ((await response.json()) as any).result;
			if (state.state !== 'preparing') break;
			assert(Date.now() < until);
			await new Promise(r => setTimeout(r, 100));
		} while (true);
		assert.equal(
			state.state,
			'ready',
			JSON.stringify({ failureCode: state.failureCode, failureDetail: state.failureDetail })
		);
		assert.equal(state.previousBackupId, scenario.previous);
		assert.equal(state.summary.added, scenario.added);
		assert.equal(state.summary.modified, scenario.modified);
		assert.equal(state.summary.deleted, scenario.deleted);
		assert.equal(state.summary.unchanged, 1);
		const pageUrl =
			url +
			'?view=files&recursive=true&limit=1&change=' +
			(scenario.added
				? 'added'
				: scenario.deleted
					? 'deleted'
					: scenario.modified
						? 'modified'
						: 'unchanged');
		let offset = 0,
			seen = 0;
		do {
			const response = await fetch(pageUrl + '&offset=' + offset, { headers });
			const payload = (await response.json()) as any;
			if (response.status !== 200)
				console.log(
					JSON.stringify({
						event: 'native_comparison_page_failure',
						scenario: scenario.id,
						offset,
						status: response.status,
						code: payload.code,
						failureCategory: payload.failureCategory,
						failureDetail: payload.failureDetail,
						pidsEvents: await fs.readFile('/sys/fs/cgroup/pids.events', 'utf8'),
						pidsCurrent: Number(await fs.readFile('/sys/fs/cgroup/pids.current', 'utf8')),
					})
				);
			assert.equal(response.status, 200);
			const page = payload.result;
			assert(page.files.length <= 1);
			assert.equal(page.previousBackupId, scenario.previous);
			seen += page.files.length;
			if (page.nextOffset === null) {
				assert.equal(seen, page.total);
				break;
			}
			offset = page.nextOffset;
		} while (true);
		console.log(
			JSON.stringify({
				event: 'snapshot_db_scenario',
				scenario: scenario.id,
				state: state.state,
				compatibility: state.compatibility,
				summary: state.summary,
				elapsedMs: state.elapsedMs,
			})
		);
	}

	assert.equal(app.rows.size,0);
	assert.equal(archives, 0);
	assert.deepEqual(await hashTree(repository), before);
	assert.deepEqual(await hashTree(source), original);
	console.log(
		JSON.stringify({
			event: 'snapshot_db_comparison',
			cgroupPeakBytes: Number(await fs.readFile('/sys/fs/cgroup/memory.peak', 'utf8')),
			pidsEvents: await fs.readFile('/sys/fs/cgroup/pids.events', 'utf8'),
			rootsDiffer,
			state: result.state,
			failureCode: result.failureCode,
			failureCategory: result.failureCategory,
			processedEntries: result.processedEntries,
			diffs,
			archives,
			elapsedMs: result.elapsedMs,
		})
	);
} finally {
	await app?.close();
	sftp?.kill('SIGTERM');
	await fs.rm(root, { recursive: true, force: true });
}
