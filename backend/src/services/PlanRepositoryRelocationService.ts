import crypto from 'crypto';
import Cryptr from 'cryptr';
import { configService } from './ConfigService';
import { RemoteBackupService } from './RemoteBackupService';
import { AppError, NotFoundError } from '../utils/AppError';
import { planLogger } from '../utils/logger';
import {
	PlanRepositoryRelocationStore,
	type PlanRepositoryRelocation,
	type RelocationEvidence,
	type RelocationProgress,
} from '../stores/PlanRepositoryRelocationStore';
import type { PlanStore } from '../stores/PlanStore';
import type { StorageStore } from '../stores/StorageStore';
import type { RemoteManagedRepositoryStore } from '../stores/RemoteManagedRepositoryStore';
import {
	isSubsetOf,
	locationsOverlap,
	RelocationError,
	validateRelocationPath,
	type RelocationFailureCode,
} from '../utils/relocation/repositoryInventory';
import {
	SftpRepositoryTransfer,
	type RepositoryTransferProvider,
	type RepositoryTransferSession,
	type SftpEndpoint,
} from '../utils/relocation/SftpRepositoryTransfer';

export type RelocationOperation = 'switching' | 'reverting' | 'deleting-source';
export type RelocationView = Omit<PlanRepositoryRelocation, 'audit' | 'source' | 'destination'> & {
	source: { storageId: string; storageName?: string; storagePath: string };
	destination: { storageId: string; storageName?: string; storagePath: string };
	operation?: RelocationOperation;
	/** Last refused or failed operation on a finished copy (switch/revert/delete). */
	lastOperationFailure?: { operation: string; code: string; at: number };
	actions: { cancel: boolean; switch: boolean; revert: boolean; deleteSource: boolean };
	audit: { at: number; event: string; code?: string; phase?: string }[];
};
export type RelocationPlanState = {
	pause(planId: string): Promise<void>;
	resume(planId: string): Promise<void>;
};

const failureCode = (error: unknown): RelocationFailureCode =>
	error instanceof RelocationError
		? error.code
		: error instanceof AppError && error.statusCode === 409
			? 'plan-busy'
			: 'execution-failed';

/**
 * Moves the primary SFTP repository of one managed remote plan to another SFTP
 * Storage: copy, prove the copy, then switch every binding in one transaction.
 * Never initializes, backs up to, forgets, prunes or unlocks a repository. The
 * previous copy is removed only by an explicit, separately proven request.
 */
export class PlanRepositoryRelocationService {
	private running?: { id: string; controller: AbortController; done: Promise<void> };
	private readonly operations = new Map<string, { kind: RelocationOperation; done: Promise<void> }>();
	private readonly controllers = new Set<AbortController>();
	private stopped = false;

	constructor(
		private readonly store: PlanRepositoryRelocationStore,
		private readonly plans: Pick<PlanStore, 'getById' | 'getStorageRemovalReferences'>,
		private readonly repositories: Pick<RemoteManagedRepositoryStore, 'getByPlanId'>,
		private readonly storages: Pick<StorageStore, 'getById'>,
		private readonly access: Pick<RemoteBackupService, 'getSftpRecoveryOptions'>,
		private readonly planState: RelocationPlanState,
		private readonly exportsBusy: (planId: string) => boolean = () => false,
		private readonly transfer: RepositoryTransferProvider = new SftpRepositoryTransfer(),
		private readonly secret: string = configService.config.SECRET
	) {}

	async overview(planId: string) {
		const plan = await this.plans.getById(planId);
		if (!plan) throw new NotFoundError('Plan not found.');
		const relocations = await Promise.all(
			this.store.listForPlan(planId).map(relocation => this.view(relocation))
		);
		const supported = RemoteBackupService.isRemoteFilesystemPlan(plan) && plan.method === 'backup';
		return {
			supported,
			canStart: supported && !this.store.activeForPlan(planId),
			current: { storageId: plan.storageId, storagePath: plan.storagePath },
			relocations,
		};
	}

	async get(id: string) {
		const relocation = this.store.get(id);
		if (!relocation) throw new NotFoundError('Repository relocation not found.');
		return this.view(relocation);
	}

