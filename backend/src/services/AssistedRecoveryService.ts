import crypto from 'crypto';
import path from 'path';
import {
	AssistedRecoveryStore,
	type AssistedPayload,
	type AssistedJob,
} from '../stores/AssistedRecoveryStore';
import type { PlanStore } from '../stores/PlanStore';
import {
	VerifiedReplicaRecoveryService,
	ReplicaRecoveryError,
} from './VerifiedReplicaRecoveryService';
import { RemoteRepositoryRecoveryService } from './RemoteRepositoryRecoveryService';
import { ManagedRepositoryAccessError } from '../utils/restic/ManagedSftpRepositorySession';
import { SnapshotIndexError } from '../utils/restic/ManagedSnapshotIndex';
import { RecoveryTestError } from '../utils/recoveryValidation';
import { RecoveryWorkspace } from '../utils/recoveryWorkspace';
import { SnapshotComparisonError } from '../utils/restic/SnapshotComparisonPolicy';
import { AppError } from '../utils/AppError';
import { managedSnapshotPath } from '../utils/managedSnapshotPath';

export function assistedFailure(error: unknown): string {
	if (
		error instanceof ManagedRepositoryAccessError ||
		error instanceof ReplicaRecoveryError ||
		error instanceof RecoveryTestError
	)
		return error.code;
	if (error instanceof SnapshotComparisonError) return error.diagnostic;
	if (error instanceof SnapshotIndexError)
		return error.reason === 'timeout' ? 'timeout' : error.code;
	if (error instanceof AppError && [401, 403].includes(error.statusCode))
		return 'authorization-denied';
	return 'unclassified-failure';
}
export class AssistedRecoveryService {
	private readonly work = new Map<string, { controller: AbortController; done: Promise<void> }>();
	private readonly workspace: RecoveryWorkspace;
	constructor(
		private readonly store: AssistedRecoveryStore,
		private readonly plans: Pick<PlanStore, 'getById'>,
		private readonly primary: Pick<
			RemoteRepositoryRecoveryService,
			'testBinding' | 'primaryAvailability'
		>,
		private readonly replicas: Pick<
			VerifiedReplicaRecoveryService,
			'preflight' | 'withReplica' | 'cleanup'
		>,
		root: string,
		private readonly now = () => Date.now()
	) {
		this.workspace = new RecoveryWorkspace(root);
		store.reconcile();
	}
	private async policy(planId: string) {
		const plan = await this.plans.getById(planId);
		if (
			!plan ||
			plan.sourceType !== 'device' ||
			plan.sourceId === 'main' ||
			plan.method !== 'backup' ||
			!plan.settings.replication?.enabled ||
			plan.settings.replication.recoveryPolicy !== 'assisted' ||
			!plan.settings.replication.storages.length ||
			plan.settings.replication.storages.length > 2
		)
			throw new AppError(
				409,
				'This plan uses Primary Only. Enable Assisted Failover with compatible replicas first.'
			);
		return plan;
	}
	private owned(owner: string, id: string) {
		const row = this.store.get(id);
		if (!row || row.owner !== owner) throw new AppError(404, 'Recovery job not found.');
		return row;
	}
	private view(row: AssistedJob) {
		return {
			id: row.id,
			planId: row.planId,
			planName: row.payload.planName || row.planId,
			backupId: row.backupId,
			status: row.status,
			phase: row.phase,
			createdAt: row.createdAt,
			expiresAt: row.expiresAt,
			expired: row.expiresAt <= this.now(),
			sourceSnapshotId: row.payload.sourceSnapshotId,
			primary: row.payload.primary,
			candidates: row.payload.candidates.map(c => ({
				replicationId: c.replicationId,
				position: c.position,
				state: c.state,
				code: c.code,
				destinationSnapshotId: c.binding?.destinationSnapshotId,
				replicaVerified: c.state === 'passed',
				recoveryPreflight: c.state === 'passed' ? 'passed' : 'failed',
				recoveryTested:
					row.audit.some(event => event.event === 'staged-recovery-verified') &&
					row.payload.selected === c.replicationId,
			})),
			selected: row.payload.selected,
			target: 'Isolated Pluton staging',
			operation: 'File/directory/SQL artifact staging (no database import)',
			includes: row.payload.includes,
			excludes: row.payload.excludes,
			cleanupPending: row.cleanupPending,
			failureCode: row.failureCode,
			stats: row.stats,
			audit: row.audit,
		};
	}
	list(owner: string, planId: string, backupId: string) {
		return this.store.list(owner, planId, backupId).map(row => this.view(row));
	}
	get(owner: string, id: string) {
		return this.view(this.owned(owner, id));
	}
	async start(
		owner: string,
		input: {
			planId: string;
			backupId: string;
			requestKey: string;
			mode: 'prefer-primary' | 'manual-replica';
			includes: string[];
			excludes: string[];
		}
	) {
		if (
			!['prefer-primary', 'manual-replica'].includes(input.mode) ||
			!/^[-a-zA-Z0-9]{36}$/.test(input.requestKey)
		)
			throw new AppError(400, 'Invalid recovery request identity.');
		const plan = await this.policy(input.planId);
		const binding = await this.primary.testBinding(input.backupId, input.planId); // SQLite only, primary may be offline
		for (const items of [input.includes, input.excludes]) {
			if (!Array.isArray(items) || items.length > 1024)
				throw new AppError(400, 'Invalid recovery selection.');
			for (const item of items) {
				managedSnapshotPath(item);
				if (!item.startsWith('/') || /[*?[\]]/.test(item))
					throw new AppError(400, 'Select exact snapshot paths.');
			}
		}
		const payload: AssistedPayload = {
			planName: plan.title || plan.id,
			mode: input.mode,
			sourceSnapshotId: binding.snapshotId,
			includes: [...new Set(input.includes)].sort(),
			excludes: [...new Set(input.excludes)].sort(),
			candidates: [],
		};
		const requestHash = crypto
			.createHash('sha256')
			.update(
				JSON.stringify({
					planId: input.planId,
					backupId: input.backupId,
					payload: { ...payload, planName: undefined },
				})
			)
			.digest('hex');
		const time = this.now();
		const created = this.store.create({
			id: crypto.randomBytes(12).toString('hex'),
			owner,
			planId: input.planId,
			backupId: input.backupId,
			requestKey: input.requestKey,
			requestHash,
			status: 'checking',
			phase: 'primary-check',
			payload,
			createdAt: time,
			updatedAt: time,
			expiresAt: time + 10 * 60_000,
			cleanupPending: true,
			audit: [{ at: time, event: 'recovery-requested' }],
		});
		if (created.created) this.launch(created.job.id, signal => this.check(created.job, signal));
		return this.view(created.job);
	}
	private launch(id: string, run: (signal: AbortSignal) => Promise<void>) {
		const controller = new AbortController();
		const done = Promise.resolve()
			.then(() => run(controller.signal))
			.finally(() => this.work.delete(id));
		this.work.set(id, { controller, done });
		void done.catch(() => {});
	}
	private async check(row: AssistedJob, signal: AbortSignal) {
		try {
			const plan = await this.policy(row.planId);
			let primary: NonNullable<AssistedJob['payload']['primary']> = { state: 'not-checked' };
			if (row.payload.mode === 'prefer-primary') {
				try {
					const proof = await this.primary.primaryAvailability(row.backupId, row.planId, signal);
					if (proof.snapshotId !== row.payload.sourceSnapshotId)
						throw new AppError(409, 'Snapshot changed.');
					primary = { state: 'ready' };
				} catch (error) {
					const code = assistedFailure(error);
					if (!['network-unavailable', 'timeout'].includes(code)) throw error;
					primary = { state: 'unavailable', code };
				}
				if (primary.state === 'ready') {
					if (!signal.aborted)
						this.store.update(
							row.id,
							['checking'],
							{
								status: 'primary-ready',
								phase: 'primary-ready',
								cleanupPending: false,
								payload: { ...row.payload, primary },
							},
							'primary-verified'
						);
					return;
				}
			}
			const payload: AssistedPayload = { ...row.payload, primary };
			this.store.update(
				row.id,
				['checking'],
				{ phase: 'replica-check', payload },
				primary.state === 'unavailable' ? 'primary-unavailable' : 'manual-replica-requested'
			);
			for (const [position, replica] of plan.settings.replication!.storages.entries()) {
				if (signal.aborted) throw new ManagedRepositoryAccessError('cancelled');
				try {
					const binding = await this.replicas.preflight(
						row.backupId,
						row.planId,
						replica.replicationId,
						AbortSignal.any([signal, AbortSignal.timeout(3 * 60_000)]),
						row.id
					);
					if (binding.sourceSnapshotId !== row.payload.sourceSnapshotId)
						throw new ReplicaRecoveryError('source-binding-invalid');
					payload.candidates.push({
						replicationId: replica.replicationId,
						position: position + 1,
						state: 'passed',
						binding,
					});
				} catch (error) {
					payload.candidates.push({
						replicationId: replica.replicationId,
						position: position + 1,
						state: 'failed',
						code: assistedFailure(error),
					});
				}
				if (signal.aborted) throw new ManagedRepositoryAccessError('cancelled');
				this.store.update(row.id, ['checking'], { payload }, 'replica-eligibility-checked');
			}
			await this.policy(row.planId);
			await this.replicas.cleanup(row.id);
			const eligible = payload.candidates.some(c => c.state === 'passed');
			this.store.update(
				row.id,
				['checking'],
				{
					status: eligible ? 'awaiting-approval' : 'failed',
					phase: eligible ? 'awaiting-approval' : 'no-eligible-replica',
					cleanupPending: false,
					payload,
					...(eligible ? {} : { failureCode: 'no-eligible-replica' }),
				},
				eligible ? 'approval-required' : 'recovery-refused'
			);
		} catch (error) {
			let cleanupPending = false;
			try {
				await this.replicas.cleanup(row.id);
			} catch {
				cleanupPending = true;
			}
			if (this.store.get(row.id)?.status === 'checking')
				this.store.update(
					row.id,
					['checking'],
					{
						status: signal.aborted ? 'cancelled' : 'failed',
						phase: 'check-failed',
						cleanupPending,
						failureCode: signal.aborted ? 'cancelled' : assistedFailure(error),
					},
					'check-failed'
				);
		}
	}
	async approve(owner: string, id: string, replicationId: string) {
		const row = this.owned(owner, id);
		await this.policy(row.planId);
		const approved = this.store.approve(id, owner, replicationId, this.now());
		this.launch(id, signal => this.execute(approved, signal));
		return this.view(approved);
	}
	private async execute(row: AssistedJob, signal: AbortSignal) {
		const candidate = row.payload.candidates.find(c => c.replicationId === row.payload.selected)!;
		try {
			await this.policy(row.planId);
			await this.replicas.withReplica(
				row.backupId,
				row.planId,
				candidate.replicationId,
				signal,
				async recovery => {
					// Approval has already been consumed durably. Revalidate identity before creating staging.
					const binding = await recovery.testBinding(row.backupId, row.planId);
					if (binding.snapshotId !== candidate.binding!.destinationSnapshotId)
						throw new ReplicaRecoveryError('approval-binding-changed');
					const workspace = await this.workspace.create(row.id),
						target = path.join(workspace, 'files');
					this.store.update(
						row.id,
						['running'],
						{ phase: 'staging-preparation' },
						'recovery-source-approved'
					);
					const result = await recovery.replicaStage(
						binding,
						{
							target: '',
							overwrite: 'never',
							delete: false,
							includes: row.payload.includes,
							excludes: row.payload.excludes,
						},
						target,
						signal,
						phase => {
							this.store.update(row.id, ['running'], { phase });
						},
						async () => {
							await this.policy(row.planId);
							await this.workspace.assert(row.id);
						}
					);
					if (signal.aborted) throw new ManagedRepositoryAccessError('cancelled');
					await this.policy(row.planId);
					this.store.update(
						row.id,
						['running'],
						{
							status: 'completed',
							phase: 'integrity-verified',
							cleanupPending: false,
							stats: { files: result.stats.total_files, bytes: result.stats.total_bytes },
						},
						'staged-recovery-verified'
					);
				},
				candidate.binding!.fingerprint,
				row.id
			);
		} catch (error) {
			let cleanupPending = false;
			try {
				await this.workspace.remove(row.id);
				await this.replicas.cleanup(row.id);
			} catch {
				cleanupPending = true;
			}
			const current = this.store.get(row.id);
			if (current?.status === 'running')
				this.store.update(
					row.id,
					['running'],
					{
						status: signal.aborted ? 'cancelled' : 'failed',
						phase: 'recovery-stopped',
						failureCode: signal.aborted ? 'cancelled' : assistedFailure(error),
						cleanupPending,
					},
					'staged-recovery-failed'
				);
		}
	}
	async cancel(owner: string, id: string) {
		const row = this.owned(owner, id),
			active = this.work.get(id);
		if (active) {
			active.controller.abort();
			await active.done;
		}
		const current = this.owned(owner, id);
		// Only the exact app-owned workspace is removed. No repository cleanup commands.
		let cleanupPending = false;
		try {
			await this.workspace.remove(id);
			await this.replicas.cleanup(id);
		} catch {
			cleanupPending = true;
		}
		return this.view(
			this.store.update(
				id,
				[current.status],
				{
					status: 'cancelled',
					phase: cleanupPending ? 'staging-cleanup-pending' : 'cancelled',
					cleanupPending,
				},
				'operator-cancelled'
			)
		);
	}
	async shutdown() {
		for (const job of this.work.values()) job.controller.abort();
		await Promise.allSettled([...this.work.values()].map(job => job.done));
	}
	async settled(id: string) {
		await this.work.get(id)?.done;
	}
}
