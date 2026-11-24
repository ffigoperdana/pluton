import crypto from 'crypto';
import Cryptr from 'cryptr';
import type { Backup } from '../db/schema/backups';
import type { NewPlan, Plan } from '../db/schema/plans';
import type { Storage } from '../db/schema/storages';
import type { AgentStore } from '../stores/AgentStore';
import type { BackupStore } from '../stores/BackupStore';
import type {
	ManagedReplicationJob,
	ManagedReplicationStore,
} from '../stores/ManagedReplicationStore';
import type { PlanStore } from '../stores/PlanStore';
import {
	type LeftBehindBackup,
	type LeftBehindReceipt,
	type PrimaryPromotion,
	type PrimaryPromotionStore,
	type ResidentBackup,
	type SwappedBackup,
} from '../stores/PrimaryPromotionStore';
import type { RemoteManagedRepositoryStore } from '../stores/RemoteManagedRepositoryStore';
import type { StorageStore } from '../stores/StorageStore';
import type { PlanReplicationStorage } from '../types/plans';
import { AppError, NotFoundError } from '../utils/AppError';
import { agentSupportsS3Repository, isAgentS3StorageType } from '../utils/agentS3Repository';
import { serverLogger } from '../utils/logger';
import { replicaRepositoryIdentity, replicaStorageKind } from '../utils/managedReplicaIdentity';
import { replicaSourceBinding } from '../utils/replicaSourceBinding';
import { ManagedS3RecoverySession } from '../utils/restic/ManagedS3RecoverySession';
import {
	ManagedSftpRepositorySession,
	type ManagedRepositorySession,
} from '../utils/restic/ManagedSftpRepositorySession';
import { trustEnvironment } from '../utils/storageSecurity';
import { configService } from './ConfigService';
import { RemoteBackupService } from './RemoteBackupService';

/** Opens a repository read-only (no lock, no write) for the identity and snapshot checks. */
export type RepositoryReader = <T>(
	storage: Storage,
	repositoryPath: string,
	password: string,
	signal: AbortSignal,
	consume: (session: ManagedRepositorySession) => Promise<T>
) => Promise<T>;

type RemoteBackups = {
	getRepositoryAccessOptions(storageId: string): Promise<Record<string, string>>;
	/** The full managed plan validation, run on the plan as it will be after the switch. */
	validatePlanCreation(plan: NewPlan): Promise<void>;
};

type Replication = {
	enqueueBackup(backupId: string): Promise<void>;
	retryFailed(backupId: string, replicationId?: string): Promise<void>;
	refreshMirrors(backupId: string): Promise<void>;
};

type PlanState = { pause(planId: string): Promise<void>; resume(planId: string): Promise<void> };

export type PromotionView = PrimaryPromotion & {
	previousStorageName?: string;
	promotedStorageName?: string;
	actions: { cancel: boolean };
};

export type PromotionReplica = {
	replicationId: string;
	storageId: string;
	storageName: string;
	storageType: string;
	storagePath: string;
	eligible: boolean;
	reason?: string;
};

export type PromotionOverview = {
	supported: boolean;
	reason?: string;
	replicas: PromotionReplica[];
	active?: PromotionView;
	history: PromotionView[];
};

export const PROMOTION_TIMING = { verifyMs: 6 * 60 * 60_000 };

/**
 * An AppError, so a refusal raised inside a repository session passes through unchanged (the
 * session maps any other error to `credentials-unavailable`).
 */
class PromotionError extends AppError {
	/** `detail` is the repository access category behind the refusal, for logs only. */
	constructor(
		readonly code: string,
		readonly detail?: string
	) {
		super(409, `Primary promotion refused (${code}${detail ? `, ${detail}` : ''}).`);
		Object.setPrototypeOf(this, PromotionError.prototype);
	}
}

const accessCode = (error: unknown): string | undefined => {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(code) ? code : undefined;
};

