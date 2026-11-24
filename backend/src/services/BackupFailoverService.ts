import crypto from 'crypto';
import Cryptr from 'cryptr';
import type { Backup } from '../db/schema/backups';
import type { Plan } from '../db/schema/plans';
import type { Storage } from '../db/schema/storages';
import type { AgentStore } from '../stores/AgentStore';
import type { BackupFailover, BackupFailoverStore } from '../stores/BackupFailoverStore';
import type { BackupStore } from '../stores/BackupStore';
import type { ManagedReplicationStore } from '../stores/ManagedReplicationStore';
import type { PlanStore } from '../stores/PlanStore';
import type { RemoteManagedRepositoryStore } from '../stores/RemoteManagedRepositoryStore';
import type { StorageStore } from '../stores/StorageStore';
import type { BackupMirrorFailover } from '../types/backups';
import type { PlanReplicationStorage } from '../types/plans';
import { AppError } from '../utils/AppError';
import { agentBackupPayloadVersion, agentSupportsS3Repository } from '../utils/agentS3Repository';
import { serverLogger } from '../utils/logger';
import { replicaRepositoryIdentity, replicaStorageKind } from '../utils/managedReplicaIdentity';
import { lifecycleDatabases, parseRemoteLifecycle } from '../utils/remoteLifecycle';
import { replicaSourceBinding } from '../utils/replicaSourceBinding';
import {
	ManagedReplicationError,
	ManagedReplicationExecutor,
	type ManagedReplicationExecutorContract,
	type ReplicationSource,
} from '../utils/restic/ManagedReplicationExecutor';
import { ManagedS3RecoverySession } from '../utils/restic/ManagedS3RecoverySession';
import {
	ManagedSftpRepositorySession,
	fullSnapshotId,
} from '../utils/restic/ManagedSftpRepositorySession';
import { REPLICATION_PROGRESS } from '../utils/restic/replicationProgress';
import { trustEnvironment } from '../utils/storageSecurity';
import { configService } from './ConfigService';
import type { ManagedFailoverGuard } from './ManagedReplicationService';
import type { BackupFailoverHook } from './RemoteBackupService';

/**
 * Agent failures that may mean the primary is down (docs/BACKUP_FAILOVER.md section 3). They are
 * all reported before `restic backup` starts, so the primary holds no part of this run.
 */
const ELIGIBLE: Record<string, readonly string[]> = {
	'repository-check': ['repository-check-failed', 'target-check-transport-failed'],
	'repository-target-check': ['repository-target-check-failed', 'target-check-transport-failed'],
};

export function failoverEligible(stage?: string, code?: string): boolean {
	return !!stage && !!code && (ELIGIBLE[stage] || []).includes(code);
}

/** Refusals that waiting cannot fix: the failover snapshot stays in the replica untouched. */
const PERMANENT = new Set([
	'binding-changed',
	'primary-changed',
	'destination-unowned',
	'snapshot-identity-mismatch',
	'snapshot-unavailable',
	'artifact-binding-mismatch',
	'artifact-size-mismatch',
	'artifact-checksum-mismatch',
	'source-binding-changed',
	'destination-binding-changed',
	'destination-snapshot-unverified',
	'destination-configuration-invalid',
]);

export const FAILOVER_TIMING = {
	probeMs: 60_000,
	retryMs: 10 * 60_000,
	primaryRecheckMs: 5 * 60_000,
	rescanWindowSeconds: 24 * 60 * 60,
	reconsiderMs: 15 * 60_000,
};

/** Returns the repository config ID, proving the repository is reachable and is the one expected. */
export type RepositoryProbe = (
	storage: Storage,
	repositoryPath: string,
	password: string,
	signal: AbortSignal
) => Promise<string>;

type RemoteBackups = {
	getRepositoryAccessOptions(storageId: string): Promise<Record<string, string>>;
	queueFailoverBackup(
		failed: Backup,
		agentId: string,
		repositoryId: string,
		replicaName: string,
		record: (backupId: string) => void
	): Promise<string>;
};

type Replication = {
	repositoryAccess(
		storage: Storage
	): Promise<{ options: Record<string, string>; environment?: Record<string, string> }>;
	executing(): boolean;
	refreshMirrors(backupId: string): Promise<void>;
	enqueueBackup(backupId: string): Promise<void>;
};

const errorCode = (error: unknown): string => {
	if (error instanceof ManagedReplicationError) return error.code;
	if (error instanceof FailoverError) return error.code;
	return 'unexpected';
};