	async start(input: { planId: string; storageId: string; storagePath: string }) {
		if (this.stopped) throw new AppError(503, 'The server is shutting down.');
		const plan = await this.plans.getById(input.planId);
		if (!plan) throw new NotFoundError('Plan not found.');
		if (!RemoteBackupService.isRemoteFilesystemPlan(plan) || plan.method !== 'backup')
			throw new AppError(
				400,
				'Only managed Remote Agent backup plans can move their repository to another Storage.'
			);
		const repository = await this.repositories.getByPlanId(plan.id);
		if (
			!repository?.initializedAt ||
			repository.storageId !== plan.storageId ||
			repository.storagePath !== plan.storagePath
		)
			throw new AppError(
				409,
				'The plan repository is not initialized or its binding changed. Run one successful backup first.'
			);
		const storagePath = validateRelocationPath(input.storagePath);
		const destination = await this.storages.getById(input.storageId);
		if (!destination || destination.type !== 'sftp')
			throw new AppError(400, 'The destination must be an SFTP Storage.');
		const source = { storageId: repository.storageId, storagePath: repository.storagePath };
		if (
			destination.id === source.storageId &&
			locationsOverlap(source.storagePath, storagePath)
		)
			throw new AppError(
				400,
				'The destination must not be the current repository location or inside/around it.'
			);
		await this.assertDestinationAvailable(repository.id, destination.id, storagePath);
		if (this.exportsBusy(plan.id))
			throw new AppError(409, 'Wait for the running Reliable Download export of this plan to finish.');
		const now = Date.now();
		const relocation = this.store.create({
			id: crypto.randomBytes(12).toString('hex'),
			planId: plan.id,
			repositoryId: repository.id,
			source,
			destination: { storageId: destination.id, storagePath },
			status: 'copying',
			phase: 'pausing-plan',
			planWasActive: !!plan.isActive,
			createdAt: now,
			updatedAt: now,
			audit: [{ at: now, event: 'requested' }],
		});
		if (plan.isActive) {
			try {
				await this.planState.pause(plan.id);
			} catch {
				this.store.transition(
					relocation.id,
					['copying'],
					{ status: 'failed', phase: 'failed', failureCode: 'execution-failed' },
					{ event: 'pause-failed', code: 'execution-failed' }
				);
				await this.restorePlanState(this.store.get(relocation.id)!);
				throw new AppError(500, 'The plan could not be paused. Nothing was copied.');
			}
		}
		this.log('relocation_started', relocation);
		this.launch(relocation.id);
		return this.view(this.store.get(relocation.id)!);
	}

	async cancel(id: string) {
		const relocation = this.store.get(id);
		if (!relocation) throw new NotFoundError('Repository relocation not found.');
		if (this.operations.has(id))
			throw new AppError(409, 'Wait for the running switch or revert to finish.');
		const cancelled = this.store.transition(
			id,
			['copying', 'verifying', 'ready'],
			{ status: 'cancelled', phase: 'cancelled' },
			{ event: 'cancelled' }
		);
		if (!cancelled) throw new AppError(409, 'This relocation is no longer active.');
		if (this.running?.id === id) {
			this.running.controller.abort();
			await this.running.done.catch(() => {});
		}
		await this.restorePlanState(cancelled);
		this.log('relocation_cancelled', cancelled);
		return this.view(this.store.get(id)!);
	}

