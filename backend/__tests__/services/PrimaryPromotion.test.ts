import Cryptr from 'cryptr';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { configService } from '../../src/services/ConfigService';
import { AppError } from '../../src/utils/AppError';
import { ManagedRepositoryAccessError } from '../../src/utils/restic/ManagedSftpRepositorySession';
import { ManagedReplicationService } from '../../src/services/ManagedReplicationService';
import { PrimaryPromotionService } from '../../src/services/PrimaryPromotionService';
import { RemoteBackupService } from '../../src/services/RemoteBackupService';
import { AgentStore } from '../../src/stores/AgentStore';
import { BackupStore } from '../../src/stores/BackupStore';
import { ManagedReplicationStore } from '../../src/stores/ManagedReplicationStore';
import { PlanStore } from '../../src/stores/PlanStore';
import { PrimaryPromotionStore } from '../../src/stores/PrimaryPromotionStore';
import { RemoteManagedRepositoryStore } from '../../src/stores/RemoteManagedRepositoryStore';
import { StorageStore } from '../../src/stores/StorageStore';
import { replicaRepositoryIdentity } from '../../src/utils/managedReplicaIdentity';
import { replicaSourceBinding } from '../../src/utils/replicaSourceBinding';
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

// Every test migrates a fresh SQLite database; under a full parallel run that alone nears 5 s.
jest.setTimeout(30_000);

/** Stage 4 (docs/PRIMARY_PROMOTION.md) against the real SQLite schema and stores. */
const PRIMARY_ID = 'e'.repeat(64);
const REPLICA_ID = 'd'.repeat(64);
const ORIGINAL = 'b'.repeat(64);
const COPY = 'c'.repeat(64);
const LEFT = '3'.repeat(64);
const TREE = '1'.repeat(64);
const PRIMARY_PATH = 'managed/fixture';
const REPLICA_PATH = 'bucket-01/replicas/app-01';
const crypt = () => new Cryptr(configService.config.SECRET);
const encrypt = (values: Record<string, string>) =>
	Object.fromEntries(Object.entries(values).map(([key, value]) => [key, crypt().encrypt(value)]));
const s3Credentials = () =>
	encrypt({
		bucket: 'bucket-01',
		access_key_id: 'SYNTHETICKEY01',
		secret_access_key: 'synthetic-secret-key-01',
	});
const s3Settings = { hcp_mode: true, endpoint: 'https://s3.example.internal' };
const replicaEntry = {
	replicationId: 'replica-s3',
	storageId: 'storage-s3',
	storagePath: REPLICA_PATH,
	storageName: 'HCP replica',
	storageType: 's3compatible',
	addedAt: 1,
};

type SnapshotRecord = {
	id: string;
	tree: string;
	tags: string[];
	paths: string[];
	original?: string;
};