class FailoverError extends Error {
	constructor(readonly code: string) {
		super(`Backup failover refused (${code}).`);
	}
}

/**
 * Stage 3: moves a backup to a verified replica while the primary is unreachable, verifies it
 * there, and copies it back to the primary later. No replica is initialized, unlocked, pruned or
 * deleted here.
 */
export class BackupFailoverService implements ManagedFailoverGuard, BackupFailoverHook {
	private readonly probe: RepositoryProbe;
	private readonly considered = new Map<string, number>();
	private readonly deciding = new Set<string>();
	private ticking?: Promise<void>;
	private copying = false;
	private interruptedReset = false;
	private stopping = false;
	private readonly controller = new AbortController();

	constructor(
		private readonly failovers: BackupFailoverStore,
		private readonly jobs: Pick<ManagedReplicationStore, 'getDestination'>,
		private readonly backups: Pick<BackupStore, 'getById'>,
		private readonly plans: Pick<PlanStore, 'getById' | 'hasActiveBackups'>,
		private readonly repositories: Pick<RemoteManagedRepositoryStore, 'getByPlanId'>,
		private readonly agents: Pick<AgentStore, 'getAgentById'>,
		private readonly storages: Pick<StorageStore, 'getById'>,
		private readonly remoteBackups: RemoteBackups,
		private readonly replication: Replication,
		private readonly executor: Pick<
			ManagedReplicationExecutorContract,
			'inspectSource' | 'copy'
		> = new ManagedReplicationExecutor(),
		probe?: RepositoryProbe,
		private readonly secret = configService.config.SECRET,
		private readonly clock: () => number = () => Date.now()
	) {
		this.probe = probe || ((...args) => this.identity(...args));
	}

	private promotionActive?: (planId: string) => boolean;

	/** Stage 4 promotions of the plan (docs/PRIMARY_PROMOTION.md). */
	setPromotionGuard(active: (planId: string) => boolean): void {
		this.promotionActive = active;
	}

	// ---- BackupFailoverHook (backup command path) ----

	isFailoverBackup(backupId: string): boolean {
		return !!this.failovers.getByBackup(backupId);
	}

	/** Re-checked at every poll: the replica must still be the one recorded when it was queued. */
	async failoverTarget(
		backupId: string
	): Promise<{ storageId: string; storagePath: string } | undefined> {
		const row = this.failovers.getByBackup(backupId);
		if (!row) return undefined;
		if (row.status !== 'queued')
			throw new AppError(409, 'The failover backup is no longer queued.');
		try {
			await this.binding(row);
		} catch {
			throw new AppError(409, 'The failover replica changed after the failover backup was queued.');
		}
		return { storageId: row.destinationStorageId, storagePath: row.destinationStoragePath };
	}

	async afterFailure(backupId: string): Promise<void> {
		if (this.failovers.getByBackup(backupId)) {
			// A failed failover run is final; failover never chains.
			if (this.failovers.markBackupFailed(backupId, this.clock()))
				await this.replication.refreshMirrors(backupId);
			return;
		}
		await this.consider(backupId);
	}

	async afterSuccess(backupId: string): Promise<void> {
		if (!this.failovers.markBackupCompleted(backupId, this.clock())) return;
		await this.replication.refreshMirrors(backupId);
		void this.tick();
	}

	// ---- ManagedFailoverGuard (replication path) ----

	awaitingCopyBack(backupId: string): boolean {
		const row = this.failovers.getByBackup(backupId);
		return !!row && row.status !== 'copied-back';
	}

	openReplicas(planId: string) {
		return this.failovers.listOpenByPlan(planId).map(row => ({
			replicationId: row.replicationId,
			storageId: row.destinationStorageId,
			storagePath: row.destinationStoragePath,
		}));
	}

	executing(): boolean {
		return this.copying;
	}

	describe(backupId: string): (BackupMirrorFailover & { replicationId: string }) | undefined {
		const row = this.failovers.getByBackup(backupId);
		if (!row) return undefined;
		return {
			replicationId: row.replicationId,
			failedBackupId: row.failedBackupId,
			status: row.status,
			lastErrorCode: row.lastErrorCode,
			copiedBackAt: row.copiedBackAt,
		};
	}

	// ---- Decision ----