	async switch(id: string) {
		const relocation = this.requireIdleOperation(id);
		if (relocation.status !== 'ready' || !relocation.evidence)
			throw new AppError(409, 'Only a verified relocation can be switched.');
		if (this.exportsBusy(relocation.planId))
			throw new AppError(409, 'Wait for the running Reliable Download export of this plan to finish.');
		this.store.assertPlanIdle(relocation.planId);
		this.background(id, 'switching', async signal => {
			const evidence = relocation.evidence!;
			try {
				await this.session(relocation, signal, async transfer => {
					const source = await transfer.inventory('source');
					if (!source || source.digest !== evidence.listingDigest)
						throw new RelocationError('source-changed');
					const destination = await transfer.inventory('destination');
					if (!destination || destination.digest !== evidence.listingDigest)
						throw new RelocationError('destination-changed');
					if ((await transfer.repositoryId('destination')) !== evidence.repositoryConfigId)
						throw new RelocationError('repository-identity-mismatch');
				});
			} catch (error) {
				const code = failureCode(error);
				// A changed copy can never be switched: finish this attempt and give the plan back.
				if (['source-changed', 'destination-changed', 'repository-identity-mismatch'].includes(code)) {
					const failed = this.store.transition(
						id,
						['ready'],
						{ status: 'failed', phase: 'failed', failureCode: code },
						{ event: 'switch-failed', code }
					);
					if (failed) await this.restorePlanState(failed);
					return;
				}
				throw error;
			}
			const switched = this.store.switchBinding(id);
			this.log('relocation_switched', switched);
			if (switched.planWasActive) {
				try {
					await this.planState.resume(switched.planId);
					this.store.appendAudit(id, { event: 'plan-resumed' });
				} catch {
					this.store.appendAudit(id, { event: 'resume-failed', code: 'execution-failed' });
				}
			}
		});
		return this.view(this.store.get(id)!);
	}

	async revert(id: string) {
		const relocation = this.requireIdleOperation(id);
		if (relocation.status !== 'switched' || !relocation.evidence)
			throw new AppError(409, 'Only a switched relocation can be reverted.');
		if (this.store.hasSuccessfulBackupSinceSwitch(relocation))
			throw new AppError(
				409,
				'A successful backup already exists at the new location. Start a new relocation instead of reverting.'
			);
		if (this.exportsBusy(relocation.planId))
			throw new AppError(409, 'Wait for the running Reliable Download export of this plan to finish.');
		this.store.assertPlanIdle(relocation.planId);
		this.background(id, 'reverting', async signal => {
			const evidence = relocation.evidence!;
			// "source" is the previous location here; it must still hold the exact verified copy.
			await this.session(relocation, signal, async transfer => {
				const previous = await transfer.inventory('source');
				if (!previous || previous.digest !== evidence.listingDigest)
					throw new RelocationError('source-changed');
				if ((await transfer.repositoryId('source')) !== evidence.repositoryConfigId)
					throw new RelocationError('repository-identity-mismatch');
			});
			const reverted = this.store.revertBinding(id);
			this.log('relocation_reverted', reverted);
		});
		return this.view(this.store.get(id)!);
	}

	async deleteSourceCopy(id: string, confirmTitle: string) {
		const relocation = this.requireIdleOperation(id);
		if (relocation.status !== 'switched' || !relocation.evidence)
			throw new AppError(409, 'Only the previous copy of a switched relocation can be deleted.');
		const plan = await this.plans.getById(relocation.planId);
		if (!plan) throw new NotFoundError('Plan not found.');
		if (typeof confirmTitle !== 'string' || confirmTitle !== plan.title)
			throw new AppError(400, 'Type the plan name exactly to confirm deleting the previous copy.');
		if (!this.store.hasSuccessfulBackupSinceSwitch(relocation))
			throw new AppError(
				409,
				'Run at least one successful backup at the new location before deleting the previous copy.'
			);
		await this.assertPreviousLocationRemovable(relocation);
		this.background(id, 'deleting-source', async signal => {
			const evidence = relocation.evidence!;
			this.store.appendAudit(id, { event: 'source-delete-started' });
			await this.session(relocation, signal, async transfer => {
				const previous = await transfer.inventory('source', {
					allowPartial: true,
					requireRepository: false,
				});
				if (!previous) return;
				const live = await transfer.inventory('destination');
				// The live repository never forgets or prunes, so it holds every previous
				// file. Anything else at the previous location is not ours to delete.
				if (!live || previous.partial.length || !isSubsetOf(previous.entries, live.entries))
					throw new RelocationError('source-changed');
				if (
					previous.entries.some(entry => entry.path === 'config') &&
					(await transfer.repositoryId('source')) !== evidence.repositoryConfigId
				)
					throw new RelocationError('repository-identity-mismatch');
				await transfer.purgeSource();
			});
			const deleted = this.store.markSourceDeleted(id);
			this.log('relocation_source_deleted', deleted);
		});
		return this.view(this.store.get(id)!);
	}

