/** Real authenticated API + read-only SFTP + Restic, in a fresh Linux cgroup.
 * All sources, identities, credentials, snapshots and destinations are disposable.
 * The server never stages a TAR; the test client streams directly to GNU tar. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, fork } from 'node:child_process';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import jwt from 'jsonwebtoken';
import { configService } from '../../src/services/ConfigService';
import { ManagedSftpRepositorySession } from '../../src/utils/restic/ManagedSftpRepositorySession';
import { startLinkFixture, type LinkFixtureConfig } from './managedSymlinkRecovery.runtime';
import {
	run,
	hashTree,
	restic,
	rclone,
	port,
	ready,
	fixture,
	measureProcesses,
} from './managedDownloadRecovery.helpers';

const mode = process.argv[2] || 'small';
const sizes: Record<string, number> = {
	small: 64000,
	large: 1230000000,
	combined: 3170000000,
	four: 4000000000,
};
assert(mode in sizes);
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
const root = await fs.mkdtemp('/lab/symlink-');
const source = path.join(root, 'source', 'app-01'),
	repository = path.join(root, 'sftp', 'application');
const password = crypto.randomBytes(32).toString('hex'),
	sftpPassword = crypto.randomBytes(32).toString('hex'),
	secret = crypto.randomBytes(32).toString('hex');
const headers = {
	'Cookie': `token=${jwt.sign({ user: 'fixture-admin' }, configService.config.SECRET!, { expiresIn: '2h' })}`,
	'Content-Type': 'application/json',
};
const snapshots: Record<string, string> = {};
const monitor = measureProcesses();
let app: Awaited<ReturnType<typeof startLinkFixture>> | undefined,
	sftp: ReturnType<typeof spawn> | undefined,
	child: ReturnType<typeof fork> | undefined;
let phase = 'fixture',
	holdArchive = mode === 'small',
	enteredArchive = false,
	archiveReads = 0;
const results: Record<string, any> = { fixture: mode, serverTemporaryTarBytes: 0 };
const command = async (args: string[]) =>
	(await run(restic, ['--no-cache', '-r', repository, ...args], password)).toString();
function stage(value: string) {
	phase = value;
	console.log(JSON.stringify({ event: 'managed_symlink_lab_progress', fixture: mode, phase }));
}
async function until(check: () => boolean | Promise<boolean>, milliseconds = 30 * 60_000) {
	const deadline = Date.now() + milliseconds;
	while (!(await check())) {
		assert(Date.now() < deadline, 'Fixture state deadline exceeded.');
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}
async function json(response: Response) {
	assert.match(response.headers.get('content-type') || '', /application\/json/);
	return (await response.json()) as any;
}
const query = (exportMode = 'full') =>
	exportMode === 'regular-files' ? '?exportMode=regular-files' : '';
async function admit(base: string, id = 'backup-01', exportMode = 'full') {
	const started = performance.now();
	const response = await fetch(`${base}/${id}/action/download${query(exportMode)}`, {
		method: 'POST',
		headers,
	});
	assert.equal(response.status, 202);
	results.maxAdmissionMs = Math.max(
		results.maxAdmissionMs || 0,
		Math.round(performance.now() - started)
	);
	assert(results.maxAdmissionMs < 4000);
	return (await json(response)).result.preparation.id as string;
}
async function preparation(
	base: string,
	id: string,
	jobId: string,
	exportMode = 'full',
	expectFailure = false
) {
	let result: any;
	await until(async () => {
		const start = performance.now();
		const response = await fetch(
			`${base}/${id}/download-preparations/${jobId}${query(exportMode)}`,
			{ headers }
		);
		assert.equal(response.status, 200);
		result = (await json(response)).result;
		results.maxStatusMs = Math.max(results.maxStatusMs || 0, Math.round(performance.now() - start));
		assert(results.maxStatusMs < 4000);
		return ['ready', 'failed', 'cancelled', 'expired'].includes(result.state);
	});
	if (result.state !== (expectFailure ? 'failed' : 'ready'))
		console.log(
			JSON.stringify({
				event: 'managed_symlink_lab_failure',
				phase,
				state: result.state,
				reason: /^[a-z-]{1,60}$/.test(result.reason || '') ? result.reason : 'unclassified',
				code: /^[a-z-]{1,60}$/.test(result.code || '') ? result.code : 'unclassified',
			})
		);
	assert.equal(result.state, expectFailure ? 'failed' : 'ready');
	if (!expectFailure) {
		assert.equal(result.export.mode, exportMode);
		assert.equal(result.export.binding.snapshotId, snapshots[id]);
	}
	return result;
}
async function extract(
	base: string,
	id: string,
	job: any,
	expected: Awaited<ReturnType<typeof hashTree>>,
	exportMode = 'full'
) {
	const response = await fetch(
		`${base}/${id}/action/download?preparationId=${job.id}${exportMode === 'regular-files' ? '&exportMode=regular-files' : ''}`,
		{ headers }
	);
	assert.equal(response.status, 200);
	assert.match(response.headers.get('content-type') || '', /application\/x-tar/);
	assert.match(response.headers.get('cache-control') || '', /no-store/);
	const target = await fs.mkdtemp(path.join(root, 'client-'));
	const tar = spawn(
		'/bin/tar',
		[
			'--extract',
			'--file',
			'-',
			'--directory',
			target,
			'--no-same-owner',
			'--no-same-permissions',
			'--keep-old-files',
		],
		{ stdio: ['pipe', 'ignore', 'ignore'], shell: false }
	);
	const exited = new Promise<void>((resolve, reject) => {
		tar.once('error', () => reject(new Error('Isolated extractor could not start.')));
		tar.once('close', code =>
			code === 0 ? resolve() : reject(new Error('Isolated TAR extraction failed.'))
		);
	});
	void exited.catch(() => undefined);
	const hash = crypto.createHash('sha256');
	let bytes = 0,
		tail = Buffer.alloc(0);
	const meter = new Transform({
		transform(chunk, _encoding, done) {
			bytes += chunk.length;
			hash.update(chunk);
			tail = Buffer.concat([tail, chunk]).subarray(-1024);
			done(null, chunk);
		},
	});
	try {
		await pipeline(Readable.fromWeb(response.body as any), meter, tar.stdin!);
		await exited;
	} catch (error) {
		tar.kill('SIGKILL');
		await exited.catch(() => undefined);
		throw error;
	}
	assert.equal(bytes, job.export.archiveBytes);
	assert.equal(hash.digest('hex'), job.export.archiveSha256);
	assert.equal(tail.length, 1024);
	assert(tail.every(byte => byte === 0));
	const actual = await hashTree(path.join(target, source.slice(1)));
	const selected = Object.fromEntries(
		Object.entries(expected.entries).filter(
			([, entry]: any) => exportMode === 'full' || ['file', 'dir'].includes(entry.type)
		)
	);
	assert.deepEqual(actual.entries, selected);
	assert.equal(actual.bytes, expected.bytes);
	await fs.rm(target, { recursive: true, force: true });
	return bytes;
}
async function manifest(base: string, id: string, job: any, exportMode = 'full') {
	const response = await fetch(
		`${base}/${id}/download-preparations/${job.id}/manifest${query(exportMode)}`,
		{ headers }
	);
	assert.equal(response.status, 200);
	const hash = crypto.createHash('sha256');
	const decoder = new TextDecoder();
	let lines = 0,
		pending = '';
	for await (const bytes of Readable.fromWeb(response.body as any)) {
		hash.update(bytes);
		pending += decoder.decode(bytes, { stream: true });
		let end: number;
		while ((end = pending.indexOf('\n')) !== -1) {
			const value = JSON.parse(pending.slice(0, end));
			pending = pending.slice(end + 1);
			lines++;
			if (lines === 1) {
				assert.equal(value.mode, exportMode);
				assert.equal(value.binding.snapshotId, snapshots[id]);
			}
			if (value.path && exportMode === 'regular-files')
				assert(['file', 'dir'].includes(value.type));
		}
		assert(Buffer.byteLength(pending) < 64 * 1024);
	}
	pending += decoder.decode();
	assert.equal(pending, '');
	assert.equal(lines, job.export.includedEntries + 2);
	assert.equal(hash.digest('hex'), job.export.manifestSha256);
}
try {
	assert.match((await run(restic, ['version'])).toString(), /restic 0\.19\.1/);
	const disk = await fs.statfs(root);
	assert(disk.bavail * disk.bsize >= 32 * 1024 ** 3, 'Disposable fixture requires 32 GiB free.');
	await fs.mkdir(repository, { recursive: true });
	await fixture(source, mode === 'combined' ? 'combined' : 'small', sizes[mode]);
	await fs.mkdir(path.join(source, 'empty'), { mode: 0o700 });
	await fs.writeFile(path.join(source, 'root.txt'), 'root fixture\n', { mode: 0o600 });
	let long = source;
	for (let n = 0; n < 4; n++) long = path.join(long, `directory-${n}-${'雪'.repeat(24)}`);
	await fs.mkdir(long, { recursive: true, mode: 0o700 });
	await fs.writeFile(path.join(long, 'literal-%2e%2e:雪.txt'), 'literal POSIX bytes\n', {
		mode: 0o600,
	});
	const links: Record<string, string> = {
		'file-link': 'nested/selected.txt',
		'directory-link': 'nested',
		'broken': 'missing',
		'circle-a': 'circle-b',
		'circle-b': 'circle-a',
		'nested/up-link': '../root.txt',
		'unicode-link': path.relative(source, path.join(long, 'literal-%2e%2e:雪.txt')),
	};
	for (const [name, target] of Object.entries(links))
		await fs.symlink(target, path.join(source, name));
	const historical = await hashTree(source);
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
	await backup('backup-01');
	await fs.writeFile(path.join(source, 'nested', 'selected.txt'), 'newer live contents\n', {
		mode: 0o600,
	});
	await fs.unlink(path.join(source, 'file-link'));
	await fs.symlink('changed-after-backup', path.join(source, 'file-link'));
	await backup('backup-02');
	await fs.symlink('/outside-fixture/secret', path.join(source, 'absolute-link'));
	await fs.symlink('../'.repeat(16) + 'escape', path.join(source, 'escaping-link'));
	await backup('backup-03');
	await run('/usr/bin/mkfifo', [path.join(source, 'fifo')]);
	await backup('backup-04');
	const latest = await hashTree(source),
		before = await hashTree(repository);
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
	const config: LinkFixtureConfig = {
		snapshots,
		source,
		secret,
		password,
		sftpPassword,
		port: sftpPort,
		staging: path.join(root, 'staging'),
	};
	const native = new ManagedSftpRepositorySession();
	app = await startLinkFixture(config, {
		withSession: (access, consume, signal, limits) =>
			native.withSession(
				access,
				session =>
					consume({
						...session,
						archive: async (id, destination) => {
							archiveReads++;
							if (!holdArchive) return session.archive(id, destination);
							const held = new Writable({
								write(_chunk, _encoding, done) {
									enteredArchive = true;
									if (signal?.aborted) done(new Error('Cancelled fixture.'));
									else
										signal?.addEventListener('abort', () => done(new Error('Cancelled fixture.')), {
											once: true,
										});
								},
							});
							held.on('error', () => undefined);
							await session.archive(id, held);
						},
					}),
				signal,
				limits
			),
	});
	const base = app.base;
	assert.equal((await fetch(`${base}/backup-01/action/download`, { method: 'POST' })).status, 401);
	if (holdArchive) {
		stage('real-archive-cancellation');
		const cancelled = await admit(base);
		await until(() => enteredArchive, 30_000);
		const response = await fetch(`${base}/backup-01/download-preparations/${cancelled}`, {
			method: 'DELETE',
			headers,
		});
		assert.equal((await json(response)).result.state, 'cancelled');
		assert.equal(
			(await fetch(`${base}/backup-01/action/download?preparationId=${cancelled}`, { headers }))
				.status,
			409
		);
		holdArchive = false;
		results.cancelRetry = 'PASS';
	}
	stage('full-download');
	const id = await admit(base);
	const same = await admit(base);
	assert.equal(same, id);
	const concurrentBrowse = await fetch(
		`${base}/backup-01/files/page?path=${encodeURIComponent(source)}&limit=200`,
		{ headers }
	);
	assert([200, 202].includes(concurrentBrowse.status));
	const full = await preparation(base, 'backup-01', id);
	assert.equal(full.export.includedByType.symlink, 7);
	assert.equal(full.export.excludedEntries, 0);
	if (mode === 'combined') assert(full.indexedEntries >= 115000);
	results.indexedEntries = full.indexedEntries;
	results.logicalBytes = historical.bytes;
	const cache = (app.recovery as any).indexes;
	const originalIndex = [...cache.entries.keys()][0];
	const indexDirectory = cache.entries.get(originalIndex).directory;
	results.indexDatabaseBytes = (await fs.stat(path.join(indexDirectory, 'metadata.sqlite'))).size;
	results.proofDatabaseBytes = (
		await fs.stat(path.join(indexDirectory, 'metadata.sqlite.exports'))
	).size;
	assert(results.indexDatabaseBytes <= 256 * 1024 ** 2);
	assert(results.proofDatabaseBytes <= 128 * 1024 ** 2);
	assert.deepEqual((await fs.readdir(indexDirectory)).sort(), [
		'metadata.sqlite',
		'metadata.sqlite.exports',
	]);
	results.sourceInventorySha256 = crypto
		.createHash('sha256')
		.update(JSON.stringify(historical.entries))
		.digest('hex');
	results.fullManifestSha256 = full.export.manifestSha256;
	results.fullArchiveSha256 = full.export.archiveSha256;
	stage('full-manifest');
	await manifest(base, 'backup-01', full);
	stage('full-extraction');
	results.fullArchiveBytes = await extract(base, 'backup-01', full, historical);
	assert.equal(
		(
			await fetch(
				`${base}/backup-01/action/download?preparationId=${id}&exportMode=regular-files`,
				{ headers }
			)
		).status,
		404
	);
	stage('index-eviction');
	assert.equal(cache.status(originalIndex), 'ready');
	for (const other of ['backup-02', 'backup-03'])
		await until(async () => {
			const result = await fetch(`${base}/${other}/files/page`, { headers });
			assert([200, 202].includes(result.status));
			return result.status === 200;
		});
	assert.equal(cache.status(originalIndex), 'missing');
	assert.equal(
		(await fetch(`${base}/backup-01/action/download?preparationId=${id}`, { headers })).status,
		409
	);
	const rebuilt = await preparation(base, 'backup-01', await admit(base));
	assert.notEqual(rebuilt.id, id);
	assert.equal(rebuilt.export.manifestSha256, full.export.manifestSha256);
	if (mode === 'small') await extract(base, 'backup-01', rebuilt, historical);
	results.evictionAndExplicitReprepare = 'PASS';
	stage('partial-download');
	const partial = await preparation(
		base,
		'backup-04',
		await admit(base, 'backup-04', 'regular-files'),
		'regular-files'
	);
	assert.equal(partial.export.excludedByType.symlink, 9);
	assert.equal(partial.export.excludedByType.fifo, 1);
	results.partialManifestSha256 = partial.export.manifestSha256;
	results.partialArchiveSha256 = partial.export.archiveSha256;
	await manifest(base, 'backup-04', partial, 'regular-files');
	results.partialArchiveBytes = await extract(base, 'backup-04', partial, latest, 'regular-files');
	stage('unsafe-full-refusal');
	for (const [snapshot, reason] of [
		['backup-03', 'unsafe-link-target'],
		['backup-04', 'unsupported-node-type'],
	]) {
		const refused = await preparation(base, snapshot, await admit(base, snapshot), 'full', true);
		assert.equal(refused.reason, reason);
		assert.equal(refused.export, undefined);
	}
	stage('full-restore');
	const restoreConfig = {
		target: '',
		overwrite: 'never' as const,
		delete: false,
		includes: [],
		excludes: [],
	};
	const restoreId = await app.recovery.restore('backup-01', restoreConfig);
	await until(() => !app!.rows.get(restoreId).inProgress);
	const row = app.rows.get(restoreId);
	assert.equal(row.status, 'completed');
	assert.deepEqual(
		(await hashTree(path.join(row.config.target, source.slice(1)))).entries,
		historical.entries
	);
	stage('selected-restore');
	const selectedId = await app.recovery.restore('backup-01', {
		...restoreConfig,
		includes: [path.join(source, 'file-link'), path.join(source, 'nested', 'selected.txt')],
	});
	await until(() => !app!.rows.get(selectedId).inProgress);
	const selected = app.rows.get(selectedId);
	assert.equal(selected.status, 'completed');
	assert.equal(
		await fs.readlink(path.join(selected.config.target, source.slice(1), 'file-link')),
		links['file-link']
	);
	assert.equal(
		await fs.readFile(
			path.join(selected.config.target, source.slice(1), 'nested', 'selected.txt'),
			'utf8'
		),
		'selected historical fixture\n'
	);
	stage('recovery-test');
	const recoveryRoot = await fs.mkdtemp(path.join(root, 'recovery-test-'));
	const recovered = await app.recovery.testRestore(
		{
			backupId: 'backup-01',
			planId: 'plan-01',
			repositoryId: 'repository-01',
			snapshotId: snapshots['backup-01'],
		},
		recoveryRoot,
		new AbortController().signal,
		() => {},
		async () => {
			assert((await fs.lstat(recoveryRoot)).isDirectory());
		}
	);
	assert.equal(
		recovered.files,
		Object.values(historical.entries).filter((entry: any) => entry.type === 'file').length
	);
	assert.deepEqual(
		(await hashTree(path.join(recoveryRoot, source.slice(1)))).entries,
		historical.entries
	);
	if (mode === 'small') {
		stage('fresh-process-restart');
		await app.close();
		app = undefined;
		child = fork(
			fileURLToPath(new URL('./managedSymlinkRecovery.restart.ts', import.meta.url)),
			[],
			{ execArgv: process.execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
		);
		const receive = () =>
			new Promise<any>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('Fresh process deadline.')), 30000);
				child!.once('message', message => {
					clearTimeout(timer);
					resolve(message);
				});
			});
		const started = receive();
		child.send({ config });
		const peer = await started;
		assert.equal(peer.ready, true);
		const previous = (
			await json(await fetch(`${peer.base}/backup-01/download-preparations/${id}`, { headers }))
		).result;
		assert.equal(previous.state, 'expired');
		const fresh = await preparation(peer.base, 'backup-01', await admit(peer.base));
		assert.equal(fresh.export.manifestSha256, full.export.manifestSha256);
		await extract(peer.base, 'backup-01', fresh, historical);
		const stopped = receive();
		child.send({ stop: true });
		assert.equal((await stopped).closed, true);
		await new Promise<void>(resolve =>
			child!.exitCode !== null ? resolve() : child!.once('exit', () => resolve())
		);
		child = undefined;
		results.freshProcess = 'PASS';
	}
	stage('immutability-and-resources');
	assert.deepEqual(await hashTree(repository), before);
	assert.deepEqual(await hashTree(source), latest);
	const memoryEvents = await fs.readFile('/sys/fs/cgroup/memory.events', 'utf8');
	assert.match(memoryEvents, /oom_kill 0/);
	assert.match(memoryEvents, /oom 0/);
	Object.assign(results, {
		fullDownload: 'PASS',
		regularFilesOnly: 'PASS',
		fullRestore: 'PASS',
		selectedRestore: 'PASS',
		recoveryTest: 'PASS',
		readOnlyRepository: 'PASS',
		archiveReads,
		...monitor.result(),
		cgroupMemoryPeak: Number((await fs.readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim()),
	});
	console.log(JSON.stringify({ event: 'managed_symlink_lab', ...results }));
} catch (error) {
	console.log(
		JSON.stringify({
			event: 'managed_symlink_lab_error',
			phase,
			kind:
				error instanceof Error &&
				['Isolated TAR extraction failed.', 'Isolated extractor could not start.'].includes(
					error.message
				)
					? error.message
					: 'unclassified',
		})
	);
	if (error instanceof assert.AssertionError)
		console.log(
			JSON.stringify({
				event: 'managed_symlink_lab_assertion',
				phase,
				operator: error.operator,
				actual:
					typeof error.actual === 'number' || typeof error.actual === 'boolean'
						? error.actual
						: undefined,
				expected:
					typeof error.expected === 'number' || typeof error.expected === 'boolean'
						? error.expected
						: undefined,
			})
		);
	throw new Error(
		`Disposable symlink lab failed (${phase}); private provider/configuration output withheld.`
	);
} finally {
	monitor.stop();
	await app?.close();
	if (child && child.exitCode === null) child.kill('SIGKILL');
	if (sftp && sftp.exitCode === null && sftp.signalCode === null) {
		const closed = new Promise<void>(resolve => sftp!.once('close', () => resolve()));
		sftp.kill('SIGTERM');
		await closed;
	}
	assert.equal(path.dirname(root), '/lab');
	assert(/^symlink-[A-Za-z0-9]+$/.test(path.basename(root)));
	await fs.rm(root, { recursive: true, force: true });
	console.log(
		JSON.stringify({ event: 'managed_symlink_lab_cleanup', fixture: mode, removed: true })
	);
}
