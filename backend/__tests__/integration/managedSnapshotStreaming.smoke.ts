/** Real 100k-file fixture; no production mounts/network and no temporary TAR. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import tar from 'tar-stream';
import Cryptr from 'cryptr';
import { RemoteRepositoryRecoveryService } from '../../src/services/RemoteRepositoryRecoveryService';

const exec = promisify(execFile),
	restic = '/usr/local/bin/restic',
	rclone = '/usr/local/bin/rclone';
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-large-native-'));
const repository = path.join(scratch, 'sftp', 'application'),
	source = path.join(scratch, 'source', 'app-01');
const password = crypto.randomBytes(32).toString('base64url'),
	sftpPassword = crypto.randomBytes(32).toString('base64url');
const secret = crypto.randomBytes(32).toString('base64url');
let server: ReturnType<typeof spawn> | undefined,
	service: RemoteRepositoryRecoveryService | undefined;
async function run(args: string[]) {
	try {
		return (
			await exec(restic, args, {
				env: { ...process.env, RESTIC_PASSWORD: password },
				maxBuffer: 32 * 1024 ** 2,
				timeout: 600000,
			})
		).stdout;
	} catch {
		throw new Error('Disposable Restic fixture failed.');
	}
}
async function repositoryDigest() {
	const digest = crypto.createHash('sha256');
	async function visit(directory: string) {
		for (const name of (await fs.readdir(directory)).sort()) {
			const file = path.join(directory, name),
				stat = await fs.lstat(file);
			if (stat.isDirectory()) await visit(file);
			else {
				digest.update(path.relative(repository, file));
				digest.update(await fs.readFile(file));
			}
		}
	}
	await visit(repository);
	return digest.digest('hex');
}
try {
	assert.match(await run(['version']), /restic 0\.19\.1/);
	await fs.mkdir(repository, { recursive: true });
	await fs.mkdir(source, { recursive: true });
	const count = 100000;
	for (let start = 0; start < count; start += 32)
		await Promise.all(
			Array.from({ length: Math.min(32, count - start) }, (_, j) =>
				fs.writeFile(
					path.join(source, `file-${String(start + j).padStart(6, '0')}-${'x'.repeat(80)}.txt`),
					'fixture\n',
					{ mode: 0o600 }
				)
			)
		);
	await run(['--no-cache', '-r', repository, 'init']);
	const output = await run([
		'--no-cache',
		'-r',
		repository,
		'--json',
		'backup',
		'--tag',
		'pluton-plan-plan-01',
		'--tag',
		'pluton-backup-backup-01',
		source,
	]);
	const snapshotId = JSON.parse(output.trim().split('\n').at(-1)!).snapshot_id;
	assert.match(snapshotId, /^[a-f0-9]{64}$/);
	const before = await repositoryDigest();
	let metadataBytes = 0;
	const listing = spawn(
		restic,
		['--no-lock', '--no-cache', '--json', '-r', repository, 'ls', snapshotId, '--long'],
		{
			env: { ...process.env, RESTIC_PASSWORD: password },
			stdio: ['ignore', 'pipe', 'ignore'],
			shell: false,
		}
	);
	const listed = new Promise<void>((resolve, reject) => {
		listing.on('error', reject);
		listing.on('close', code =>
			code === 0 ? resolve() : reject(new Error('Fixture listing failed.'))
		);
	});
	for await (const chunk of listing.stdout!) metadataBytes += chunk.length;
	await listed;
	assert(metadataBytes > 32 * 1024 ** 2);
	const socket = net.createServer();
	await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
	const port = (socket.address() as net.AddressInfo).port;
	await new Promise<void>(resolve => socket.close(() => resolve()));
	server = spawn(
		rclone,
		[
			'serve',
			'sftp',
			path.dirname(repository),
			'--addr',
			`127.0.0.1:${port}`,
			'--user',
			'fixture-user',
			'--pass',
			sftpPassword,
			'--read-only',
			'--cache-dir',
			path.join(scratch, 'rclone-cache'),
		],
		{ stdio: 'ignore', shell: false }
	);
	for (let attempt = 0; ; attempt++) {
		const ready = await new Promise<boolean>(resolve => {
			const client = net.createConnection({ host: '127.0.0.1', port });
			client.once('connect', () => {
				client.destroy();
				resolve(true);
			});
			client.once('error', () => {
				client.destroy();
				resolve(false);
			});
		});
		if (ready) break;
		assert(attempt < 200);
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	const plan = {
		id: 'plan-01',
		sourceId: 'app-01',
		sourceType: 'device',
		method: 'backup',
		storageId: 'storage-01',
		storagePath: 'application',
	};
	const backup = {
		...plan,
		id: 'backup-01',
		planId: plan.id,
		status: 'completed',
		success: true,
		inProgress: false,
		completionStats: { snapshot_id: snapshotId },
	};
	const repo = {
		id: 'repository-01',
		planId: plan.id,
		agentId: 'agent-01',
		storageId: plan.storageId,
		storagePath: plan.storagePath,
		initializedAt: new Date(),
		encryptedPassword: new Cryptr(secret).encrypt(password),
	};
	service = new RemoteRepositoryRecoveryService(
		{ getByPlanId: async () => repo } as any,
		{ getById: async () => backup } as any,
		{ getById: async () => plan } as any,
		{} as any,
		{
			getSftpRecoveryOptions: async () => ({
				host: '127.0.0.1',
				port: String(port),
				user: 'fixture-user',
				pass: sftpPassword,
			}),
		},
		{ getAgentById: async () => ({ deviceId: 'app-01' }) } as any,
		undefined,
		secret,
		path.join(scratch, 'staging')
	);
	const start = performance.now();
	let page = await service.browsePage('backup-01', { path: source, limit: 200 });
	assert.equal(page.status, 'indexing');
	// This separate fixture backup owns repository writes; browsing remains no-lock/read-only.
	const concurrentBackup = run(['--no-cache', '-r', repository, '--json', 'backup', source]);
	while (page.status === 'indexing') {
		await new Promise(resolve => setTimeout(resolve, 100));
		page = await service.browsePage('backup-01', { path: source, limit: 200 });
	}
	assert.equal(page.total, count);
	assert.equal(page.files.length, 200);
	await concurrentBackup;
	const afterBackup = await repositoryDigest();
	assert.notEqual(
		afterBackup,
		before,
		'The concurrent fixture backup created a new historical snapshot.'
	);
	const indexingMs = performance.now() - start;
	const requestStart = performance.now();
	const next = await service.browsePage('backup-01', {
		path: source,
		limit: 200,
		offset: 200,
		sort: 'size',
		order: 'desc',
	});
	assert.equal(next.status, 'ready');
	const pageMs = performance.now() - requestStart;
	const preview = await service.preview('backup-01', {
		target: '',
		overwrite: 'never',
		includes: [],
		excludes: [],
		delete: false,
	});
	assert.equal(preview.stats.total_files, count);
	assert.equal(preview.files.length, 5000);
	assert.equal(preview.truncated, true);
	await assert.rejects(
		service.browse('backup-01'),
		(error: any) => error.code === 'pagination-required'
	);
	await service.prepareDownload('backup-01');
	const extract = tar.extract();
	let archiveFiles = 0,
		archiveBytes = 0;
	extract.on('entry', (header, body, nextEntry) => {
		if (header.type === 'file') {
			assert.equal(header.size, 8);
			archiveFiles++;
		}
		assert(!header.name.split('/').includes('..'));
		body.on('end', nextEntry);
		body.resume();
	});
	const transfer = new Transform({
		transform(chunk, _encoding, done) {
			archiveBytes += chunk.length;
			done(null, chunk);
		},
	});
	transfer.pipe(extract);
	const complete = finished(extract);
	const downloadStart = performance.now();
	let headersMs = 0;
	await (
		await service.download('backup-01')
	).streamTo(transfer, new AbortController().signal, () => {
		headersMs = performance.now() - downloadStart;
	});
	transfer.end();
	await complete;
	assert.equal(archiveFiles, count);
	assert.equal(
		await repositoryDigest(),
		afterBackup,
		'All repository objects, including lock inventory, remain unchanged.'
	);
	let cacheDiskBytes = 0;
	const cacheRoot = path.join(scratch, 'managed-snapshot-indexes');
	for (const directory of await fs.readdir(cacheRoot))
		for (const file of await fs.readdir(path.join(cacheRoot, directory)))
			cacheDiskBytes += (await fs.stat(path.join(cacheRoot, directory, file))).size;
	const cgroupPeak = await fs
		.readFile('/sys/fs/cgroup/memory.peak', 'utf8')
		.catch(() => 'unavailable');
	console.log(
		JSON.stringify({
			native: 'restic-0.19.1-read-only-sftp',
			files: count,
			metadataBytes,
			indexingMs: Math.round(indexingMs),
			pageMs: Math.round(pageMs),
			downloadHeadersMs: Math.round(headersMs),
			downloadMs: Math.round(performance.now() - downloadStart),
			archiveFiles,
			archiveBytes,
			cacheDiskBytes,
			nodePeakRssBytes: process.resourceUsage().maxRSS * 1024,
			cgroupPeakBytes: cgroupPeak.trim(),
			temporaryTarBytes: 0,
		})
	);
} finally {
	await service?.close();
	if (server && server.exitCode === null && server.signalCode === null) {
		const closed = new Promise<void>(resolve => server!.once('close', () => resolve()));
		server.kill('SIGTERM');
		await closed;
	}
	await fs.rm(scratch, { recursive: true, force: true });
}