const promotionId = () => crypto.randomBytes(12).toString('hex');
const receiptId = (backupId: string, replicationId: string) =>
	`managed-replication-${crypto.createHash('sha256').update(`${backupId}\0${replicationId}`).digest('hex')}`;

type Classified = {
	total: number;
	swapped: { job: ManagedReplicationJob; backupId: string }[];
	resident: { job: ManagedReplicationJob; backupId: string }[];
	waiting: string[];
	uncertain: string[];
	retry: string[];
	admit: string[];
	leftBehind: LeftBehindBackup[];
};

/**
 * Stage 4: promotes a plan's verified replica to primary (docs/PRIMARY_PROMOTION.md). Catch-up
 * uses the existing replication queue; the switch is one SQLite transaction. Never initializes,
 * unlocks, forgets, prunes or deletes anything in either repository.
 */
export class PrimaryPromotionService {
	private ticking?: Promise<void>;
	private switching?: string;
	private stopping = false;
	private readonly controller = new AbortController();
	/** One admission at a time: an admission reads the whole SQL artifact of its backup. */
	private admission?: { backupId: string; done: Promise<void> };
	private readonly reader: RepositoryReader;

	constructor(
		private readonly store: PrimaryPromotionStore,
		private readonly jobs: Pick<ManagedReplicationStore, 'listByBackup' | 'getDestination'>,
		private readonly backups: Pick<BackupStore, 'getById'>,
		private readonly plans: Pick<PlanStore, 'getById' | 'hasActiveBackups'>,
		private readonly repositories: Pick<RemoteManagedRepositoryStore, 'getByPlanId'>,
		private readonly agents: Pick<AgentStore, 'getAgentById'>,
		private readonly storages: Pick<StorageStore, 'getById'>,
		private readonly remoteBackups: RemoteBackups,
		private readonly replication: Replication,
		private readonly planState: PlanState,
		private readonly assertPlanIdle: (planId: string) => void,
		private readonly exportsBusy: (planId: string) => boolean = () => false,
		reader?: RepositoryReader,
		private readonly secret = configService.config.SECRET,
		private readonly clock: () => number = () => Date.now()
	) {
		this.reader =
			reader ||
			repositoryReader(storageId => this.remoteBackups.getRepositoryAccessOptions(storageId));
	}

	// ---- Guards used by plans, failover and the UI ----

	activeForPlan(planId: string): PrimaryPromotion | null {
		return this.store.activeForPlan(planId);
	}

	// ---- API ----

	async overview(planId: string): Promise<PromotionOverview> {
		const plan = await this.plans.getById(planId);
		if (!plan) throw new NotFoundError('Plan not found.');
		const history = await Promise.all(
			this.store.listForPlan(planId).map(promotion => this.view(promotion))
		);
		const active = history.find(item => ['catching-up', 'switching'].includes(item.status));
		const replicas: PromotionReplica[] = [];
		let reason: string | undefined;
		const replication = plan.settings.replication;
		if (!RemoteBackupService.isRemoteFilesystemPlan(plan) || plan.method !== 'backup')
			reason = 'Only managed Agent backup plans can promote a replica.';
		else if (!replication?.enabled || !replication.storages?.length)
			reason = 'Enable replication and wait for a verified replica copy first.';
		else if (replication.storages.length !== 1)
			reason = 'Promotion supports plans with exactly one replica.';
		for (const replica of replication?.storages || []) {
			const storage = await this.storages.getById(replica.storageId);
			let problem = reason;
			if (!problem) {
				try {
					await this.replicaState(plan, replica);
				} catch (error) {
					problem = error instanceof AppError ? error.message : 'The replica cannot be promoted.';
				}
			}
			replicas.push({
				replicationId: replica.replicationId,
				storageId: replica.storageId,
				storageName: storage?.name || replica.storageName || 'Unavailable storage',
				storageType: storage?.type || replica.storageType,
				storagePath: replica.storagePath,
				eligible: !problem && !active,
				...(problem ? { reason: problem } : {}),
			});
		}
		return { supported: !reason, ...(reason ? { reason } : {}), replicas, active, history };
	}