	/**
	 * Two witnesses: the Agent reported an eligible pre-upload failure, and the server cannot
	 * reach the primary either. Returns the decision for logs and tests.
	 */
	async consider(backupId: string): Promise<string> {
		if (this.stopping || this.deciding.has(backupId)) return 'busy';
		this.deciding.add(backupId);
		this.considered.set(backupId, this.clock());
		try {
			const decision = await this.decide(backupId);
			serverLogger?.info(
				{ event: 'backup_failover_decision', backupId, decision },
				'Backup failover decision recorded'
			);
			return decision;
		} finally {
			this.deciding.delete(backupId);
		}
	}

	private async decide(backupId: string): Promise<string> {
		const backup = await this.backups.getById(backupId);
		if (
			!backup?.planId ||
			backup.status !== 'failed' ||
			backup.method !== 'backup' ||
			backup.sourceType !== 'device' ||
			backup.sourceId === 'main'
		)
			return 'not-eligible';
		if (this.failovers.getByFailedBackup(backupId) || this.failovers.getByBackup(backupId))
			return 'already-decided';
		const failure = backup.progressStats?.sourceFailure;
		if (!failoverEligible(failure?.failureStage, failure?.failureCode)) return 'not-eligible';
		const plan = await this.plans.getById(backup.planId);
		const replication = plan?.settings.replication;
		if (!plan || !replication?.enabled || replication.backupFailover !== 'automatic')
			return 'disabled';
		// A promotion swaps primary and replica (docs/PRIMARY_PROMOTION.md); never both at once.
		if (this.promotionActive?.(plan.id)) return 'promotion-active';
		if (
			this.failovers.hasNewerBackup(plan.id, backup.id) ||
			(await this.plans.hasActiveBackups(plan.id))
		)
			return 'superseded';
		const repository = await this.repositories.getByPlanId(plan.id);
		if (
			!repository?.initializedAt ||
			repository.storageId !== plan.storageId ||
			repository.storagePath !== plan.storagePath ||
			backup.storageId !== repository.storageId ||
			backup.storagePath !== repository.storagePath
		)
			return 'binding-changed';
		const agent = await this.agents.getAgentById(repository.agentId);
		if (!agent || agent.revokedAt || agent.deviceId !== backup.sourceId) return 'agent-unavailable';
		const primaryStorage = await this.storages.getById(repository.storageId);
		const primaryKind = replicaStorageKind(primaryStorage?.type);
		if (!primaryStorage || !primaryKind) return 'binding-changed';
		const candidates: {
			replica: PlanReplicationStorage;
			storage: Storage;
			fingerprint: string;
			replicaIdentity: string;
			primaryIdentity: string;
		}[] = [];
		for (const replica of replication.storages) {
			const storage = await this.storages.getById(replica.storageId);
			const kind = replicaStorageKind(storage?.type);
			if (!storage || !kind || kind === primaryKind) continue;
			if (
				kind === 's3'
					? !agentSupportsS3Repository(agent.capabilities)
					: agentBackupPayloadVersion(agent.capabilities) !== 5
			)
				continue;
			let fingerprint: string;
			try {
				fingerprint = replicaRepositoryIdentity(storage, replica.storagePath).fingerprint;
			} catch {
				continue;
			}
			const destination = await this.jobs.getDestination(fingerprint);
			const primaryIdentity = this.failovers.verifiedPrimaryIdentity(
				plan.id,
				repository.id,
				replica.replicationId
			);
			if (
				!primaryIdentity ||
				!destination ||
				destination.initState !== 'ready' ||
				!fullSnapshotId.safeParse(destination.actualRepositoryId).success ||
				destination.planId !== plan.id ||
				destination.replicationId !== replica.replicationId ||
				destination.sourceRepositoryId !== repository.id ||
				destination.destinationStorageId !== replica.storageId ||
				destination.destinationStoragePath !== replica.storagePath
			)
				continue;
			candidates.push({
				replica,
				storage,
				fingerprint,
				replicaIdentity: destination.actualRepositoryId!,
				primaryIdentity,
			});
		}
		if (!candidates.length) return 'no-verified-replica';
		const password = this.password(repository.encryptedPassword);
		const primaryIdentity = candidates[0].primaryIdentity;
		try {
			const seen = await this.probe(
				primaryStorage,
				repository.storagePath,
				password,
				this.signal(FAILOVER_TIMING.probeMs)
			);
			return seen === primaryIdentity ? 'primary-reachable' : 'primary-changed';
		} catch {
			// The server cannot reach the primary either: the second witness.
		}
		for (const candidate of candidates) {
			if (candidate.primaryIdentity !== primaryIdentity) continue;
			try {
				const seen = await this.probe(
					candidate.storage,
					candidate.replica.storagePath,
					password,
					this.signal(FAILOVER_TIMING.probeMs)
				);
				if (seen !== candidate.replicaIdentity) continue;
			} catch {
				continue;
			}
			// Settings or a new run may have changed while probing.
			const current = await this.plans.getById(plan.id);
			if (
				current?.settings.replication?.backupFailover !== 'automatic' ||
				this.failovers.hasNewerBackup(plan.id, backup.id)
			)
				return 'superseded';
			const failoverBackupId = await this.remoteBackups.queueFailoverBackup(
				backup,
				repository.agentId,
				repository.id,
				candidate.storage.name,
				newBackupId =>
					this.failovers.insertQueued(
						{
							backupId: newBackupId,
							failedBackupId: backup.id,
							planId: plan.id,
							repositoryId: repository.id,
							agentId: repository.agentId,
							replicationId: candidate.replica.replicationId,
							destinationStorageId: candidate.replica.storageId,
							destinationStoragePath: candidate.replica.storagePath,
							destinationFingerprint: candidate.fingerprint,
							primaryRepositoryConfigId: primaryIdentity,
							replicaRepositoryConfigId: candidate.replicaIdentity,
						},
						this.clock()
					)
			);
			await this.replication.refreshMirrors(failoverBackupId);
			return 'queued';
		}
		return 'replica-unreachable';
	}

