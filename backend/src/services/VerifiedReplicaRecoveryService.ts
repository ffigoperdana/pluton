import { RecoveryWorkspace } from '../utils/recoveryWorkspace';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import Cryptr from 'cryptr';
import type { BackupStore } from '../stores/BackupStore';
import type { PlanStore } from '../stores/PlanStore';
import type { AgentStore } from '../stores/AgentStore';
import type { StorageStore } from '../stores/StorageStore';
import type { RemoteManagedRepositoryStore } from '../stores/RemoteManagedRepositoryStore';
import type { ManagedReplicationStore } from '../stores/ManagedReplicationStore';
import { AppError } from '../utils/AppError';
import { configService } from './ConfigService';
import { replicaSourceBinding } from '../utils/replicaSourceBinding';
import { recoveryArtifacts } from '../utils/recoveryValidation';
import {
	canonicalS3RepositoryIdentity,
	isHcpMode,
	storageRcloneOptions,
	trustEnvironment,
} from '../utils/storageSecurity';
import { ManagedS3RecoverySession } from '../utils/restic/ManagedS3RecoverySession';
import {
	fullSnapshotId,
	type ManagedRepositorySession,
	type ManagedRepositorySessionProvider,
} from '../utils/restic/ManagedSftpRepositorySession';
import {
	RemoteRepositoryRecoveryService,
	type RecoveryContext,
} from './RemoteRepositoryRecoveryService';

export type ReplicaRecoveryCode =
	| 'source-binding-invalid'
	| 'replica-unverified'
	| 'destination-changed'
	| 'repository-identity-mismatch'
	| 'snapshot-identity-mismatch'
	| 'approval-binding-changed';
export class ReplicaRecoveryError extends AppError {
	constructor(readonly code: ReplicaRecoveryCode) {
		super(409, 'Replica recovery refused (' + code + ').');
		Object.setPrototypeOf(this, new.target.prototype);
	}
}
export type ReplicaRecoveryBinding = {
	planId: string;
	backupId: string;
	sourceSnapshotId: string;
	replicationId: string;
	destinationSnapshotId: string;
	repositoryConfigId: string;
	treeId: string;
	fingerprint: string;
};

type ResolvedReplica = {
	revision: string;
	context: RecoveryContext;
	binding: ReplicaRecoveryBinding;
	trust: Record<string, string>;
};

/** Server-only resolver. A cosmetic mirror status is never an authorization source.
 * Does not contact the primary, initialize a repo, mutate a replica or import SQL. */
export class VerifiedReplicaRecoveryService {
	private get cacheWorkspace() {
		return new RecoveryWorkspace(this.root);
	}
	async cleanup(operationId: string) {
		await this.cacheWorkspace.remove(operationId);
	}
	constructor(
		private readonly jobs: Pick<ManagedReplicationStore, 'listByBackup' | 'getDestination'>,
		private readonly backups: Pick<BackupStore, 'getById'>,
		private readonly plans: Pick<PlanStore, 'getById'>,
		private readonly repositories: Pick<RemoteManagedRepositoryStore, 'getByPlanId'>,
		private readonly agents: Pick<AgentStore, 'getAgentById'>,
		private readonly storages: Pick<StorageStore, 'getById'>,
		private readonly root: string,
		private readonly secret = configService.config.SECRET!,
		private readonly sessionFactory: (
			trust: Record<string, string>
		) => ManagedRepositorySessionProvider = trust => new ManagedS3RecoverySession(trust)
	) {}

