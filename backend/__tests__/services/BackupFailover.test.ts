import Cryptr from 'cryptr';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
	BackupFailoverService,
	failoverEligible,
	FAILOVER_TIMING,
} from '../../src/services/BackupFailoverService';
import { configService } from '../../src/services/ConfigService';
import { RemoteBackupService } from '../../src/services/RemoteBackupService';
import { AgentStore } from '../../src/stores/AgentStore';
import { BackupFailoverStore } from '../../src/stores/BackupFailoverStore';
import { BackupStore } from '../../src/stores/BackupStore';
import { ManagedReplicationStore } from '../../src/stores/ManagedReplicationStore';
import { PlanStore } from '../../src/stores/PlanStore';
import { RemoteManagedRepositoryStore } from '../../src/stores/RemoteManagedRepositoryStore';
import { StorageStore } from '../../src/stores/StorageStore';
import { replicaRepositoryIdentity } from '../../src/utils/managedReplicaIdentity';
import { fixture } from '../integration/persistentRestore.fixture';
import { backupRelations, backups as backupsTable } from '../../src/db/schema/backups';
import { plans as plansTable, plansRelations } from '../../src/db/schema/plans';
import { storageRelations, storages as storagesTable } from '../../src/db/schema/storages';
import { deviceRelations, devices } from '../../src/db/schema/devices';
import { restoreRelations, restores } from '../../src/db/schema/restores';
import {
	agentCommandRelations,
	agentCommands,
	agentIdentities,
	agentIdentityRelations,
} from '../../src/db/schema/agents';
import {
	remoteManagedRepositories,
	remoteManagedRepositoryRelations,
} from '../../src/db/schema/remoteManagedRepositories';