	async get(id: string): Promise<PromotionView> {
		const promotion = this.store.get(id);
		if (!promotion) throw new NotFoundError('Promotion not found.');
		return this.view(promotion);
	}

	async start(input: { planId: string; replicationId: string }): Promise<PromotionView> {
		if (this.stopping) throw new AppError(503, 'The server is shutting down.');
		const plan = await this.plans.getById(input.planId);
		if (!plan) throw new NotFoundError('Plan not found.');
		if (!RemoteBackupService.isRemoteFilesystemPlan(plan) || plan.method !== 'backup')
			throw new AppError(400, 'Only managed Agent backup plans can promote a replica.');
		const replication = plan.settings.replication;
		if (!replication?.enabled || replication.storages?.length !== 1)
			throw new AppError(409, 'Promotion supports plans with exactly one enabled replica.');
		const replica = replication.storages.find(item => item.replicationId === input.replicationId);
		if (!replica) throw new NotFoundError('Replica not found in this plan.');
		const state = await this.replicaState(plan, replica);
		if (this.exportsBusy(plan.id))
			throw new AppError(
				409,
				'Wait for the running Reliable Download export of this plan to finish.'
			);
		// Validate the plan exactly as it will be after the switch: the Agent must support the new
		// primary type, and the previous primary must be a valid replica of it.
		const previousEntry: PlanReplicationStorage = {
			replicationId: replica.replicationId,
			storageId: state.repository.storageId,
			storagePath: state.repository.storagePath,
			storageType: state.previousStorage.type as string,
			storageName: state.previousStorage.name,
			addedAt: this.clock(),
		};
		await this.remoteBackups.validatePlanCreation({
			...plan,
			storageId: replica.storageId,
			storagePath: replica.storagePath,
			settings: {
				...plan.settings,
				replication: { ...replication, storages: [previousEntry] },
			},
		} as NewPlan);
		const promotion = this.store.create(
			{
				id: promotionId(),
				planId: plan.id,
				repositoryId: state.repository.id,
				replicationId: replica.replicationId,
				previousStorageId: state.repository.storageId,
				previousStoragePath: state.repository.storagePath,
				previousRepositoryConfigId: state.previousConfigId,
				promotedStorageId: replica.storageId,
				promotedStoragePath: replica.storagePath,
				promotedFingerprint: state.fingerprint,
				promotedRepositoryConfigId: state.promotedConfigId,
			},
			this.clock()
		);
		this.log('primary_promotion_started', promotion);
		void this.tick();
		return this.view(promotion);
	}

	async cancel(id: string): Promise<PromotionView> {
		const promotion = this.store.get(id);
		if (!promotion) throw new NotFoundError('Promotion not found.');
		if (this.switching === id)
			throw new AppError(409, 'The switch is running and cannot be cancelled.');
		const cancelled = this.store.cancel(id, this.clock());
		if (!cancelled) throw new AppError(409, 'This promotion is no longer active.');
		await this.restorePlan(cancelled);
		this.log('primary_promotion_cancelled', cancelled);
		return this.view(cancelled);
	}

	// ---- Reconciliation ----

	tick(): Promise<void> {
		if (this.stopping) return Promise.resolve();
		if (this.ticking) return this.ticking;
		this.ticking = this.runTick().finally(() => {
			this.ticking = undefined;
		});
		return this.ticking;
	}

	async shutdown(): Promise<void> {
		this.stopping = true;
		this.controller.abort();
		await Promise.allSettled([this.ticking, this.admission?.done]);
	}

