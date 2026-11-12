import type Database from 'better-sqlite3';
import { AppError } from '../utils/AppError';

export type RelocationStatus =
	| 'copying'
	| 'verifying'
	| 'ready'
	| 'switched'
	| 'reverted'
	| 'failed'
	| 'cancelled'
	| 'source-deleted';
export const ACTIVE_RELOCATION_STATUSES: readonly RelocationStatus[] = [
	'copying',
	'verifying',
	'ready',
];
export type RelocationLocation = { storageId: string; storagePath: string };
/** Facts proven by verification. No path listing, credential or provider output is stored. */
export type RelocationEvidence = {
	repositoryConfigId: string;
	fileCount: number;
	totalBytes: number;
	listingDigest: string;
	snapshotCount: number;
};
/** Real counters from Rclone/verification only; never an estimated percentage. */
export type RelocationProgress = {
	totalFiles?: number;
	totalBytes?: number;
	copiedBytes?: number;
	/** Rclone's own totals for this run (files already present are not counted). */
	copyTotalBytes?: number;
	copiedFiles?: number;
	copyTotalFiles?: number;
	verifiedFiles?: number;
};
/** `phase` names where a failure happened; never provider text. */
export type RelocationAuditEvent = { at: number; event: string; code?: string; phase?: string };
export type PlanRepositoryRelocation = {
	id: string;
	planId: string;
	repositoryId: string;
	source: RelocationLocation;
	destination: RelocationLocation;
	status: RelocationStatus;
	phase: string;
	planWasActive: boolean;
	failureCode?: string;
	progress?: RelocationProgress;
	evidence?: RelocationEvidence;
	createdAt: number;
	updatedAt: number;
	verifiedAt?: number;
	switchedAt?: number;
	revertedAt?: number;
	sourceDeletedAt?: number;
	audit: RelocationAuditEvent[];
};
/** A location that must stay reserved for this repository (old copy or job-owned destination). */
export type RelocationRetainedLocation = RelocationLocation & {
	relocationId: string;
	planId: string;
	repositoryId: string;
	role: 'previous-location' | 'relocation-destination';
};

const decode = (row: any): PlanRepositoryRelocation | undefined =>
	row
		? {
				id: row.id,
				planId: row.plan_id,
				repositoryId: row.repository_id,
				source: { storageId: row.source_storage_id, storagePath: row.source_storage_path },
				destination: {
					storageId: row.destination_storage_id,
					storagePath: row.destination_storage_path,
				},
				status: row.status,
				phase: row.phase,
				planWasActive: row.plan_was_active === 1,
				failureCode: row.failure_code || undefined,
				progress: row.progress ? JSON.parse(row.progress) : undefined,
				evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				verifiedAt: row.verified_at ?? undefined,
				switchedAt: row.switched_at ?? undefined,
				revertedAt: row.reverted_at ?? undefined,
				sourceDeletedAt: row.source_deleted_at ?? undefined,
				audit: JSON.parse(row.audit),
			}
		: undefined;

const conflict = (message = 'Repository relocation state changed. Refresh and review.') =>
	new AppError(409, message);

/**
 * Durable CAS for plan repository relocation. Every binding change happens in
 * one immediate SQLite transaction together with the idle checks, so no backup,
 * replication or recovery can interleave with the rewrite.
 */
export class PlanRepositoryRelocationStore {
	constructor(private readonly db: Database.Database) {}

	get(id: string) {
		return decode(this.db.prepare('SELECT * FROM plan_repository_relocations WHERE id=?').get(id));
	}

	listForPlan(planId: string, limit = 10) {
		return this.db
			.prepare(
				'SELECT * FROM plan_repository_relocations WHERE plan_id=? ORDER BY created_at DESC,id DESC LIMIT ?'
			)
			.all(planId, limit)
			.map(row => decode(row)!);
	}

	listByStatus(statuses: readonly RelocationStatus[]) {
		return this.db
			.prepare(
				`SELECT * FROM plan_repository_relocations WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at,id`
			)
			.all(...statuses)
			.map(row => decode(row)!);
	}

	activeForPlan(planId: string) {
		return decode(
			this.db
				.prepare(
					"SELECT * FROM plan_repository_relocations WHERE plan_id=? AND status IN ('copying','verifying','ready') LIMIT 1"
				)
				.get(planId)
		);
	}

	hasActiveForStorage(storageId: string) {
		return !!this.db
			.prepare(
				"SELECT 1 FROM plan_repository_relocations WHERE (source_storage_id=? OR destination_storage_id=?) AND status IN ('copying','verifying','ready') LIMIT 1"
			)
			.get(storageId, storageId);
	}

