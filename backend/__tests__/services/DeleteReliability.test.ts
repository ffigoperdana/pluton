import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import * as planSchema from '../../src/db/schema/plans';
import * as backupSchema from '../../src/db/schema/backups';
import * as restoreSchema from '../../src/db/schema/restores';
import * as storageSchema from '../../src/db/schema/storages';
import * as deviceSchema from '../../src/db/schema/devices';
import { legacyRepositories } from '../../src/db/schema/legacyRepositories';
import { PlanStore } from '../../src/stores/PlanStore';
import { BackupStore } from '../../src/stores/BackupStore';
import { RestoreStore } from '../../src/stores/RestoreStore';
import { StorageStore } from '../../src/stores/StorageStore';
import { DeviceStore } from '../../src/stores/DeviceStore';
import { PlanService } from '../../src/services/PlanService';
import { PlanController } from '../../src/controllers/PlanController';
import { createPlanRouter } from '../../src/routes/plans';
import { configService } from '../../src/services/ConfigService';
import { webAccess } from '../../src/middlewares/webAccess';
import { assertStorageRemovalScope } from '../../src/utils/storageRemovalScope';

describe('selected-resource deletion with real SQLite stores and HTTP route', () => {
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle>;
	let service: PlanService;
	let manager: {
		removeBackup: jest.Mock;
		removeReplicationStorage: jest.Mock;
		updateBackup: jest.Mock;
	};
	let app: express.Express;
	const replica = {
		replicationId: 'replica-a',
		storageId: 'storage-a',
		storagePath: '/synthetic/replica-a',
	};
	const plan = (id: string, storagePath: string) => ({
		id,
		title: id,
		sourceId: 'main',
		sourceType: 'device',
		method: 'backup',
		storageId: 'storage-a',
		storagePath,
		sourceConfig: { includes: ['/synthetic/source'], excludes: [] },
		settings: {
			interval: { type: 'daily', time: '10:00AM' },
			encryption: true,
			replication: { enabled: true, concurrent: false, storages: [replica] },
		},
	});
	beforeEach(() => {
		sqlite = new Database(':memory:');
		db = drizzle(sqlite, {
			schema: {
				...planSchema,
				...backupSchema,
				...restoreSchema,
				...storageSchema,
				...deviceSchema,
				legacyRepositories,
			},
		});
		migrate(db, { migrationsFolder: './drizzle' });
		db.insert(storageSchema.storages)
			.values({ id: 'storage-a', name: 'Local', type: 'local' })
			.run();
		db.insert(deviceSchema.devices).values({ id: 'main', name: 'Synthetic host' }).run();
		db.insert(planSchema.plans)
			.values([
				plan('plan-a', '/synthetic/a'),
				{ ...plan('plan-b', '/synthetic/b'), settings: { encryption: true } },
			] as any)
			.run();
		db.insert(backupSchema.backups)
			.values(
				['a', 'b'].map(id => ({
					id: 'backup-' + id,
					planId: 'plan-' + id,
					sourceId: 'main',
					method: 'backup',
					storageId: 'storage-a',
					storagePath: '/synthetic/' + id,
				}))
			)
			.run();
		manager = {
			removeBackup: jest.fn().mockResolvedValue({ success: true, result: 'Removed' }),
			removeReplicationStorage: jest.fn().mockResolvedValue({ success: true, result: 'Removed' }),
			updateBackup: jest.fn().mockResolvedValue({ success: true }),
		};
		service = new PlanService(
			manager as any,
			new PlanStore(db as any),
			new BackupStore(db as any),
			new StorageStore(db as any),
			new DeviceStore(db as any),
			new RestoreStore(db as any)
		);
		app = express();
		app.use(express.json());
		app.use(webAccess({ canonical: 'http://localhost:5173', origins: ['http://localhost:5173'] }));
		app.use('/api/plans', createPlanRouter(new PlanController(service)));
	});
	afterEach(() => sqlite.close());
	const remove = (query = '') =>
		request(app)
			.delete('/api/plans/plan-a' + query)
			.set('Host', 'localhost:5173')
			.set('Origin', 'http://localhost:5173')
			.set('Cookie', 'token=' + jwt.sign({ user: 'synthetic-user' }, configService.config.SECRET!));
	const rows = () => ({
		plans: sqlite.prepare('SELECT id FROM plans ORDER BY id').pluck().all(),
		backups: sqlite.prepare('SELECT id FROM backups ORDER BY id').pluck().all(),
	});
	it.each([false, true])(
		'removeData=%s only removes the selected plan and history',
		async removeData => {
			const response = await remove('?removeData=' + removeData);
			expect(response.status).toBe(200);
			expect(response.type).toBe('application/json');
			expect(response.body.success).toBe(true);
			expect(manager.removeBackup).toHaveBeenCalledWith(
				'plan-a',
				expect.objectContaining({ removeRemoteData: removeData })
			);
			expect(rows()).toEqual({ plans: ['plan-b'], backups: ['backup-b'] });
			expect((await remove('?removeData=' + removeData)).status).toBe(404);
			expect(manager.removeBackup).toHaveBeenCalledTimes(1);
		}
	);
	it('retains all metadata and never purges on execution failure', async () => {
		manager.removeBackup.mockResolvedValue({ success: false, result: 'Synthetic failure' });
		expect((await remove('?removeData=true')).status).toBe(500);
		expect(rows()).toEqual({ plans: ['plan-a', 'plan-b'], backups: ['backup-a', 'backup-b'] });
	});
	it('rolls back history deletion if the final plan row cannot be removed', async () => {
		sqlite.exec(
			"CREATE TRIGGER deny_plan_removal BEFORE DELETE ON plans WHEN OLD.id='plan-a' BEGIN SELECT RAISE(ABORT, 'synthetic removal failure'); END"
		);
		expect((await remove('?removeData=false')).status).toBe(500);
		expect(rows()).toEqual({ plans: ['plan-a', 'plan-b'], backups: ['backup-a', 'backup-b'] });
	});
	it('surfaces partial storage cleanup without claiming the data was erased', async () => {
		manager.removeBackup.mockResolvedValue({
			success: true,
			result: 'Removed schedule',
			unremovedPaths: [{ storageName: 'local', storagePath: '/synthetic/a' }],
			unremovedReason: 'Storage unavailable',
		});
		const response = await remove('?removeData=true');
		expect(response.status).toBe(200);
		expect(response.body.unremovedPaths).toHaveLength(1);
		expect(response.body.unremovedReason).toBe('Storage unavailable');
		expect(rows()).toEqual({ plans: ['plan-b'], backups: ['backup-b'] });
	});
	it.each(['plan', 'snapshot', 'legacy'])(
		'blocks overlapping retained %s before schedule or metadata changes',
		async kind => {
			if (kind === 'plan')
				sqlite
					.prepare('UPDATE plans SET storage_path=? WHERE id=?')
					.run('/synthetic/a/child', 'plan-b');
			if (kind === 'snapshot')
				sqlite
					.prepare('UPDATE backups SET storage_path=? WHERE id=?')
					.run('/synthetic/a', 'backup-b');
			if (kind === 'legacy')
				db.insert(legacyRepositories)
					.values({
						id: 'legacy-a',
						displayName: 'Synthetic imported',
						repositoryPath: '/synthetic/a/imported',
						encryptedPassword: 'synthetic-unused',
					})
					.run();
			expect((await remove('?removeData=true')).status).toBe(409);
			expect(manager.removeBackup).not.toHaveBeenCalled();
			expect(rows()).toEqual({ plans: ['plan-a', 'plan-b'], backups: ['backup-a', 'backup-b'] });
			// Metadata-only removal remains possible and explicitly retains all repository bytes.
			expect((await remove('?removeData=false')).status).toBe(200);
		}
	);
	it.each(['backup', 'restore'])('refuses deletion during active %s', async kind => {
		if (kind === 'backup')
			sqlite.prepare('UPDATE backups SET in_progress=1 WHERE id=?').run('backup-a');
		else
			db.insert(restoreSchema.restores)
				.values({
					id: 'restore-a',
					planId: 'plan-a',
					backupId: 'backup-a',
					sourceId: 'main',
					method: 'backup',
					inProgress: true,
					config: {},
				} as any)
				.run();
		expect((await remove('?removeData=true')).status).toBe(409);
		expect(manager.removeBackup).not.toHaveBeenCalled();
	});
	it('rejects mismatched replica identity before any purge or settings mutation', async () => {
		await expect(
			service.deleteReplicationStorage(
				'plan-a',
				'storage-a',
				'/synthetic/b',
				true,
				replica.replicationId
			)
		).rejects.toHaveProperty('statusCode', 409);
		expect(manager.removeReplicationStorage).not.toHaveBeenCalled();
		expect(
			JSON.parse(
				sqlite.prepare('SELECT settings FROM plans WHERE id=?').pluck().get('plan-a') as string
			).replication.storages
		).toEqual([replica]);
	});
	it('purges only the matched stored replica and preserves primary and other-plan rows', async () => {
		await service.deleteReplicationStorage(
			'plan-a',
			replica.storageId,
			replica.storagePath,
			true,
			replica.replicationId
		);
		expect(manager.removeReplicationStorage).toHaveBeenCalledWith('plan-a', {
			storageName: 'local',
			storagePath: replica.storagePath,
			removeData: true,
		});
		expect(rows()).toEqual({ plans: ['plan-a', 'plan-b'], backups: ['backup-a', 'backup-b'] });
	});
	it('never purges for replica metadata-only removal', async () => {
		await service.deleteReplicationStorage(
			'plan-a',
			replica.storageId,
			replica.storagePath,
			false,
			replica.replicationId
		);
		expect(manager.removeReplicationStorage).not.toHaveBeenCalled();
	});
	it('refuses a legacy replica with missing identity even if its path matches', async () => {
		const settings = {
			encryption: true,
			replication: {
				enabled: true,
				storages: [{ storageId: replica.storageId, storagePath: '/synthetic/a' }],
			},
		};
		sqlite
			.prepare('UPDATE plans SET settings=? WHERE id=?')
			.run(JSON.stringify(settings), 'plan-a');
		await expect(
			service.deleteReplicationStorage('plan-a', replica.storageId, '/synthetic/a', true)
		).rejects.toHaveProperty('statusCode', 409);
		expect(manager.removeReplicationStorage).not.toHaveBeenCalled();
	});
	it('refuses replica data deletion overlapping its own retained primary', async () => {
		const settings = {
			encryption: true,
			replication: { enabled: true, storages: [{ ...replica, storagePath: '/synthetic/a' }] },
		};
		sqlite
			.prepare('UPDATE plans SET settings=? WHERE id=?')
			.run(JSON.stringify(settings), 'plan-a');
		await expect(
			service.deleteReplicationStorage(
				'plan-a',
				replica.storageId,
				'/synthetic/a',
				true,
				replica.replicationId
			)
		).rejects.toHaveProperty('statusCode', 409);
		expect(manager.removeReplicationStorage).not.toHaveBeenCalled();
	});
	it('rejects duplicate deletion and manual backup while removal is in flight', async () => {
		let finish!: (value: unknown) => void;
		manager.removeBackup.mockImplementation(
			() =>
				new Promise(resolve => {
					finish = resolve;
				})
		);
		const pending = service.deletePlan('plan-a', false);
		while (!finish) await new Promise(resolve => setImmediate(resolve));
		await expect(service.deletePlan('plan-a', true)).rejects.toHaveProperty('statusCode', 409);
		await expect(service.performBackup('plan-a')).rejects.toHaveProperty('statusCode', 409);
		finish({ success: true, result: 'Removed' });
		await pending;
		expect(manager.removeBackup).toHaveBeenCalledTimes(1);
	});
	it('preserves auth and same-origin rejection as JSON without mutation', async () => {
		const noAuth = await request(app)
			.delete('/api/plans/plan-a')
			.set('Host', 'localhost:5173')
			.set('Origin', 'http://localhost:5173');
		expect(noAuth.status).toBe(401);
		expect(noAuth.type).toBe('application/json');
		const crossOrigin = await remove().set('Origin', 'https://example.invalid');
		expect(crossOrigin.status).toBe(403);
		expect(crossOrigin.type).toBe('application/json');
		expect(manager.removeBackup).not.toHaveBeenCalled();
	});
});