	/** Startup: a copy or verification never resumes silently; the plan gets its state back. */
	async recoverInterrupted() {
		for (const relocation of this.store.listByStatus(['copying', 'verifying'])) {
			const failed = this.store.transition(
				relocation.id,
				['copying', 'verifying'],
				{ status: 'failed', phase: 'failed', failureCode: 'server-restarted' },
				{ event: 'interrupted', code: 'server-restarted' }
			);
			if (failed) await this.restorePlanState(failed);
		}
		for (const relocation of this.store.listByStatus(['switched'])) {
			const last = relocation.audit.at(-1);
			if (last?.event === 'source-delete-started')
				this.store.appendAudit(relocation.id, {
					event: 'source-delete-failed',
					code: 'server-restarted',
				});
		}
	}

	async shutdown() {
		this.stopped = true;
		for (const controller of this.controllers) controller.abort();
		await Promise.allSettled([
			this.running?.done,
			...[...this.operations.values()].map(operation => operation.done),
		]);
	}

	/** True while a copy job for the plan is running in this process (used by tests). */
	async idle() {
		await Promise.allSettled([
			this.running?.done,
			...[...this.operations.values()].map(operation => operation.done),
		]);
	}

	private launch(id: string) {
		const controller = new AbortController();
		this.controllers.add(controller);
		const done = this.execute(id, controller.signal).finally(() => {
			this.controllers.delete(controller);
			if (this.running?.id === id) this.running = undefined;
		});
		this.running = { id, controller, done };
	}

	private async execute(id: string, signal: AbortSignal) {
		const relocation = this.store.get(id)!;
		const progress: RelocationProgress = {};
		const phase = (name: string, status: 'copying' | 'verifying' = 'copying') => {
			if (!this.store.transition(id, [status], { phase: name })) throw new RelocationError('cancelled');
		};
		try {
			await this.session(relocation, signal, async transfer => {
				phase('source-inventory');
				const source = await transfer.inventory('source');
				if (!source) throw new RelocationError('source-missing');
				progress.totalFiles = source.fileCount;
				progress.totalBytes = source.totalBytes;
				this.store.recordProgress(id, progress);
				phase('destination-inventory');
				const existing = await transfer.inventory('destination', {
					allowPartial: true,
					requireRepository: false,
				});
				if (existing && (existing.fileCount || existing.partial.length)) {
					// Only an earlier attempt of this same repository may have left files here,
					// and only a subset of the source. Its Rclone temporaries are removed.
					if (
						!this.reusableDestination(relocation) ||
						!isSubsetOf(existing.entries, source.entries)
					)
						throw new RelocationError('destination-not-empty');
					if (existing.partial.length) await transfer.removeDestinationPartials();
					this.store.appendAudit(id, { event: 'destination-reused' });
				}
				phase('copying');
				await transfer.copy(copy => {
					Object.assign(progress, copy);
					this.store.recordProgress(id, progress);
				});
				if (
					!this.store.transition(
						id,
						['copying'],
						{ status: 'verifying', phase: 'listing-verification' },
						{ event: 'copy-completed' }
					)
				)
					throw new RelocationError('cancelled');
				const unchanged = await transfer.inventory('source');
				if (!unchanged || unchanged.digest !== source.digest)
					throw new RelocationError('source-changed');
				const copied = await transfer.inventory('destination');
				if (!copied || copied.digest !== source.digest)
					throw new RelocationError('destination-listing-mismatch');
				phase('hash-verification', 'verifying');
				const configSha256 = await transfer.sha256('source', 'config');
				await transfer.verifyDestinationHashes(copied, configSha256, verifiedFiles => {
					progress.verifiedFiles = verifiedFiles;
					this.store.recordProgress(id, progress);
				});
				phase('repository-verification', 'verifying');
				const repositoryConfigId = await transfer.repositoryId('source');
				if ((await transfer.repositoryId('destination')) !== repositoryConfigId)
					throw new RelocationError('repository-identity-mismatch');
				const sourceSnapshots = new Set(await transfer.snapshotIds('source'));
				const destinationSnapshots = new Set(await transfer.snapshotIds('destination'));
				if (
					sourceSnapshots.size !== destinationSnapshots.size ||
					[...sourceSnapshots].some(snapshot => !destinationSnapshots.has(snapshot))
				)
					throw new RelocationError('snapshot-set-mismatch');
				if (
					this.store
						.completedSnapshotIds(relocation)
						.some(snapshot => !destinationSnapshots.has(snapshot))
				)
					throw new RelocationError('snapshot-missing');
				phase('restic-check', 'verifying');
				await transfer.checkDestination();
				const evidence: RelocationEvidence = {
					repositoryConfigId,
					fileCount: source.fileCount,
					totalBytes: source.totalBytes,
					listingDigest: source.digest,
					snapshotCount: destinationSnapshots.size,
				};
				if (
					!this.store.transition(
						id,
						['verifying'],
						{ status: 'ready', phase: 'ready', evidence, verifiedAt: Date.now() },
						{ event: 'verified' }
					)
				)
					throw new RelocationError('cancelled');
			});
			this.log('relocation_verified', this.store.get(id)!);
		} catch (error) {
			const code = signal.aborted ? 'cancelled' : failureCode(error);
			const failedPhase = this.store.get(id)?.phase;
			const failed = this.store.transition(
				id,
				['copying', 'verifying'],
				{ status: 'failed', phase: 'failed', failureCode: code },
				{ event: 'failed', code, ...(failedPhase ? { phase: failedPhase } : {}) }
			);
			if (failed) {
				await this.restorePlanState(failed);
				this.log('relocation_failed', failed);
			}
		}
	}

