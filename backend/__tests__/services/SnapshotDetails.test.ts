import { BackupService } from '../../src/services/BackupServices';
import { BackupController } from '../../src/controllers/BackupController';
import { createBackupRouter } from '../../src/routes/backups';
import express from 'express';
import request from 'supertest';
jest.mock('../../src/middlewares/authMiddleware', () => ({
	__esModule: true,
	default: (req: any, res: any, next: any) =>
		req.headers.cookie === 'fixture=admin' ? next() : res.status(401).end(),
}));
const snapshot = 'a'.repeat(64);
function fixture() {
	const backup: any = {
		id: 'backup-01',
		planId: 'plan-01',
		storageId: 'storage-01',
		sourceId: 'app-01',
		sourceType: 'device',
		method: 'backup',
		status: 'completed',
		started: new Date('2026-01-01T00:00:00Z'),
		ended: new Date('2026-01-01T00:00:10Z'),
		sourceConfig: { password: 'captured-private-value' },
		completionStats: {
			snapshot_id: snapshot,
			total_files_processed: 3,
			total_bytes_processed: 14,
			files_new: 1,
			files_changed: 1,
			files_unmodified: 1,
			data_added_packed: 0,
			lifecycle: {
				warnings: [],
				databases: [
					{
						databaseId: 'database-01',
						engine: 'mysql',
						database: 'example_app',
						path: '/pluton/database/example.sql',
						bytes: 7,
						sha256: 'b'.repeat(64),
						password: 'captured-private-value',
					},
				],
			},
		},
	};
	const recovery = {
		latestForSnapshot: jest.fn(async () => ({
			id: 'test-01',
			status: 'failed',
			createdAt: new Date(),
		})),
	};
	const remote = { comparison: jest.fn(async () => ({ state: 'missing' })) };
	const service = new BackupService(
		{} as any,
		{} as any,
		{
			getById: async () => ({
				title: 'Example plan',
				settings: { interval: { timeZone: 'Asia/Jakarta' } },
				password: 'captured-private-value',
			}),
		} as any,
		{ getById: async (id: string) => (id === backup.id ? backup : null) } as any,
		{} as any,
		{
			getById: async () => ({
				id: 'storage-01',
				name: 'Example SFTP',
				type: 'sftp',
				credentials: { password: 'captured-private-value' },
			}),
		} as any,
		undefined,
		remote as any,
		undefined,
		recovery as any
	);
	const app = express();
	app.use(express.json());
	app.use('/api/backups', createBackupRouter(new BackupController(service)));
	return { backup, recovery, remote, service, app };
}
test('details project only trustworthy recorded fields, distinguish missing values from zero and retain exact recovery binding', async () => {
	const f = fixture(),
		value = await f.service.snapshotDetails('backup-01');
	expect(value).toMatchObject({
		backupId: 'backup-01',
		snapshotId: snapshot,
		timeZone: 'Asia/Jakarta',
		statistics: { totalFiles: 3, logicalBytes: 14, deletedFiles: null, packedRepositoryBytes: 0 },
		recovery: { status: 'failed' },
	});
	expect(value.databases[0]).toMatchObject({ engine: 'mysql', bytes: 7, reference: 'database-01' });
	expect(JSON.stringify(value)).not.toContain('captured-private-value');
	expect(f.recovery.latestForSnapshot).toHaveBeenCalledWith('plan-01', 'backup-01', snapshot);
	f.backup.completionStats.lifecycle.databases[0].path = '/pluton/database/../outside.sql';
	expect((await f.service.snapshotDetails('backup-01')).databases).toEqual([]);
	f.backup.completionStats = null;
	const old = await f.service.snapshotDetails('backup-01');
	expect(old.snapshotId).toBeNull();
	expect(old.statistics.logicalBytes).toBeNull();
	expect(old.databases).toEqual([]);
});
test('details and comparison require authentication and reject arbitrary configuration/repository overrides', async () => {
	const f = fixture();
	for (const method of ['get', 'post', 'delete'] as const)
		expect((await request(f.app)[method]('/api/backups/backup-01/comparison')).status).toBe(401);
	expect((await request(f.app).get('/api/backups/backup-01/details')).status).toBe(401);
	expect(
		(await request(f.app).get('/api/backups/backup-01/details').set('Cookie', 'fixture=admin'))
			.status
	).toBe(200);
	expect(
		(await request(f.app).get('/api/backups/foreign/details').set('Cookie', 'fixture=admin')).status
	).toBe(404);
	expect(
		(
			await request(f.app)
				.get('/api/backups/backup-01/details?password=bad')
				.set('Cookie', 'fixture=admin')
		).status
	).toBe(400);
	expect(
		(
			await request(f.app)
				.post('/api/backups/backup-01/comparison')
				.set('Cookie', 'fixture=admin')
				.send({ previousSnapshotId: 'c'.repeat(64) })
		).status
	).toBe(400);
	expect(
		(
			await request(f.app)
				.get('/api/backups/backup-01/comparison?path=/../escape&view=files')
				.set('Cookie', 'fixture=admin')
		).status
	).toBe(400);
});