jest.mock('../../src/utils/logger', () => ({
	serverLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
	planLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

/** Stage 3 (docs/BACKUP_FAILOVER.md) against the real SQLite schema and stores. */
const PRIMARY_ID = 'e'.repeat(64);
const REPLICA_ID = 'd'.repeat(64);
const FAILOVER_SNAPSHOT = 'f'.repeat(64);
const PRIMARY_COPY = '2'.repeat(64);
const TREE = '1'.repeat(64);
const replicaPath = 'bucket-01/replicas/app-01';
const cipher = () => new Cryptr(configService.config.SECRET);
const replica = {
	replicationId: 'replica-s3',
	storageId: 'storage-s3',
	storagePath: replicaPath,
	storageName: 'HCP replica',
	storageType: 's3compatible',
	addedAt: 1,
};

function setup(options: { failover?: 'off' | 'automatic'; receipt?: boolean } = {}) {
	const context = fixture();
	const { sqlite } = context;
	const db = drizzle(sqlite, {
		schema: {
			plans: plansTable,
			plansRelations,
			storages: storagesTable,
			storageRelations,
			devices,
			deviceRelations,
			restores,
			restoreRelations,
			backups: backupsTable,
			backupRelations,
			agentIdentities,
			agentIdentityRelations,
			agentCommands,
			agentCommandRelations,
			remoteManagedRepositories,
			remoteManagedRepositoryRelations,
		},
	}) as any;
	const crypt = cipher();
	sqlite.prepare('INSERT INTO storages(id,name,type,credentials,settings) VALUES(?,?,?,?,?)').run(
		'storage-s3',
		'HCP replica',
		's3compatible',
		JSON.stringify({
			bucket: crypt.encrypt('bucket-01'),
			access_key_id: crypt.encrypt('SYNTHETICKEY01'),
			secret_access_key: crypt.encrypt('synthetic-secret-key-01'),
		}),
		JSON.stringify({ hcp_mode: true, endpoint: 'https://s3.example.internal' })
	);
	sqlite.prepare('UPDATE agent_identities SET capabilities=?,agent_version=? WHERE agent_id=?').run(
		JSON.stringify({
			commandTypes: ['BACKUP_FILESYSTEM'],
			repositoryBackends: ['sftp', 's3'],
			backupPayloadVersion: 5,
		}),
		'0.9.0',
		'agent-01'
	);
	sqlite.prepare('UPDATE plans SET storage_path=?,settings=? WHERE id=?').run(
		'managed/fixture',
		JSON.stringify({
			replication: {
				enabled: true,
				concurrent: false,
				recoveryPolicy: 'assisted',
				backupFailover: options.failover || 'automatic',
				storages: [replica],
			},
		}),
		'plan-01'
	);
	sqlite
		.prepare('UPDATE remote_managed_repositories SET encrypted_password=? WHERE id=?')
		.run(
			new Cryptr(configService.config.SECRET).encrypt('synthetic-repository-password'),
			'repo-01'
		);
	const storages = new StorageStore(db);
	const identity = replicaRepositoryIdentity(
		{
			type: 's3compatible',
			settings: { hcp_mode: true, endpoint: 'https://s3.example.internal' },
			credentials: {
				bucket: crypt.encrypt('bucket-01'),
				access_key_id: crypt.encrypt('SYNTHETICKEY01'),
				secret_access_key: crypt.encrypt('synthetic-secret-key-01'),
			},
		} as any,
		replicaPath
	);
	sqlite
		.prepare(
			`INSERT INTO managed_replication_destinations(fingerprint,plan_id,replication_id,source_repository_id,destination_storage_id,destination_storage_path,destination_authority,destination_prefix,init_state,actual_repository_id,created_at) VALUES(?,?,?,?,?,?,?,?,'ready',?,1)`
		)
		.run(
			identity.fingerprint,
			'plan-01',
			replica.replicationId,
			'repo-01',
			replica.storageId,
			replicaPath,
			identity.authority,
			identity.prefix,
			REPLICA_ID
		);
	if (options.receipt !== false)
		sqlite
			.prepare(
				`INSERT INTO managed_replication_jobs(id,backup_id,plan_id,repository_id,agent_id,source_storage_id,source_storage_path,source_snapshot_id,source_repository_config_id,source_tree_id,source_binding_hash,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,destination_snapshot_id,status,attempts,created_at,updated_at,verified_at) VALUES('job-01','backup-01','plan-01','repo-01','agent-01','storage-01','managed/fixture',?,?,?,?,?,?,?,?,?,'completed',1,1,1,1)`
			)
			.run(
				'b'.repeat(64),
				PRIMARY_ID,
				TREE,
				'c'.repeat(64),
				replica.replicationId,
				replica.storageId,
				replicaPath,
				identity.fingerprint,
				'9'.repeat(64)
			);
	// The newest run failed before upload: the Agent could not reach the primary.
	sqlite
		.prepare(
			`INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,storage_path,status,in_progress,success,started_at,progress_stats) VALUES('backup-02','plan-01','app-01','device','backup','storage-01','managed/fixture','failed',0,0,?,?)`
		)
		.run(
			Math.floor(Date.now() / 1000) + 60,
			JSON.stringify({
				sourceFailure: { failureStage: 'repository-check', failureCode: 'repository-check-failed' },
			})
		);
	const backups = new BackupStore(db);
	const plans = new PlanStore(db);
	const repositories = new RemoteManagedRepositoryStore(db);
	const agents = new AgentStore(db);
	const jobs = new ManagedReplicationStore(sqlite);
	const failovers = new BackupFailoverStore(sqlite);
	const remote = new RemoteBackupService(repositories, agents, plans, backups, storages);
	const replication = {
		repositoryAccess: jest.fn(async () => ({ options: { type: 'sftp' } })),
		executing: jest.fn(() => false),
		refreshMirrors: jest.fn(async () => undefined),
		enqueueBackup: jest.fn(async () => undefined),
	};
	const executor = {
		inspectSource: jest.fn(async (source: any) => ({
			repositoryConfigId: REPLICA_ID,
			snapshot: { id: source.snapshotId, tree: TREE, tags: [], paths: ['/srv/example-app'] },
		})),
		copy: jest.fn(async () => ({ snapshotId: PRIMARY_COPY, repositoryConfigId: PRIMARY_ID })),
	};
	const state = { primary: 'down' as 'down' | 'up' | 'replaced', replica: 'up' as 'up' | 'down' };
	const probe = jest.fn(async (storage: any) => {
		if (storage.id === 'storage-01') {
			if (state.primary === 'down') throw new Error('synthetic transport failure');
			return state.primary === 'up' ? PRIMARY_ID : 'a'.repeat(64);
		}
		if (state.replica === 'down') throw new Error('synthetic transport failure');
		return REPLICA_ID;
	});
	let now = Date.now();
	const clock = { advance: (ms: number) => (now += ms) };
	const service = new BackupFailoverService(
		failovers,
		jobs,
		backups,
		plans,
		repositories,
		agents,
		storages,
		{
			getRepositoryAccessOptions: async (id: string) =>
				id === 'storage-s3' ? { type: 's3' } : { host: 'sftp.example.internal' },
			queueFailoverBackup: (...args) => remote.queueFailoverBackup(...args),
		},
		replication,
		executor as any,
		probe,
		configService.config.SECRET,
		() => now
	);
	return { ...context, service, failovers, replication, executor, probe, state, clock };
}

describe('backup failover eligibility', () => {
	it('fails over only on pre-upload repository and transport failures', () => {
		expect(failoverEligible('repository-check', 'repository-check-failed')).toBe(true);
		expect(failoverEligible('repository-check', 'target-check-transport-failed')).toBe(true);
		expect(failoverEligible('repository-target-check', 'repository-target-check-failed')).toBe(
			true
		);
		expect(failoverEligible('repository-check', 'target-check-auth-failed')).toBe(false);
		expect(failoverEligible('repository-target-check', 'repository-target-not-empty')).toBe(false);
		expect(failoverEligible('restic-backup', 'restic-backup-failed')).toBe(false);
		expect(failoverEligible('database-dump', 'database-unavailable')).toBe(false);
		expect(failoverEligible(undefined, undefined)).toBe(false);
	});
});

describe('BackupFailoverService', () => {
	let context: ReturnType<typeof setup>;
	afterEach(() => context?.sqlite.close());

	it('queues a failover backup into the verified replica when the server cannot reach the primary either', async () => {
		context = setup();
		expect(await context.service.consider('backup-02')).toBe('queued');
		const row = context.failovers.getByFailedBackup('backup-02')!;
		expect(row).toMatchObject({
			status: 'queued',
			planId: 'plan-01',
			replicationId: 'replica-s3',
			destinationStoragePath: replicaPath,
			primaryRepositoryConfigId: PRIMARY_ID,
			replicaRepositoryConfigId: REPLICA_ID,
		});
		const backup = context.sqlite
			.prepare(
				'SELECT title,description,in_progress,storage_id,storage_path FROM backups WHERE id=?'
			)
			.get(row.backupId) as any;
		expect(backup).toEqual({
			title: 'Failover backup',
			description: 'Failover of backup-02 to HCP replica.',
			in_progress: 1,
			storage_id: 'storage-01',
			storage_path: 'managed/fixture',
		});
		const command = context.sqlite
			.prepare('SELECT payload FROM agent_commands WHERE id=?')
			.get(`remote-backup-${row.backupId}`) as any;
		expect(JSON.parse(command.payload)).toEqual({
			backupId: row.backupId,
			planId: 'plan-01',
			repositoryId: 'repo-01',
		});
		expect(await context.service.failoverTarget(row.backupId)).toEqual({
			storageId: 'storage-s3',
			storagePath: replicaPath,
		});
		expect(await context.service.failoverTarget('backup-02')).toBeUndefined();
		expect(await context.service.consider('backup-02')).toBe('already-decided');
		// A failover run never fails over again.
		expect(await context.service.consider(row.backupId)).toBe('not-eligible');
	});

	it('does not fail over while the server still reaches the primary', async () => {
		context = setup();
		context.state.primary = 'up';
		expect(await context.service.consider('backup-02')).toBe('primary-reachable');
		expect(context.failovers.getByFailedBackup('backup-02')).toBeNull();
	});

	it('does not fail over for ineligible failures, a disabled plan, a newer run or an unverified replica', async () => {
		context = setup();
		context.sqlite.prepare('UPDATE backups SET progress_stats=? WHERE id=?').run(
			JSON.stringify({
				sourceFailure: {
					failureStage: 'repository-check',
					failureCode: 'target-check-auth-failed',
				},
			}),
			'backup-02'
		);
		expect(await context.service.consider('backup-02')).toBe('not-eligible');
		context.sqlite.close();

		context = setup({ failover: 'off' });
		expect(await context.service.consider('backup-02')).toBe('disabled');
		context.sqlite.close();

		context = setup();
		context.sqlite
			.prepare(
				`INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,storage_path,status,in_progress,success,started_at) VALUES('backup-03','plan-01','app-01','device','backup','storage-01','managed/fixture','completed',0,1,?)`
			)
			.run(Math.floor(Date.now() / 1000) + 120);
		expect(await context.service.consider('backup-02')).toBe('superseded');
		context.sqlite.close();

		context = setup({ receipt: false });
		expect(await context.service.consider('backup-02')).toBe('no-verified-replica');
		expect(context.probe).not.toHaveBeenCalled();
	});

	it('skips an unreachable replica', async () => {
		context = setup();
		context.state.replica = 'down';
		expect(await context.service.consider('backup-02')).toBe('replica-unreachable');
		expect(context.failovers.getByFailedBackup('backup-02')).toBeNull();
	});

	it('does not fail over while a replica of the plan is being promoted', async () => {
		context = setup();
		context.service.setPromotionGuard(planId => planId === 'plan-01');
		expect(await context.service.consider('backup-02')).toBe('promotion-active');
		expect(context.failovers.getByFailedBackup('backup-02')).toBeNull();
	});

	it('verifies the failover snapshot in the replica, waits for the primary, then copies it back', async () => {
		context = setup();
		await context.service.consider('backup-02');
		const id = context.failovers.getByFailedBackup('backup-02')!.backupId;
		context.sqlite
			.prepare(
				"UPDATE backups SET status='completed',success=1,in_progress=0,completion_stats=? WHERE id=?"
			)
			.run(JSON.stringify({ snapshot_id: FAILOVER_SNAPSHOT }), id);
		context.sqlite
			.prepare('UPDATE plans SET stats=? WHERE id=?')
			.run(JSON.stringify({ size: 1, snapshots: ['b'.repeat(64), FAILOVER_SNAPSHOT] }), 'plan-01');
		await context.service.afterSuccess(id);
		await context.service.tick();
		expect(context.executor.inspectSource).toHaveBeenCalledWith(
			expect.objectContaining({
				snapshotId: FAILOVER_SNAPSHOT,
				access: expect.objectContaining({ repositoryPath: replicaPath }),
			}),
			expect.anything()
		);
		expect(context.failovers.getByBackup(id)).toMatchObject({
			status: 'verified',
			replicaSnapshotId: FAILOVER_SNAPSHOT,
		});
		const receipt = () =>
			context.sqlite
				.prepare(
					'SELECT status,source_snapshot_id,destination_snapshot_id,source_repository_config_id FROM managed_replication_jobs WHERE backup_id=?'
				)
				.get(id) as any;
		expect(receipt()).toEqual({
			status: 'completed',
			source_snapshot_id: FAILOVER_SNAPSHOT,
			destination_snapshot_id: FAILOVER_SNAPSHOT,
			source_repository_config_id: PRIMARY_ID,
		});
		expect(context.service.awaitingCopyBack(id)).toBe(true);
		expect(context.service.openReplicas('plan-01')).toEqual([
			{ replicationId: 'replica-s3', storageId: 'storage-s3', storagePath: replicaPath },
		]);

		// The primary is still down: nothing is copied and the step waits.
		await context.service.tick();
		expect(context.executor.copy).not.toHaveBeenCalled();
		expect(context.failovers.getByBackup(id)).toMatchObject({
			status: 'verified',
			lastErrorCode: 'primary-unreachable',
		});

		context.state.primary = 'up';
		context.clock.advance(FAILOVER_TIMING.primaryRecheckMs + 1);
		await context.service.tick();
		expect(context.executor.copy).toHaveBeenCalledWith(
			expect.objectContaining({
				destination: expect.objectContaining({ repositoryPath: 'managed/fixture' }),
				state: { repositoryConfigId: PRIMARY_ID, initialization: 'ready' },
			})
		);
		expect(context.failovers.getByBackup(id)).toMatchObject({
			status: 'copied-back',
			primarySnapshotId: PRIMARY_COPY,
		});
		const completion = context.sqlite
			.prepare('SELECT completion_stats FROM backups WHERE id=?')
			.get(id) as any;
		expect(JSON.parse(completion.completion_stats).snapshot_id).toBe(PRIMARY_COPY);
		expect(receipt()).toMatchObject({
			source_snapshot_id: PRIMARY_COPY,
			destination_snapshot_id: FAILOVER_SNAPSHOT,
		});
		const stats = context.sqlite
			.prepare('SELECT stats FROM plans WHERE id=?')
			.get('plan-01') as any;
		expect(JSON.parse(stats.stats).snapshots).toEqual(['b'.repeat(64), PRIMARY_COPY]);
		expect(context.replication.enqueueBackup).toHaveBeenCalledWith(id);
		expect(context.service.awaitingCopyBack(id)).toBe(false);
		expect(context.service.openReplicas('plan-01')).toEqual([]);
	});

	it('reconciles a failover run that finished while the server was restarting', async () => {
		context = setup();
		await context.service.consider('backup-02');
		const id = context.failovers.getByFailedBackup('backup-02')!.backupId;
		context.sqlite
			.prepare(
				"UPDATE backups SET status='completed',success=1,in_progress=0,completion_stats=? WHERE id=?"
			)
			.run(JSON.stringify({ snapshot_id: FAILOVER_SNAPSHOT }), id);
		// No afterSuccess handoff: the tick finds the finished run and verifies it.
		await context.service.tick();
		expect(context.failovers.getByBackup(id)).toMatchObject({ status: 'verified' });
	});

	it('never copies back into a replaced primary repository', async () => {
		context = setup();
		await context.service.consider('backup-02');
		const id = context.failovers.getByFailedBackup('backup-02')!.backupId;
		context.sqlite
			.prepare(
				"UPDATE backups SET status='completed',success=1,in_progress=0,completion_stats=? WHERE id=?"
			)
			.run(JSON.stringify({ snapshot_id: FAILOVER_SNAPSHOT }), id);
		await context.service.afterSuccess(id);
		await context.service.tick();
		context.state.primary = 'replaced';
		await context.service.tick();
		expect(context.executor.copy).not.toHaveBeenCalled();
		expect(context.failovers.getByBackup(id)).toMatchObject({
			status: 'failed',
			lastErrorCode: 'primary-changed',
		});
	});

	it('refuses a snapshot that is not the original written into the recorded replica', async () => {
		context = setup();
		await context.service.consider('backup-02');
		const id = context.failovers.getByFailedBackup('backup-02')!.backupId;
		context.sqlite
			.prepare(
				"UPDATE backups SET status='completed',success=1,in_progress=0,completion_stats=? WHERE id=?"
			)
			.run(JSON.stringify({ snapshot_id: FAILOVER_SNAPSHOT }), id);
		context.executor.inspectSource.mockResolvedValueOnce({
			repositoryConfigId: 'a'.repeat(64),
			snapshot: { id: FAILOVER_SNAPSHOT, tree: TREE, tags: [], paths: [] },
		});
		await context.service.afterSuccess(id);
		await context.service.tick();
		expect(context.failovers.getByBackup(id)).toMatchObject({
			status: 'failed',
			lastErrorCode: 'snapshot-identity-mismatch',
		});
		expect(
			context.sqlite
				.prepare('SELECT count(*) AS n FROM managed_replication_jobs WHERE backup_id=?')
				.get(id)
		).toEqual({ n: 0 });
	});

	it('marks a failed failover run as final and keeps its records while copy-back is open', async () => {
		context = setup();
		await context.service.consider('backup-02');
		const id = context.failovers.getByFailedBackup('backup-02')!.backupId;
		expect(() => context.sqlite.prepare('DELETE FROM plans WHERE id=?').run('plan-01')).toThrow(
			/MANAGED_FAILOVER_BUSY/
		);
		expect(() =>
			context.sqlite
				.prepare('UPDATE plans SET storage_path=? WHERE id=?')
				.run('managed/other', 'plan-01')
		).toThrow(/MANAGED_FAILOVER_BUSY/);
		context.sqlite.prepare("UPDATE backups SET status='failed',in_progress=0 WHERE id=?").run(id);
		await context.service.afterFailure(id);
		expect(context.failovers.getByBackup(id)?.status).toBe('backup-failed');
		expect(await context.service.failoverTarget(id).catch(error => error.message)).toMatch(
			/no longer queued/
		);
	});
});
