import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Cryptr from 'cryptr';
import { RemoteRepositoryRecoveryService } from '../../src/services/RemoteRepositoryRecoveryService';
import { SnapshotIndexError } from '../../src/utils/restic/ManagedSnapshotIndex';
import { AppError } from '../../src/utils/AppError';
jest.mock('../../src/utils/logger', () => ({
	initializeLogger: jest.fn(),
	planLogger: () => ({ info: jest.fn(), warn: jest.fn() }),
}));
const secret = 'synthetic-comparison-application-secret',
	source = '/srv/example-app';
const oldId = 'b'.repeat(64),
	newId = 'a'.repeat(64),
	thirdId = 'c'.repeat(64);
const artifact = (name = 'app.sql') => ({
	path: '/pluton/database/' + name,
	bytes: 10,
	sha256: 'd'.repeat(64),
});
const sqlRoot = (job: string, name = 'app.sql') =>
	'/var/lib/example-agent/jobs/job-' + job + '/pluton/database/' + name;
const node = (p: string, type = 'file', size = 10) => ({
	struct_type: 'node',
	path: p,
	name: path.posix.basename(p),
	type,
	size,
	mtime: '2026-01-01T00:00:00Z',
	mode: 420,
});
const rows = (sql = true) => [
	node('/srv', 'dir', 0),
	node(source, 'dir', 0),
	node(source + '/same.txt'),
	...(sql
		? [node('/pluton', 'dir', 0), node('/pluton/database', 'dir', 0), node(artifact().path)]
		: []),
];
describe('immutable authenticated managed comparison pairs', () => {
	let root: string,
		service: RemoteRepositoryRecoveryService,
		records: Map<string, any>,
		snapshots: Map<string, any>,
		entries: Map<string, any[]>,
		session: any,
		repository: any,
		stores: any;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'comparison-service-'));
		const base = {
			planId: 'plan-01',
			sourceId: 'app-01',
			sourceType: 'device',
			method: 'backup',
			storageId: 'storage-01',
			storagePath: 'application',
			status: 'completed',
			success: true,
			inProgress: false,
		};
		const backup = (id: string, snapshotId: string) => ({
			...base,
			id,
			completionStats: {
				snapshot_id: snapshotId,
				sourcePaths: [source],
				lifecycle: { database: artifact() },
			},
		});
		records = new Map([
			['old', backup('old', oldId)],
			['current', backup('current', newId)],
		]);
		snapshots = new Map(
			[...records.values()].map(row => [
				row.completionStats.snapshot_id,
				{
					id: row.completionStats.snapshot_id,
					tags: ['pluton-plan-plan-01', 'pluton-backup-' + row.id],
					paths: [source, sqlRoot(row.id === 'old' ? 'OLD123' : 'NEW123')],
				},
			])
		);
		entries = new Map([
			[oldId, rows()],
			[newId, rows()],
		]);
		const plan = {
			id: 'plan-01',
			sourceId: 'app-01',
			sourceType: 'device',
			method: 'backup',
			storageId: 'storage-01',
			storagePath: 'application',
		};
		repository = {
			id: 'repository-01',
			planId: 'plan-01',
			agentId: 'agent-01',
			storageId: 'storage-01',
			storagePath: 'application',
			initializedAt: new Date(),
			encryptedPassword: new Cryptr(secret).encrypt('synthetic-repository-password'),
		};
		stores = {
			backups: {
				getById: jest.fn(async (id: string) => records.get(id)),
				comparisonCandidates: jest.fn(async () => [records.get('old')]),
			},
			plans: { getById: jest.fn(async () => plan) },
			repositories: { getByPlanId: jest.fn(async () => repository) },
			agents: { getAgentById: jest.fn(async () => ({ deviceId: 'app-01' })) },
			restores: { create: jest.fn() },
		};
		session = {
			snapshot: jest.fn(async (id: string) => {
				const value = snapshots.get(id);
				if (!value) throw new AppError(404, 'Exact snapshot missing.');
				return value;
			}),
			streamFiles: jest.fn(async (id: string, consume: any) => {
				for (const row of entries.get(id) || []) await consume(row);
			}),
			files: jest.fn(() => {
				throw new Error('Array listing is forbidden.');
			}),
			archive: jest.fn(() => {
				throw new Error('Archive read is forbidden.');
			}),
			restore: jest.fn(() => {
				throw new Error('Restore is forbidden.');
			}),
			diff: jest.fn(async (previous: string, current: string, consume: any) => {
				consume({ message_type: 'change', path: artifact().path, modifier: 'M' });
				consume({
					message_type: 'statistics',
					source_snapshot: previous,
					target_snapshot: current,
				});
			}),
		};
		service = new RemoteRepositoryRecoveryService(
			stores.repositories,
			stores.backups,
			stores.plans,
			stores.restores,
			{
				getSftpRecoveryOptions: async () => ({
					host: '192.0.2.10',
					port: '22',
					user: 'fixture-user',
					pass: 'synthetic-sftp-password',
				}),
			},
			stores.agents,
			{ withSession: async (_access: any, consume: any) => consume(session) },
			secret,
			path.join(root, 'staging')
		);
	});
	afterEach(async () => {
		await service.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	async function done(retry = false) {
		await service.comparison('current', 'start', {}, retry);
		const deadline = Date.now() + 10000;
		for (;;) {
			const result: any = await service.comparison('current', 'status');
			if (result.state !== 'preparing') return result;
			if (Date.now() > deadline) throw new Error('Comparison did not settle.');
			await new Promise<void>(r => setImmediate(r));
		}
	}
	test('missing status admits nothing; verified SQL pair reaches Ready with accurate pagination and no content reads', async () => {
		expect((await service.comparison('current', 'status')).state).toBe('missing');
		expect(session.snapshot).not.toHaveBeenCalled();
		expect(session.diff).not.toHaveBeenCalled();
		const result = await done();
		expect(result).toMatchObject({
			state: 'ready',
			previousBackupId: 'old',
			compatibility: { mode: 'verified-database-roots' },
		});
		expect(result.summary).toMatchObject({ modified: 1, unchanged: 1 });
		const page: any = await service.comparison('current', 'page', {
			path: '/pluton/database',
			limit: 1,
		});
		expect(page.files).toEqual([
			expect.objectContaining({ path: artifact().path, change: 'modified', snapshotId: newId }),
		]);
		expect(session.files).not.toHaveBeenCalled();
		expect(session.archive).not.toHaveBeenCalled();
		expect(session.restore).not.toHaveBeenCalled();
	});
	test('preparing-409 is precise when an unproven extra root remains; explicit retry revalidates rather than bypassing', async () => {
		snapshots.get(newId).paths.push('/etc/foreign');
		const failed = await done();
		expect(failed).toMatchObject({
			state: 'failed',
			failureCode: 'preparing-409',
			failureCategory: 'snapshot-root-incompatible',
			failureDetail: 'snapshot-root-path-incompatible',
			failureStage: 'root-validation',
			processedEntries: 0,
		});
		expect(session.diff).not.toHaveBeenCalled();
		expect((await done(true)).state).toBe('failed');
		snapshots.get(newId).paths.pop();
		expect((await done(true)).state).toBe('ready');
		expect(session.diff).toHaveBeenCalledTimes(1);
	});
	test('receipt-backed database root changes are not confused with an unavailable diff adapter', async () => {
		delete session.diff;
		expect(await done()).toMatchObject({
			state: 'failed',
			failureCode: 'preparing-409',
			failureDetail: 'restic-diff-unavailable',
			failureCategory: 'diff-unavailable',
		});
	});
	test('missing previous snapshot stays inspectable as a failed job and ordinary current browsing remains available', async () => {
		snapshots.delete(oldId);
		expect(await done()).toMatchObject({
			state: 'failed',
			failureDetail: 'previous-snapshot-unavailable',
		});
		expect(await service.browse('current')).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: source + '/same.txt' })])
		);
	});
	test.each(['missing-tag', 'foreign-tag', 'ambiguous-tags'])(
		'ownership check refuses %s before diff',
		async kind => {
			snapshots.get(newId).tags =
				kind === 'missing-tag'
					? []
					: kind === 'foreign-tag'
						? ['pluton-plan-foreign', 'pluton-backup-current']
						: ['pluton-plan-plan-01', 'pluton-plan-foreign', 'pluton-backup-current'];
			expect(await done()).toMatchObject({
				state: 'failed',
				failureDetail: 'snapshot-ownership-mismatch',
			});
			expect(session.diff).not.toHaveBeenCalled();
		}
	);
	test('changed managed repository binding refuses admission and a non-full current snapshot ID cannot enter a job', async () => {
		repository.storagePath = 'elsewhere';
		await expect(service.comparison('current', 'start')).rejects.toMatchObject({
			diagnostic: 'repository-binding-changed',
		});
		repository.storagePath = 'application';
		records.get('current').completionStats.snapshot_id = 'latest';
		await expect(service.comparison('current', 'start')).rejects.toMatchObject({
			diagnostic: 'snapshot-identity-missing',
		});
		expect(session.diff).not.toHaveBeenCalled();
	});
	test('candidate selection skips incompatible recorded source scope but exposes the actual older pair', async () => {
		const incompatible = {
			...records.get('old'),
			id: 'nearer',
			completionStats: { snapshot_id: thirdId, sourcePaths: ['/srv/other'] },
		};
		records.set('nearer', incompatible);
		stores.backups.comparisonCandidates.mockResolvedValue([incompatible, records.get('old')]);
		expect(await done()).toMatchObject({
			state: 'ready',
			previousBackupId: 'old',
			skippedCandidates: 1,
		});
	});
	test('incomplete historical source metadata is unavailable, while exact stable roots can use historical source config', async () => {
		delete records.get('old').completionStats.sourcePaths;
		expect(await service.comparison('current', 'status')).toMatchObject({
			state: 'unavailable',
			failureDetail: 'historical-metadata-incomplete',
		});
		records.get('old').sourceConfig = { includes: [source] };
		expect((await done()).state).toBe('ready');
	});
	test('a new nearer candidate never replaces an already admitted pair, even during retry or repeated status polling', async () => {
		expect((await done()).previousBackupId).toBe('old');
		const newer = {
			...records.get('old'),
			id: 'nearer',
			completionStats: { ...records.get('old').completionStats, snapshot_id: thirdId },
		};
		records.set('nearer', newer);
		stores.backups.comparisonCandidates.mockResolvedValue([newer, records.get('old')]);
		expect(((await service.comparison('current', 'status')) as any).previousBackupId).toBe('old');
		expect(((await service.comparison('current', 'start', {}, true)) as any).previousBackupId).toBe(
			'old'
		);
		expect(session.diff).toHaveBeenCalledTimes(1);
	});
	test('changed receipt invalidates a stale comparison instead of presenting Ready or silently admitting another pair', async () => {
		expect((await done()).state).toBe('ready');
		records.get('old').completionStats.lifecycle.database.sha256 = 'e'.repeat(64);
		expect(await service.comparison('current', 'status')).toMatchObject({
			state: 'unavailable',
			failureDetail: 'comparison-context-changed',
		});
		expect((await service.comparison('current', 'start', {}, true)).state).toBe('unavailable');
		expect(session.diff).toHaveBeenCalledTimes(1);
	});
	test('an invalid previous full identity is unavailable rather than guessed or passed to Restic', async () => {
		records.get('old').completionStats.snapshot_id = 'bbbbbbbb';
		expect(await service.comparison('current', 'status')).toMatchObject({
			state: 'unavailable',
			failureDetail: 'snapshot-identity-missing',
		});
		expect(session.snapshot).not.toHaveBeenCalled();
		expect(session.diff).not.toHaveBeenCalled();
	});
	test('a different managed repository identity cannot reuse the previous Ready cache', async () => {
		expect((await done()).state).toBe('ready');
		repository.id = 'repository-other';
		expect(await service.comparison('current', 'status')).toMatchObject({
			state: 'unavailable',
			failureDetail: 'comparison-context-changed',
		});
		expect(session.diff).toHaveBeenCalledTimes(1);
	});
	test('an invalid snapshot index has its own stage and diagnostic rather than a repository binding label', async () => {
		session.streamFiles.mockRejectedValueOnce(
			new SnapshotIndexError('metadata-invalid', 'duplicate-entry')
		);
		expect(await done()).toMatchObject({
			state: 'failed',
			failureStage: 'current-index',
			failureDetail: 'snapshot-index-verification',
			processedEntries: 0,
		});
		expect(session.diff).not.toHaveBeenCalled();
	});
	test('mid-diff receipt mutation is detected at final revalidation and cannot publish Ready', async () => {
		const original = session.diff.getMockImplementation();
		session.diff.mockImplementation(async (...args: any[]) => {
			await original(...args);
			records.get('old').completionStats.lifecycle.database.sha256 = 'f'.repeat(64);
		});
		await service.comparison('current', 'start');
		const until = Date.now() + 10000;
		let result: any;
		do {
			result = (service as any).comparisons.status(
				(service as any).comparisons.find('current').key
			);
			if (result.state !== 'preparing') break;
			if (Date.now() > until) throw new Error('Comparison did not settle.');
			await new Promise<void>(r => setImmediate(r));
		} while (true);
		expect(result).toMatchObject({
			state: 'failed',
			failureDetail: 'comparison-context-changed',
			failureStage: 'final-revalidation',
		});
		expect(result.summary).toBeUndefined();
	});
});
