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
};
export type AssistedCandidate = {
	replicationId: string;
	position: number;
	state: 'passed' | 'failed';
	code?: string;
	diagnostic?: AssistedRecoveryDiagnostic;
	binding?: ReplicaRecoveryBinding;
};
export type AssistedPayload = {
	planName?: string;
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
	activity?: ArchiveActivity;
	diagnostic?: AssistedRecoveryDiagnostic;
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
		event?: string
	): AssistedJob {
		return this.db
			.transaction(() => {
				const row = this.get(id);
				if (!row || !from.includes(row.status)) throw conflict();
				const next = { ...row, ...patch, updatedAt: Date.now() };
				if (event)
					next.audit = [
						...row.audit,
						{
							at: next.updatedAt,
							event,
							...(patch.failureCode ? { code: patch.failureCode } : {}),
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
				return this.update(
					id,
					['awaiting-approval'],
					{
						status: 'running',
						phase: 'approval-revalidation',
						payload: { ...row.payload, selected: replicationId },
						cleanupPending: true,
					},
					'operator-approved'
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