describe('whole-directory purge path boundaries', () => {
	it.each(['', '.', '/', 'C:\\', '../retained', '/synthetic/../retained'])(
		'refuses dangerous root/traversal %s',
		storagePath => {
			expect(() =>
				assertStorageRemovalScope({ storageId: 'storage-a', storagePath, local: true }, [], {
					planId: 'plan-a',
					kind: 'plan',
				})
			).toThrow();
		}
	);
	it.each(['/synthetic/a', '/synthetic/a/child', '/synthetic'])(
		'refuses equal or nested retained path %s',
		storagePath => {
			expect(() =>
				assertStorageRemovalScope(
					{ storageId: 'storage-a', storagePath: '/synthetic/a', local: true },
					[{ planId: 'plan-b', storageId: 'storage-a', storagePath, kind: 'primary' }],
					{ planId: 'plan-a', kind: 'plan' }
				)
			).toThrow();
		}
	);
	it('does not confuse a sibling prefix with a nested repository', () => {
		expect(() =>
			assertStorageRemovalScope(
				{ storageId: 'storage-a', storagePath: '/synthetic/a', local: true },
				[
					{
						planId: 'plan-b',
						storageId: 'storage-a',
						storagePath: '/synthetic/another',
						kind: 'primary',
					},
				],
				{ planId: 'plan-a', kind: 'plan' }
			)
		).not.toThrow();
	});
});
