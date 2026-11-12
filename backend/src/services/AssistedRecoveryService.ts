import crypto from 'crypto';
import path from 'path';
import { planLogger } from '../utils/logger';
import {
	AssistedRecoveryStore,
	ASSISTED_TIMED_PHASES,
	type AssistedPhaseTimings,
	type AssistedPayload,
	type AssistedJob,
	type AssistedRecoveryDiagnostic,
} from '../stores/AssistedRecoveryStore';
import type { PlanStore } from '../stores/PlanStore';
import {
	VerifiedReplicaRecoveryService,
	ReplicaRecoveryError,
} from './VerifiedReplicaRecoveryService';
import { RemoteRepositoryRecoveryService } from './RemoteRepositoryRecoveryService';
import {
	ManagedRepositoryAccessError,
	type ArchiveActivity,
} from '../utils/restic/ManagedSftpRepositorySession';
import { ManagedExportError } from '../utils/restic/ManagedExportPolicy';
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
	if (error instanceof ManagedExportError) return error.reason;
	if (error instanceof SnapshotIndexError)
		return error.reason === 'timeout' ? 'timeout' : error.code;
	if (error instanceof AppError && [401, 403].includes(error.statusCode))
		return 'authorization-denied';
	return 'unclassified-failure';
}
const elapsedMs = (duration: number) =>
	Math.min(24 * 60 * 60_000, Math.max(0, Math.round(duration)));
/** Failures that mean "this source could not be read", never "this source is wrong". */
const AUTOMATIC_RETRY_FAILURES = new Set(['network-unavailable', 'timeout']);
/** Source decisions go to the existing restore log with closed fields only. */
function logSourceDecision(
	job: AssistedJob,
	event: 'automatic-source-selected' | 'automatic-failover-next-replica' | 'automatic-failover-blocked',
	fields: { position?: number; code?: string }
) {
	try {
		planLogger('restore', job.planId, job.backupId).info(
			{ event: `assisted_recovery_${event.replace(/-/g, '_')}`, jobId: job.id, ...fields },
			'Assisted recovery source decision.'
		);
	} catch {
		/* Logging never changes a recovery decision. */
	}
}