function setup() {
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
	const s3 = s3Credentials();
	sqlite
		.prepare('INSERT INTO storages(id,name,type,credentials,settings) VALUES(?,?,?,?,?)')
		.run(
			'storage-s3',
			'HCP replica',
			's3compatible',
			JSON.stringify(s3),
			JSON.stringify(s3Settings)
		);
	const sftp = encrypt({
		host: 'sftp.example.internal',
		user: 'fixture',
		pass: 'synthetic-sftp-pass',
	});
	sqlite
		.prepare('UPDATE storages SET credentials=?,settings=? WHERE id=?')
		.run(JSON.stringify(sftp), '{}', 'storage-01');
	sqlite.prepare('UPDATE agent_identities SET capabilities=?,agent_version=? WHERE agent_id=?').run(
		JSON.stringify({
			commandTypes: ['BACKUP_FILESYSTEM'],
			repositoryBackends: ['sftp', 's3'],
			backupPayloadVersion: 5,
		}),
		'0.9.0',
		'agent-01'
	);
	sqlite
		.prepare('UPDATE plans SET storage_path=?,source_config=?,settings=?,active=1 WHERE id=?')
		.run(
			PRIMARY_PATH,
			JSON.stringify({ includes: ['/srv/example-app'] }),
			JSON.stringify({
				encryption: true,
				replication: {
					enabled: true,
					concurrent: false,
					recoveryPolicy: 'assisted',
					backupFailover: 'automatic',
					storages: [replicaEntry],
				},
			}),
			'plan-01'
		);
	sqlite
		.prepare('UPDATE remote_managed_repositories SET encrypted_password=? WHERE id=?')
		.run(crypt().encrypt('synthetic-repository-password'), 'repo-01');
	const replicaIdentity = replicaRepositoryIdentity(
		{ type: 's3compatible', settings: s3Settings, credentials: s3 } as any,
		REPLICA_PATH
	);
	const primaryIdentity = replicaRepositoryIdentity(
		{ type: 'sftp', settings: {}, credentials: sftp } as any,
		PRIMARY_PATH
	);
	sqlite
		.prepare(
			`INSERT INTO managed_replication_destinations(fingerprint,plan_id,replication_id,source_repository_id,destination_storage_id,destination_storage_path,destination_authority,destination_prefix,init_state,actual_repository_id,created_at) VALUES(?,?,?,?,?,?,?,?,'ready',?,1)`
		)
		.run(
			replicaIdentity.fingerprint,
			'plan-01',
			replicaEntry.replicationId,
			'repo-01',
			'storage-s3',
			REPLICA_PATH,
			replicaIdentity.authority,
			replicaIdentity.prefix,
			REPLICA_ID
		);
	const backups = new BackupStore(db);
	const plans = new PlanStore(db);
	const repositories = new RemoteManagedRepositoryStore(db);
	const agents = new AgentStore(db);
	const storages = new StorageStore(db);
	const jobs = new ManagedReplicationStore(sqlite);
	const store = new PrimaryPromotionStore(sqlite);
	// backup-01 was copied to the replica; its binding hash is the real one.
	const backup01 = sqlite.prepare('SELECT * FROM backups WHERE id=?').get('backup-01') as any;
	const bindingOf = (snapshotId: string) =>
		replicaSourceBinding({
			sourceId: backup01.source_id,
			sourceType: backup01.source_type,
			completionStats: { snapshot_id: snapshotId },
		} as any);
	sqlite
		.prepare(
			`INSERT INTO managed_replication_jobs(id,backup_id,plan_id,repository_id,agent_id,source_storage_id,source_storage_path,source_snapshot_id,source_repository_config_id,source_tree_id,source_binding_hash,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,destination_snapshot_id,status,attempts,created_at,updated_at,verified_at) VALUES('job-01','backup-01','plan-01','repo-01','agent-01','storage-01',?,?,?,?,?,?,?,?,?,?,'completed',1,1,1,1)`
		)
		.run(
			PRIMARY_PATH,
			ORIGINAL,
			PRIMARY_ID,
			TREE,
			bindingOf(ORIGINAL),
			replicaEntry.replicationId,
			'storage-s3',
			REPLICA_PATH,
			replicaIdentity.fingerprint,
			COPY
		);
	// backup-03 predates its database dump: replication admission refused it.
	sqlite
		.prepare(
			`INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,storage_path,status,in_progress,success,started_at,completion_stats,mirrors) VALUES('backup-03','plan-01','app-01','device','backup','storage-01',?,'completed',0,1,?,?,?)`
		)
		.run(
			PRIMARY_PATH,
			Math.floor(Date.now() / 1000) - 3600,
			JSON.stringify({ snapshot_id: LEFT }),
			JSON.stringify([
				{ ...replicaEntry, status: 'failed', lastErrorCode: 'artifact-binding-mismatch' },
			])
		);
	const repositoriesState: Record<
		string,
		{ up: boolean; id: string; snapshots: Map<string, SnapshotRecord> }
	> = {
		'storage-01': {
			up: true,
			id: PRIMARY_ID,
			snapshots: new Map([
				[
					ORIGINAL,
					{ id: ORIGINAL, tree: TREE, tags: tags('backup-01'), paths: ['/srv/example-app'] },
				],
				[LEFT, { id: LEFT, tree: TREE, tags: tags('backup-03'), paths: ['/srv/example-app'] }],
			]),
		},
		'storage-s3': {
			up: true,
			id: REPLICA_ID,
			snapshots: new Map([
				[
					COPY,
					{
						id: COPY,
						tree: TREE,
						original: ORIGINAL,
						tags: tags('backup-01'),
						paths: ['/srv/example-app'],
					},
				],
			]),
		},
	};
	const reader = jest.fn(
		async (storage: any, _path: string, password: string, _signal: any, consume: any) => {
			expect(password).toBe('synthetic-repository-password');
			const repository = repositoriesState[storage.id];
			if (!repository?.up) throw new Error('synthetic transport failure');
			// Like ManagedSftpRepositorySession: only an AppError leaves the session unchanged.
			try {
				return await consume({
					identity: async () => repository.id,
					snapshot: async (id: string) => {
						const snapshot = repository.snapshots.get(id);
						if (!snapshot) throw new ManagedRepositoryAccessError('execution-failed');
						return snapshot;
					},
				});
			} catch (error) {
				if (error instanceof AppError) throw error;
				throw new ManagedRepositoryAccessError('credentials-unavailable');
			}
		}
	);
	const planState = {
		pause: jest.fn(async (planId: string) => {
			sqlite.prepare('UPDATE plans SET active=0 WHERE id=?').run(planId);
		}),
		resume: jest.fn(async (planId: string) => {
			sqlite.prepare('UPDATE plans SET active=1 WHERE id=?').run(planId);
		}),
	};
	const replication = {
		enqueueBackup: jest.fn(async () => undefined),
		retryFailed: jest.fn(async () => undefined),
		refreshMirrors: jest.fn(async () => undefined),
	};
	const remoteBackups = {
		getRepositoryAccessOptions: jest.fn(async () => ({})),
		validatePlanCreation: jest.fn(async (_plan: any) => undefined),
	};
	const service = new PrimaryPromotionService(
		store,
		jobs,
		backups,
		plans,
		repositories,
		agents,
		storages,
		remoteBackups,
		replication,
		planState,
		() => undefined,
		() => false,
		reader as any
	);
	const job = (id = 'job-01') =>
		sqlite.prepare('SELECT * FROM managed_replication_jobs WHERE id=?').get(id) as any;
	const backup = (id: string) => {
		const row = sqlite.prepare('SELECT * FROM backups WHERE id=?').get(id) as any;
		return { ...row, snapshotId: JSON.parse(row.completion_stats || '{}').snapshot_id };
	};
	const plan = () => {
		const row = sqlite.prepare('SELECT * FROM plans WHERE id=?').get('plan-01') as any;
		return { ...row, settings: JSON.parse(row.settings) };
	};
	return {
		...context,
		service,
		store,
		reader,
		planState,
		replication,
		remoteBackups,
		repositoriesState,
		replicaIdentity,
		primaryIdentity,
		bindingOf,
		job,
		backup,
		plan,
	};
}