	private reusableDestination(relocation: PlanRepositoryRelocation) {
		return this.store
			.listForPlan(relocation.planId, 100)
			.some(
				other =>
					other.id !== relocation.id &&
					other.repositoryId === relocation.repositoryId &&
					['failed', 'cancelled', 'reverted'].includes(other.status) &&
					other.destination.storageId === relocation.destination.storageId &&
					other.destination.storagePath === relocation.destination.storagePath
			);
	}

	private async assertDestinationAvailable(repositoryId: string, storageId: string, storagePath: string) {
		for (const reference of await this.plans.getStorageRemovalReferences())
			if (
				!reference.relocationId &&
				reference.storageId === storageId &&
				locationsOverlap(reference.storagePath, storagePath)
			)
				throw new AppError(
					409,
					'The destination overlaps a repository, mirror or retained copy already stored there.'
				);
		for (const location of this.store.retainedLocations()) {
			if (location.storageId !== storageId || !locationsOverlap(location.storagePath, storagePath))
				continue;
			const retry =
				location.role === 'relocation-destination' &&
				location.repositoryId === repositoryId &&
				location.storagePath === storagePath;
			if (!retry)
				throw new AppError(
					409,
					'The destination overlaps a copy kept by another repository relocation.'
				);
		}
	}

	private async assertPreviousLocationRemovable(relocation: PlanRepositoryRelocation) {
		const previous = relocation.source;
		validateRelocationPath(previous.storagePath);
		for (const reference of await this.plans.getStorageRemovalReferences())
			if (
				!reference.relocationId &&
				reference.storageId === previous.storageId &&
				locationsOverlap(reference.storagePath, previous.storagePath)
			)
				throw new AppError(
					409,
					'The previous location overlaps a live repository, mirror or retained copy. Delete it manually after review.'
				);
		for (const location of this.store.retainedLocations())
			if (
				location.relocationId !== relocation.id &&
				location.storageId === previous.storageId &&
				locationsOverlap(location.storagePath, previous.storagePath)
			)
				throw new AppError(
					409,
					'The previous location overlaps a copy kept by another repository relocation.'
				);
	}

	private requireIdleOperation(id: string) {
		const relocation = this.store.get(id);
		if (!relocation) throw new NotFoundError('Repository relocation not found.');
		if (this.stopped) throw new AppError(503, 'The server is shutting down.');
		if (this.running?.id === id || this.operations.has(id))
			throw new AppError(409, 'Another operation on this relocation is running.');
		for (const [otherId] of this.operations) {
			const other = this.store.get(otherId);
			if (other?.planId === relocation.planId)
				throw new AppError(409, 'Another relocation operation of this plan is running.');
		}
		return relocation;
	}