	private async runTick(): Promise<void> {
		for (const promotion of this.store.listActive()) {
			if (this.stopping) return;
			try {
				await this.advance(promotion);
			} catch (error) {
				const code = error instanceof PromotionError ? error.code : 'execution-failed';
				const failed = this.store.fail(promotion.id, code, this.clock());
				if (failed) {
					await this.restorePlan(failed);
					this.log(
						'primary_promotion_failed',
						failed,
						code,
						error instanceof PromotionError ? error.detail : accessCode(error)
					);
				}
			}
		}
	}

	private async advance(promotion: PrimaryPromotion): Promise<void> {
		const context = await this.binding(promotion);
		let current = promotion;
		const classified = await this.classify(current);
		if (classified.uncertain.length) throw new PromotionError('replication-uncertain');
		this.store.recordProgress(
			current.id,
			{
				total: classified.total,
				copied: classified.swapped.length + classified.resident.length,
				retried: current.retried,
				leftBehind: classified.leftBehind,
			},
			this.clock()
		);
		if (await this.kick(current, classified)) return;
		if (classified.waiting.length) return;
		if (current.status === 'catching-up') {
			const wasActive = !!context.plan.isActive;
			if (wasActive) {
				try {
					await this.planState.pause(current.planId);
				} catch {
					throw new PromotionError('pause-failed');
				}
			}
			const switching = this.store.toSwitching(current.id, wasActive, this.clock());
			if (!switching) return;
			current = switching;
			this.log('primary_promotion_final_catch_up', current);
		}
		// Final step: nothing runs for the plan, and nothing completed since is left uncopied.
		if (await this.plans.hasActiveBackups(current.planId)) return;
		const final = await this.classify(current);
		if (final.uncertain.length) throw new PromotionError('replication-uncertain');
		if ((await this.kick(current, final)) || final.waiting.length) return;
		await this.switchOver(current, context, final);
	}

	/** Starts the retries and the next admission. True when something was started. */
	private async kick(promotion: PrimaryPromotion, classified: Classified): Promise<boolean> {
		let started = false;
		const retried = new Set(promotion.retried);
		for (const backupId of classified.retry) {
			try {
				await this.replication.retryFailed(backupId, promotion.replicationId);
			} catch {
				// A refused retry leaves the backup behind on the next pass.
			}
			retried.add(backupId);
			started = true;
		}
		if (!this.admission) {
			const next = classified.admit[0];
			if (next) {
				// One admission per backup and promotion: a second refusal leaves it behind.
				retried.add(next);
				const done = this.replication
					.enqueueBackup(next)
					.catch(() => undefined)
					.finally(() => {
						if (this.admission?.backupId === next) this.admission = undefined;
					});
				this.admission = { backupId: next, done };
				started = true;
			}
		}
		if (started)
			this.store.recordProgress(
				promotion.id,
				{
					total: classified.total,
					copied: classified.swapped.length + classified.resident.length,
					retried: [...retried],
					leftBehind: classified.leftBehind,
				},
				this.clock()
			);
		return started;
	}