function tags(backupId: string) {
	return ['pluton-plan-plan-01', `pluton-backup-${backupId}`];
}

/** Runs reconciliation passes until the promotion leaves its active states. */
async function settle(t: ReturnType<typeof setup>, id: string, passes = 6) {
	for (let pass = 0; pass < passes; pass++) {
		await t.service.tick();
		if (!['catching-up', 'switching'].includes(t.store.get(id)!.status)) break;
	}
	return t.store.get(id)!;
}

describe('primary promotion start', () => {
	it('offers the verified replica and refuses plans it cannot promote', async () => {
		const t = setup();
		const overview = await t.service.overview('plan-01');
		expect(overview.supported).toBe(true);
		expect(overview.replicas).toEqual([
			expect.objectContaining({ replicationId: 'replica-s3', eligible: true }),
		]);

		await expect(t.service.start({ planId: 'plan-01', replicationId: 'missing' })).rejects.toThrow(
			'Replica not found'
		);
		const settings = t.plan().settings;
		t.sqlite.prepare('UPDATE plans SET settings=? WHERE id=?').run(
			JSON.stringify({
				...settings,
				replication: {
					...settings.replication,
					storages: [replicaEntry, { ...replicaEntry, replicationId: 'replica-two' }],
				},
			}),
			'plan-01'
		);
		await expect(
			t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' })
		).rejects.toThrow('exactly one enabled replica');
	});

	it('refuses a replica without a verified repository or copy, and an Agent without S3', async () => {
		const t = setup();
		t.sqlite.prepare("UPDATE managed_replication_jobs SET status='failed'").run();
		await expect(
			t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' })
		).rejects.toThrow('no verified copy');
		t.sqlite.prepare("UPDATE managed_replication_jobs SET status='completed'").run();
		t.sqlite
			.prepare('UPDATE agent_identities SET capabilities=? WHERE agent_id=?')
			.run(JSON.stringify({ repositoryBackends: ['sftp'] }), 'agent-01');
		await expect(
			t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' })
		).rejects.toThrow('Agent 0.8.0');
		t.sqlite.prepare("UPDATE managed_replication_destinations SET init_state='uncertain'").run();
		await expect(
			t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' })
		).rejects.toThrow('no verified repository');
	});

	it('validates the plan as it will be after the switch', async () => {
		const t = setup();
		t.remoteBackups.validatePlanCreation.mockRejectedValueOnce(new Error('synthetic refusal'));
		await expect(
			t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' })
		).rejects.toThrow('synthetic refusal');
		const shape = (t.remoteBackups.validatePlanCreation.mock.calls[0] as any[])[0];
		expect(shape.storageId).toBe('storage-s3');
		expect(shape.storagePath).toBe(REPLICA_PATH);
		expect(shape.settings.replication.storages).toEqual([
			expect.objectContaining({
				replicationId: 'replica-s3',
				storageId: 'storage-01',
				storagePath: PRIMARY_PATH,
				storageType: 'sftp',
			}),
		]);
		expect(t.store.activeForPlan('plan-01')).toBeNull();
	});

	it('passes the real managed plan validation in both directions', async () => {
		const t = setup();
		const db = (t.service as any).backups.db;
		const storages = new StorageStore(db);
		const plans = new PlanStore(db);
		const backups = new BackupStore(db);
		const repositories = new RemoteManagedRepositoryStore(db);
		const agents = new AgentStore(db);
		const remote = new RemoteBackupService(repositories, agents, plans, backups, storages);
		remote.setReplicationService(
			new ManagedReplicationService(
				new ManagedReplicationStore(t.sqlite),
				backups,
				plans,
				repositories,
				agents,
				storages,
				remote
			)
		);
		// The Agent is online: the validation checks its live capabilities.
		t.sqlite
			.prepare(
				'UPDATE agent_identities SET last_seen=?,restic_version=?,rclone_version=?,capabilities=? WHERE agent_id=?'
			)
			.run(
				Math.floor(Date.now() / 1000),
				'0.18.0',
				'1.70.0',
				JSON.stringify({
					filesystemRootsConfigured: true,
					commandTypes: ['BACKUP_FILESYSTEM'],
					repositoryBackends: ['sftp', 's3'],
					backupPayloadVersion: 5,
				}),
				'agent-01'
			);
		t.remoteBackups.validatePlanCreation.mockImplementation(plan =>
			remote.validatePlanCreation(plan)
		);
		const started = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		expect(started.status).toBe('catching-up');
		expect((await settle(t, started.id)).status).toBe('switched');
		// And back: an S3 primary promoted to its SFTP replica.
		const back = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		expect(back).toEqual(
			expect.objectContaining({ status: 'catching-up', promotedStorageId: 'storage-01' })
		);
		expect(t.remoteBackups.validatePlanCreation).toHaveBeenCalledTimes(2);
	});

	it('recognizes a trigger refusal whose SqliteError comes from another realm', () => {
		// Under Jest, better-sqlite3 binds its error constructor in the first test file of a worker,
		// so later files receive errors that are not `instanceof Error` there.
		const foreign = Object.create(null);
		foreign.message = 'MANAGED_PROMOTION_BUSY';
		const store = new PrimaryPromotionStore({
			prepare: () => ({
				run: () => {
					throw foreign;
				},
			}),
		} as any);
		expect(() =>
			store.create({
				id: 'a'.repeat(24),
				planId: 'plan-01',
				repositoryId: 'repo-01',
				replicationId: 'replica-s3',
				previousStorageId: 'storage-01',
				previousStoragePath: PRIMARY_PATH,
				previousRepositoryConfigId: PRIMARY_ID,
				promotedStorageId: 'storage-s3',
				promotedStoragePath: REPLICA_PATH,
				promotedFingerprint: 'f'.repeat(64),
				promotedRepositoryConfigId: REPLICA_ID,
			})
		).toThrow('open backup failover');
	});

	it('never runs together with a relocation or an open failover', async () => {
		const t = setup();
		t.sqlite
			.prepare(
				`INSERT INTO managed_backup_failovers(backup_id,failed_backup_id,plan_id,repository_id,agent_id,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,primary_repository_config_id,replica_repository_config_id,status,created_at,updated_at) VALUES('backup-09','backup-08','plan-01','repo-01','agent-01','replica-s3','storage-s3',?,?,?,?,'verified',1,1)`
			)
			.run(REPLICA_PATH, t.replicaIdentity.fingerprint, PRIMARY_ID, REPLICA_ID);
		await expect(
			t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' })
		).rejects.toThrow('open backup failover');
		expect(t.store.activeForPlan('plan-01')).toBeNull();
	});
});

