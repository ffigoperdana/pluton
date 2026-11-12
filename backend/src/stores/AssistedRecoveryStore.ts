import type Database from 'better-sqlite3';
import type { ReplicaRecoveryBinding } from '../services/VerifiedReplicaRecoveryService';
import { AppError } from '../utils/AppError';
import type {
	ArchiveActivity,
	RepositoryOperationDiagnostic,
} from '../utils/restic/ManagedSftpRepositorySession';
export type AssistedStatus =
	| 'checking'
	| 'awaiting-approval'
	| 'primary-ready'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'uncertain';
export const ASSISTED_TIMED_PHASES = [
	'approval-revalidation',
	'staging-preparation',
	'snapshot-indexing',
	'snapshot-validation',
	'integrity-preparation',
	'staged-restore',
	'filesystem-validation',
	'final-verification',
	'staging-cleanup',
] as const;
export type AssistedPhaseTimings = Partial<Record<(typeof ASSISTED_TIMED_PHASES)[number], number>>;

export type AssistedRecoveryDiagnostic = {
	phase: string;
	operation: RepositoryOperationDiagnostic['operation'] | 'recovery-phase';
	elapsedMs: number;
	timeoutCategory?:
		| RepositoryOperationDiagnostic['timeoutCategory']
		| 'primary-check-deadline'
		| 'replica-preflight-deadline'
		| 'undetermined';
	failureCode: string;
	archive?: RepositoryOperationDiagnostic['archive'];
};
export type AssistedCandidate = {
	replicationId: string;
	position: number;
	state: 'passed' | 'failed';
	code?: string;
	diagnostic?: AssistedRecoveryDiagnostic;
	binding?: ReplicaRecoveryBinding;
};
/** How the recovery source was chosen; automatic choices keep every attempt for audit. */
export type AssistedSourceSelection = {
	mode: 'operator' | 'automatic';
	/** Classified primary failure that allowed failover (automatic only). */
	reason?: string;
	attempts: {
		replicationId: string;
		position: number;
		outcome: 'selected' | 'failed';
		code?: string;
		at: number;
	}[];
};
export type AssistedPayload = {
	planName?: string;
	/** Plan recovery policy when the job was requested. */
	policy?: 'assisted' | 'automatic';
	mode: 'prefer-primary' | 'manual-replica';
	sourceSnapshotId: string;
	includes: string[];
	excludes: string[];
	primary?: {
		state: 'ready' | 'unavailable' | 'not-checked';
		code?: string;
		diagnostic?: AssistedRecoveryDiagnostic;
	};
	candidates: AssistedCandidate[];
	selected?: string;
	selection?: AssistedSourceSelection;
	activity?: ArchiveActivity;
	diagnostic?: AssistedRecoveryDiagnostic;
	phaseTimingsMs?: AssistedPhaseTimings;
};
export type AssistedJob = {
	id: string;
	owner: string;
	planId: string;
	backupId: string;
	requestKey: string;
	requestHash: string;
	status: AssistedStatus;
	phase: string;
	payload: AssistedPayload;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
	cleanupPending: boolean;
	failureCode?: string;
	stats?: { files: number; bytes: number };
	audit: { at: number; event: string; code?: string }[];
};
const decode = (row: any): AssistedJob | undefined =>
	row
		? {
				id: row.id,
				owner: row.owner,
				planId: row.plan_id,
				backupId: row.backup_id,
				requestKey: row.request_key,
				requestHash: row.request_hash,
				status: row.status,
				phase: row.phase,
				payload: JSON.parse(row.payload),
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				expiresAt: row.expires_at,
				cleanupPending: !!row.cleanup_pending,
				failureCode: row.failure_code || undefined,
				stats: row.stats ? JSON.parse(row.stats) : undefined,
				audit: JSON.parse(row.audit),
			}
		: undefined;
const conflict = () =>
	new AppError(
		409,
		'Recovery state changed, approval expired, or another recovery is active. Refresh and review.'
	);