	/**
	 * Every completed backup bound to the current primary: copied (swapped), only in the replica
	 * (resident), still moving (waiting), or left behind after one retry.
	 */
	private async classify(promotion: PrimaryPromotion): Promise<Classified> {
		const result: Classified = {
			total: 0,
			swapped: [],
			resident: [],
			waiting: [],
			uncertain: [],
			retry: [],
			admit: [],
			leftBehind: [],
		};
		const retried = new Set(promotion.retried);
		for (const row of this.store.completedBackups(
			promotion.planId,
			promotion.previousStorageId,
			promotion.previousStoragePath
		)) {
			if (!row.snapshotId) continue;
			result.total++;
			const job = (await this.jobs.listByBackup(row.id)).find(
				item => item.replicationId === promotion.replicationId
			);
			if (job) {
				if (
					job.destinationStorageId !== promotion.promotedStorageId ||
					job.destinationStoragePath !== promotion.promotedStoragePath ||
					job.destinationFingerprint !== promotion.promotedFingerprint
				)
					throw new PromotionError('binding-changed');
				if (job.status === 'completed') {
					if (job.sourceSnapshotId !== row.snapshotId || !job.destinationSnapshotId)
						throw new PromotionError('receipt-mismatch');
					(job.destinationSnapshotId === job.sourceSnapshotId
						? result.resident
						: result.swapped
					).push({
						job,
						backupId: row.id,
					});
				} else if (job.status === 'pending' || job.status === 'running')
					result.waiting.push(row.id);
				else if (job.status === 'uncertain') result.uncertain.push(row.id);
				else if (!retried.has(row.id)) {
					result.retry.push(row.id);
					result.waiting.push(row.id);
				} else
					result.leftBehind.push({ backupId: row.id, code: job.lastErrorCode || 'copy-failed' });
				continue;
			}
			if (this.admission?.backupId === row.id) {
				result.waiting.push(row.id);
				continue;
			}
			const backup = await this.backups.getById(row.id);
			const mirror = backup?.mirrors?.find(item => item.replicationId === promotion.replicationId);
			if (mirror?.status === 'failed' && retried.has(row.id)) {
				result.leftBehind.push({
					backupId: row.id,
					code: mirror.lastErrorCode || 'admission-refused',
				});
				continue;
			}
			result.admit.push(row.id);
			result.waiting.push(row.id);
		}
		return result;
	}

	private async switchOver(
		promotion: PrimaryPromotion,
		context: Awaited<ReturnType<typeof this.binding>>,
		classified: Classified
	): Promise<void> {
		this.switching = promotion.id;
		try {
			const signal = AbortSignal.any([
				this.controller.signal,
				AbortSignal.timeout(PROMOTION_TIMING.verifyMs),
			]);
			const backups = new Map<string, Backup>();
			for (const { backupId } of [
				...classified.swapped,
				...classified.resident,
				...classified.leftBehind,
			]) {
				const backup = await this.backups.getById(backupId);
				if (!backup) throw new PromotionError('backup-changed');
				backups.set(backupId, backup);
			}
			const { swapped, resident, leftBehind, record } = await verifyPromotion(this.reader, {
				promotion,
				promotedStorage: context.promotedStorage,
				previousStorage: context.previousStorage,
				password: context.password,
				signal,
				swapped: classified.swapped.map(item => ({
					job: item.job,
					backup: backups.get(item.backupId)!,
				})),
				resident: classified.resident.map(item => ({ job: item.job, backupId: item.backupId })),
				leftBehind: classified.leftBehind.map(item => ({
					...item,
					backup: backups.get(item.backupId)!,
				})),
			});
			const previous = replicaRepositoryIdentity(
				context.previousStorage,
				promotion.previousStoragePath
			);
			const switched = this.store.switchPrimary(
				promotion.id,
				{
					previous: {
						fingerprint: previous.fingerprint,
						authority: previous.authority,
						prefix: previous.prefix,
						storageType: context.previousStorage.type as string,
						storageName: context.previousStorage.name,
					},
					swapped,
					resident,
					leftBehind,
					leftBehindRecord: record,
					assertPlanIdle: this.assertPlanIdle,
				},
				this.clock()
			);
			this.log('primary_promotion_switched', switched);
			await this.restorePlan(switched);
			for (const backupId of backups.keys()) {
				try {
					await this.replication.refreshMirrors(backupId);
				} catch {
					// The mirror projection is rebuilt by the next replication pass.
				}
			}
		} finally {
			this.switching = undefined;
		}
	}

	// ---- Bindings ----

