import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DatabaseRestoreService } from '../../src/services/DatabaseRestoreService';
import { recoveryMetadataToken } from '../../src/utils/recoveryPreparation';
import { RecoveryTestError } from '../../src/utils/recoveryValidation';
import { DatabaseRestoreError } from '../../src/utils/persistentRestorePolicy';
import { fixture, approval, row, sql } from '../integration/persistentRestore.fixture';

describe('Persistent MySQL service lifecycle and immutable binding', () => {
	let db: ReturnType<typeof fixture>,
		target: any,
		item: any,
		service: DatabaseRestoreService,
		root: string,
		targets: any,
		recovery: any,
		native: any,
		oldEnv: string | undefined;
	beforeEach(async () => {
		oldEnv = process.env.PLUTON_MYSQL_WORKER;
		process.env.PLUTON_MYSQL_WORKER = 'enabled';
		db = fixture();
		target = approval();
		target.engine = target.target.engine = 'mysql';
		item = row(target);
		item.artifact.engine = 'mysql';
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-service-'));
		const metadata = () => ({
			planId: item.planId,
			backupId: item.backupId,
			snapshotId: item.snapshotId,
			repositoryId: item.repositoryId,
			databases: [item.artifact],
		});
		item.metadataToken = recoveryMetadataToken(metadata());
		targets = {
			policy: async () => ({ maxSqlBytes: 128 * 1024 ** 2, maxRetentionSeconds: 86400 }),
			list: async () => [],
			resourceView: async () => ({ status: 'measured', sample: {}, observedAt: 1 }),
			admission: jest.fn(async () => {}),
			assertBinding: jest.fn(async current => {
				if (current.artifact.engine !== target.engine)
					throw new DatabaseRestoreError('target-binding-mismatch');
				return target;
			}),
			ca: async () => '/synthetic-ca',
			state: async () => ({ state: 'external' }),
		};
		recovery = {
			testMetadata: jest.fn(async () => metadata()),
			databaseRestoreArtifact: jest.fn(async (_binding, directory) => {
				await fs.mkdir(path.join(directory, 'pluton/database'), { recursive: true });
				await fs.writeFile(path.join(directory, 'pluton/database/db_example.sql'), sql, {
					mode: 0o600,
				});
			}),
		};
		native = {
			restore: jest.fn(async current => {
				db.store.addLease({
					restoreId: current.id,
					targetId: target.id,
					database: 'example_db',
					ownerToken: current.ownerToken,
					state: 'validated',
				});
				return {
					engine: 'mysql',
					version: '8.4.11',
					database: 'example_db',
					tables: 1,
					views: 0,
					bytes: 1024,
					catalog: [],
					catalogTruncated: false,
					observedAt: Date.now(),
				};
			}),
			inspect: jest.fn(async () => ({})),
			removeOwned: jest.fn(async current => {
				db.store.removeLease(current.id);
				return true;
			}),
		};
		service = new DatabaseRestoreService(
			db.store,
			{
				getById: async () =>
					({ sourceType: 'device', sourceId: 'app-01', method: 'backup' }) as any,
			},
			recovery,
			targets,
			path.join(root, 'workspace'),
			() => native
		);
	});
	afterEach(async () => {
		await service.shutdown();
		db.sqlite.close();
		await fs.rm(root, { recursive: true, force: true });
		if (oldEnv === undefined) delete process.env.PLUTON_MYSQL_WORKER;
		else process.env.PLUTON_MYSQL_WORKER = oldEnv;
	});
	const request = () => ({
		planId: item.planId,
		backupId: item.backupId,
		snapshotId: item.snapshotId,
		databaseId: item.databaseId,
		metadataToken: item.metadataToken,
		mode: 'custom',
		targetId: target.id,
		ttlSeconds: 3600,
		resourcesAcknowledged: true,
		securityAcknowledged: true,
	});
	const run = async () => {
		const result = await service.create(request(), 'administrator');
		await service.tick();
		await service.idle();
		return result.id;
	};
	it('keeps a verified restore active with durable completion, exact source identity and safe view', async () => {
		const id = await run(),
			result = service.get(id, 'administrator');
		expect(result).toMatchObject({
			status: 'active',
			engine: 'mysql',
			snapshotId: item.snapshotId,
			databaseId: item.databaseId,
			backupId: item.backupId,
		});
		expect(result.completedAt).toBeGreaterThan(0);
		expect(db.store.lease(id)?.state).toBe('validated');
		expect(native.removeOwned).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain(target.target.password);
		await service.tick();
		await service.idle();
		expect(service.get(id, 'administrator').status).toBe('active');
	});
	it('0014 preserves pre-existing encrypted approvals, source bindings, leases and 0013 index', async () => {
		db.store.create(item);
		db.store.bind(item.id, target);
		const before = db.store.get(item.id)!;
		// Reconstruct the pre-0014 schema ONLY in this disposable in-memory fixture.
		db.sqlite.exec(
			'ALTER TABLE persistent_database_restores DROP COLUMN completed_at; ALTER TABLE persistent_database_restores DROP COLUMN failure_stage; ALTER TABLE persistent_database_restores DROP COLUMN failure_code;'
		);
		db.sqlite.exec(
			await fs.readFile(
				path.join(process.cwd(), 'drizzle/0014_persistent_restore_outcomes.sql'),
				'utf8'
			)
		);
		const after = db.store.get(item.id)!;
		expect(after).toEqual({ ...before, completedAt: null, failureStage: null, failureCode: null });
		expect(after.encryptedApproval).toBe(before.encryptedApproval);
		expect(
			db.sqlite
				.prepare("SELECT name FROM sqlite_master WHERE name='backups_plan_history_date_idx'")
				.get()
		).toBeTruthy();
		expect(() =>
			db.sqlite
				.prepare('UPDATE persistent_database_restores SET snapshot_id=? WHERE id=?')
				.run('f'.repeat(64), item.id)
		).toThrow();
	});
	it('only advertises custom MySQL when enabled; Internal and unconfigured requests fail before reservation', async () => {
		expect(
			(
				await service.preview({
					planId: item.planId,
					backupId: item.backupId,
					snapshotId: item.snapshotId,
				})
			).engines.mysql
		).toEqual(['custom']);
		await expect(
			service.create({ ...request(), mode: 'internal' }, 'administrator')
		).rejects.toMatchObject({ code: 'mysql-internal-not-supported' });
		delete process.env.PLUTON_MYSQL_WORKER;
		await expect(service.create(request(), 'administrator')).rejects.toMatchObject({
			code: 'mysql-worker-not-configured',
		});
		expect(db.store.list()).toHaveLength(0);
	});
	it('rejects cross-engine and changed metadata without staging or modifying target', async () => {
		await expect(
			service.create({ ...request(), metadataToken: '0'.repeat(64) }, 'administrator')
		).rejects.toMatchObject({ code: 'snapshot-metadata-changed' });
		target.engine = target.target.engine = 'mariadb';
		await expect(service.create(request(), 'administrator')).rejects.toMatchObject({
			code: 'target-binding-mismatch',
		});
		expect(recovery.databaseRestoreArtifact).not.toHaveBeenCalled();
	});
	it('SQLite target reservation refuses concurrent reuse and retains encrypted credentials only', async () => {
		const first = await service.create(request(), 'administrator');
		await expect(service.create(request(), 'administrator')).rejects.toMatchObject({
			code: 'target-already-reserved',
		});
		expect(
			JSON.stringify(db.sqlite.prepare('SELECT * FROM persistent_database_restores').get())
		).not.toContain(target.target.password);
		expect(service.list('other-owner')).toEqual([]);
		expect(() => service.get(first.id, 'other-owner')).toThrow();
	});
	it('failed import never becomes active and original error survives failed cleanup', async () => {
		native.restore.mockRejectedValue(
			new RecoveryTestError('database-import', 'database-import-failed')
		);
		native.removeOwned.mockRejectedValue(new DatabaseRestoreError('restore-ownership-uncertain'));
		const id = await run();
		expect(service.get(id, 'administrator')).toMatchObject({
			status: 'cleanup_required',
			completedAt: null,
			failureStage: 'database-import',
			failureCode: 'database-import-failed',
			errorCode: 'restore-ownership-uncertain',
		});
	});
	it('SQL mismatch is rejected before worker import, with artifact stage preserved', async () => {
		recovery.databaseRestoreArtifact.mockImplementation(async (_binding, directory) => {
			await fs.mkdir(path.join(directory, 'pluton/database'), { recursive: true });
			await fs.writeFile(
				path.join(directory, 'pluton/database/db_example.sql'),
				sql.replace('fixture_entries', 'fixture_invalid')
			);
		});
		const id = await run();
		expect(service.get(id, 'administrator').failureStage).toBe('database-artifact-validation');
		expect(native.restore).not.toHaveBeenCalled();
	});
	it('expiry and exact-ID deletion clean only owned data and retain history idempotently', async () => {
		const id = await run();
		db.store.update(id, { expiresAt: Date.now() - 1 });
		await expect(service.inspect(id, 'administrator')).rejects.toMatchObject({
			code: 'restore-access-not-active',
		});
		await service.tick();
		await service.idle();
		expect(service.get(id, 'administrator').status).toBe('deleted');
		expect(db.store.lease(id)).toBeNull();
		await service.delete(id, 'administrator', { confirmation: id });
		expect(native.removeOwned).toHaveBeenCalledTimes(1);
		expect(db.store.list()).toHaveLength(1);
	});
	it('interrupted imports recover to ownership-checked cleanup, never resumed as success', async () => {
		const saved = await service.create(request(), 'administrator');
		db.store.claim(saved.id);
		await service.recoverInterrupted();
		await service.idle();
		expect(service.get(saved.id, 'administrator')).toMatchObject({
			status: 'deleted',
			errorCode: 'interrupted',
			completedAt: null,
		});
		expect(native.restore).not.toHaveBeenCalled();
	});
	it('shutdown of metadata-only inspection preserves a completed retained database', async () => {
		const id = await run();
		let entered!: () => void;
		const started = new Promise<void>(resolve => {
			entered = resolve;
		});
		native.inspect.mockImplementation(
			async (_row: unknown, _directory: unknown, signal: AbortSignal) => {
				entered();
				await new Promise<void>(resolve =>
					signal.addEventListener('abort', () => resolve(), { once: true })
				);
				throw new RecoveryTestError('database-import-validation', 'cancelled');
			}
		);
		const inspection = service.inspect(id, 'administrator');
		const refusal = expect(inspection).rejects.toMatchObject({ code: 'cancelled' });
		await started;
		await service.shutdown();
		await refusal;
		expect(service.get(id, 'administrator').status).toBe('active');
		expect(service.get(id, 'administrator').cancelRequested).toBe(false);
		expect(db.store.lease(id)?.state).toBe('validated');
		expect(native.removeOwned).not.toHaveBeenCalled();
	});
});
