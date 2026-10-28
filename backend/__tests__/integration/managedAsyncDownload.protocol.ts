/** Real HTTP/controller/service/cache and five-second gateway, SYNTHETIC repository
 * transport. This portable timeout probe does not replace native SFTP/TAR acceptance. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import Cryptr from 'cryptr';
import { RemoteRepositoryRecoveryService } from '../../src/services/RemoteRepositoryRecoveryService';
import { BackupService } from '../../src/services/BackupServices';
import { BackupController } from '../../src/controllers/BackupController';
import { createBackupRouter } from '../../src/routes/backups';
import { configService } from '../../src/services/ConfigService';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-async-protocol-'));
const secret = crypto.randomBytes(32).toString('hex');
const snapshotId = 'a'.repeat(64);
const plan = {
	id: 'plan-01',
	method: 'backup',
	sourceId: 'app-01',
	sourceType: 'device',
	storageId: 'storage-01',
	storagePath: 'fixture',
};
const repository = {
	id: 'repository-01',
	planId: plan.id,
	agentId: 'agent-01',
	storageId: plan.storageId,
	storagePath: plan.storagePath,
	initializedAt: new Date(),
	encryptedPassword: new Cryptr(secret).encrypt(crypto.randomBytes(32).toString('hex')),
};
const backup = {
	...plan,
	id: 'backup-01',
	planId: plan.id,
	completionStats: { snapshot_id: snapshotId },
	status: 'completed',
	success: true,
};
const headers = {
	'Cookie': `token=${jwt.sign({ user: 'fixture-admin' }, configService.config.SECRET!, { expiresIn: '1h' })}`,
	'Content-Type': 'application/json',
};
const synchronousControl = process.argv.includes('--synchronous-control');
for (const delayMs of [65_000, 126_000]) {
	let calls = 0,
		builds = 0,
		sessions = 0;
	const service = new RemoteRepositoryRecoveryService(
		{ getByPlanId: async () => repository } as any,
		{ getById: async () => backup } as any,
		{ getById: async () => plan } as any,
		{} as any,
		{
			getSftpRecoveryOptions: async () => ({
				host: '192.0.2.10',
				user: 'fixture',
				pass: 'synthetic-fixture',
			}),
		},
		{ getAgentById: async () => ({ deviceId: 'app-01' }) } as any,
		{
			withSession: async (_access, consume, signal) => {
				sessions++;
				return consume({
					snapshot: async () => ({
						id: snapshotId,
						tags: ['pluton-plan-plan-01', 'pluton-backup-backup-01'],
						paths: ['/srv/example-app'],
					}),
					files: async () => {
						throw new Error('Array listing forbidden');
					},
					streamFiles: async (_id, append) => {
						builds++;
						await new Promise<void>((resolve, reject) => {
							const abort = () => {
								clearTimeout(timer);
								reject(new Error('cancelled fixture'));
							};
							const timer = setTimeout(() => {
								signal?.removeEventListener('abort', abort);
								resolve();
							}, delayMs);
							signal?.addEventListener('abort', abort, { once: true });
						});
						await append({
							struct_type: 'node',
							path: '/srv/example-app',
							name: 'example-app',
							type: 'dir',
							size: 0,
							mtime: '2026-01-01T00:00:00Z',
							mode: 0o700,
						});
					},
					restore: async () => {
						throw new Error('Not a native recovery fixture');
					},
					archive: async (_id, destination) => {
						calls++;
						destination.write(Buffer.from('synthetic-stream-only'));
					},
				});
			},
		},
		secret,
		path.join(scratch, String(delayMs), 'staging')
	);
	if (synchronousControl) {
		// Reconstruct the previous POST contract using the same production context/index
		// methods: the HTTP request waits for the complete manifest and verification.
		service.prepareDownload = async (id, _replica, signal) => {
			const context = await (service as any).context(id);
			await (service as any).withIndex(context, (index: any) => index.assertSafe(), signal);
			return { streaming: true } as any;
		};
	}
	const api = new BackupService(
		{} as any,
		{} as any,
		{} as any,
		{ getById: async () => backup } as any,
		{} as any,
		{} as any,
		undefined,
		service
	);
	const app = express();
	app.use(express.json());
	app.use('/api/backups', createBackupRouter(new BackupController(api)));
	const server = app.listen(0, '127.0.0.1');
	await new Promise<void>(resolve => server.once('listening', resolve));
	const origin = `http://127.0.0.1:${(server.address() as any).port}`;
	const gateway = http.createServer((req, res) => {
		const upstream = http.request(
			origin + req.url,
			{ method: req.method, headers: req.headers },
			response => {
				clearTimeout(timer);
				res.writeHead(response.statusCode!, response.headers);
				response.pipe(res);
			}
		);
		const timer = setTimeout(() => {
			res.writeHead(524, { 'Content-Type': 'text/html', 'Server': 'fixture-gateway' });
			res.end('<html>synthetic upstream timeout</html>');
			upstream.destroy();
		}, 5000);
		upstream.on('error', () => {
			clearTimeout(timer);
			if (!res.headersSent) {
				res.writeHead(502);
				res.end();
			}
		});
		res.on('close', () => {
			clearTimeout(timer);
			upstream.destroy();
		});
		req.pipe(upstream);
	});
	gateway.listen(0, '127.0.0.1');
	await new Promise<void>(resolve => gateway.once('listening', resolve));
	const base = `http://127.0.0.1:${(gateway.address() as any).port}/api/backups/backup-01`;
	try {
		const started = performance.now();
		const accepted = await fetch(`${base}/action/download`, { method: 'POST', headers });
		if (synchronousControl) {
			assert.equal(accepted.status, 524);
			assert.equal(accepted.headers.get('server'), 'fixture-gateway');
			assert.match(await accepted.text(), /synthetic upstream timeout/);
			console.log(JSON.stringify({ event: 'async_download_synchronous_control', transport: 'synthetic', delayMs, gatewayTimeoutMs: 5000, responseMs: Math.round(performance.now() - started), status: 524, passed: true }));
			continue;
		}
		assert.equal(accepted.status, 202);
		const jobId = ((await accepted.json()) as any).result.preparation.id;
		const admissionMs = Math.round(performance.now() - started);
		assert(admissionMs < 4000);
		const duplicate = await fetch(`${base}/action/download`, { method: 'POST', headers });
		assert.equal(((await duplicate.json()) as any).result.preparation.id, jobId);
		let polls = 0,
			maxStatusMs = 0;
		for (;;) {
			const statusStart = performance.now();
			const status = await fetch(`${base}/download-preparations/${jobId}`, { headers });
			assert.equal(status.status, 200);
			const state = ((await status.json()) as any).result;
			maxStatusMs = Math.max(maxStatusMs, Math.round(performance.now() - statusStart));
			polls++;
			assert(maxStatusMs < 4000);
			if (state.state === 'ready') break;
			assert(
				['queued', 'indexing', 'validating'].includes(state.state),
				JSON.stringify({
					state: state.state,
					code: state.code,
					reason: state.reason,
					error: state.error,
				})
			);
			assert(performance.now() - started < delayMs + 30_000);
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		assert.equal(builds, 1);
		assert.equal(sessions, 2);
		const download = await fetch(`${base}/action/download?preparationId=${jobId}`, { headers });
		assert.equal(download.status, 200);
		assert.equal(await download.text(), 'synthetic-stream-only');
		assert.equal(calls, 1);
		console.log(
			JSON.stringify({
				event: 'async_download_protocol',
				transport: 'synthetic',
				gatewayTimeoutMs: 5000,
				delayMs,
				admissionMs,
				maxStatusMs,
				polls,
				preparationMs: Math.round(performance.now() - started),
				builds,
				sessions,
				nodeRssBytes: process.memoryUsage().rss,
				cpu: process.cpuUsage(),
				passed: true,
			})
		);
	} finally {
		gateway.closeAllConnections();
		server.closeAllConnections();
		await Promise.all([
			new Promise<void>(resolve => gateway.close(() => resolve())),
			new Promise<void>(resolve => server.close(() => resolve())),
		]);
		await service.close();
	}
}
await fs.rm(scratch, { recursive: true, force: true });