	private async resolve(
		backupId: string,
		planId: string,
		replicationId: string,
		reuse?: ResolvedReplica
	): Promise<ResolvedReplica> {
		const fail = (code: ReplicaRecoveryCode): never => {
			throw new ReplicaRecoveryError(code);
		};
		const backup = await this.backups.getById(backupId);
		if (
			!backup ||
			backup.planId !== planId ||
			backup.method !== 'backup' ||
			backup.status !== 'completed' ||
			backup.inProgress ||
			backup.success !== true ||
			backup.encryption !== true ||
			backup.sourceType !== 'device' ||
			backup.sourceId === 'main'
		)
			fail('source-binding-invalid');
		const plan = await this.plans.getById(planId),
			repository = await this.repositories.getByPlanId(planId);
		const agent = repository ? await this.agents.getAgentById(repository.agentId) : null;
		if (
			!plan ||
			!repository?.initializedAt ||
			!agent ||
			agent.revokedAt ||
			repository.planId !== planId ||
			agent.deviceId !== backup!.sourceId ||
			plan.sourceId !== backup!.sourceId ||
			plan.sourceType !== backup!.sourceType ||
			plan.method !== 'backup' ||
			plan.storageId !== repository.storageId ||
			backup!.storageId !== repository.storageId ||
			plan.storagePath !== repository.storagePath ||
			backup!.storagePath !== repository.storagePath
		)
			fail('source-binding-invalid');
		const configured = plan!.settings.replication;
		if (!configured?.enabled || configured.storages.length > 2) fail('replica-unverified');
		const selected = configured!.storages.filter(row => row.replicationId === replicationId);
		const receipts = (await this.jobs.listByBackup(backupId)).filter(
			row => row.replicationId === replicationId
		);
		if (selected.length !== 1 || receipts.length !== 1) fail('replica-unverified');
		const replica = selected[0],
			receipt = receipts[0];
		const destination = await this.jobs.getDestination(receipt.destinationFingerprint);
		if (
			receipt.status !== 'completed' ||
			!receipt.verifiedAt ||
			receipt.lastErrorCode ||
			receipt.planId !== planId ||
			receipt.backupId !== backupId ||
			receipt.repositoryId !== repository!.id ||
			receipt.agentId !== repository!.agentId ||
			receipt.sourceStorageId !== repository!.storageId ||
			receipt.sourceStoragePath !== repository!.storagePath ||
			receipt.sourceSnapshotId !== backup!.completionStats?.snapshot_id ||
			receipt.sourceBindingHash !== replicaSourceBinding(backup!) ||
			[
				receipt.sourceSnapshotId,
				receipt.sourceRepositoryConfigId,
				receipt.sourceTreeId,
				receipt.destinationSnapshotId,
			].some(id => !fullSnapshotId.safeParse(id).success)
		)
			fail('replica-unverified');
		if (
			!destination ||
			destination.initState !== 'ready' ||
			!fullSnapshotId.safeParse(destination.actualRepositoryId).success ||
			destination.planId !== planId ||
			destination.replicationId !== replicationId ||
			destination.sourceRepositoryId !== repository!.id ||
			destination.destinationStorageId !== replica.storageId ||
			destination.destinationStoragePath !== replica.storagePath ||
			receipt.destinationStorageId !== replica.storageId ||
			receipt.destinationStoragePath !== replica.storagePath
		)
			fail('destination-changed');
		const sourceStorage = await this.storages.getById(repository!.storageId);
		if (sourceStorage?.type !== 'sftp') fail('source-binding-invalid');
		const storage = await this.storages.getById(replica.storageId);
		if (!storage) fail('destination-changed');
		const trust = trustEnvironment();
		const caHashes = await Promise.all(
			Object.entries(trust).map(async ([key, file]) => [
				key,
				file,
				crypto
					.createHash('sha256')
					.update(await fs.readFile(file))
					.digest('hex'),
			])
		);
		// Revalidate authoritative ciphertext/configuration on every boundary; avoid
		// repeated password-KDF work when the exact pinned inputs have not changed.
		const revision = crypto
			.createHmac('sha256', this.secret)
			.update(
				JSON.stringify({
					backup: {
						id: backup!.id,
						planId: backup!.planId,
						sourceId: backup!.sourceId,
						sourceType: backup!.sourceType,
						storageId: backup!.storageId,
						storagePath: backup!.storagePath,
						method: backup!.method,
						status: backup!.status,
						inProgress: backup!.inProgress,
						success: backup!.success,
						encryption: backup!.encryption,
						sourceBinding: replicaSourceBinding(backup!),
					},
					plan: {
						id: plan!.id,
						sourceId: plan!.sourceId,
						sourceType: plan!.sourceType,
						method: plan!.method,
						storageId: plan!.storageId,
						storagePath: plan!.storagePath,
						replication: configured,
					},
					repository: {
						id: repository!.id,
						planId: repository!.planId,
						agentId: repository!.agentId,
						storageId: repository!.storageId,
						storagePath: repository!.storagePath,
						encryptedPassword: repository!.encryptedPassword,
						initializedAt: repository!.initializedAt,
					},
					agent: { deviceId: agent!.deviceId, revokedAt: agent!.revokedAt },
					storage: {
						id: storage!.id,
						type: storage!.type,
						settings: storage!.settings,
						credentials: storage!.credentials,
					},
					receipt,
					destination,
					caHashes,
				})
			)
			.digest('hex');
		if (reuse?.revision === revision) return reuse;
		const scope = canonicalS3RepositoryIdentity(storage!, replica.storagePath);
		if (
			scope.fingerprint !== receipt.destinationFingerprint ||
			scope.authority !== destination!.destinationAuthority ||
			scope.prefix !== destination!.destinationPrefix
		)
			fail('destination-changed');
		const options = storageRcloneOptions(storage!);
		const endpoint = new URL(options.endpoint);
		if (
			!(
				(storage!.type === 's3' &&
					/^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(endpoint.hostname)) ||
				isHcpMode(storage!.settings)
			)
		)
			fail('destination-changed');
		if (options.force_path_style === 'false') fail('destination-changed');
		options.force_path_style = 'true';
		let password: string;
		try {
			password = new Cryptr(this.secret).decrypt(repository!.encryptedPassword);
		} catch {
			fail('source-binding-invalid');
		}
		// Validate recorded SQL evidence before reading any replica. Current DB plan settings
		// cannot rewrite historical artifacts or substitute a different database.
		recoveryArtifacts(backup!.completionStats?.lifecycle);
		const context: RecoveryContext = {
			backupId,
			planId,
			storageId: replica.storageId,
			repositoryId: 'replica-' + receipt.id,
			snapshotId: receipt.destinationSnapshotId!,
			sourcePaths: [
				...(backup!.completionStats?.sourcePaths || backup!.sourceConfig?.includes || []),
			],
			access: { options, password: password!, repositoryPath: replica.storagePath },
		};
		const fingerprint = revision;
		const binding: ReplicaRecoveryBinding = {
			backupId,
			planId,
			sourceSnapshotId: receipt.sourceSnapshotId,
			replicationId,
			destinationSnapshotId: receipt.destinationSnapshotId!,
			repositoryConfigId: destination!.actualRepositoryId!,
			treeId: receipt.sourceTreeId,
			fingerprint,
		};
		return { revision, context, binding, trust };
	}