	// ---- Verification and copy-back ----

	tick(): Promise<void> {
		if (this.stopping) return Promise.resolve();
		if (this.ticking) return this.ticking;
		this.ticking = this.runTick()
			.catch(() => {
				serverLogger?.warn({ event: 'backup_failover_tick_failed' }, 'Backup failover tick failed');
			})
			.finally(() => {
				this.ticking = undefined;
			});
		return this.ticking;
	}

	async shutdown(): Promise<void> {
		this.stopping = true;
		this.controller.abort('shutdown');
		await this.ticking?.catch(() => undefined);
	}

	private async runTick(): Promise<void> {
		if (!this.interruptedReset) {
			this.failovers.markInterrupted(this.clock());
			this.interruptedReset = true;
		}
		for (const finished of this.failovers.queuedFinished()) {
			if (finished.succeeded) this.failovers.markBackupCompleted(finished.backupId, this.clock());
			else this.failovers.markBackupFailed(finished.backupId, this.clock());
			await this.replication.refreshMirrors(finished.backupId).catch(() => undefined);
		}
		for (const row of this.failovers.listDue(this.clock())) {
			if (this.stopping) return;
			if (row.status === 'verify-pending') await this.verify(row);
			else if (!this.replication.executing()) await this.copyBack(row);
		}
		const since = Math.floor(this.clock() / 1000) - FAILOVER_TIMING.rescanWindowSeconds;
		for (const backupId of this.failovers.undecidedFailures(since)) {
			if (this.stopping) return;
			const last = this.considered.get(backupId);
			if (last !== undefined && this.clock() - last < FAILOVER_TIMING.reconsiderMs) continue;
			await this.consider(backupId);
		}
	}

	private async verify(row: BackupFailover): Promise<void> {
		const token = crypto.randomBytes(32).toString('hex');
		const claimed = this.failovers.claim(row.backupId, 'verify-pending', token, this.clock());
		if (!claimed) return;
		try {
			const context = await this.binding(claimed);
			const snapshotId = context.backup.completionStats?.snapshot_id;
			if (!fullSnapshotId.safeParse(snapshotId).success)
				throw new FailoverError('snapshot-identity-mismatch');
			const source = await this.replicaSource(context, snapshotId!);
			const proof = await this.executor.inspectSource(
				source,
				this.signal(REPLICATION_PROGRESS.limitMs)
			);
			// The Agent wrote an original snapshot into the recorded replica repository.
			if (
				proof.repositoryConfigId !== claimed.replicaRepositoryConfigId ||
				proof.snapshot.id !== snapshotId ||
				proof.snapshot.original
			)
				throw new FailoverError('snapshot-identity-mismatch');
			const recorded = this.failovers.recordVerified(
				claimed,
				token,
				snapshotId!,
				{
					id: `managed-failover-${crypto.createHash('sha256').update(`${claimed.backupId}\0${claimed.replicationId}`).digest('hex')}`,
					sourceStorageId: context.repository.storageId,
					sourceStoragePath: context.repository.storagePath,
					sourceTreeId: proof.snapshot.tree,
					sourceBindingHash: replicaSourceBinding(context.backup),
				},
				this.clock()
			);
			if (recorded) await this.replication.refreshMirrors(claimed.backupId);
		} catch (error) {
			await this.settle(claimed, token, error);
		}
	}

