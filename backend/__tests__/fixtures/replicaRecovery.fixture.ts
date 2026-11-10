import Cryptr from 'cryptr';
import { configService } from '../../src/services/ConfigService';
import { canonicalS3RepositoryIdentity } from '../../src/utils/storageSecurity';
import { replicaSourceBinding } from '../../src/utils/replicaSourceBinding';
import { VerifiedReplicaRecoveryService } from '../../src/services/VerifiedReplicaRecoveryService';
import type { ManagedRepositorySessionProvider } from '../../src/utils/restic/ManagedSftpRepositorySession';

export function replicaFixture(
	root: string,
	provider?: ManagedRepositorySessionProvider,
	endpoint = 'https://s3.example.internal',
	password = 'synthetic-restic-password'
) {
	const secret = configService.config.SECRET!;
	const replica = {
		replicationId: 'replica-01',
		storageId: 'mirror-01',
		storagePath: 'bucket-01/managed/plan-01',
		storageName: 'Replica 1',
		storageType: 's3compatible',
		addedAt: 1,
	};
	const plan: any = {
		id: 'plan-01',
		sourceId: 'app-01',
		sourceType: 'device',
		storageId: 'primary-01',
		storagePath: 'application',
		method: 'backup',
		settings: { replication: { enabled: true, concurrent: false, storages: [replica] } },
	};
	const backup: any = {
		id: 'backup-01',
		planId: plan.id,
		sourceId: plan.sourceId,
		sourceType: plan.sourceType,
		storageId: plan.storageId,
		storagePath: plan.storagePath,
		method: 'backup',
		status: 'completed',
		inProgress: false,
		success: true,
		encryption: true,
		completionStats: { snapshot_id: 'a'.repeat(64), sourcePaths: ['/srv/example-app'] },
	};
	const repository: any = {
		id: 'repository-01',
		planId: plan.id,
		agentId: 'agent-01',
		storageId: plan.storageId,
		storagePath: plan.storagePath,
		initializedAt: new Date(),
		encryptedPassword: new Cryptr(secret).encrypt(password),
	};
	const agent: any = { agentId: 'agent-01', deviceId: 'app-01' };
	const storage: any = {
		id: 'mirror-01',
		type: 's3compatible',
		settings: { hcp_mode: true, endpoint },
		credentials: Object.fromEntries(
			Object.entries({
				bucket: 'bucket-01',
				access_key_id: 'synthetic-access-key',
				secret_access_key: 'synthetic-secret-key',
				region: 'us-east-1',
			}).map(([k, v]) => [k, new Cryptr(secret).encrypt(v)])
		),
	};
	const scope = canonicalS3RepositoryIdentity(storage, replica.storagePath);
	const receipt: any = {
		id: 'receipt-01',
		backupId: backup.id,
		planId: plan.id,
		repositoryId: repository.id,
		agentId: repository.agentId,
		sourceStorageId: repository.storageId,
		sourceStoragePath: repository.storagePath,
		sourceSnapshotId: backup.completionStats.snapshot_id,
		sourceRepositoryConfigId: 'b'.repeat(64),
		sourceTreeId: 'c'.repeat(64),
		sourceBindingHash: replicaSourceBinding(backup),
		replicationId: replica.replicationId,
		destinationStorageId: storage.id,
		destinationStoragePath: replica.storagePath,
		destinationFingerprint: scope.fingerprint,
		destinationSnapshotId: 'd'.repeat(64),
		status: 'completed',
		ownerToken: null,
		attempts: 1,
		lastErrorCode: null,
		createdAt: 1,
		updatedAt: 2,
		verifiedAt: 2,
	};
	const destination: any = {
		fingerprint: scope.fingerprint,
		planId: plan.id,
		replicationId: replica.replicationId,
		sourceRepositoryId: repository.id,
		destinationStorageId: storage.id,
		destinationStoragePath: replica.storagePath,
		destinationAuthority: scope.authority,
		destinationPrefix: scope.prefix,
		initState: 'ready',
		actualRepositoryId: 'e'.repeat(64),
		createdAt: 1,
	};
	const snapshot: any = {
		id: receipt.destinationSnapshotId,
		tree: receipt.sourceTreeId,
		original: receipt.sourceSnapshotId,
		tags: ['pluton-plan-' + plan.id, 'pluton-backup-' + backup.id],
		paths: ['/srv/example-app'],
	};
	const rows = [receipt];
	const stores = {
		jobs: { listByBackup: () => rows, getDestination: () => destination },
		backups: { getById: async () => backup },
		plans: { getById: async () => plan },
		repositories: { getByPlanId: async () => repository },
		agents: { getAgentById: async () => agent },
		storages: {
			getById: async (id: string) =>
				id === storage.id ? storage : { id: repository.storageId, type: 'sftp' },
		},
	};
	const service = new VerifiedReplicaRecoveryService(
		stores.jobs as any,
		stores.backups as any,
		stores.plans as any,
		stores.repositories as any,
		stores.agents as any,
		stores.storages as any,
		root,
		secret,
		provider ? () => provider : undefined
	);
	return {
		service,
		plan,
		backup,
		repository,
		agent,
		storage,
		receipt,
		destination,
		snapshot,
		rows,
		replica,
		stores,
		refreshBinding: () => (receipt.sourceBindingHash = replicaSourceBinding(backup)),
	};
}