	/** Read-only live identity checks. No recovery writes until the caller's separate approval. */
	async withReplica<T>(
		backupId: string,
		planId: string,
		replicationId: string,
		signal: AbortSignal,
		consume: (
			recovery: RemoteRepositoryRecoveryService,
			binding: ReplicaRecoveryBinding
		) => Promise<T>,
		expected?: string,
		operationId = crypto.randomBytes(12).toString('hex')
	): Promise<T> {
		const pinned = await this.resolve(backupId, planId, replicationId);
		if (expected && expected !== pinned.binding.fingerprint)
			throw new ReplicaRecoveryError('approval-binding-changed');
		const current = async () => {
			const now = await this.resolve(backupId, planId, replicationId, pinned);
			if (now.binding.fingerprint !== pinned.binding.fingerprint)
				throw new ReplicaRecoveryError('approval-binding-changed');
			return now.context;
		};
		let probed = false;
		const validate = async (session: ManagedRepositorySession) => {
			await current();
			if (!probed) {
				await session.probe?.();
				probed = true;
			}
			if (!session.identity || (await session.identity()) !== pinned.binding.repositoryConfigId)
				throw new ReplicaRecoveryError('repository-identity-mismatch');
			const snapshot = await session.snapshot(pinned.binding.destinationSnapshotId);
			if (
				snapshot.id !== pinned.binding.destinationSnapshotId ||
				snapshot.tree !== pinned.binding.treeId ||
				(snapshot.id !== pinned.binding.sourceSnapshotId &&
					snapshot.original !== pinned.binding.sourceSnapshotId) ||
				snapshot.tags.filter(t => t.startsWith('pluton-plan-')).length !== 1 ||
				snapshot.tags.filter(t => t.startsWith('pluton-backup-')).length !== 1 ||
				!snapshot.tags.includes('pluton-plan-' + planId) ||
				!snapshot.tags.includes('pluton-backup-' + backupId)
			)
				throw new ReplicaRecoveryError('snapshot-identity-mismatch');
		};
		const cacheRoot = await this.cacheWorkspace.create(operationId);
		const provider = this.sessionFactory(pinned.trust);
		const guarded: ManagedRepositorySessionProvider = {
			withSession: (access, work, requestedSignal, limits) =>
				provider.withSession(
					access,
					async session => {
						await validate(session);
						const result = await work(session);
						await validate(session);
						return result;
					},
					requestedSignal ? AbortSignal.any([requestedSignal, signal]) : signal,
					{
						restoreTimeoutMs: limits?.restoreTimeoutMs || 60 * 60_000,
						...limits,
						temporaryRoot: cacheRoot,
					}
				),
		};
		const recovery = new RemoteRepositoryRecoveryService(
			{} as any,
			this.backups as BackupStore,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			guarded,
			this.secret,
			path.join(cacheRoot, 'staging'),
			async (id, plan) => {
				if (id !== backupId || (plan !== undefined && plan !== planId))
					throw new ReplicaRecoveryError('source-binding-invalid');
				return current();
			}
		);
		try {
			return await consume(recovery, pinned.binding);
		} finally {
			try {
				await recovery.close();
			} finally {
				await this.cacheWorkspace.remove(operationId);
			}
		}
	}
	async preflight(
		backupId: string,
		planId: string,
		replicationId: string,
		signal: AbortSignal,
		operationId?: string
	) {
		return this.withReplica(
			backupId,
			planId,
			replicationId,
			signal,
			async (recovery, binding) => {
				await recovery.testMetadata(backupId, planId, binding.destinationSnapshotId);
				return binding;
			},
			undefined,
			operationId
		);
	}
}