	private async copyBack(row: BackupFailover): Promise<void> {
		let context: Awaited<ReturnType<typeof this.binding>>;
		try {
			context = await this.binding(row);
		} catch (error) {
			const token = crypto.randomBytes(32).toString('hex');
			if (this.failovers.claim(row.backupId, 'verified', token, this.clock()))
				await this.settle({ ...row, status: 'copying' }, token, error);
			return;
		}
		// Copy back only into the same primary repository, once the server reaches it again.
		try {
			const seen = await this.probe(
				context.primaryStorage,
				context.repository.storagePath,
				context.password,
				this.signal(FAILOVER_TIMING.probeMs)
			);
			if (seen !== row.primaryRepositoryConfigId) {
				const token = crypto.randomBytes(32).toString('hex');
				if (this.failovers.claim(row.backupId, 'verified', token, this.clock()))
					await this.settle(row, token, new FailoverError('primary-changed'));
				return;
			}
		} catch {
			this.failovers.defer(
				row.backupId,
				'primary-unreachable',
				FAILOVER_TIMING.primaryRecheckMs,
				this.clock()
			);
			return;
		}
		if (this.replication.executing()) return;
		const token = crypto.randomBytes(32).toString('hex');
		const claimed = this.failovers.claim(row.backupId, 'verified', token, this.clock());
		if (!claimed?.replicaSnapshotId) return;
		this.copying = true;
		try {
			const source = await this.replicaSource(context, claimed.replicaSnapshotId);
			const signal = this.signal(REPLICATION_PROGRESS.limitMs);
			const proof = await this.executor.inspectSource(source, signal);
			if (proof.repositoryConfigId !== claimed.replicaRepositoryConfigId || proof.snapshot.original)
				throw new FailoverError('snapshot-identity-mismatch');
			const copied = await this.executor.copy({
				source,
				proof,
				destination: {
					...(await this.replication.repositoryAccess(context.primaryStorage)),
					repositoryPath: context.repository.storagePath,
				},
				state: { repositoryConfigId: claimed.primaryRepositoryConfigId, initialization: 'ready' },
				beginInitialization: async () => {
					throw new FailoverError('primary-changed');
				},
				bindRepository: async () => {
					throw new FailoverError('primary-changed');
				},
				signal,
			});
			if (copied.repositoryConfigId !== claimed.primaryRepositoryConfigId)
				throw new FailoverError('primary-changed');
			const moved = {
				...context.backup,
				completionStats: { ...context.backup.completionStats!, snapshot_id: copied.snapshotId },
			} as Backup;
			const recorded = this.failovers.recordCopiedBack(
				claimed,
				token,
				copied.snapshotId,
				`managed-failover-${crypto.createHash('sha256').update(`${claimed.backupId}\0${claimed.replicationId}`).digest('hex')}`,
				replicaSourceBinding(moved),
				this.clock()
			);
			if (recorded) {
				await this.replication.refreshMirrors(claimed.backupId);
				// Other replicas copy the backup from the primary as usual.
				void this.replication.enqueueBackup(claimed.backupId).catch(() => undefined);
			}
		} catch (error) {
			await this.settle(claimed, token, error);
		} finally {
			this.copying = false;
		}
	}

	private async settle(row: BackupFailover, token: string, error: unknown): Promise<void> {
		const code = errorCode(error);
		if (PERMANENT.has(code)) this.failovers.fail(row.backupId, token, code, this.clock());
		else this.failovers.release(row.backupId, token, code, FAILOVER_TIMING.retryMs, this.clock());
		serverLogger?.warn(
			{ event: 'backup_failover_step_failed', backupId: row.backupId, code },
			'Backup failover step needs attention'
		);
		await this.replication.refreshMirrors(row.backupId).catch(() => undefined);
	}

