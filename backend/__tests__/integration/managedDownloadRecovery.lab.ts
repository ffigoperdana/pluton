/** Opt-in real HTTP, authenticated controller/service, read-only SFTP and Linux extraction.
 * Domain records are disposable in-memory stores; the metadata index is real SQLite.
 * No caller-selected filesystem, repository, host or credential can enter this lab.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, fork } from 'node:child_process';
import { Readable } from 'node:stream';
import express from 'express';
import jwt from 'jsonwebtoken';
import Cryptr from 'cryptr';
import { BackupService } from '../../src/services/BackupServices';
import { BackupController } from '../../src/controllers/BackupController';
import { createBackupRouter } from '../../src/routes/backups';
import { configService } from '../../src/services/ConfigService';
import { RemoteRepositoryRecoveryService } from '../../src/services/RemoteRepositoryRecoveryService';
import { processManager } from '../../src/managers/ProcessManager';
import { ManagedSftpRepositorySession } from '../../src/utils/restic/ManagedSftpRepositorySession';
import {
	run,
	hashTree,
	restic,
	rclone,
	port,
	ready,
	fixture,
	receive,
	checkTar,
	measureProcesses,
} from './managedDownloadRecovery.helpers';

const mode = process.argv[2] || 'small';
const sizes: Record<string, number> = {
	small: 120_000_000,
	proxy: 120_000_000,
	history: 0,
	delay: 0,
	combined: 3_170_000_000,
	medium: 1_230_000_000,
	large: Math.round(3.16 * 1024 ** 3),
	four: 4_000_000_000,
	metadata: 0,
	colon: 0,
	percent: 0,
	symlink: 0,
	fifo: 0,
};
assert(mode in sizes);
assert.equal(process.getuid?.(), 1000, 'Extraction must run unprivileged.');
const scratch = await fs.mkdtemp('/lab/run-'),
	source = path.join(scratch, 'source', 'app-01'),
	repository = path.join(scratch, 'sftp', 'application');
const password = crypto.randomBytes(32).toString('base64url'),
	sftpPassword = crypto.randomBytes(32).toString('base64url'),
	secret = crypto.randomBytes(32).toString('base64url');
const measurements: Record<string, any> = { fixture: mode, serverTemporaryTarBytes: 0 };
const monitor = measureProcesses();
let active = 0,
	maxSessions = 0,
	metadataBuilds = 0,
	archiveProcesses = 0;
let terminateArchive = false;
let disconnectSftp = false;
const native = new ManagedSftpRepositorySession();
const sessions = {
	withSession: async (access: any, consume: any, signal?: AbortSignal, limits?: any) => {
		maxSessions = Math.max(maxSessions, ++active);
		try {
			return await native.withSession(
				access,
				async session =>
					consume({
						...session,
						streamFiles: async (...args: Parameters<typeof session.streamFiles>) => {
							metadataBuilds++;
							if (metadataBuilds === 1 && process.env.LAB_PREPARATION_DELAY_MS) {
								await new Promise<void>((resolve, reject) => {
									const abort = () => {
										clearTimeout(timer);
										reject(new Error('Fixture cancelled'));
									};
									const timer = setTimeout(() => {
										signal?.removeEventListener('abort', abort);
										resolve();
									}, Number(process.env.LAB_PREPARATION_DELAY_MS));
									signal?.addEventListener('abort', abort, { once: true });
								});
							}
							return session.streamFiles(...args);
						},
						archive: async (...args: Parameters<typeof session.archive>) => {
							archiveProcesses++;
							if (!terminateArchive && !disconnectSftp) return session.archive(...args);
							terminateArchive = false;
							const destination = args[1],
								write = destination.write;
							let terminated = false;
							destination.write = function (...values: any[]) {
								const result = (write as any).apply(this, values);
								if (!terminated) {
									terminated = true;
									if (disconnectSftp) {
										disconnectSftp = false;
										sftp?.kill('SIGKILL');
									} else processManager.killAll('SIGKILL');
								}
								return result;
							} as typeof write;
							try {
								return await session.archive(...args);
							} finally {
								destination.write = write;
							}
						},
					}),
				signal,
				limits
			);
		} finally {
			active--;
		}
	},
};
let gateway: http.Server | undefined;
let restartedProcess: ReturnType<typeof fork> | undefined;
let sftp: ReturnType<typeof spawn> | undefined,
	server: ReturnType<ReturnType<typeof express>['listen']> | undefined,
	recovery: RemoteRepositoryRecoveryService | undefined;
try {
	const disk = await fs.statfs('/lab');
	assert(
		disk.bavail * disk.bsize > 32 * 1024 ** 3,
		'At least 32 GiB free lab filesystem required.'
	);
	assert.match((await run(restic, ['version'])).toString(), /restic 0\.19\.1/);
	await fs.mkdir(repository, { recursive: true, mode: 0o700 });
	await fixture(source, mode, sizes[mode]);
	const beforeSource = await hashTree(source);
	measurements.physicalSourceBytes = beforeSource.bytes;
	measurements.files = Object.values(beforeSource.entries).filter(
		(x: any) => x.type === 'file'
	).length;
	if (sizes[mode])
		assert.equal(
			beforeSource.bytes,
			sizes[mode] + 28 + (mode === 'combined' ? 115552 * 8 : 0),
			'Physical, non-sparse fixture content size.'
		);
	const command = async (args: string[]) =>
		(await run(restic, ['--no-cache', '-r', repository, ...args], password)).toString();
	await command(['init']);
	const snapshotIds = new Map<string, string>();
	for (const id of ['backup-01', 'backup-02', 'backup-03']) {
		const output = await command([
			'--json',
			'backup',
			source,
			'--tag',
			'pluton-plan-plan-01',
			'--tag',
			`pluton-backup-${id}`,
		]);
		const summary = JSON.parse(output.trim().split('\n').at(-1)!);
		assert.match(summary.snapshot_id, /^[a-f0-9]{64}$/);
		snapshotIds.set(id, summary.snapshot_id);
		if (mode === 'history')
			await fs.writeFile(
				path.join(source, 'nested', 'selected.txt'),
				`newer live content after ${id}\n`,
				{ mode: 0o600 }
			);
	}
	if (mode === 'symlink') {
		const bytes = await run(
			restic,
			[
				'--no-lock',
				'--no-cache',
				'-r',
				repository,
				'dump',
				'--archive',
				'tar',
				snapshotIds.get('backup-01')!,
				'/',
			],
			password
		);
		const entries = await checkTar(Readable.from([bytes]), true);
		assert.equal(entries.links, 3);
		assert.equal(entries.externalLinks, 1);
		measurements.nativeTarPreservesUnverifiedLinkTargets = true;
	}
	const beforeInspectionSource = mode === 'history' ? await hashTree(source) : beforeSource;
	if (mode === 'history') {
		assert.notDeepEqual(beforeInspectionSource, beforeSource);
		measurements.historicalContentDiffersFromLive = true;
		measurements.currentSourceBytes = beforeInspectionSource.bytes;
	}
	const beforeRepository = await hashTree(repository);
	measurements.physicalRepositoryBytes = beforeRepository.bytes;
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
			path.join(scratch, 'rclone-cache'),
		],
		{ stdio: 'ignore', shell: false }
	);
	await ready(sftpPort);
	const plan = {
		id: 'plan-01',
		sourceId: 'app-01',
		sourceType: 'device',
		method: 'backup',
		storageId: 'storage-01',
		storagePath: 'application',
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
	const backups = {
		getById: async (id: string) =>
			snapshotIds.has(id)
				? {
						...plan,
						id,
						planId: plan.id,
						status: 'completed',
						success: true,
						inProgress: false,
						completionStats: { snapshot_id: snapshotIds.get(id), sourcePaths: [source] },
					}
				: undefined,
	};
	const plans = { getById: async () => plan };
	const rows = new Map<string, any>();
	const restores = {
		isRestoreRunning: async () => false,
		create: async (row: any) => {
			rows.set(row.id, row);
			return row;
		},
		update: async (id: string, change: any) => {
			const row = { ...rows.get(id), ...change };
			rows.set(id, row);
			return row;
		},
	};
	const makeService = () =>
		new RemoteRepositoryRecoveryService(
			{ getByPlanId: async () => repo } as any,
			backups as any,
			plans as any,
			restores as any,
			{
				getSftpRecoveryOptions: async () => ({
					host: '127.0.0.1',
					port: String(sftpPort),
					user: 'fixture-user',
					pass: sftpPassword,
				}),
			},
			{ getAgentById: async () => ({ deviceId: 'app-01' }) } as any,
			sessions,
			secret,
			path.join(scratch, 'staging')
		);
	recovery = makeService();
	const backupService = new BackupService(
		{} as any,
		{} as any,
		plans as any,
		backups as any,
		restores as any,
		{} as any,
		undefined,
		recovery
	);
	const app = express();
	app.use(express.json());
	app.use('/api/backups', createBackupRouter(new BackupController(backupService)));
	server = app.listen(0, '127.0.0.1');
	await new Promise<void>(r => server!.once('listening', r));
	const upstreamOrigin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
	gateway = http.createServer((req, res) => {
		const upstream = http.request(
			upstreamOrigin + req.url,
			{ method: req.method, headers: req.headers },
			response => {
				clearTimeout(timer);
				res.writeHead(response.statusCode!, response.headers);
				response.pipe(res);
			}
		);
		const timer = setTimeout(() => {
			res.writeHead(524, { 'Content-Type': 'text/html', 'Server': 'fixture-gateway' });
			res.end('<html>fixture upstream timeout</html>');
			upstream.destroy();
		}, 5000);
		upstream.on('error', () => {
			clearTimeout(timer);
			if (!res.headersSent) {
				res.writeHead(502);
				res.end();
			} else res.destroy();
		});
		res.on('close', () => {
			clearTimeout(timer);
			upstream.destroy();
		});
		req.pipe(upstream);
	});
	gateway.listen(0, '127.0.0.1');
	await new Promise<void>(r => gateway!.once('listening', r));
	const api = `http://127.0.0.1:${(gateway.address() as net.AddressInfo).port}/api/backups`;
	const preparationIds = new Map<string, string>();
	const downloadUrl = (base = api, id = 'backup-01') =>
		`${base}/${id}/action/download${preparationIds.has(id) ? `?preparationId=${preparationIds.get(id)}` : ''}`;
	const headers = {
		'Cookie': `token=${jwt.sign({ user: 'fixture-admin' }, configService.config.SECRET!, { expiresIn: '1h' })}`,
		'Content-Type': 'application/json',
	};
	assert.equal((await fetch(`${api}/backup-01/action/download`, { method: 'POST' })).status, 401);
	async function prepareViaApi(base = api, id = 'backup-01') {
		const started = performance.now();
		const response = await fetch(`${base}/${id}/action/download`, {
			method: 'POST',
			headers,
			body: '{}',
		});
		let value = (await response.json()) as any;
		if (process.env.LAB_BASELINE === '1') return { prepare: response, prepared: value };
		assert.equal(response.status, 202);
		const admissionMs = Math.round(performance.now() - started);
		assert(admissionMs < 4000, 'Admission must fit the five-second gateway deadline.');
		measurements.maxAdmissionMs = Math.max(measurements.maxAdmissionMs || 0, admissionMs);
		const jobId = value.result.preparation.id;
		const duplicate = await fetch(`${base}/${id}/action/download`, {
			method: 'POST',
			headers,
			body: '{}',
		});
		assert.equal(((await duplicate.json()) as any).result.preparation.id, jobId);
		preparationIds.set(id, jobId);
		const deadline = Date.now() + 25 * 60_000;
		for (;;) {
			const pollStart = performance.now();
			const status = await fetch(`${base}/${id}/download-preparations/${jobId}`, { headers });
			assert.equal(status.status, 200);
			const job = ((await status.json()) as any).result;
			measurements.maxStatusMs = Math.max(
				measurements.maxStatusMs || 0,
				Math.round(performance.now() - pollStart)
			);
			assert(measurements.maxStatusMs < 4000);
			if (job.state === 'ready')
				return {
					prepare: { ok: true, status: 202 },
					prepared: { success: true, result: { streaming: true } },
				};
			if (job.state === 'failed')
				return {
					prepare: { ok: false, status: job.failureStatus },
					prepared: { code: job.code, reason: job.reason },
				};
			assert(['queued', 'indexing', 'validating'].includes(job.state));
			assert(Date.now() < deadline);
			await new Promise(r => setTimeout(r, 1000));
		}
	}
	const start = performance.now();
	const { prepare, prepared } = await prepareViaApi();
	measurements.preparationMs = Math.round(performance.now() - start);

	if (!prepare.ok) {
		measurements.preparation = {
			status: prepare.status,
			code: prepared.code,
			reason: prepared.reason,
		};
		assert.equal(
			process.env.LAB_EXPECT_REFUSAL,
			'1',
			`Unexpected refusal (${prepared.code}/${prepared.reason}).`
		);
		if (process.env.LAB_BASELINE !== '1')
			assert.equal(
				prepared.reason,
				mode === 'symlink' ? 'symlink-target-unverified' : 'unsupported-node-type'
			);
		if (['symlink', 'fifo'].includes(mode)) {
			const selection = {
				target: '',
				overwrite: 'never' as const,
				includes: [] as string[],
				excludes: [] as string[],
				delete: false,
			};
			await assert.rejects(recovery.preview('backup-01', selection, 'plan-01'));
			const target = path.join(scratch, 'refused-recovery-test');
			await fs.mkdir(target, { mode: 0o700 });
			await assert.rejects(
				recovery.testRestore(
					{
						backupId: 'backup-01',
						planId: 'plan-01',
						repositoryId: repo.id,
						snapshotId: snapshotIds.get('backup-01')!,
					},
					target,
					new AbortController().signal,
					() => {},
					async () => {}
				)
			);
			assert.deepEqual(await fs.readdir(target), []);
			const partial = await recovery.restore(
				'backup-01',
				{ ...selection, includes: [`${source}/nested/selected.txt`] },
				'plan-01'
			);
			await (recovery as any).jobs.get(partial)?.done;
			const row = rows.get(partial);
			assert.equal(row.status, 'completed', row.errorMsg);
			assert.equal(row.taskStats.files_restored, 1);
			assert.deepEqual(
				(await hashTree(row.config.target)).entries[`${source.slice(1)}/nested/selected.txt`],
				beforeSource.entries['nested/selected.txt']
			);
			assert.deepEqual(await hashTree(repository), beforeRepository);
			assert.deepEqual(await hashTree(source), beforeInspectionSource);
			measurements.fullRestoreRefusal = 'PASS';
			measurements.recoveryTestRefusal = 'PASS';
			measurements.selectedRestore = 'PASS';
		}
	} else {
		assert.deepEqual(prepared, { success: true, result: { streaming: true } });
		const initialBuilds = metadataBuilds;
		const downloadStart = performance.now(),
			response = await fetch(downloadUrl(), { headers });
		const headerMs = performance.now() - downloadStart;
		const clientTar = path.join(scratch, 'client.tar'),
			transfer = await receive(response, clientTar);
		measurements.transferMs = Math.round(performance.now() - downloadStart);
		measurements.firstByteMs = Math.round(headerMs + transfer.firstByteMs);
		measurements.tarBytes = transfer.bytes;
		measurements.mibPerSecond =
			Math.round((transfer.bytes / 1024 ** 2 / (measurements.transferMs / 1000)) * 100) / 100;
		const tar = await checkTar(createReadStream(clientTar));
		assert.equal(tar.files, measurements.files);
		measurements.tarFiles = tar.files;
		measurements.tarDirectories = tar.directories;
		const extraction = path.join(scratch, 'extracted');
		await fs.mkdir(extraction, { mode: 0o700 });
		await run('/bin/tar', [
			'--no-same-owner',
			'--no-same-permissions',
			'-xf',
			clientTar,
			'-C',
			extraction,
		]);
		assert.deepEqual(await hashTree(path.join(extraction, source.slice(1))), beforeSource);
		if (mode === 'proxy') {
			const proxy = http.createServer((_request, downstream) => {
				const upstream = http.get(downloadUrl(), { headers }, response => {
					response.once('data', chunk => {
						downstream.write(chunk);
						response.destroy();
						upstream.destroy();
						downstream.destroy();
					});
					response.on('error', () => downstream.destroy());
				});
				upstream.on('error', () => downstream.destroy());
			});
			await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
			try {
				await assert.rejects(async () => {
					const response = await fetch(
						`http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`
					);
					for await (const _chunk of Readable.fromWeb(response.body as any)) {
						/* discard only a partial fixture response */
					}
				});
			} finally {
				proxy.closeAllConnections();
				await new Promise<void>(resolve => proxy.close(() => resolve()));
			}
			const deadline = Date.now() + 10_000;
			while (active) {
				assert(Date.now() < deadline);
				await new Promise(resolve => setTimeout(resolve, 25));
			}
			measurements.proxyConnectionClosure = 'PASS';
		}
		const selection = {
			target: '',
			overwrite: 'never' as const,
			includes: [] as string[],
			excludes: [] as string[],
			delete: false,
		};
		const preview = await recovery.preview('backup-01', selection, 'plan-01');
		assert.equal(preview.stats.total_files, measurements.files);
		const restoreStart = performance.now(),
			full = await recovery.restore('backup-01', selection, 'plan-01');
		await (recovery as any).jobs.get(full)?.done;
		const fullRow = rows.get(full);
		assert.equal(fullRow.status, 'completed', fullRow.errorMsg);
		assert.equal(fullRow.taskStats.files_restored, measurements.files);
		assert.deepEqual(
			await hashTree(path.join(fullRow.config.target, source.slice(1))),
			beforeSource
		);
		measurements.restoreMs = Math.round(performance.now() - restoreStart);
		const selectedRelative =
			mode === 'colon'
				? 'nested/job:2026.txt'
				: mode === 'percent'
					? '100%complete/%2e%2e:文件.txt'
					: 'nested/selected.txt';
		const partial = await recovery.restore(
			'backup-01',
			{ ...selection, includes: [`${source}/${selectedRelative}`] },
			'plan-01'
		);
		await (recovery as any).jobs.get(partial)?.done;
		const partialRow = rows.get(partial);
		assert.equal(partialRow.status, 'completed', partialRow.errorMsg);
		assert.equal(partialRow.taskStats.files_restored, 1);
		assert.deepEqual(
			(await hashTree(partialRow.config.target)).entries[`${source.slice(1)}/${selectedRelative}`],
			beforeSource.entries[selectedRelative]
		);
		const target = path.join(scratch, 'recovery-test');
		await fs.mkdir(target, { mode: 0o700 });
		await recovery.testRestore(
			{
				backupId: 'backup-01',
				planId: 'plan-01',
				repositoryId: repo.id,
				snapshotId: snapshotIds.get('backup-01')!,
			},
			target,
			new AbortController().signal,
			() => {},
			async () => {
				const stat = await fs.lstat(target);
				assert(stat.isDirectory() && !stat.isSymbolicLink());
			}
		);
		assert.deepEqual(await hashTree(path.join(target, source.slice(1))), beforeSource);
		await fs.rm(target, { recursive: true });
		const reopenStart = performance.now();
		for (let i = 0; i < 3; i++) {
			const page = await recovery.browsePage('backup-01', { path: source, limit: 200, offset: 0 });
			assert.equal(page.status, 'ready');
			if (page.status === 'ready') assert.equal(page.snapshotId, snapshotIds.get('backup-01'));
		}
		assert.equal(metadataBuilds, initialBuilds, 'Healthy index reused for navigation.');
		measurements.reopenMs = Math.round(performance.now() - reopenStart);
		if (mode === 'small') {
			await prepareViaApi();
			const slowStart = performance.now();
			const slow = await fetch(downloadUrl(), { headers });
			const browsing = recovery.browsePage('backup-01', { path: source, limit: 200, offset: 0 });
			let slowBytes = 0;
			for await (const chunk of Readable.fromWeb(slow.body as any)) {
				slowBytes += chunk.length;
				await new Promise(resolve => setTimeout(resolve, 1));
			}
			assert.equal(slowBytes, transfer.bytes);
			assert.equal((await browsing).status, 'ready');
			assert.equal(metadataBuilds, initialBuilds);
			measurements.slowClientAndConcurrentBrowse = 'PASS';
			measurements.slowTransferMs = Math.round(performance.now() - slowStart);
			terminateArchive = true;
			let failedBytes = 0;
			const failStart = performance.now();
			await assert.rejects(async () => {
				const failed = await fetch(downloadUrl(), { headers });
				for await (const chunk of Readable.fromWeb(failed.body as any)) failedBytes += chunk.length;
			});
			assert(failedBytes < transfer.bytes);
			measurements.terminatedResticHttp = 'PASS';
			measurements.interruptedBytes = failedBytes;
			measurements.interruptionMs = Math.round(performance.now() - failStart);
			const sftpClosed = new Promise<void>(resolve => sftp!.once('close', () => resolve()));
			disconnectSftp = true;
			const faultAbort = new AbortController();
			let deadlineHit = false,
				disconnectedBytes = 0;
			// Observe the unchanged 10-minute server inactivity guard, rather than
			// misreporting a shorter client abort as repository failure propagation.
			const faultDeadline = setTimeout(() => {
				deadlineHit = true;
				faultAbort.abort();
			}, 660_000);
			const sftpFailureStart = performance.now();
			try {
				await assert.rejects(async () => {
					const failed = await fetch(downloadUrl(), {
						headers,
						signal: faultAbort.signal,
					});
					for await (const chunk of Readable.fromWeb(failed.body as any))
						disconnectedBytes += chunk.length;
				});
			} finally {
				clearTimeout(faultDeadline);
			}
			await sftpClosed;
			assert(disconnectedBytes < transfer.bytes);
			measurements.sftpDisconnect = deadlineHit ? 'BLOCKED' : 'PASS';
			measurements.sftpDisconnectMs = Math.round(performance.now() - sftpFailureStart);
			const idleDeadline = Date.now() + 10_000;
			while (active) {
				assert(Date.now() < idleDeadline);
				await new Promise(resolve => setTimeout(resolve, 25));
			}
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
					path.join(scratch, 'rclone-cache'),
				],
				{ stdio: 'ignore', shell: false }
			);
			await ready(sftpPort);
		}
		await prepareViaApi();
		const abort = new AbortController(),
			cancelled = await fetch(downloadUrl(), {
				headers,
				signal: abort.signal,
			}),
			reader = cancelled.body!.getReader();
		await reader.read();
		abort.abort();
		await assert.rejects(async () => {
			while (!(await reader.read()).done) {}
		});
		const deadline = Date.now() + 10_000;
		while (active) {
			assert(Date.now() < deadline);
			await new Promise(r => setTimeout(r, 25));
		}
		for (const id of ['backup-02', 'backup-03', 'backup-01']) {
			if (mode === 'history' && id === 'backup-01' && process.env.LAB_BASELINE !== '1') {
				const beforeBuilds = metadataBuilds;
				const stale = await fetch(downloadUrl(), { headers });
				assert.equal(stale.status, 409);
				assert.equal(metadataBuilds, beforeBuilds);
				await prepareViaApi();
				const response = await fetch(downloadUrl(), { headers });
				assert.equal(response.status, 200);
				const digest = crypto.createHash('sha256');
				for await (const chunk of Readable.fromWeb(response.body as any)) digest.update(chunk);
				assert.equal(digest.digest('hex'), transfer.sha256);
				measurements.downloadAfterEviction = 'PASS';
			}
			await prepareViaApi(api, id);
		}
		assert((await fs.readdir(path.join(scratch, 'managed-snapshot-indexes'))).length <= 2);
		let completedIndexBytes = 0;
		for (const d of await fs.readdir(path.join(scratch, 'managed-snapshot-indexes')))
			for (const f of await fs.readdir(path.join(scratch, 'managed-snapshot-indexes', d)))
				completedIndexBytes += (await fs.stat(path.join(scratch, 'managed-snapshot-indexes', d, f)))
					.size;
		await recovery.close();
		server.closeAllConnections();
		await new Promise<void>(r => server!.close(() => r()));
		server = undefined;
		restartedProcess = fork(
			fileURLToPath(new URL('./managedDownloadRecovery.restart.ts', import.meta.url)),
			[],
			{ stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
		);
		const child = restartedProcess;
		const nextMessage = () =>
			new Promise<any>((resolve, reject) => {
				const timer = setTimeout(() => {
					cleanup();
					reject(new Error('Disposable restart IPC deadline.'));
				}, 10000);
				const message = (value: any) => {
					cleanup();
					value.failure ? reject(new Error('Disposable restart failed.')) : resolve(value);
				};
				const exit = () => {
					cleanup();
					reject(new Error('Disposable restart exited.'));
				};
				const cleanup = () => {
					clearTimeout(timer);
					child.removeListener('message', message);
					child.removeListener('exit', exit);
				};
				child.once('message', message);
				child.once('exit', exit);
			});
		const listening = nextMessage();
		child.send({
			scratch,
			source,
			plan,
			repo,
			snapshotIds: [...snapshotIds],
			secret,
			options: {
				host: '127.0.0.1',
				port: String(sftpPort),
				user: 'fixture-user',
				pass: sftpPassword,
			},
		});
		const restartedApi = `http://127.0.0.1:${(await listening).port}/api/backups`;
		if (process.env.LAB_BASELINE !== '1') {
			const oldPreparation = preparationIds.get('backup-01');
			const staleStatus = await fetch(`${restartedApi}/backup-01/download-preparations/${oldPreparation}`, { headers });
			assert.equal(((await staleStatus.json()) as any).result.state, 'expired');
			assert.equal((await fetch(downloadUrl(restartedApi), { headers })).status, 409);
		}
		await prepareViaApi(restartedApi);
		const restarted = await fetch(downloadUrl(restartedApi), { headers });
		assert.equal(restarted.status, 200);
		let bytes = 0;
		const restartedHash = crypto.createHash('sha256');
		for await (const data of Readable.fromWeb(restarted.body as any)) {
			bytes += data.length;
			restartedHash.update(data);
		}
		assert.equal(bytes, transfer.bytes);
		assert.equal(restartedHash.digest('hex'), transfer.sha256);
		const stopped = nextMessage();
		child.send({ stop: true });
		const stoppedResult = await stopped;
		assert.equal(stoppedResult.closed, true);
		measurements.restartedNodePeakRssBytes = stoppedResult.nodePeakRssBytes;
		measurements.freshProcessDownload = 'PASS';
		await new Promise<void>(resolve => {
			if (child.exitCode !== null) resolve();
			else child.once('exit', () => resolve());
		});
		restartedProcess = undefined;
		assert.deepEqual(await hashTree(repository), beforeRepository);
		assert.deepEqual(await hashTree(source), beforeInspectionSource);
		assert.equal(active, 0);
		assert.deepEqual(
			(await fs.readdir('/tmp')).filter(n => n.startsWith('pluton-recovery-')),
			[]
		);
		Object.assign(
			measurements,
			{
				indexBytes: completedIndexBytes,
				metadataBuilds,
				maxRepositorySessions: maxSessions,
				archiveProcesses,
				download: 'PASS',
				tarIntegrity: 'PASS',
				fileRestore: 'PASS',
				selectedRestore: 'PASS',
				recoveryTest: 'PASS',
				browse: 'PASS',
			},
			monitor.result()
		);
		for (const name of ['memory.peak', 'memory.events', 'cpu.stat', 'io.stat'])
			measurements[name] = await fs
				.readFile(`/sys/fs/cgroup/${name}`, 'utf8')
				.catch(() => 'unavailable');
	}
	console.log(JSON.stringify({ event: 'managed_recovery_lab', ...measurements }));
} finally {
	monitor.stop();
	if (gateway) {
		gateway.closeAllConnections();
		await new Promise<void>(resolve => gateway!.close(() => resolve()));
	}
	if (restartedProcess && restartedProcess.exitCode === null) restartedProcess.kill('SIGTERM');
	await recovery?.close();
	if (server) {
		server.closeAllConnections();
		await new Promise<void>(r => server!.close(() => r()));
	}
	if (sftp && sftp.exitCode === null && sftp.signalCode === null) {
		const done = new Promise<void>(r => sftp!.once('close', () => r()));
		sftp.kill('SIGTERM');
		await done;
	}
	await fs.rm(scratch, { recursive: true, force: true });
	assert.equal(
		await fs.stat(scratch).then(
			() => true,
			() => false
		),
		false
	);
	console.log(
		JSON.stringify({
			event: 'managed_recovery_lab_cleanup',
			fixture: mode,
			removed: true,
			activeSessions: active,
		})
	);
}