	/**
	 * Locations that still hold (or may hold) bytes of a relocated repository:
	 * the previous location until its copy is deleted, and every job-owned
	 * destination that did not become the live location.
	 */
	retainedLocations(): RelocationRetainedLocation[] {
		const rows = this.db.prepare('SELECT * FROM plan_repository_relocations').all();
		const locations: RelocationRetainedLocation[] = [];
		for (const row of rows) {
			const relocation = decode(row)!;
			const base = {
				relocationId: relocation.id,
				planId: relocation.planId,
				repositoryId: relocation.repositoryId,
			};
			if (relocation.status === 'switched')
				locations.push({ ...base, ...relocation.source, role: 'previous-location' });
			else if (relocation.status !== 'source-deleted')
				locations.push({ ...base, ...relocation.destination, role: 'relocation-destination' });
		}
		return locations;
	}

	/** Snapshot IDs of successful backup records that live at the relocation source. */
	completedSnapshotIds(relocation: PlanRepositoryRelocation): string[] {
		return (
			this.db
				.prepare(
					"SELECT json_extract(completion_stats,'$.snapshot_id') AS id FROM backups WHERE plan_id=? AND storage_id=? AND storage_path=? AND status='completed' AND success=1 AND json_valid(completion_stats)"
				)
				.all(relocation.planId, relocation.source.storageId, relocation.source.storagePath) as {
				id: unknown;
			}[]
		)
			.map(row => row.id)
			.filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id));
	}

	/** Every reason a plan's repository is in use. Messages name the blocker, never data. */
	assertPlanIdle(planId: string) {
		const blocked = (query: string, ...params: unknown[]) =>
			!!this.db.prepare(query).get(...params);
		if (blocked('SELECT 1 FROM backups WHERE plan_id=? AND in_progress=1 LIMIT 1', planId))
			throw conflict('Wait for the running backup of this plan to finish.');
		if (blocked('SELECT 1 FROM restores WHERE plan_id=? AND in_progress=1 LIMIT 1', planId))
			throw conflict('Wait for the running restore of this plan to finish.');
		if (
			blocked(
				"SELECT 1 FROM managed_replication_jobs WHERE plan_id=? AND status IN ('pending','running','uncertain') LIMIT 1",
				planId
			)
		)
			throw conflict('Managed replication of this plan is pending, active or uncertain.');
		if (
			blocked(
				"SELECT 1 FROM recovery_tests WHERE plan_id=? AND status IN ('queued','running') LIMIT 1",
				planId
			) ||
			blocked(
				'SELECT 1 FROM internal_recovery_sessions s JOIN recovery_tests t ON t.id=s.test_id WHERE t.plan_id=? AND s.released_at IS NULL LIMIT 1',
				planId
			) ||
			blocked(
				'SELECT 1 FROM recovery_import_leases l JOIN recovery_tests t ON t.id=l.test_id WHERE t.plan_id=? LIMIT 1',
				planId
			)
		)
			throw conflict('A recovery test of this plan is active or awaiting cleanup.');
		if (
			blocked(
				"SELECT 1 FROM assisted_recovery_jobs WHERE plan_id=? AND (status IN ('checking','awaiting-approval','running') OR cleanup_pending=1) LIMIT 1",
				planId
			)
		)
			throw conflict('An Assisted Recovery of this plan is active or awaiting cleanup.');
		if (
			blocked(
				"SELECT 1 FROM persistent_database_restores WHERE plan_id=? AND status IN ('queued','importing','deleting') LIMIT 1",
				planId
			) ||
			blocked(
				'SELECT 1 FROM persistent_restore_import_leases l JOIN persistent_database_restores r ON r.id=l.restore_id WHERE r.plan_id=? LIMIT 1',
				planId
			)
		)
			throw conflict('A database restore from this plan is importing or cleaning up.');
	}

	create(relocation: PlanRepositoryRelocation): PlanRepositoryRelocation {
		return this.db
			.transaction(() => {
				const busy = this.db
					.prepare(
						"SELECT plan_id FROM plan_repository_relocations WHERE status IN ('copying','verifying','ready')"
					)
					.all() as { plan_id: string }[];
				if (busy.some(row => row.plan_id === relocation.planId))
					throw conflict('A repository relocation is already active for this plan.');
				if (
					this.db
						.prepare(
							"SELECT 1 FROM plan_repository_relocations WHERE status IN ('copying','verifying') LIMIT 1"
						)
						.get()
				)
					throw new AppError(
						429,
						'Another repository relocation is copying or verifying. Retry after it finishes.'
					);
				this.assertPlanIdle(relocation.planId);
				const binding = this.db
					.prepare(
						'SELECT 1 FROM plans p JOIN remote_managed_repositories r ON r.plan_id=p.id WHERE p.id=? AND r.id=? AND p.storage_id=? AND p.storage_path=? AND r.storage_id=p.storage_id AND r.storage_path=p.storage_path AND r.initialized_at IS NOT NULL'
					)
					.get(
						relocation.planId,
						relocation.repositoryId,
						relocation.source.storageId,
						relocation.source.storagePath
					);
				if (!binding) throw conflict('The plan repository binding changed. Refresh and review.');
				this.db
					.prepare(
						`INSERT INTO plan_repository_relocations(id,plan_id,repository_id,source_storage_id,source_storage_path,destination_storage_id,destination_storage_path,status,phase,plan_was_active,created_at,updated_at,audit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
					)
					.run(
						relocation.id,
						relocation.planId,
						relocation.repositoryId,
						relocation.source.storageId,
						relocation.source.storagePath,
						relocation.destination.storageId,
						relocation.destination.storagePath,
						relocation.status,
						relocation.phase,
						relocation.planWasActive ? 1 : 0,
						relocation.createdAt,
						relocation.updatedAt,
						JSON.stringify(relocation.audit)
					);
				return this.get(relocation.id)!;
			})
			.immediate();
	}

	/** Compare-and-set transition. Returns undefined when the row left `from` meanwhile. */
	transition(
		id: string,
		from: readonly RelocationStatus[],
		patch: Partial<
			Pick<
				PlanRepositoryRelocation,
				'status' | 'phase' | 'failureCode' | 'progress' | 'evidence' | 'verifiedAt'
			>
		>,
		event?: Omit<RelocationAuditEvent, 'at'>
	): PlanRepositoryRelocation | undefined {
		return this.db
			.transaction(() => {
				const current = this.get(id);
				if (!current || !from.includes(current.status)) return undefined;
				const next = { ...current, ...patch, updatedAt: Date.now() };
				const audit = event ? [...current.audit, { at: next.updatedAt, ...event }] : current.audit;
				this.db
					.prepare(
						'UPDATE plan_repository_relocations SET status=?,phase=?,failure_code=?,progress=?,evidence=?,verified_at=?,updated_at=?,audit=? WHERE id=? AND status=?'
					)
					.run(
						next.status,
						next.phase,
						next.failureCode ?? null,
						next.progress ? JSON.stringify(next.progress) : null,
						next.evidence ? JSON.stringify(next.evidence) : null,
						next.verifiedAt ?? null,
						next.updatedAt,
						JSON.stringify(audit.slice(-50)),
						id,
						current.status
					);
				return this.get(id);
			})
			.immediate();
	}

	/** Progress counters only while the job still runs; never resurrects a finished row. */
	recordProgress(id: string, progress: RelocationProgress) {
		this.db
			.prepare(
				"UPDATE plan_repository_relocations SET progress=?,updated_at=? WHERE id=? AND status IN ('copying','verifying')"
			)
			.run(JSON.stringify(progress), Date.now(), id);
	}

	/**
	 * The single binding rewrite. Plan, managed repository record, every backup
	 * row at the previous location and every replication receipt of the
	 * repository move together, or nothing moves.
	 */
	switchBinding(id: string): PlanRepositoryRelocation {
		return this.db
			.transaction(() => {
				const current = this.get(id);
				if (!current || current.status !== 'ready' || !current.evidence) throw conflict();
				this.assertPlanIdle(current.planId);
				this.rewrite(current, current.source, current.destination);
				const now = Date.now();
				const audit = [...current.audit, { at: now, event: 'switched' }].slice(-50);
				this.db
					.prepare(
						"UPDATE plan_repository_relocations SET status='switched',phase='switched',switched_at=?,updated_at=?,audit=? WHERE id=? AND status='ready'"
					)
					.run(now, now, JSON.stringify(audit), id);
				return this.get(id)!;
			})
			.immediate();
	}

	/** True when a successful backup that the switch did not move exists at the new location. */
	hasSuccessfulBackupSinceSwitch(relocation: PlanRepositoryRelocation) {
		if (!relocation.switchedAt) return false;
		return !!this.db
			.prepare(
				"SELECT 1 FROM backups b WHERE b.plan_id=? AND b.storage_id=? AND b.storage_path=? AND b.status='completed' AND b.success=1 AND coalesce(b.in_progress,0)=0 AND NOT EXISTS(SELECT 1 FROM plan_repository_relocation_backups m WHERE m.relocation_id=? AND m.backup_id=b.id) LIMIT 1"
			)
			.get(
				relocation.planId,
				relocation.destination.storageId,
				relocation.destination.storagePath,
				relocation.id
			);
	}

	/** Revert is only possible while the previous location still holds every snapshot. */
	revertBinding(id: string): PlanRepositoryRelocation {
		return this.db
			.transaction(() => {
				const current = this.get(id);
				if (!current || current.status !== 'switched' || !current.switchedAt) throw conflict();
				if (this.hasSuccessfulBackupSinceSwitch(current))
					throw conflict(
						'A successful backup already exists at the new location. Start a new relocation instead of reverting.'
					);
				this.assertPlanIdle(current.planId);
				this.rewrite(current, current.destination, current.source, true);
				const now = Date.now();
				const audit = [...current.audit, { at: now, event: 'reverted' }].slice(-50);
				this.db
					.prepare(
						"UPDATE plan_repository_relocations SET status='reverted',phase='reverted',reverted_at=?,updated_at=?,audit=? WHERE id=? AND status='switched'"
					)
					.run(now, now, JSON.stringify(audit), id);
				return this.get(id)!;
			})
			.immediate();
	}

	markSourceDeleted(id: string): PlanRepositoryRelocation {
		return this.db
			.transaction(() => {
				const current = this.get(id);
				if (!current || current.status !== 'switched') throw conflict();
				const now = Date.now();
				const audit = [...current.audit, { at: now, event: 'source-deleted' }].slice(-50);
				this.db
					.prepare(
						"UPDATE plan_repository_relocations SET status='source-deleted',phase='source-deleted',source_deleted_at=?,updated_at=?,audit=? WHERE id=? AND status='switched'"
					)
					.run(now, now, JSON.stringify(audit), id);
				return this.get(id)!;
			})
			.immediate();
	}

	appendAudit(id: string, event: Omit<RelocationAuditEvent, 'at'>) {
		this.db
			.transaction(() => {
				const current = this.get(id);
				if (!current) return;
				const audit = [...current.audit, { at: Date.now(), ...event }].slice(-50);
				this.db
					.prepare('UPDATE plan_repository_relocations SET audit=? WHERE id=?')
					.run(JSON.stringify(audit), id);
			})
			.immediate();
	}

	/**
	 * A switch records exactly which backup rows it moved. A revert moves back
	 * only those rows (and their receipts); rows written at the new location
	 * afterwards keep their true location.
	 */
	private rewrite(
		relocation: PlanRepositoryRelocation,
		from: RelocationLocation,
		to: RelocationLocation,
		revert = false
	) {
		const plan = this.db
			.prepare(
				'UPDATE plans SET storage_id=?,storage_path=?,updated_at=unixepoch() WHERE id=? AND storage_id=? AND storage_path=?'
			)
			.run(to.storageId, to.storagePath, relocation.planId, from.storageId, from.storagePath);
		const repository = this.db
			.prepare(
				'UPDATE remote_managed_repositories SET storage_id=?,storage_path=?,updated_at=unixepoch() WHERE id=? AND plan_id=? AND storage_id=? AND storage_path=?'
			)
			.run(
				to.storageId,
				to.storagePath,
				relocation.repositoryId,
				relocation.planId,
				from.storageId,
				from.storagePath
			);
		if (plan.changes !== 1 || repository.changes !== 1)
			throw conflict('The plan repository binding changed. Refresh and review.');
		if (!revert)
			this.db
				.prepare(
					'INSERT OR IGNORE INTO plan_repository_relocation_backups(relocation_id,backup_id) SELECT ?,id FROM backups WHERE plan_id=? AND storage_id=? AND storage_path=?'
				)
				.run(relocation.id, relocation.planId, from.storageId, from.storagePath);
		const moved =
			' AND id IN (SELECT backup_id FROM plan_repository_relocation_backups WHERE relocation_id=?)';
		this.db
			.prepare(
				`UPDATE backups SET storage_id=?,storage_path=? WHERE plan_id=? AND storage_id=? AND storage_path=?${moved}`
			)
			.run(
				to.storageId,
				to.storagePath,
				relocation.planId,
				from.storageId,
				from.storagePath,
				relocation.id
			);
		this.db
			.prepare(
				`UPDATE managed_replication_jobs SET source_storage_id=?,source_storage_path=? WHERE repository_id=? AND plan_id=? AND source_storage_id=? AND source_storage_path=?${moved.replace(' id IN', ' backup_id IN')}`
			)
			.run(
				to.storageId,
				to.storagePath,
				relocation.repositoryId,
				relocation.planId,
				from.storageId,
				from.storagePath,
				relocation.id
			);
	}
}