function recoveryDiagnostic(
	error: unknown,
	phase: string,
	began: number,
	failureCode = assistedFailure(error),
	preflightDeadline = false
): AssistedRecoveryDiagnostic {
	const native =
		error instanceof ManagedRepositoryAccessError || error instanceof SnapshotIndexError
			? error.diagnostic
			: undefined;
	let timeoutCategory: AssistedRecoveryDiagnostic['timeoutCategory'] = native?.timeoutCategory;
	if (timeoutCategory === 'caller-deadline' || (preflightDeadline && !timeoutCategory)) {
		if (phase === 'primary-check') timeoutCategory = 'primary-check-deadline';
		if (phase === 'replica-check') timeoutCategory = 'replica-preflight-deadline';
	}
	const duration = native?.elapsedMs;
	const archive = native?.archive;
	const io = archive?.nativeIo;
	const counters = (value?: NonNullable<typeof io>['restic']) =>
		value && {
			readBytes: value.readBytes,
			writtenBytes: value.writtenBytes,
			cpuTicks: value.cpuTicks,
		};
	const retries = archive?.backendRetries;
	return {
		phase,
		operation: native?.operation ?? 'recovery-phase',
		elapsedMs: elapsedMs(
			typeof duration === 'number' && Number.isFinite(duration)
				? duration
				: performance.now() - began
		),
		archive: archive && {
			firstByteMs: archive.firstByteMs,
			bytesReceived: archive.bytesReceived,
			lastOutputAgeMs: archive.lastOutputAgeMs,
			consumerPending: archive.consumerPending,
			consumerPendingMs: archive.consumerPendingMs,
			consumerBackpressured: archive.consumerBackpressured,
			stdoutEnded: archive.stdoutEnded,
			processAtStop: archive.processAtStop,
			completion: archive.completion,
			nativeIo: io && {
				windowMs: io.windowMs,
				sampleAgeMs: io.sampleAgeMs,
				restic: counters(io.restic),
				rclone: counters(io.rclone),
			},
			backendRetries: retries && {
				retryCount: retries.retryCount,
				gaveUpCount: retries.gaveUpCount,
				recoveredCount: retries.recoveredCount,
				serverErrorCount: retries.serverErrorCount,
				errorClasses: { ...retries.errorClasses },
				loads: retries.loads.map(load => ({
					objectType: load.objectType,
					packPrefix: load.packPrefix,
					length: load.length,
					offset: load.offset,
					attempts: load.attempts,
					lastErrorClass: load.lastErrorClass,
					httpStatus: load.httpStatus,
				})),
				lastRetryAfterMs: retries.lastRetryAfterMs,
				lastServedBytes: retries.lastServedBytes,
				lastExpectedBytes: retries.lastExpectedBytes,
				truncated: retries.truncated,
			},
		},
		timeoutCategory: timeoutCategory ?? (failureCode === 'timeout' ? 'undetermined' : undefined),
		failureCode,
	};
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
		const recoveryPolicy = plan?.settings.replication?.recoveryPolicy;
		if (
			!plan ||
			plan.sourceType !== 'device' ||
			plan.sourceId === 'main' ||
			plan.method !== 'backup' ||
			!plan.settings.replication?.enabled ||
			(recoveryPolicy !== 'assisted' && recoveryPolicy !== 'automatic') ||
			!plan.settings.replication.storages.length ||
			plan.settings.replication.storages.length > 2
		)
			throw new AppError(
				409,
				'This plan uses Primary Only. Enable Assisted Failover with compatible replicas first.'
			);
		return { plan, recoveryPolicy };
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
			activeSince:
				row.status === 'checking'
					? row.createdAt
					: row.status === 'running'
						? row.audit.find(
								event =>
									event.event === 'operator-approved' || event.event === 'automatic-source-selected'
							)?.at
						: undefined,
			policy: row.payload.policy ?? 'assisted',
			sourceSelection: row.payload.selection && {
				mode: row.payload.selection.mode,
				reason: row.payload.selection.reason,
				attempts: row.payload.selection.attempts.map(attempt => ({
					replicationId: attempt.replicationId,
					position: attempt.position,
					outcome: attempt.outcome,
					code: attempt.code,
					at: attempt.at,
				})),
			},
			activity: row.status === 'running' ? row.payload.activity : undefined,
			diagnostic: row.payload.diagnostic,
			phaseTimingsMs: row.payload.phaseTimingsMs,
			expiresAt: row.expiresAt,
			expired: row.expiresAt <= this.now(),
			sourceSnapshotId: row.payload.sourceSnapshotId,
			primary: row.payload.primary,
			candidates: row.payload.candidates.map(c => ({
				replicationId: c.replicationId,
				position: c.position,
				state: c.state,
				code: c.code,
				diagnostic: c.diagnostic,
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
		const { plan, recoveryPolicy } = await this.policy(input.planId);
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
			policy: recoveryPolicy,
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
			phase: input.mode === 'manual-replica' ? 'replica-check' : 'primary-check',
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
		let phaseBegan = performance.now();
		let phase = row.phase;
		let payload = row.payload;
		try {
			const { plan } = await this.policy(row.planId);
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
					primary = {
						state: 'unavailable',
						code,
						diagnostic: recoveryDiagnostic(error, 'primary-check', phaseBegan, code),
					};
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
			payload = { ...row.payload, primary };
			phase = 'replica-check';
			phaseBegan = performance.now();
			this.store.update(
				row.id,
				['checking'],
				{ phase: 'replica-check', payload },
				primary.state === 'unavailable' ? 'primary-unavailable' : 'manual-replica-requested',
				primary.code
			);
			for (const [position, replica] of plan.settings.replication!.storages.entries()) {
				if (signal.aborted) throw new ManagedRepositoryAccessError('cancelled');
				const began = performance.now();
				const deadline = AbortSignal.timeout(3 * 60_000);
				try {
					const binding = await this.replicas.preflight(
						row.backupId,
						row.planId,
						replica.replicationId,
						AbortSignal.any([signal, deadline]),
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
					const failure = assistedFailure(error);
					const expired = deadline.aborted && (failure === 'cancelled' || failure === 'timeout');
					const code = expired ? 'timeout' : failure;
					payload.candidates.push({
						replicationId: replica.replicationId,
						position: position + 1,
						state: 'failed',
						code,
						diagnostic: recoveryDiagnostic(error, 'replica-check', began, code, expired),
					});
				}
				if (signal.aborted) throw new ManagedRepositoryAccessError('cancelled');
				this.store.update(row.id, ['checking'], { payload }, 'replica-eligibility-checked');
			}
			const current = await this.policy(row.planId);
			await this.replicas.cleanup(row.id);
			const eligible = payload.candidates.some(c => c.state === 'passed');
			const first = payload.candidates.find(c => c.state === 'passed');
			// Automatic Failover: only after an eligible primary outage, only while the plan is still
			// Automatic, and only for a replica that passed every identity/integrity preflight.
			if (
				first &&
				primary.state === 'unavailable' &&
				primary.code &&
				row.payload.mode === 'prefer-primary' &&
				row.payload.policy === 'automatic' &&
				current.recoveryPolicy === 'automatic'
			) {
				let approved: AssistedJob;
				try {
					approved = this.store.autoApprove(row.id, first.replicationId, primary.code, this.now());
					logSourceDecision(approved, 'automatic-source-selected', {
						position: first.position,
						code: primary.code,
					});
				} catch {
					logSourceDecision(row, 'automatic-failover-blocked', { code: primary.code });
					this.store.update(
						row.id,
						['checking'],
						{
							status: 'failed',
							phase: 'automatic-failover-blocked',
							cleanupPending: false,
							payload,
							failureCode: 'automatic-failover-blocked',
						},
						'recovery-refused'
					);
					return;
				}
				await this.execute(approved, signal);
				return;
			}
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
			const diagnostic = recoveryDiagnostic(error, phase, phaseBegan);
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
						failureCode: signal.aborted ? 'cancelled' : diagnostic.failureCode,
						payload: { ...payload, diagnostic },
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
	private async execute(initial: AssistedJob, signal: AbortSignal) {
		let row = initial;
		let phase = row.phase;
		let phaseBegan = performance.now();
		const phaseTimingsMs: AssistedPhaseTimings = {};
		const recordPhase = (now = performance.now()) => {
			const known = ASSISTED_TIMED_PHASES.find(value => value === phase);
			if (known) phaseTimingsMs[known] = elapsedMs((phaseTimingsMs[known] ?? 0) + now - phaseBegan);
		};
		const stage = (value: string, activity?: ArchiveActivity, event?: string) => {
			if (phase !== value) {
				const now = performance.now();
				recordPhase(now);
				phaseBegan = now;
			}
			phase = value;
			this.store.update(
				row.id,
				['running'],
				{ phase, payload: { ...row.payload, activity } },
				event
			);
		};
		// Bounded by the number of verified candidates (at most two). Operator-approved jobs
		// make exactly one attempt; only Automatic Failover advances after a transport failure.
		for (;;) {
			const outcome = await this.attempt(row, signal, stage, recordPhase, phaseTimingsMs, () => ({
				phase,
				phaseBegan,
			}));
			if (outcome === 'done') return;
			row = outcome;
			phase = row.phase;
			phaseBegan = performance.now();
		}
	}
	/** One staged recovery from the selected replica. Returns 'done' on a terminal state, or the
	 * advanced job when Automatic Failover moved to the next verified replica. */
	private async attempt(
		row: AssistedJob,
		signal: AbortSignal,
		stage: (value: string, activity?: ArchiveActivity, event?: string) => void,
		recordPhase: (now?: number) => void,
		phaseTimingsMs: AssistedPhaseTimings,
		current: () => { phase: string; phaseBegan: number }
	): Promise<'done' | AssistedJob> {
		const candidate = row.payload.candidates.find(c => c.replicationId === row.payload.selected)!;
		try {
			await this.policy(row.planId);
			const result = await this.replicas.withReplica(
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
					stage('staging-preparation', undefined, 'recovery-source-approved');
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
						stage,
						async () => {
							await this.policy(row.planId);
							await this.workspace.assert(row.id);
						}
					);
					if (signal.aborted) throw new ManagedRepositoryAccessError('cancelled');
					stage('staging-cleanup');
					return result;
				},
				candidate.binding!.fingerprint,
				row.id
			);
			await this.policy(row.planId);
			if (signal.aborted) throw new ManagedRepositoryAccessError('cancelled');
			recordPhase();
			this.store.update(
				row.id,
				['running'],
				{
					status: 'completed',
					phase: 'integrity-verified',
					payload: { ...row.payload, phaseTimingsMs },
					cleanupPending: false,
					stats: { files: result.stats.total_files, bytes: result.stats.total_bytes },
				},
				'staged-recovery-verified'
			);
			return 'done';
		} catch (error) {
			const { phase, phaseBegan } = current();
			const diagnostic = recoveryDiagnostic(error, phase, phaseBegan);
			recordPhase();
			const cleanupStarted = performance.now();
			try {
				this.store.update(row.id, ['running'], { phase: 'staging-cleanup', payload: row.payload });
			} catch {
				// A failed status write cannot prevent cleanup of the owned workspace.
			}
			let cleanupPending = false;
			try {
				await this.workspace.remove(row.id);
				await this.replicas.cleanup(row.id);
			} catch {
				cleanupPending = true;
			}
			phaseTimingsMs['staging-cleanup'] = elapsedMs(
				(phaseTimingsMs['staging-cleanup'] ?? 0) + performance.now() - cleanupStarted
			);
			const failureCode = signal.aborted ? 'cancelled' : diagnostic.failureCode;
			// Automatic Failover may move on only after a transport-class failure, with this
			// replica's partial staging verifiably removed. Identity, integrity, authentication,
			// TLS and unknown failures stop the job; the next source never sees partial output.
			if (
				!signal.aborted &&
				!cleanupPending &&
				row.payload.selection?.mode === 'automatic' &&
				AUTOMATIC_RETRY_FAILURES.has(failureCode)
			) {
				try {
					const advanced = this.store.advanceAutomatic(row.id, failureCode, this.now());
					logSourceDecision(advanced, 'automatic-failover-next-replica', {
						position: advanced.payload.candidates.find(
							c => c.replicationId === advanced.payload.selected
						)?.position,
						code: failureCode,
					});
					return advanced;
				} catch {
					// No untried verified replica, or the job changed: fall through to a terminal failure.
				}
			}
			const selection = row.payload.selection && {
				...row.payload.selection,
				attempts: row.payload.selection.attempts.map(attempt =>
					attempt.replicationId === row.payload.selected && attempt.outcome === 'selected'
						? { ...attempt, outcome: 'failed' as const, code: failureCode }
						: attempt
				),
			};
			const latest = this.store.get(row.id);
			if (latest?.status === 'running')
				this.store.update(
					row.id,
					['running'],
					{
						status: signal.aborted ? 'cancelled' : 'failed',
						phase: 'recovery-stopped',
						failureCode,
						payload: {
							...row.payload,
							...(selection ? { selection } : {}),
							diagnostic,
							phaseTimingsMs,
						},
						cleanupPending,
					},
					'staged-recovery-failed'
				);
			return 'done';
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