	/** Runs switch/revert/delete in the background: a large listing outlives proxy timeouts. */
	private background(
		id: string,
		kind: RelocationOperation,
		work: (signal: AbortSignal) => Promise<void>
	) {
		const controller = new AbortController();
		this.controllers.add(controller);
		const operation = kind === 'deleting-source' ? 'source-delete' : kind === 'switching' ? 'switch' : 'revert';
		const done = work(controller.signal)
			.catch(error => {
				const code = controller.signal.aborted ? 'cancelled' : failureCode(error);
				this.store.appendAudit(id, { event: `${operation}-failed`, code });
				this.log(`relocation_${operation.replace('-', '_')}_failed`, this.store.get(id)!, code);
			})
			.finally(() => {
				this.controllers.delete(controller);
				this.operations.delete(id);
			});
		this.operations.set(id, { kind, done });
	}

	private async session<T>(
		relocation: PlanRepositoryRelocation,
		signal: AbortSignal,
		consume: (session: RepositoryTransferSession) => Promise<T>
	) {
		const repository = await this.repositories.getByPlanId(relocation.planId);
		if (!repository || repository.id !== relocation.repositoryId)
			throw new RelocationError('configuration-invalid');
		let password: string;
		let source: SftpEndpoint;
		let destination: SftpEndpoint;
		try {
			password = new Cryptr(this.secret).decrypt(repository.encryptedPassword);
			source = {
				options: await this.access.getSftpRecoveryOptions(relocation.source.storageId),
				path: relocation.source.storagePath,
			};
			destination = {
				options: await this.access.getSftpRecoveryOptions(relocation.destination.storageId),
				path: relocation.destination.storagePath,
			};
		} catch {
			throw new RelocationError('configuration-invalid');
		}
		return this.transfer.withSession({ source, destination, password }, consume, signal);
	}

	private async restorePlanState(relocation: PlanRepositoryRelocation) {
		if (!relocation.planWasActive) return;
		try {
			await this.planState.resume(relocation.planId);
			this.store.appendAudit(relocation.id, { event: 'plan-resumed' });
		} catch {
			this.store.appendAudit(relocation.id, { event: 'resume-failed', code: 'execution-failed' });
		}
	}

	private async view(relocation: PlanRepositoryRelocation): Promise<RelocationView> {
		const name = async (storageId: string) => {
			try {
				return (await this.storages.getById(storageId))?.name || undefined;
			} catch {
				return undefined;
			}
		};
		const operation = this.operations.get(relocation.id)?.kind;
		const busy = !!operation || this.running?.id === relocation.id;
		const newBackup =
			relocation.status === 'switched' && this.store.hasSuccessfulBackupSinceSwitch(relocation);
		const failure = [...relocation.audit]
			.reverse()
			.find(event => /-(?:failed|refused)$/.test(event.event) && event.event !== 'failed');
		const settled = relocation.audit.at(-1);
		return {
			...relocation,
			source: { ...relocation.source, storageName: await name(relocation.source.storageId) },
			destination: {
				...relocation.destination,
				storageName: await name(relocation.destination.storageId),
			},
			operation,
			lastOperationFailure:
				failure && failure === settled
					? { operation: failure.event.replace(/-failed$/, ''), code: failure.code || 'execution-failed', at: failure.at }
					: undefined,
			actions: {
				cancel: !operation && ['copying', 'verifying', 'ready'].includes(relocation.status),
				switch: !busy && relocation.status === 'ready',
				revert: !busy && relocation.status === 'switched' && !newBackup,
				deleteSource: !busy && relocation.status === 'switched' && newBackup,
			},
		};
	}

	private log(event: string, relocation: PlanRepositoryRelocation, code?: string) {
		try {
			planLogger('relocation', relocation.planId).info(
				{
					event,
					relocationId: relocation.id,
					status: relocation.status,
					phase: relocation.phase,
					...(code || relocation.failureCode ? { code: code || relocation.failureCode } : {}),
				},
				'Plan repository relocation.'
			);
		} catch {
			/* Telemetry cannot fail the relocation. */
		}
	}
}