describe('primary promotion', () => {
	it('catches up, swaps primary and replica, and keeps a left-behind backup restorable', async () => {
		const t = setup();
		const started = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		expect(started.status).toBe('catching-up');

		// First pass: the refused backup gets one more admission; the plan keeps running.
		await t.service.tick();
		expect(t.replication.enqueueBackup).toHaveBeenCalledWith('backup-03');
		expect(t.planState.pause).not.toHaveBeenCalled();
		expect(t.store.get(started.id)!.retried).toEqual(['backup-03']);

		const promotion = await settle(t, started.id);
		expect(promotion.status).toBe('switched');
		expect(t.planState.pause).toHaveBeenCalledWith('plan-01');
		expect(t.planState.resume).toHaveBeenCalledWith('plan-01');
		expect(promotion.leftBehind).toEqual([
			{ backupId: 'backup-03', code: 'artifact-binding-mismatch', restorable: true },
		]);
		expect(promotion.copiedBackups).toBe(1);

		const plan = t.plan();
		expect(plan.storage_id).toBe('storage-s3');
		expect(plan.storage_path).toBe(REPLICA_PATH);
		expect(plan.settings.replication.storages).toEqual([
			expect.objectContaining({
				replicationId: 'replica-s3',
				storageId: 'storage-01',
				storagePath: PRIMARY_PATH,
				storageType: 'sftp',
				storageName: 'Fixture SFTP',
			}),
		]);
		expect(plan.settings.replication.backupFailover).toBe('automatic');
		const repository = t.sqlite
			.prepare('SELECT storage_id,storage_path FROM remote_managed_repositories WHERE id=?')
			.get('repo-01');
		expect(repository).toEqual({ storage_id: 'storage-s3', storage_path: REPLICA_PATH });

		// backup-01 now points at the copy in the new primary; its receipt is inverted.
		expect(t.backup('backup-01')).toEqual(
			expect.objectContaining({ storage_id: 'storage-s3', snapshotId: COPY })
		);
		expect(t.job()).toEqual(
			expect.objectContaining({
				source_storage_id: 'storage-s3',
				source_storage_path: REPLICA_PATH,
				source_snapshot_id: COPY,
				source_repository_config_id: REPLICA_ID,
				source_binding_hash: t.bindingOf(COPY),
				destination_storage_id: 'storage-01',
				destination_storage_path: PRIMARY_PATH,
				destination_fingerprint: t.primaryIdentity.fingerprint,
				destination_snapshot_id: ORIGINAL,
				destination_original: 1,
				source_tree_id: TREE,
			})
		);
		// backup-03 stays in the previous primary, restorable through its receipt.
		expect(t.backup('backup-03')).toEqual(
			expect.objectContaining({ storage_id: 'storage-s3', snapshotId: LEFT })
		);
		const left = t.sqlite
			.prepare('SELECT * FROM managed_replication_jobs WHERE backup_id=?')
			.get('backup-03') as any;
		expect(left).toEqual(
			expect.objectContaining({
				status: 'completed',
				source_snapshot_id: LEFT,
				destination_snapshot_id: LEFT,
				destination_storage_id: 'storage-01',
				destination_original: 1,
				source_tree_id: TREE,
			})
		);
		// Replica ownership moved from the promoted location to the previous primary.
		const destinations = t.sqlite
			.prepare(
				'SELECT fingerprint,destination_storage_id,init_state,actual_repository_id FROM managed_replication_destinations'
			)
			.all();
		expect(destinations).toEqual([
			{
				fingerprint: t.primaryIdentity.fingerprint,
				destination_storage_id: 'storage-01',
				init_state: 'ready',
				actual_repository_id: PRIMARY_ID,
			},
		]);
		expect(t.replication.refreshMirrors).toHaveBeenCalledWith('backup-01');
	});

	it('promotes back to the previous primary and restores the original bindings', async () => {
		const t = setup();
		const first = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		expect((await settle(t, first.id)).status).toBe('switched');
		const before = { ...t.job() };

		const second = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		expect(second.promotedStorageId).toBe('storage-01');
		expect(second.promotedRepositoryConfigId).toBe(PRIMARY_ID);
		expect(second.previousRepositoryConfigId).toBe(REPLICA_ID);
		expect((await settle(t, second.id)).status).toBe('switched');

		expect(t.plan().storage_id).toBe('storage-01');
		expect(t.plan().settings.replication.storages[0]).toEqual(
			expect.objectContaining({ storageId: 'storage-s3', storagePath: REPLICA_PATH })
		);
		expect(t.backup('backup-01')).toEqual(
			expect.objectContaining({ storage_id: 'storage-01', snapshotId: ORIGINAL })
		);
		expect(t.job()).toEqual(
			expect.objectContaining({
				source_snapshot_id: ORIGINAL,
				source_repository_config_id: PRIMARY_ID,
				source_binding_hash: t.bindingOf(ORIGINAL),
				destination_storage_id: 'storage-s3',
				destination_fingerprint: t.replicaIdentity.fingerprint,
				destination_snapshot_id: COPY,
				destination_original: 0,
			})
		);
		expect(before.destination_original).toBe(1);
		// backup-03 lives in the primary again and needs no receipt.
		expect(t.backup('backup-03')).toEqual(
			expect.objectContaining({ storage_id: 'storage-01', snapshotId: LEFT })
		);
		expect(
			t.sqlite.prepare('SELECT 1 FROM managed_replication_jobs WHERE backup_id=?').get('backup-03')
		).toBeUndefined();
		expect(
			t.sqlite.prepare('SELECT fingerprint FROM managed_replication_destinations').all()
		).toEqual([{ fingerprint: t.replicaIdentity.fingerprint }]);
	});

	it('promotes while the previous primary is down and leaves its unproven backups in place', async () => {
		const t = setup();
		t.repositoriesState['storage-01'].up = false;
		const started = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		const promotion = await settle(t, started.id);
		expect(promotion.status).toBe('switched');
		expect(promotion.leftBehind).toEqual([
			{ backupId: 'backup-03', code: 'artifact-binding-mismatch', restorable: false },
		]);
		expect(t.backup('backup-03')).toEqual(
			expect.objectContaining({ storage_id: 'storage-01', snapshotId: LEFT })
		);
		expect(
			t.sqlite.prepare('SELECT 1 FROM managed_replication_jobs WHERE backup_id=?').get('backup-03')
		).toBeUndefined();
		expect(t.backup('backup-01').snapshotId).toBe(COPY);
	});

	it('waits for running copies and keeps backing up until the final step', async () => {
		const t = setup();
		t.sqlite
			.prepare("UPDATE managed_replication_jobs SET status='pending' WHERE id='job-01'")
			.run();
		const started = await t.service
			.start({ planId: 'plan-01', replicationId: 'replica-s3' })
			.catch(error => error);
		// A pending copy is not proof of a verified replica yet.
		expect(String(started)).toContain('no verified copy');
		t.sqlite
			.prepare("UPDATE managed_replication_jobs SET status='completed' WHERE id='job-01'")
			.run();
		const promotion = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		t.sqlite
			.prepare(
				`INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,storage_path,status,in_progress,success,completion_stats) VALUES('backup-04','plan-01','app-01','device','backup','storage-01',?,'completed',0,1,?)`
			)
			.run(PRIMARY_PATH, JSON.stringify({ snapshot_id: '4'.repeat(64) }));
		t.sqlite
			.prepare(
				`INSERT INTO managed_replication_jobs(id,backup_id,plan_id,repository_id,agent_id,source_storage_id,source_storage_path,source_snapshot_id,source_repository_config_id,source_tree_id,source_binding_hash,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,status,attempts,created_at,updated_at) VALUES('job-04','backup-04','plan-01','repo-01','agent-01','storage-01',?,?,?,?,?,'replica-s3','storage-s3',?,?,'running',1,1,1)`
			)
			.run(
				PRIMARY_PATH,
				'4'.repeat(64),
				PRIMARY_ID,
				TREE,
				'a'.repeat(64),
				REPLICA_PATH,
				t.replicaIdentity.fingerprint
			);
		for (let pass = 0; pass < 4; pass++) await t.service.tick();
		expect(t.store.get(promotion.id)!.status).toBe('catching-up');
		expect(t.planState.pause).not.toHaveBeenCalled();
		expect(t.store.get(promotion.id)!.totalBackups).toBe(3);
	});

	it('fails on an uncertain copy or a changed replica identity and gives the plan back', async () => {
		const t = setup();
		const first = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		t.sqlite
			.prepare(
				`INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,storage_path,status,in_progress,success,completion_stats) VALUES('backup-05','plan-01','app-01','device','backup','storage-01',?,'completed',0,1,?)`
			)
			.run(PRIMARY_PATH, JSON.stringify({ snapshot_id: '5'.repeat(64) }));
		t.sqlite
			.prepare(
				`INSERT INTO managed_replication_jobs(id,backup_id,plan_id,repository_id,agent_id,source_storage_id,source_storage_path,source_snapshot_id,source_repository_config_id,source_tree_id,source_binding_hash,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,status,attempts,created_at,updated_at) VALUES('job-05','backup-05','plan-01','repo-01','agent-01','storage-01',?,?,?,?,?,'replica-s3','storage-s3',?,?,'uncertain',1,1,1)`
			)
			.run(
				PRIMARY_PATH,
				'5'.repeat(64),
				PRIMARY_ID,
				TREE,
				'a'.repeat(64),
				REPLICA_PATH,
				t.replicaIdentity.fingerprint
			);
		const failed = await settle(t, first.id);
		expect(failed).toEqual(
			expect.objectContaining({ status: 'failed', lastErrorCode: 'replication-uncertain' })
		);
		expect(t.plan().storage_id).toBe('storage-01');
		t.sqlite.prepare("DELETE FROM managed_replication_jobs WHERE id='job-05'").run();
		t.sqlite.prepare("DELETE FROM backups WHERE id='backup-05'").run();

		t.repositoriesState['storage-s3'].id = 'f'.repeat(64);
		const second = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		const refused = await settle(t, second.id);
		expect(refused).toEqual(
			expect.objectContaining({ status: 'failed', lastErrorCode: 'repository-identity-mismatch' })
		);
		// The plan was paused for the final step and is active again; nothing moved.
		expect(t.planState.pause).toHaveBeenCalledTimes(1);
		expect(t.planState.resume).toHaveBeenCalledTimes(1);
		expect(t.plan().active).toBe(1);
		expect(t.plan().storage_id).toBe('storage-01');
		expect(t.backup('backup-01').snapshotId).toBe(ORIGINAL);
		expect(t.job().destination_original).toBe(0);
	});

	it('cancels before the switch and resumes a plan it paused', async () => {
		const t = setup();
		const first = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		expect((await t.service.cancel(first.id)).status).toBe('cancelled');
		expect(t.planState.resume).not.toHaveBeenCalled();
		await expect(t.service.cancel(first.id)).rejects.toThrow('no longer active');

		// Cancelled in the final step: the plan it paused is resumed.
		const second = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		await t.planState.pause('plan-01');
		expect(t.store.toSwitching(second.id, true)?.status).toBe('switching');
		expect((await t.service.cancel(second.id)).status).toBe('cancelled');
		expect(t.planState.resume).toHaveBeenCalledWith('plan-01');
		expect(t.plan().active).toBe(1);
		expect(t.plan().storage_id).toBe('storage-01');
	});

	it('fails with replica-unreachable when the replica cannot be read in the final step', async () => {
		const t = setup();
		t.repositoriesState['storage-s3'].up = false;
		const started = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		const failed = await settle(t, started.id);
		expect(failed).toEqual(
			expect.objectContaining({ status: 'failed', lastErrorCode: 'replica-unreachable' })
		);
		expect(t.planState.resume).toHaveBeenCalledWith('plan-01');
		expect(t.plan().active).toBe(1);
		expect(t.plan().storage_id).toBe('storage-01');
		expect(t.backup('backup-01').snapshotId).toBe(ORIGINAL);
	});

	it('guards the plan, its backups and failover while a promotion is active', async () => {
		const t = setup();
		const started = await t.service.start({ planId: 'plan-01', replicationId: 'replica-s3' });
		expect(() => t.sqlite.prepare('DELETE FROM plans WHERE id=?').run('plan-01')).toThrow(
			'MANAGED_PROMOTION_ACTIVE'
		);
		expect(() =>
			t.sqlite.prepare("UPDATE plans SET storage_path='elsewhere' WHERE id=?").run('plan-01')
		).toThrow('MANAGED_PROMOTION_ACTIVE');
		expect(() =>
			t.sqlite
				.prepare(
					`INSERT INTO managed_backup_failovers(backup_id,failed_backup_id,plan_id,repository_id,agent_id,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,primary_repository_config_id,replica_repository_config_id,status,created_at,updated_at) VALUES('backup-09','backup-08','plan-01','repo-01','agent-01','replica-s3','storage-s3',?,?,?,?,'queued',1,1)`
				)
				.run(REPLICA_PATH, t.replicaIdentity.fingerprint, PRIMARY_ID, REPLICA_ID)
		).toThrow('MANAGED_PROMOTION_ACTIVE');
		expect(t.service.activeForPlan('plan-01')?.id).toBe(started.id);
		// The final step blocks new backups and resuming until the switch.
		t.store.toSwitching(started.id, true);
		expect(() =>
			t.sqlite
				.prepare(
					`INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,status) VALUES('backup-10','plan-01','app-01','device','backup','storage-01','started')`
				)
				.run()
		).toThrow('MANAGED_PROMOTION_ACTIVE');
		t.sqlite.prepare('UPDATE plans SET active=0 WHERE id=?').run('plan-01');
		expect(() => t.sqlite.prepare('UPDATE plans SET active=1 WHERE id=?').run('plan-01')).toThrow(
			'MANAGED_PROMOTION_ACTIVE'
		);
	});
});