	/** The replica of the plan, ready and verified, and the identity of the current primary. */
	private async replicaState(plan: Plan, replica: PlanReplicationStorage) {
		const repository = await this.repositories.getByPlanId(plan.id);
		if (
			!repository?.initializedAt ||
			repository.storageId !== plan.storageId ||
			repository.storagePath !== plan.storagePath
		)
			throw new AppError(409, 'The plan repository is not initialized or its binding changed.');
		const previousStorage = await this.storages.getById(repository.storageId);
		const promotedStorage = await this.storages.getById(replica.storageId);
		if (
			!previousStorage ||
			!promotedStorage ||
			!replicaStorageKind(previousStorage.type) ||
			!replicaStorageKind(promotedStorage.type)
		)
			throw new AppError(409, 'The replica storage is unavailable.');
		let fingerprint: string;
		try {
			fingerprint = replicaRepositoryIdentity(promotedStorage, replica.storagePath).fingerprint;
		} catch {
			throw new AppError(409, 'The replica location cannot be verified.');
		}
		const destination = await this.jobs.getDestination(fingerprint);
		if (
			!destination ||
			destination.initState !== 'ready' ||
			!/^[a-f0-9]{64}$/.test(destination.actualRepositoryId || '') ||
			destination.planId !== plan.id ||
			destination.replicationId !== replica.replicationId ||
			destination.sourceRepositoryId !== repository.id ||
			destination.destinationStorageId !== replica.storageId ||
			destination.destinationStoragePath !== replica.storagePath
		)
			throw new AppError(
				409,
				'The replica has no verified repository yet. Wait for its first verified copy.'
			);
		const receipts = (
			await Promise.all(
				this.store
					.completedBackups(plan.id, repository.storageId, repository.storagePath)
					.map(row => this.jobs.listByBackup(row.id))
			)
		)
			.flat()
			.filter(
				job =>
					job.replicationId === replica.replicationId &&
					job.status === 'completed' &&
					job.destinationFingerprint === fingerprint &&
					!!job.verifiedAt
			)
			.sort((a, b) => (b.verifiedAt || 0) - (a.verifiedAt || 0));
		const previousConfigId = receipts[0]?.sourceRepositoryConfigId;
		if (!previousConfigId)
			throw new AppError(
				409,
				'The replica holds no verified copy yet. Wait for its first verified copy.'
			);
		if (isAgentS3StorageType(promotedStorage.type)) {
			const agent = await this.agents.getAgentById(repository.agentId);
			if (!agent || agent.revokedAt || !agentSupportsS3Repository(agent.capabilities))
				throw new AppError(
					409,
					'An S3 primary needs Agent 0.8.0 or later on this host. Update the Agent first.'
				);
		}
		return {
			repository,
			previousStorage,
			promotedStorage,
			fingerprint,
			promotedConfigId: destination.actualRepositoryId!,
			previousConfigId,
		};
	}

	/** Re-checked on every pass: the plan still points at the previous primary and the replica. */
	private async binding(promotion: PrimaryPromotion) {
		const plan = await this.plans.getById(promotion.planId);
		const repository = await this.repositories.getByPlanId(promotion.planId);
		const replica = plan?.settings.replication?.storages?.find(
			item => item.replicationId === promotion.replicationId
		);
		if (
			!plan ||
			!repository ||
			repository.id !== promotion.repositoryId ||
			plan.storageId !== promotion.previousStorageId ||
			plan.storagePath !== promotion.previousStoragePath ||
			repository.storageId !== promotion.previousStorageId ||
			repository.storagePath !== promotion.previousStoragePath ||
			!plan.settings.replication?.enabled ||
			plan.settings.replication.storages.length !== 1 ||
			!replica ||
			replica.storageId !== promotion.promotedStorageId ||
			replica.storagePath !== promotion.promotedStoragePath
		)
			throw new PromotionError('binding-changed');
		const destination = await this.jobs.getDestination(promotion.promotedFingerprint);
		if (
			!destination ||
			destination.initState !== 'ready' ||
			destination.actualRepositoryId !== promotion.promotedRepositoryConfigId ||
			destination.planId !== promotion.planId ||
			destination.replicationId !== promotion.replicationId
		)
			throw new PromotionError('binding-changed');
		const previousStorage = await this.storages.getById(promotion.previousStorageId);
		const promotedStorage = await this.storages.getById(promotion.promotedStorageId);
		if (!previousStorage || !promotedStorage) throw new PromotionError('binding-changed');
		let password: string;
		try {
			password = new Cryptr(this.secret).decrypt(repository.encryptedPassword);
		} catch {
			throw new PromotionError('credentials-unavailable');
		}
		return { plan, repository, previousStorage, promotedStorage, password };
	}

