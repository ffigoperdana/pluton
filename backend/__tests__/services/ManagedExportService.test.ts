import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import Cryptr from 'cryptr';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { ManagedExportStore } from '../../src/stores/ManagedExportStore';
import { ManagedExportService } from '../../src/services/ManagedExportService';
import { ManagedExportController } from '../../src/controllers/ManagedExportController';
import { createManagedExportRouter } from '../../src/routes/managedExports';
import { createManagedExportPreflightRouter } from '../../src/routes/managedExportPreflight';
import { configService } from '../../src/services/ConfigService';
import {
	EXPORT_LIMITS,
	TemporaryExportError,
	exportConfiguration,
	exportRange,
	type ExportBinding,
	type ExportJob,
} from '../../src/utils/managedExport/ExportPolicy';
import { assertExportIsolation } from '../../src/utils/managedExport/ExportIsolation';
import type { ManagedExportSummary } from '../../src/utils/restic/ManagedExportPolicy';

jest.mock('../../src/utils/logger', () => ({ planLogger: () => ({ info: jest.fn() }) }));
const binding: ExportBinding = {
	backupId: 'backup-01',
	planId: 'plan-01',
	sourceId: 'app-01',
	repositoryId: 'repository-01',
	snapshotId: 'a'.repeat(64),
	mode: 'full',
};
const data = Buffer.alloc(2048, 42),
	owner = crypto.createHash('sha256').update('fixture-admin').digest('hex');