/** Durable CAS before any staging side effect. Restart never replays execution. */
export class AssistedRecoveryStore {
	constructor(private readonly db: Database.Database) {}
	get(id: string) {
		return decode(this.db.prepare('SELECT * FROM assisted_recovery_jobs WHERE id=?').get(id));
	}
	list(owner: string, planId: string, backupId: string) {
		return this.db
			.prepare(
				'SELECT * FROM assisted_recovery_jobs WHERE owner=? AND plan_id=? AND backup_id=? ORDER BY created_at DESC,id LIMIT 20'
			)
			.all(owner, planId, backupId)
			.map(row => decode(row)!);
	}
	create(job: AssistedJob): { job: AssistedJob; created: boolean } {
		return this.db
			.transaction(() => {
				const old = decode(
					this.db
						.prepare('SELECT * FROM assisted_recovery_jobs WHERE owner=? AND request_key=?')
						.get(job.owner, job.requestKey)
				);
				if (old) {
					if (old.requestHash !== job.requestHash) throw conflict();
					return { job: old, created: false };
				}
				const active = decode(
					this.db
						.prepare(
							"SELECT * FROM assisted_recovery_jobs WHERE plan_id=? AND (status IN ('checking','awaiting-approval','running') OR cleanup_pending=1) LIMIT 1"
						)
						.get(job.planId)
				);
				if (active) {
					if (active.owner === job.owner && active.requestHash === job.requestHash)
						return { job: active, created: false };
					throw conflict();
				}
				const count = this.db
					.prepare(
						"SELECT count(*) AS n FROM assisted_recovery_jobs WHERE status IN ('checking','running')"
					)
					.get() as { n: number };
				if (count.n >= 2)
					throw new AppError(429, 'Recovery capacity is busy. Retry after current checks finish.');
				this.db
					.prepare(
						'INSERT INTO assisted_recovery_jobs(id,owner,plan_id,backup_id,request_key,request_hash,status,phase,payload,created_at,updated_at,expires_at,cleanup_pending,audit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
					)
					.run(
						job.id,
						job.owner,
						job.planId,
						job.backupId,
						job.requestKey,
						job.requestHash,
						job.status,
						job.phase,
						JSON.stringify(job.payload),
						job.createdAt,
						job.updatedAt,
						job.expiresAt,
						job.cleanupPending ? 1 : 0,
						JSON.stringify(job.audit)
					);
				return { job, created: true };
			})
			.immediate();
	}
	update(
		id: string,
		from: AssistedStatus[],
		patch: Partial<
			Pick<AssistedJob, 'status' | 'phase' | 'payload' | 'cleanupPending' | 'failureCode' | 'stats'>
		>,
		event?: string,
		eventCode?: string
	): AssistedJob {
		return this.db
			.transaction(() => {
				const row = this.get(id);
				if (!row || !from.includes(row.status)) throw conflict();
				const next = { ...row, ...patch, updatedAt: Date.now() };
				const code = eventCode ?? patch.failureCode;
				if (event)
					next.audit = [
						...row.audit,
						{
							at: next.updatedAt,
							event,
							...(code ? { code } : {}),
						},
					].slice(-50);
				this.db
					.prepare(
						'UPDATE assisted_recovery_jobs SET status=?,phase=?,payload=?,updated_at=?,cleanup_pending=?,failure_code=?,stats=?,audit=? WHERE id=?'
					)
					.run(
						next.status,
						next.phase,
						JSON.stringify(next.payload),
						next.updatedAt,
						next.cleanupPending ? 1 : 0,
						next.failureCode || null,
						next.stats ? JSON.stringify(next.stats) : null,
						JSON.stringify(next.audit),
						id
					);
				return next;
			})
			.immediate();
	}
	approve(id: string, owner: string, replicationId: string, now = Date.now()) {
		return this.db
			.transaction(() => {
				const row = this.get(id);
				if (
					!row ||
					row.owner !== owner ||
					row.status !== 'awaiting-approval' ||
					row.expiresAt <= now ||
					!row.payload.candidates.some(
						c => c.replicationId === replicationId && c.state === 'passed' && c.binding
					)
				)
					throw conflict();
				if (
					this.db
						.prepare(
							"SELECT 1 FROM assisted_recovery_jobs WHERE status='running' OR (cleanup_pending=1 AND status IN ('uncertain','failed','cancelled'))"
						)
						.get()
				)
					throw conflict();
				const candidate = row.payload.candidates.find(c => c.replicationId === replicationId)!;
				return this.update(
					id,
					['awaiting-approval'],
					{
						status: 'running',
						phase: 'approval-revalidation',
						payload: {
							...row.payload,
							selected: replicationId,
							selection: {
								mode: 'operator',
								attempts: [
									{ replicationId, position: candidate.position, outcome: 'selected', at: now },
								],
							},
						},
						cleanupPending: true,
					},
					'operator-approved'
				);
			})
			.immediate();
	}
	/** Automatic Failover: the operator's explicit start authorizes exactly one source switch.
	 * Same CAS and capacity rules as operator approval, consumed once from 'checking'. */
	autoApprove(id: string, replicationId: string, reason: string, now = Date.now()) {
		return this.db
			.transaction(() => {
				const row = this.get(id);
				if (
					!row ||
					row.status !== 'checking' ||
					row.payload.mode !== 'prefer-primary' ||
					row.payload.policy !== 'automatic' ||
					row.payload.selection ||
					row.expiresAt <= now ||
					!row.payload.candidates.some(
						c => c.replicationId === replicationId && c.state === 'passed' && c.binding
					)
				)
					throw conflict();
				if (
					this.db
						.prepare(
							"SELECT 1 FROM assisted_recovery_jobs WHERE id<>? AND (status='running' OR (cleanup_pending=1 AND status IN ('uncertain','failed','cancelled')))"
						)
						.get(id)
				)
					throw conflict();
				const candidate = row.payload.candidates.find(c => c.replicationId === replicationId)!;
				return this.update(
					id,
					['checking'],
					{
						status: 'running',
						phase: 'approval-revalidation',
						payload: {
							...row.payload,
							selected: replicationId,
							selection: {
								mode: 'automatic',
								reason,
								attempts: [
									{ replicationId, position: candidate.position, outcome: 'selected', at: now },
								],
							},
						},
						cleanupPending: true,
					},
					'automatic-source-selected',
					reason
				);
			})
			.immediate();
	}
	/** Automatic Failover only: after a transport failure and a clean workspace, move to the
	 * next verified replica that has not been attempted. Never for operator-approved jobs. */
	advanceAutomatic(id: string, failedCode: string, now = Date.now()) {
		return this.db
			.transaction(() => {
				const row = this.get(id);
				const selection = row?.payload.selection;
				if (!row || row.status !== 'running' || selection?.mode !== 'automatic') throw conflict();
				const attempted = new Set(selection.attempts.map(attempt => attempt.replicationId));
				const next = row.payload.candidates.find(
					c => c.state === 'passed' && c.binding && !attempted.has(c.replicationId)
				);
				if (!next) throw conflict();
				const attempts = selection.attempts.map(attempt =>
					attempt.replicationId === row.payload.selected
						? { ...attempt, outcome: 'failed' as const, code: failedCode }
						: attempt
				);
				return this.update(
					id,
					['running'],
					{
						phase: 'approval-revalidation',
						payload: {
							...row.payload,
							activity: undefined,
							selected: next.replicationId,
							selection: {
								...selection,
								attempts: [
									...attempts,
									{
										replicationId: next.replicationId,
										position: next.position,
										outcome: 'selected',
										at: now,
									},
								],
							},
						},
					},
					'automatic-failover-next-replica',
					failedCode
				);
			})
			.immediate();
	}
	reconcile() {
		for (const raw of this.db
			.prepare("SELECT * FROM assisted_recovery_jobs WHERE status IN ('checking','running')")
			.all()) {
			const row = decode(raw)!;
			this.update(
				row.id,
				[row.status],
				{ status: 'uncertain', phase: 'interrupted', failureCode: 'restart-interrupted' },
				'restart-reconciliation'
			);
		}
	}
}