	private async restorePlan(promotion: PrimaryPromotion): Promise<void> {
		if (!promotion.planWasActive) return;
		try {
			await this.planState.resume(promotion.planId);
		} catch {
			this.log('primary_promotion_resume_failed', promotion, 'resume-failed');
		}
	}

	private async view(promotion: PrimaryPromotion): Promise<PromotionView> {
		const name = async (storageId: string) => {
			try {
				return (await this.storages.getById(storageId))?.name || undefined;
			} catch {
				return undefined;
			}
		};
		return {
			...promotion,
			previousStorageName: await name(promotion.previousStorageId),
			promotedStorageName: await name(promotion.promotedStorageId),
			actions: {
				cancel:
					['catching-up', 'switching'].includes(promotion.status) &&
					this.switching !== promotion.id,
			},
		};
	}

	/** Identifiers only: no storage names, paths, endpoints or credentials. */
	private log(event: string, promotion: PrimaryPromotion, code?: string, detail?: string) {
		try {
			serverLogger?.info(
				{
					event,
					promotionId: promotion.id,
					planId: promotion.planId,
					replicationId: promotion.replicationId,
					status: promotion.status,
					totalBackups: promotion.totalBackups,
					copiedBackups: promotion.copiedBackups,
					...(code || promotion.lastErrorCode ? { code: code || promotion.lastErrorCode } : {}),
					...(detail ? { detail } : {}),
				},
				'Primary promotion'
			);
		} catch {
			/* Telemetry cannot fail the promotion. */
		}
	}
}

const tagged = (tags: string[], planId: string, backupId: string): boolean =>
	tags.filter(tag => tag.startsWith('pluton-plan-')).length === 1 &&
	tags.filter(tag => tag.startsWith('pluton-backup-')).length === 1 &&
	tags.includes('pluton-plan-' + planId) &&
	tags.includes('pluton-backup-' + backupId);

/** Read-only Restic access through the server read path of SFTP and S3 repositories. */
export function repositoryReader(
	accessOptions: (storageId: string) => Promise<Record<string, string>>
): RepositoryReader {
	return async (storage, repositoryPath, password, signal, consume) => {
		const kind = replicaStorageKind(storage.type);
		const provider =
			kind === 's3'
				? new ManagedS3RecoverySession(trustEnvironment())
				: kind === 'sftp'
					? new ManagedSftpRepositorySession()
					: undefined;
		if (!provider) throw new PromotionError('binding-changed');
		const options = await accessOptions(storage.id);
		return provider.withSession({ options, repositoryPath, password }, consume, signal);
	};
}

export type PromotionVerification = {
	promotion: Pick<
		PrimaryPromotion,
		| 'planId'
		| 'replicationId'
		| 'promotedStoragePath'
		| 'promotedRepositoryConfigId'
		| 'previousStoragePath'
		| 'previousRepositoryConfigId'
	>;
	promotedStorage: Storage;
	previousStorage: Storage;
	password: string;
	signal: AbortSignal;
	swapped: { job: ManagedReplicationJob; backup: Backup }[];
	resident: { job: ManagedReplicationJob; backupId: string }[];
	leftBehind: (LeftBehindBackup & { backup: Backup })[];
};