const env = () => ({
	MANAGED_EXPORT_ENABLED: 'true',
	MANAGED_EXPORT_ENDPOINT: 'https://s3.example.internal',
	MANAGED_EXPORT_BUCKET: 'example-private-exports',
	MANAGED_EXPORT_ACCESS_KEY_ID: crypto.randomBytes(12).toString('hex'),
	MANAGED_EXPORT_SECRET_ACCESS_KEY: crypto.randomBytes(32).toString('hex'),
});
const summary: ManagedExportSummary = {
	version: 1,
	binding: {
		backupId: binding.backupId,
		repositoryId: binding.repositoryId,
		snapshotId: binding.snapshotId,
	},
	mode: 'full',
	includedEntries: 2,
	excludedEntries: 0,
	includedByType: { file: 1, dir: 1 },
	excludedByType: {},
	manifestSha256: 'b'.repeat(64),
	archiveSha256: crypto.createHash('sha256').update(data).digest('hex'),
	archiveBytes: data.length,
};
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean | Promise<boolean>) {
	for (let i = 0; i < 200; i++) {
		if (await check()) return;
		await immediate();
	}
	throw new Error('Expected export state was not reached.');
}
function harness() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pluton-export-test-')),
		file = path.join(root, 'jobs.sqlite'),
		config = exportConfiguration(env())!;
	const store = new ManagedExportStore(file);
	const storage = {
		inventory: jest.fn(async () => ({ objects: 0, uploads: 0, exclusive: true })),
		preflight: jest.fn(async () => {}),
		upload: jest.fn(async (_j: ExportJob, archive: any, signal: AbortSignal, update: any) => {
			update({ state: 'uploading', uploadId: 'synthetic-upload' });
			await archive.streamTo(
				new Writable({
					write(_chunk, _encoding, done) {
						done();
					},
				}),
				signal,
				() => {}
			);
			update({
				state: 'verifying',
				versionId: 'synthetic-version',
				etag: '"synthetic-etag"',
				processedBytes: data.length,
				uploadedBytes: data.length,
				uploadId: undefined,
			});
		}),
		verify: jest.fn(async () => {}),
		identity: jest.fn(async () => {}),
		get: jest.fn(async (_j: ExportJob, _s: AbortSignal, range?: string) => {
			const match = range && /^bytes=(\d+)-(\d+)$/.exec(range);
			const start = match ? Number(match[1]) : 0,
				end = match ? Number(match[2]) : data.length - 1;
			return {
				Body: Readable.from([data.subarray(start, end + 1)]),
				ContentLength: end - start + 1,
				ContentRange: range ? `bytes ${start}-${end}/${data.length}` : undefined,
				$metadata: { httpStatusCode: range ? 206 : 200 },
			};
		}),
		authorize: jest.fn(async () => 'https://s3.example.internal/private-synthetic-authorization'),
		cleanup: jest.fn(async () => {}),
		close: jest.fn(),
	};
	let current = { ...binding };
	const recovery = {
		exportBindingFor: jest.fn(async (id: string, mode: any) => ({
			...current,
			backupId: id,
			mode,
		})),
		withVerifiedExport: jest.fn(async (_binding: any, signal: AbortSignal, consume: any) =>
			consume({
				fileName: 'backup.tar',
				export: summary,
				streamTo: async (dest: Writable, s: AbortSignal, ready: () => void) => {
					ready();
					await pipeline(Readable.from([data]), dest, { end: false, signal: s });
				},
			})
		),
	};
	const service = new ManagedExportService(
		store,
		recovery as any,
		() => config,
		async () => {},
		() => storage as any
	);
	return {
		file,
		config,
		store,
		service,
		storage,
		recovery,
		changeBinding: () => {
			current = { ...current, snapshotId: 'c'.repeat(64) };
		},
		close: async () => {
			await service.shutdown();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}
describe('temporary export policy and durable admission', () => {
	test('TLS, operator-only configuration, isolated bucket AND independent credentials fail closed', () => {
		expect(exportConfiguration({})).toBeUndefined();
		for (const bad of [
			{ MANAGED_EXPORT_ENDPOINT: 'http://s3.example.internal' },
			{ MANAGED_EXPORT_ENDPOINT: 'https://s3.example.internal/?secret=value' },
			{ MANAGED_EXPORT_PREFIX: '../repository' },
			{ MANAGED_EXPORT_TTL_SECONDS: '0' },
			{ MANAGED_EXPORT_CA_FILE: 'relative.pem' },
		])
			expect(() => exportConfiguration({ ...env(), ...bad })).toThrow(TemporaryExportError);
		const config = exportConfiguration(env())!,
			encrypt = new Cryptr(configService.config.SECRET!);
		const storage = (bucket: string, key: string) => ({
			type: 's3',
			credentials: { bucket: encrypt.encrypt(bucket), access_key_id: encrypt.encrypt(key) },
			settings: {},
		});
		expect(() => assertExportIsolation(config, [storage(config.bucket, 'different')])).toThrow(
			'destination-not-isolated'
		);
		expect(() =>
			assertExportIsolation(config, [storage('repository-bucket', config.accessKeyId)])
		).toThrow('destination-not-isolated');
		expect(() =>
			assertExportIsolation(config, [storage('repository-bucket', 'independent')])
		).not.toThrow();
	});
	test('range handling includes suffixes, clamping, If-Range and strict 416 boundaries', () => {
		expect(exportRange(undefined, undefined, 100, '"v"')).toEqual({
			status: 200,
			start: 0,
			end: 99,
		});
		expect(exportRange('bytes=20-', undefined, 100, '"v"')).toEqual({
			status: 206,
			start: 20,
			end: 99,
		});
		expect(exportRange('bytes=-20', undefined, 100, '"v"')).toEqual({
			status: 206,
			start: 80,
			end: 99,
		});
		expect(exportRange('bytes=20-500', undefined, 100, '"v"').end).toBe(99);
		expect(exportRange('bytes=20-30', '"old"', 100, '"v"').status).toBe(200);
		for (const value of [
			'bytes=100-',
			'bytes=4-3',
			'bytes=-0',
			'bytes=1-2,4-5',
			'bytes=',
			'items=1-2',
			'bytes=9007199254740992-',
		])
			expect(() => exportRange(value, undefined, 100, '"v"')).toThrow('range-invalid');
	});
	test('deduplication, hard queue/quota limits and exclusive process ownership are durable', async () => {
		const h = harness();
		try {
			const j = h.store.admit(owner, binding, h.config);
			expect(h.store.admit(owner, binding, h.config).id).toBe(j.id);
			expect(() => new ManagedExportStore(h.file)).toThrow('queue-full');
			for (let i = 1; i < EXPORT_LIMITS.maxAdmitted; i++)
				h.store.admit(owner, { ...binding, backupId: `backup-${i + 1}` }, h.config);
			expect(() => h.store.admit(owner, { ...binding, backupId: 'backup-over' }, h.config)).toThrow(
				'queue-full'
			);
			for (const n of [-1, NaN, Infinity, 1.5, EXPORT_LIMITS.maxObjectBytes + 1])
				expect(() => h.store.reserve(j.id, n)).toThrow('quota-exceeded');
			h.store.reserve(j.id, EXPORT_LIMITS.maxObjectBytes);
			const jobs = h.store.all().filter(other => other.id !== j.id);
			h.store.reserve(jobs[0].id, EXPORT_LIMITS.maxObjectBytes);
			expect(() => h.store.reserve(jobs[1].id, 1024)).toThrow('quota-exceeded');
			const serialized = JSON.stringify(h.store.all());
			expect(serialized).not.toContain(h.config.secretAccessKey);
			expect(serialized).not.toContain(h.config.accessKeyId);
			expect(serialized).not.toContain(h.config.endpoint);
		} finally {
			await h.close();
		}
	});
});
describe('durable independent export lifecycle', () => {
	test('inventory intent is durable in the first admission write, before any worker can run', async () => {
		const h = harness();
		try {
			const value = h.store.admit(
				owner,
				{ ...binding, backupId: 'inventory-crash-fixture' },
				h.config,
				'inventory'
			);
			expect(h.store.get(value.id)).toMatchObject({
				kind: 'inventory',
				state: 'queued',
				cleaned: true,
			});
			await h.service.recoverInterrupted();
			expect(h.store.get(value.id)).toMatchObject({
				kind: 'inventory',
				state: 'failed',
				failure: 'interrupted',
				cleaned: true,
			});
			expect(h.storage.cleanup).not.toHaveBeenCalled();
			expect(h.storage.preflight).not.toHaveBeenCalled();
			expect(h.recovery.withVerifiedExport).not.toHaveBeenCalled();
		} finally {
			await h.close();
		}
	});
	test('inventory-only jobs never upload, read a backup, or invoke cleanup even on failure/cancellation', async () => {
		const h = harness();
		try {
			const inventory = await h.service.preflight(owner, true);
			await until(() => h.store.get(inventory.id)?.state === 'ready');
			expect((await h.service.preflightStatus(owner, inventory.id)).inventory).toEqual({
				objects: 0,
				uploads: 0,
				exclusive: true,
			});
			await h.service.cancelPreflight(owner, inventory.id);
			h.storage.inventory.mockRejectedValueOnce(new Error('synthetic inaccessible inventory'));
			const failed = await h.service.preflight(owner, true);
			await until(() => h.store.get(failed.id)?.state === 'failed');
			expect(h.store.get(failed.id)?.cleaned).toBe(true);
			expect(h.storage.preflight).not.toHaveBeenCalled();
			expect(h.storage.upload).not.toHaveBeenCalled();
			expect(h.storage.cleanup).not.toHaveBeenCalled();
			expect(h.recovery.exportBindingFor).not.toHaveBeenCalled();
			expect(h.recovery.withVerifiedExport).not.toHaveBeenCalled();
		} finally {
			await h.close();
		}
	});
	test('standalone preflight uses durable random jobs, owner checks and no backup/repository reads', async () => {
		const h = harness();
		try {
			const value = await h.service.preflight(owner);
			expect(value.kind).toBe('preflight');
			await until(() => h.store.get(value.id)?.state === 'ready');
			const result = await h.service.preflightStatus(owner, value.id);
			expect(result.cleanupPending).toBe(false);
			expect(h.store.get(value.id)!.cleaned).toBe(true);
			expect(h.recovery.exportBindingFor).not.toHaveBeenCalled();
			expect(h.recovery.withVerifiedExport).not.toHaveBeenCalled();
			expect(h.storage.upload).not.toHaveBeenCalled();
			await expect(h.service.preflightStatus('other-user', value.id)).rejects.toThrow(
				'Preflight not found'
			);
			const next = await h.service.preflight(owner);
			expect(next.id).not.toBe(value.id);
		} finally {
			await h.close();
		}
	});
	test('only the preflight owner can retry exhausted cleanup without reading a backup', async () => {
		const h = harness();
		try {
			const value = await h.service.preflight(owner);
			await until(() => h.store.get(value.id)?.state === 'ready');
			h.store.update(value.id, { state: 'failed', cleaned: false, cleanupAttempts: 10 });
			await expect(h.service.cancelPreflight('other-user', value.id)).rejects.toThrow(
				'Preflight not found'
			);
			expect(h.storage.cleanup).not.toHaveBeenCalled();
			await h.service.cancelPreflight(owner, value.id);
			await until(() => h.store.get(value.id)?.cleaned);
			expect(h.store.get(value.id)?.cleanupAttempts).toBe(11);
			expect(h.storage.cleanup).toHaveBeenCalledTimes(1);
			expect(h.recovery.exportBindingFor).not.toHaveBeenCalled();
			expect(h.recovery.withVerifiedExport).not.toHaveBeenCalled();
		} finally {
			await h.close();
		}
	});
	test('interrupted preflight reconciles through exact cleanup without restarting a backup read', async () => {
		const h = harness();
		try {
			const value = await h.service.preflight(owner);
			await until(() => h.store.get(value.id)?.state === 'ready');
			h.store.update(value.id, {
				state: 'validating',
				cleaned: false,
				probeUploadId: 'interrupted-probe',
			});
			await h.service.recoverInterrupted();
			await until(() => h.store.get(value.id)!.cleaned);
			expect(h.store.get(value.id)!.failure).toBe('interrupted');
			expect(h.recovery.withVerifiedExport).not.toHaveBeenCalled();
		} finally {
			await h.close();
		}
	});
	test('cancellation during the last binding check cannot resurrect a Ready object', async () => {
		const h = harness();
		let verified = false,
			held = false,
			release!: () => void;
		h.storage.verify.mockImplementation(async () => {
			verified = true;
		});
		h.recovery.exportBindingFor.mockImplementation(async (id, mode) => {
			if (verified && !held) {
				held = true;
				await new Promise<void>(resolve => {
					release = resolve;
				});
			}
			return { ...binding, backupId: id, mode };
		});
		try {
			const job = await h.service.admit(owner, binding.backupId, 'full');
			await until(() => !!release);
			await h.service.cancel(owner, binding.backupId, job.id);
			release();
			await until(() => h.store.get(job.id)!.cleaned);
			expect(h.store.get(job.id)!.state).toBe('cancelled');
			await expect(h.service.authorize(owner, binding.backupId, job.id)).rejects.toThrow('expired');
		} finally {
			release?.();
			await h.close();
		}
	});
	test('cancellation while a signed authorization is being generated refuses its return', async () => {
		const h = harness();
		let release!: () => void;
		h.storage.authorize.mockImplementation(
			() =>
				new Promise(resolve => {
					release = () => resolve('https://s3.example.internal/private-synthetic-authorization');
				})
		);
		try {
			const job = await h.service.admit(owner, binding.backupId, 'full');
			await until(() => h.store.get(job.id)?.state === 'ready');
			const pending = h.service.authorize(owner, binding.backupId, job.id);
			const refused = expect(pending).rejects.toThrow('expired');
			await until(() => !!release);
			await h.service.cancel(owner, binding.backupId, job.id);
			release();
			await refused;
			expect(h.store.get(job.id)!.state).toBe('cancelled');
		} finally {
			release?.();
			await h.close();
		}
	});
	test('a transient storage outage preserves the verified object for renewal', async () => {
		const h = harness();
		try {
			const job = await h.service.admit(owner, binding.backupId, 'full');
			await until(() => h.store.get(job.id)?.state === 'ready');
			h.storage.identity.mockRejectedValue(new TemporaryExportError('storage-unavailable'));
			await expect(h.service.authorize(owner, binding.backupId, job.id)).rejects.toThrow(
				'storage-unavailable'
			);
			expect(h.store.get(job.id)!.state).toBe('ready');
			expect((await h.service.admit(owner, binding.backupId, 'full')).id).toBe(job.id);
		} finally {
			await h.close();
		}
	});
	test('unreadable durable metadata stops export work without throwing from startup reconciliation', async () => {
		const h = harness();
		const read = jest.spyOn(h.store, 'all').mockImplementation(() => {
			throw new Error('synthetic unreadable metadata');
		});
		try {
			await expect(h.service.recoverInterrupted()).resolves.toBeUndefined();
			await expect(h.service.admit(owner, binding.backupId, 'full')).rejects.toThrow('interrupted');
			expect(h.storage.preflight).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
			await h.close();
		}
	});
	test('missing immutable objects invalidate readiness and an explicit retry gets a new job identity', async () => {
		const h = harness();
		try {
			const job = await h.service.admit(owner, binding.backupId, 'full');
			await until(() => h.store.get(job.id)?.state === 'ready');
			h.storage.identity.mockRejectedValue(
				Object.assign(new Error('synthetic missing version'), {
					$metadata: { httpStatusCode: 404 },
				})
			);
			await expect(h.service.authorize(owner, binding.backupId, job.id)).rejects.toThrow(
				'object-mismatch'
			);
			expect(h.store.get(job.id)!.state).toBe('failed');
			const next = await h.service.admit(owner, binding.backupId, 'full');
			expect(next.id).not.toBe(job.id);
		} finally {
			await h.close();
		}
	});
	test('a different snapshot proof is refused before reserving or uploading bytes', async () => {
		const h = harness();
		h.recovery.withVerifiedExport.mockImplementation(async (_binding, _signal, consume) =>
			consume({
				export: { ...summary, binding: { ...summary.binding, snapshotId: 'd'.repeat(64) } },
			})
		);
		try {
			const job = await h.service.admit(owner, binding.backupId, 'full');
			await until(() => h.store.get(job.id)?.state === 'failed');
			expect(h.store.get(job.id)!.failure).toBe('object-mismatch');
			expect(h.storage.upload).not.toHaveBeenCalled();
			expect(h.store.get(job.id)!.reservedBytes).toBe(0);
		} finally {
			await h.close();
		}
	});
	test('metadata persistence failure stops the worker rather than retrying forever', async () => {
		const h = harness();
		jest.spyOn(h.store, 'update').mockImplementation(() => {
			throw new Error('synthetic metadata failure');
		});
		try {
			await h.service.admit(owner, binding.backupId, 'full');
			await until(() => h.storage.close.mock.calls.length > 0);
			await immediate();
			await expect(h.service.admit(owner, 'backup-02', 'full')).rejects.toThrow('interrupted');
			expect(h.store.all()).toHaveLength(1);
			expect(h.storage.preflight).not.toHaveBeenCalled();
		} finally {
			await h.close();
		}
	});
	test('ready is published only after complete archive AND object verification', async () => {
		const h = harness();
		let release!: () => void;
		h.storage.verify.mockImplementation(
			() =>
				new Promise(resolve => {
					release = resolve;
				})
		);
		try {
			const admitted = await h.service.admit(owner, binding.backupId, 'full');
			await until(() => !!release);
			expect((await h.service.status(owner, binding.backupId, admitted.id)).state).toBe(
				'verifying'
			);
			await expect(h.service.authorize(owner, binding.backupId, admitted.id)).rejects.toThrow(
				'expired'
			);
			release();
			await until(() => h.store.get(admitted.id)?.state === 'ready');
			const state = await h.service.status(owner, binding.backupId, admitted.id);
			expect(state.integrity).toBe('verified');
			expect(state.summary!.archiveSha256).toBe(summary.archiveSha256);
			expect(h.storage.verify).toHaveBeenCalledTimes(1);
			expect(h.store.get(admitted.id)!.reservedBytes).toBe(data.length);
		} finally {
			release?.();
			await h.close();
		}
	});
	test('duplicate requests share one export; changed historical identity refuses renewal', async () => {
		const h = harness();
		try {
			const a = await h.service.admit(owner, binding.backupId, 'full'),
				b = await h.service.admit(owner, binding.backupId, 'full');
			expect(a.id).toBe(b.id);
			await until(() => h.store.get(a.id)?.state === 'ready');
			expect(h.storage.upload).toHaveBeenCalledTimes(1);
			await h.service.authorize(owner, binding.backupId, a.id);
			await expect(h.service.status('different-owner', binding.backupId, a.id)).rejects.toThrow(
				'Export not found'
			);
			h.changeBinding();
			await expect(h.service.authorize(owner, binding.backupId, a.id)).rejects.toThrow(
				'binding-changed'
			);
		} finally {
			await h.close();
		}
	});
	test('archive failure never finalizes or exposes an object and cleanup remains bounded', async () => {
		const h = harness();
		h.recovery.withVerifiedExport.mockRejectedValue(new Error('untrusted-provider-secret'));
		h.storage.cleanup.mockRejectedValue(new Error('untrusted-provider-secret'));
		try {
			const j = await h.service.admit(owner, binding.backupId, 'full');
			await until(() => h.store.get(j.id)?.state === 'failed');
			await until(() => h.storage.cleanup.mock.calls.length >= 1);
			for (let i = 0; i < 15; i++) await h.service.tick();
			expect(h.storage.cleanup.mock.calls.length).toBeLessThanOrEqual(10);
			expect(h.store.get(j.id)!.cleaned).toBe(false);
			expect((await h.service.status(owner, binding.backupId, j.id)).failure).toBe(
				'archive-refused'
			);
			expect(JSON.stringify(h.store.all())).not.toContain('untrusted-provider-secret');
			expect(h.storage.upload).not.toHaveBeenCalled();
		} finally {
			await h.close();
		}
	});
	test('cancel aborts an active export and releases capacity only after cleanup confirmation', async () => {
		const h = harness();
		let entered = false;
		h.storage.upload.mockImplementation(async (_job, _archive, signal) => {
			entered = true;
			await new Promise<void>((_resolve, reject) =>
				signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
			);
		});
		try {
			const j = await h.service.admit(owner, binding.backupId, 'full');
			await until(() => entered);
			await h.service.cancel(owner, binding.backupId, j.id);
			await until(() => h.store.get(j.id)!.cleaned);
			expect(h.store.get(j.id)!.state).toBe('cancelled');
			expect(h.store.get(j.id)!.reservedBytes).toBe(0);
			expect(h.storage.verify).not.toHaveBeenCalled();
		} finally {
			await h.close();
		}
	});
	test('restart keeps verified objects and explicitly fails unfinished work without regenerating it', async () => {
		const h = harness();
		let second: ManagedExportService | undefined;
		try {
			const ready = h.store.admit(owner, binding, h.config);
			h.store.update(ready.id, {
				state: 'ready',
				summary,
				versionId: 'version',
				etag: '"tag"',
				expiresAt: Date.now() + 60000,
			});
			const unfinished = h.store.admit(owner, { ...binding, backupId: 'backup-02' }, h.config);
			h.store.update(unfinished.id, {
				state: 'uploading',
				uploadId: 'interrupted-upload',
				reservedBytes: 2048,
			});
			await h.service.shutdown();
			const durable = new ManagedExportStore(h.file);
			second = new ManagedExportService(
				durable,
				h.recovery as any,
				() => h.config,
				async () => {},
				() => h.storage as any
			);
			await second.recoverInterrupted();
			await until(() => durable.get(unfinished.id)!.cleaned);
			expect(durable.get(ready.id)!.state).toBe('ready');
			expect(durable.get(unfinished.id)!.failure).toBe('interrupted');
			expect(durable.get(unfinished.id)!.cleaned).toBe(true);
			expect(h.storage.upload).not.toHaveBeenCalled();
			await second.authorize(owner, binding.backupId, ready.id);
			durable.update(ready.id, { expiresAt: Date.now() - 1 });
			await second.tick();
			expect(durable.get(ready.id)!.state).toBe('expired');
			expect(durable.get(ready.id)!.cleaned).toBe(true);
		} finally {
			await second?.shutdown();
			fs.rmSync(path.dirname(h.file), { recursive: true, force: true });
		}
	});
});
describe('authenticated Range proxy and authorization boundaries', () => {
	test('operator endpoints require cookie ownership and refuse every destination override', async () => {
		const h = harness(),
			app = express();
		app.use(express.json());
		app.use(
			'/api/managed-exports',
			createManagedExportPreflightRouter(new ManagedExportController(h.service))
		);
		const cookie = `token=${jwt.sign({ user: 'fixture-admin' }, configService.config.SECRET!)}`;
		try {
			const api = request(app),
				path = '/api/managed-exports/preflights';
			expect((await api.post(path).send({})).status).toBe(401);
			for (const body of [
				{ endpoint: 'https://foreign.example.internal' },
				{ backupId: 'backup-01' },
				{ key: 'foreign' },
			])
				expect((await api.post(path).set('Cookie', cookie).send(body)).status).toBe(400);
			const created = await api.post(path).set('Cookie', cookie).send({});
			expect(created.status).toBe(202);
			await until(() => h.store.get(created.body.result.id)?.state === 'ready');
			expect(
				(await api.get(path + '/' + created.body.result.id).set('Cookie', cookie)).status
			).toBe(200);
			expect(h.recovery.withVerifiedExport).not.toHaveBeenCalled();
			const config = await api.get('/api/managed-exports/configuration').set('Cookie', cookie);
			expect(config.status).toBe(200);
			expect(JSON.stringify(config.body)).not.toContain(h.config.secretAccessKey);
			expect(JSON.stringify(config.body)).not.toContain(h.config.accessKeyId);
			expect(config.headers['cache-control']).toContain('no-store');
			const cancellation = path + '/' + created.body.result.id;
			expect((await api.delete(cancellation)).status).toBe(401);
			expect(
				(await api.delete(cancellation).set('Cookie', cookie).send({ key: 'foreign' })).status
			).toBe(400);
			expect((await api.delete(cancellation).set('Cookie', cookie).send({})).status).toBe(200);
			const inventoryPath = '/api/managed-exports/inventory-checks';
			expect((await api.post(inventoryPath).send({})).status).toBe(401);
			expect(
				(await api.post(inventoryPath).set('Cookie', cookie).send({ prefix: 'foreign' })).status
			).toBe(400);
			const inventory = await api.post(inventoryPath).set('Cookie', cookie).send({});
			expect(inventory.status).toBe(202);
			await until(() => h.store.get(inventory.body.result.id)?.state === 'ready');
			const inventoryUrl = inventoryPath + '/' + inventory.body.result.id;
			const foreignCookie = `token=${jwt.sign({ user: 'other-user' }, configService.config.SECRET!)}`;
			expect((await api.get(inventoryUrl).set('Cookie', foreignCookie)).status).toBe(404);
			expect((await api.delete(inventoryUrl).set('Cookie', foreignCookie).send({})).status).toBe(
				404
			);
			expect(
				(await api.get(inventoryUrl).set('Cookie', cookie)).body.result.inventory.exclusive
			).toBe(true);
			expect((await api.delete(inventoryUrl).set('Cookie', cookie).send({})).status).toBe(200);
		} finally {
			await h.close();
		}
	});
	test('disabled exports return a safe 503 and leave other endpoints available', async () => {
		const app = express();
		app.use(express.json());
		app.use('/api/backups', createManagedExportRouter(new ManagedExportController()));
		app.get('/api/backups/backup-01/files', (_req, res) => res.json({ success: true }));
		const cookie = `token=${jwt.sign({ user: 'fixture-admin' }, configService.config.SECRET!)}`;
		const result = await request(app)
			.post('/api/backups/backup-01/exports')
			.set('Cookie', cookie)
			.send({ mode: 'full' });
		expect(result.status).toBe(503);
		expect(result.body.reason).toBe('not-configured');
		expect((await request(app).get('/api/backups/backup-01/files')).status).toBe(200);
	});
	test('actual cookie authentication, ownership, strict inputs, HEAD, 206, If-Range and 416', async () => {
		const h = harness();
		const app = express();
		app.use(express.json());
		app.use('/api/backups', createManagedExportRouter(new ManagedExportController(h.service)));
		const cookie = (user: string) =>
			`token=${jwt.sign({ user }, configService.config.SECRET!, { expiresIn: '2m' })}`;
		try {
			const api = request(app),
				route = '/api/backups/backup-01/exports';
			expect((await api.post(route).send({ mode: 'full' })).status).toBe(401);
			expect(
				(
					await api
						.post(route)
						.set('Cookie', cookie('fixture-admin'))
						.send({ mode: 'full', key: 'arbitrary' })
				).status
			).toBe(400);
			const created = await api
				.post(route)
				.set('Cookie', cookie('fixture-admin'))
				.send({ mode: 'full' });
			expect(created.status).toBe(202);
			const id = created.body.result.id,
				url = `${route}/${id}`;
			await until(() => h.store.get(id)?.state === 'ready');
			for (const suffix of ['', '/authorization', '/link', '/content']) {
				const r =
					suffix === '/authorization'
						? await api
								.post(url + suffix)
								.set('Cookie', cookie('other-user'))
								.send({})
						: await api.get(url + suffix).set('Cookie', cookie('other-user'));
				expect(r.status).toBe(404);
			}
			expect(
				(await api.get(url + '?key=elsewhere').set('Cookie', cookie('fixture-admin'))).status
			).toBe(400);
			const head = await api.head(url + '/content').set('Cookie', cookie('fixture-admin'));
			expect(head.status).toBe(200);
			expect(head.headers['content-length']).toBe(String(data.length));
			expect(head.headers['accept-ranges']).toBe('bytes');
			const etag = head.headers.etag;
			const partial = await api
				.get(url + '/content')
				.set('Cookie', cookie('fixture-admin'))
				.set('Range', 'bytes=100-199')
				.set('If-Range', etag);
			expect(partial.status).toBe(206);
			expect(partial.headers['content-range']).toBe(`bytes 100-199/${data.length}`);
			expect(partial.headers['content-length']).toBe('100');
			const full = await api
				.get(url + '/content')
				.set('Cookie', cookie('fixture-admin'))
				.set('Range', 'bytes=100-')
				.set('If-Range', '"old"');
			expect(full.status).toBe(200);
			const invalid = await api
				.get(url + '/content')
				.set('Cookie', cookie('fixture-admin'))
				.set('Range', `bytes=${data.length}-`);
			expect(invalid.status).toBe(416);
			expect(invalid.headers['content-range']).toBe(`bytes */${data.length}`);
			expect(
				(
					await api
						.post(url + '/authorization')
						.set('Cookie', cookie('fixture-admin'))
						.send({ key: 'foreign' })
				).status
			).toBe(400);
		} finally {
			await h.close();
		}
	});
});