	/** Every record behind a failover must still be exactly what was recorded. */
	private async binding(row: BackupFailover) {
		const fail = (): never => {
			throw new FailoverError('binding-changed');
		};
		const backup = await this.backups.getById(row.backupId);
		const plan = await this.plans.getById(row.planId);
		const repository = await this.repositories.getByPlanId(row.planId);
		if (
			!backup ||
			!plan ||
			!repository ||
			backup.planId !== plan.id ||
			repository.id !== row.repositoryId ||
			repository.agentId !== row.agentId ||
			repository.storageId !== plan.storageId ||
			repository.storagePath !== plan.storagePath ||
			backup.storageId !== repository.storageId ||
			backup.storagePath !== repository.storagePath ||
			(row.status !== 'queued' && (backup.status !== 'completed' || backup.success !== true))
		)
			fail();
		const replica = plan!.settings.replication?.storages.find(
			item => item.replicationId === row.replicationId
		);
		if (
			!plan!.settings.replication?.enabled ||
			!replica ||
			replica.storageId !== row.destinationStorageId ||
			replica.storagePath !== row.destinationStoragePath
		)
			fail();
		const replicaStorage = await this.storages.getById(row.destinationStorageId);
		const primaryStorage = await this.storages.getById(repository!.storageId);
		if (!replicaStorage || !primaryStorage) fail();
		let fingerprint: string | undefined;
		try {
			fingerprint = replicaRepositoryIdentity(
				replicaStorage!,
				row.destinationStoragePath
			).fingerprint;
		} catch {
			fail();
		}
		const destination = await this.jobs.getDestination(row.destinationFingerprint);
		if (
			fingerprint !== row.destinationFingerprint ||
			!destination ||
			destination.initState !== 'ready' ||
			destination.actualRepositoryId !== row.replicaRepositoryConfigId ||
			destination.planId !== row.planId ||
			destination.replicationId !== row.replicationId ||
			destination.sourceRepositoryId !== row.repositoryId
		)
			fail();
		return {
			backup: backup!,
			plan: plan!,
			repository: repository!,
			replicaStorage: replicaStorage!,
			primaryStorage: primaryStorage!,
			password: this.password(repository!.encryptedPassword),
			destinationPath: row.destinationStoragePath,
		};
	}

	/** The replica read as a replication source: its own credentials, the shared password. */
	private async replicaSource(
		context: Awaited<ReturnType<typeof this.binding>>,
		snapshotId: string
	): Promise<ReplicationSource> {
		const options = await this.remoteBackups.getRepositoryAccessOptions(context.replicaStorage.id);
		return {
			access: { options, repositoryPath: context.destinationPath, password: context.password },
			...(options.type === 's3' ? { environment: trustEnvironment() } : {}),
			planId: context.plan.id,
			backupId: context.backup.id,
			snapshotId,
			artifacts: recordedArtifacts(context.plan, context.backup),
		};
	}

	private password(encrypted: string): string {
		try {
			return new Cryptr(this.secret).decrypt(encrypted);
		} catch {
			throw new FailoverError('credentials-unavailable');
		}
	}

	private signal(timeoutMs: number): AbortSignal {
		return AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)]);
	}

	/** Read-only `restic cat config` through the recovery sessions; nothing is written. */
	private async identity(
		storage: Storage,
		repositoryPath: string,
		password: string,
		signal: AbortSignal
	): Promise<string> {
		const kind = replicaStorageKind(storage.type);
		const options = await this.remoteBackups.getRepositoryAccessOptions(storage.id);
		const provider =
			kind === 's3'
				? new ManagedS3RecoverySession(trustEnvironment())
				: kind === 'sftp'
					? new ManagedSftpRepositorySession()
					: undefined;
		if (!provider) throw new FailoverError('binding-changed');
		return provider.withSession(
			{ options, repositoryPath, password },
			async session => {
				if (!session.identity) throw new FailoverError('binding-changed');
				return session.identity();
			},
			signal
		);
	}
}

/** The SQL artifacts the plan requires and this backup recorded (as in replication). */
function recordedArtifacts(plan: Plan, backup: Backup): ReplicationSource['artifacts'] {
	const lifecycle = backup.completionStats?.lifecycle;
	const configured = plan.settings.remoteLifecycle
		? lifecycleDatabases(parseRemoteLifecycle(plan.settings.remoteLifecycle))
		: [];
	const artifacts = lifecycle?.databases || (lifecycle?.database ? [lifecycle.database] : []);
	if (
		configured.length !== artifacts.length ||
		configured.some(
			item =>
				!artifacts.some(
					artifact =>
						artifact.path === `/pluton/database/${item.dumpFilename}` &&
						artifact.bytes > 0 &&
						artifact.bytes <= item.maxDumpBytes
				)
		)
	)
		throw new FailoverError('artifact-binding-mismatch');
	return artifacts;
}
