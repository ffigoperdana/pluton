import { drizzle } from 'drizzle-orm/better-sqlite3';
import { fixture } from '../integration/persistentRestore.fixture';
import { StorageStore } from '../../src/stores/StorageStore';
import {
	PlanRepositoryRelocationStore,
	type PlanRepositoryRelocation,
} from '../../src/stores/PlanRepositoryRelocationStore';

const evidence = {
	repositoryConfigId: 'c'.repeat(64),
	fileCount: 12,
	totalBytes: 4096,
	listingDigest: 'd'.repeat(64),
	snapshotCount: 1,
};

describe('plan repository relocation store', () => {
	let context: ReturnType<typeof fixture>;
	let store: PlanRepositoryRelocationStore;
	const relocation = (patch: Partial<PlanRepositoryRelocation> = {}): PlanRepositoryRelocation => ({
		id: 'relocation-01',
		planId: 'plan-01',
		repositoryId: 'repo-01',
		source: { storageId: 'storage-01', storagePath: 'managed/fixture' },
		destination: { storageId: 'storage-02', storagePath: 'managed/fixture-moved' },
		status: 'copying',
		phase: 'source-inventory',
		planWasActive: true,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		audit: [{ at: Date.now(), event: 'requested' }],
		...patch,
	});
	const ready = () => {
		store.create(relocation());
		return store.transition('relocation-01', ['copying'], {
			status: 'ready',
			phase: 'ready',
			evidence,
			verifiedAt: Date.now(),
		})!;
	};
	const row = (sql: string, ...params: unknown[]) =>
		context.sqlite.prepare(sql).get(...params) as Record<string, unknown>;

	beforeEach(() => {
		context = fixture();
		context.sqlite.exec(`
			UPDATE plans SET storage_path='managed/fixture';
			INSERT INTO storages(id,name,type) VALUES('storage-02','Fixture SFTP 2','sftp');
		`);
		store = new PlanRepositoryRelocationStore(context.sqlite);
	});
	afterEach(() => context.sqlite.close());

	it('creates one active relocation per plan and one copy workload globally', () => {
		const created = store.create(relocation());
		expect(created.status).toBe('copying');
		expect(created.planWasActive).toBe(true);
		expect(() => store.create(relocation({ id: 'relocation-02' }))).toThrow(
			'already active for this plan'
		);
		context.sqlite.exec(`
			INSERT INTO plans(id,title,source_id,source_type,method,storage_id,storage_path,source_config,settings)
			VALUES('plan-02','Second','app-01','device','backup','storage-01','managed/second','{}','{}');
			INSERT INTO remote_managed_repositories(id,plan_id,agent_id,storage_id,storage_path,encrypted_password,initialized_at)
			VALUES('repo-02','plan-02','agent-01','storage-01','managed/second','synthetic-cipher',1);
		`);
		expect(() =>
			store.create(
				relocation({
					id: 'relocation-02',
					planId: 'plan-02',
					repositoryId: 'repo-02',
					source: { storageId: 'storage-01', storagePath: 'managed/second' },
				})
			)
		).toThrow('Another repository relocation is copying');
	});

	it.each([
		['backup', "UPDATE backups SET in_progress=1", 'running backup'],
		[
			'restore',
			"INSERT INTO restores(id,plan_id,backup_id,source_id,in_progress) VALUES('restore-01','plan-01','backup-01','app-01',1)",
			'running restore',
		],
		[
			'replication',
			`INSERT INTO managed_replication_jobs(id,backup_id,plan_id,repository_id,agent_id,source_storage_id,source_storage_path,source_snapshot_id,source_repository_config_id,source_tree_id,source_binding_hash,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,status,created_at,updated_at)
			 VALUES('job-01','backup-01','plan-01','repo-01','agent-01','storage-01','managed/fixture','${'b'.repeat(64)}','${'c'.repeat(64)}','${'d'.repeat(64)}','${'e'.repeat(64)}','mirror-01','storage-03','bucket/fixture','${'f'.repeat(64)}','pending',1,1)`,
			'Managed replication',
		],
		[
			'assisted recovery',
			"INSERT INTO assisted_recovery_jobs(id,owner,plan_id,backup_id,request_key,request_hash,status,phase,payload,created_at,updated_at,expires_at) VALUES('a1','admin','plan-01','backup-01','k','h','running','x','{}',1,1,1)",
			'Assisted Recovery',
		],
	])('refuses to start while a %s is active', (_name, statement, message) => {
		context.sqlite.exec(statement);
		expect(() => store.create(relocation())).toThrow(message);
		expect(store.listForPlan('plan-01')).toEqual([]);
	});

	it('refuses a stale source binding', () => {
		expect(() =>
			store.create(relocation({ source: { storageId: 'storage-01', storagePath: 'other/path' } }))
		).toThrow('binding changed');
	});

	it('blocks new backups, resume, storage edits and plan removal while active (database guards)', () => {
		context.sqlite.exec('UPDATE plans SET active=0');
		store.create(relocation());
		expect(() =>
			context.sqlite.exec(
				"INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,status,in_progress) VALUES('backup-02','plan-01','app-01','device','backup','storage-01','queued',1)"
			)
		).toThrow('PLAN_RELOCATION_ACTIVE');
		expect(() => context.sqlite.exec("UPDATE plans SET active=1 WHERE id='plan-01'")).toThrow(
			'PLAN_RELOCATION_ACTIVE'
		);
		expect(() =>
			context.sqlite.exec("UPDATE storages SET settings='{}' WHERE id='storage-02'")
		).toThrow('PLAN_RELOCATION_ACTIVE');
		expect(() => context.sqlite.exec("DELETE FROM storages WHERE id='storage-01'")).toThrow(
			'PLAN_RELOCATION_ACTIVE'
		);
		expect(() => context.sqlite.exec("DELETE FROM plans WHERE id='plan-01'")).toThrow(
			'PLAN_RELOCATION_ACTIVE'
		);
		expect(store.hasActiveForStorage('storage-02')).toBe(true);
		store.transition('relocation-01', ['copying'], { status: 'failed', phase: 'failed' });
		expect(store.hasActiveForStorage('storage-02')).toBe(false);
		context.sqlite.exec("UPDATE plans SET active=1 WHERE id='plan-01'");
	});

	it('explains the Storage edit guard before the database trigger fires', () => {
		const storages = new StorageStore(drizzle(context.sqlite) as any);
		store.create(relocation());
		expect(() => storages.assertManagedReplicationStorageEditable('storage-02')).toThrow(
			expect.objectContaining({ statusCode: 409, message: expect.stringContaining('repository relocation') })
		);
		store.transition('relocation-01', ['copying'], { status: 'cancelled', phase: 'cancelled' });
		expect(() => storages.assertManagedReplicationStorageEditable('storage-02')).not.toThrow();
	});

	it('transitions only from the expected state', () => {
		store.create(relocation());
		expect(store.transition('relocation-01', ['ready'], { status: 'switched' })).toBeUndefined();
		const verifying = store.transition(
			'relocation-01',
			['copying'],
			{ status: 'verifying', phase: 'hash-verification' },
			{ event: 'copy-completed' }
		)!;
		expect(verifying.status).toBe('verifying');
		expect(verifying.audit.map(event => event.event)).toEqual(['requested', 'copy-completed']);
		store.recordProgress('relocation-01', { verifiedFiles: 3, totalFiles: 12 });
		expect(store.get('relocation-01')!.progress).toEqual({ verifiedFiles: 3, totalFiles: 12 });
	});

	it('switches plan, repository record, backup history and replication receipts in one transaction', () => {
		context.sqlite.exec(`
			INSERT INTO managed_replication_jobs(id,backup_id,plan_id,repository_id,agent_id,source_storage_id,source_storage_path,source_snapshot_id,source_repository_config_id,source_tree_id,source_binding_hash,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,status,created_at,updated_at,verified_at)
			VALUES('job-01','backup-01','plan-01','repo-01','agent-01','storage-01','managed/fixture','${'b'.repeat(64)}','${'c'.repeat(64)}','${'d'.repeat(64)}','${'e'.repeat(64)}','mirror-01','storage-03','bucket/fixture','${'f'.repeat(64)}','completed',1,1,1);
			INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,storage_path,status,in_progress,success)
			VALUES('backup-other','plan-01','app-01','device','backup','storage-01','other/history','failed',0,0);
		`);
		const before = ready();
		expect(before.status).toBe('ready');
		const switched = store.switchBinding('relocation-01');
		expect(switched.status).toBe('switched');
		expect(switched.switchedAt).toBeGreaterThan(0);
		expect(row('SELECT storage_id,storage_path FROM plans WHERE id=?', 'plan-01')).toEqual({
			storage_id: 'storage-02',
			storage_path: 'managed/fixture-moved',
		});
		expect(
			row('SELECT storage_id,storage_path FROM remote_managed_repositories WHERE id=?', 'repo-01')
		).toEqual({ storage_id: 'storage-02', storage_path: 'managed/fixture-moved' });
		expect(row('SELECT storage_id,storage_path FROM backups WHERE id=?', 'backup-01')).toEqual({
			storage_id: 'storage-02',
			storage_path: 'managed/fixture-moved',
		});
		// Rows that never lived at the relocated location keep their history.
		expect(row('SELECT storage_path FROM backups WHERE id=?', 'backup-other')).toEqual({
			storage_path: 'other/history',
		});
		expect(
			row(
				'SELECT source_storage_id,source_storage_path,source_repository_config_id FROM managed_replication_jobs WHERE id=?',
				'job-01'
			)
		).toEqual({
			source_storage_id: 'storage-02',
			source_storage_path: 'managed/fixture-moved',
			source_repository_config_id: 'c'.repeat(64),
		});
		// Recovery-test insertion trigger requires backup and repository to agree.
		context.sqlite.exec(
			`INSERT INTO recovery_tests(id,plan_id,backup_id,repository_id,snapshot_id,status,"trigger",policy) VALUES('test-01','plan-01','backup-01','repo-01','${'b'.repeat(64)}','completed','manual','{}')`
		);
		expect(() => store.switchBinding('relocation-01')).toThrow('state changed');
		expect(store.retainedLocations()).toEqual([
			expect.objectContaining({
				storageId: 'storage-01',
				storagePath: 'managed/fixture',
				role: 'previous-location',
			}),
		]);
	});

	it('rechecks idle state inside the switch transaction', () => {
		ready();
		context.sqlite.exec(
			"INSERT INTO restores(id,plan_id,backup_id,source_id,in_progress) VALUES('restore-01','plan-01','backup-01','app-01',1)"
		);
		expect(() => store.switchBinding('relocation-01')).toThrow('running restore');
		expect(store.get('relocation-01')!.status).toBe('ready');
		expect(row('SELECT storage_id FROM plans WHERE id=?', 'plan-01')).toEqual({
			storage_id: 'storage-01',
		});
	});

	it('reverts only history that existed at switch time and refuses after a new successful backup', () => {
		ready();
		const switched = store.switchBinding('relocation-01');
		const later = Math.floor(switched.switchedAt! / 1000) + 5;
		context.sqlite.exec(
			`INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,storage_path,status,in_progress,success,started_at)
			 VALUES('backup-new-failed','plan-01','app-01','device','backup','storage-02','managed/fixture-moved','failed',0,0,${later})`
		);
		expect(store.hasSuccessfulBackupSinceSwitch(switched)).toBe(false);
		const reverted = store.revertBinding('relocation-01');
		expect(reverted.status).toBe('reverted');
		expect(row('SELECT storage_id,storage_path FROM plans WHERE id=?', 'plan-01')).toEqual({
			storage_id: 'storage-01',
			storage_path: 'managed/fixture',
		});
		expect(row('SELECT storage_id FROM backups WHERE id=?', 'backup-01')).toEqual({
			storage_id: 'storage-01',
		});
		expect(row('SELECT storage_id FROM backups WHERE id=?', 'backup-new-failed')).toEqual({
			storage_id: 'storage-02',
		});
		expect(store.retainedLocations()).toEqual([
			expect.objectContaining({ storageId: 'storage-02', role: 'relocation-destination' }),
		]);
	});

	it('refuses revert once a successful backup exists at the new location', () => {
		ready();
		const switched = store.switchBinding('relocation-01');
		const later = Math.floor(switched.switchedAt! / 1000) + 5;
		context.sqlite.exec(
			`INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,storage_path,status,in_progress,success,started_at)
			 VALUES('backup-new','plan-01','app-01','device','backup','storage-02','managed/fixture-moved','completed',0,1,${later})`
		);
		expect(store.hasSuccessfulBackupSinceSwitch(store.get('relocation-01')!)).toBe(true);
		expect(() => store.revertBinding('relocation-01')).toThrow('successful backup already exists');
		expect(store.markSourceDeleted('relocation-01').status).toBe('source-deleted');
		expect(store.retainedLocations()).toEqual([]);
	});
});