/**
 * Read-only proof before the switch. The promoted repository must be the recorded one and hold
 * every snapshot the plan will point at, each the copy (or the original) its receipt names.
 * Left-behind backups get a receipt only when the previous primary is proven to hold them.
 */
export async function verifyPromotion(reader: RepositoryReader, input: PromotionVerification) {
	const { promotion, signal } = input;
	const swapped: SwappedBackup[] = [];
	const resident: ResidentBackup[] = [];
	await reader(
		input.promotedStorage,
		promotion.promotedStoragePath,
		input.password,
		signal,
		async session => {
			if (!session.identity || (await session.identity()) !== promotion.promotedRepositoryConfigId)
				throw new PromotionError('repository-identity-mismatch');
			for (const { job, backup } of input.swapped) {
				const snapshot = await session.snapshot(job.destinationSnapshotId!);
				const original = job.destinationOriginal === 1;
				if (
					snapshot.id !== job.destinationSnapshotId ||
					snapshot.tree !== job.sourceTreeId ||
					(original
						? snapshot.original !== undefined
						: snapshot.original !== job.sourceSnapshotId) ||
					!tagged(snapshot.tags, promotion.planId, backup.id)
				)
					throw new PromotionError('snapshot-identity-mismatch');
				swapped.push({
					jobId: job.id,
					backupId: backup.id,
					previousSnapshotId: job.sourceSnapshotId,
					promotedSnapshotId: job.destinationSnapshotId!,
					bindingHash: replicaSourceBinding({
						...backup,
						completionStats: {
							...(backup.completionStats || {}),
							snapshot_id: job.destinationSnapshotId!,
						},
					} as Backup),
					// The previous primary holds the original unless it held the copy before.
					destinationOriginal: !original,
				});
			}
			for (const { job, backupId } of input.resident) {
				const snapshot = await session.snapshot(job.destinationSnapshotId!);
				if (
					snapshot.id !== job.destinationSnapshotId ||
					snapshot.tree !== job.sourceTreeId ||
					!tagged(snapshot.tags, promotion.planId, backupId)
				)
					throw new PromotionError('snapshot-identity-mismatch');
				resident.push({ jobId: job.id, backupId, snapshotId: job.destinationSnapshotId! });
			}
		}
	).catch(error => {
		if (error instanceof PromotionError) throw error;
		throw new PromotionError(
			signal.aborted ? 'verification-stopped' : 'replica-unreachable',
			accessCode(error)
		);
	});
	const leftBehind: LeftBehindReceipt[] = [];
	const record: LeftBehindBackup[] = input.leftBehind.map(({ backupId, code }) => ({
		backupId,
		code,
		restorable: false,
	}));
	if (record.length) {
		try {
			await reader(
				input.previousStorage,
				promotion.previousStoragePath,
				input.password,
				signal,
				async session => {
					if (
						!session.identity ||
						(await session.identity()) !== promotion.previousRepositoryConfigId
					)
						throw new PromotionError('previous-identity-mismatch');
					for (const [index, item] of input.leftBehind.entries()) {
						const snapshotId = item.backup.completionStats?.snapshot_id as string;
						try {
							const snapshot = await session.snapshot(snapshotId);
							if (
								snapshot.id !== snapshotId ||
								!snapshot.tree ||
								!tagged(snapshot.tags, promotion.planId, item.backupId)
							)
								continue;
							leftBehind.push({
								receiptId: receiptId(item.backupId, promotion.replicationId),
								backupId: item.backupId,
								snapshotId,
								treeId: snapshot.tree,
								bindingHash: replicaSourceBinding(item.backup),
							});
							record[index].restorable = true;
						} catch {
							// Unproven: the backup row keeps its previous location.
						}
					}
				}
			);
		} catch (error) {
			if (signal.aborted) throw error;
			// The previous primary may be the reason for the promotion; continue without it.
		}
	}
	return { swapped, resident, leftBehind, record };
}
