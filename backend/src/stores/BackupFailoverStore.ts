import type Database from 'better-sqlite3';

/** Stage 3 backup failover records (docs/BACKUP_FAILOVER.md). No secret values. */
export type BackupFailoverStatus =
	| 'queued'
	| 'backup-failed'
	| 'verify-pending'
	| 'verifying'
	| 'verified'
	| 'copying'
	| 'copied-back'
	| 'failed';

export type BackupFailover = {
	backupId: string;
	failedBackupId: string;
	planId: string;
	repositoryId: string;
	agentId: string;
	replicationId: string;
	destinationStorageId: string;
	destinationStoragePath: string;
	destinationFingerprint: string;
	primaryRepositoryConfigId: string;
	replicaRepositoryConfigId: string;
	status: BackupFailoverStatus;
	replicaSnapshotId: string | null;
	primarySnapshotId: string | null;
	ownerToken: string | null;
	attempts: number;
	nextAttemptAt: number;
	lastErrorCode: string | null;
	createdAt: number;
	updatedAt: number;
	verifiedAt: number | null;
	copiedBackAt: number | null;
};

export type BackupFailoverInput = Pick<
	BackupFailover,
	| 'backupId'
	| 'failedBackupId'
	| 'planId'
	| 'repositoryId'
	| 'agentId'
	| 'replicationId'
	| 'destinationStorageId'
	| 'destinationStoragePath'
	| 'destinationFingerprint'
	| 'primaryRepositoryConfigId'
	| 'replicaRepositoryConfigId'
>;

/** The verified replica copy, stored as a completed replication receipt. */
export type FailoverReceipt = {
	id: string;
	sourceStorageId: string;
	sourceStoragePath: string;
	sourceTreeId: string;
	sourceBindingHash: string;
};

export const OPEN_FAILOVER = "status NOT IN ('backup-failed','copied-back','failed')";
const fullId = (value: string | null | undefined) => !!value && /^[a-f0-9]{64}$/.test(value);
const decode = (raw: unknown): BackupFailover | null =>
	raw
		? (Object.fromEntries(
				Object.entries(raw as object).map(([key, value]) => [
					key.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase()),
					value,
				])
			) as BackupFailover)
		: null;

/** SQLite compare-and-set transitions; an owner token guards every claimed step. */
export class BackupFailoverStore {
	constructor(private readonly sqlite: Database.Database) {}

	getByBackup(backupId: string): BackupFailover | null {
		return decode(
			this.sqlite.prepare('SELECT * FROM managed_backup_failovers WHERE backup_id=?').get(backupId)
		);
	}

	getByFailedBackup(failedBackupId: string): BackupFailover | null {
		return decode(
			this.sqlite
				.prepare('SELECT * FROM managed_backup_failovers WHERE failed_backup_id=?')
				.get(failedBackupId)
		);
	}

	listOpenByPlan(planId: string): BackupFailover[] {
		return this.sqlite
			.prepare(
				`SELECT * FROM managed_backup_failovers WHERE plan_id=? AND ${OPEN_FAILOVER} ORDER BY created_at`
			)
			.all(planId)
			.map(row => decode(row)!);
	}

	/** Runs inside the transaction that creates the failover backup row and its command. */
	insertQueued(input: BackupFailoverInput, now = Date.now()): void {
		if (!fullId(input.primaryRepositoryConfigId) || !fullId(input.replicaRepositoryConfigId))
			throw new Error('Failover repository identities are incomplete.');
		this.sqlite
			.prepare(
				`INSERT INTO managed_backup_failovers(backup_id,failed_backup_id,plan_id,repository_id,agent_id,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,primary_repository_config_id,replica_repository_config_id,status,created_at,updated_at)
				VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`
			)
			.run(
				input.backupId,
				input.failedBackupId,
				input.planId,
				input.repositoryId,
				input.agentId,
				input.replicationId,
				input.destinationStorageId,
				input.destinationStoragePath,
				input.destinationFingerprint,
				input.primaryRepositoryConfigId,
				input.replicaRepositoryConfigId,
				now,
				now
			);
	}

	/** The Agent finished the failover backup; the server verifies it next. */
	markBackupCompleted(backupId: string, now = Date.now()): boolean {
		return (
			this.sqlite
				.prepare(
					`UPDATE managed_backup_failovers SET status='verify-pending',next_attempt_at=0,updated_at=? WHERE backup_id=? AND status='queued'`
				)
				.run(now, backupId).changes === 1
		);
	}

	markBackupFailed(backupId: string, now = Date.now()): boolean {
		return (
			this.sqlite
				.prepare(
					`UPDATE managed_backup_failovers SET status='backup-failed',updated_at=? WHERE backup_id=? AND status='queued'`
				)
				.run(now, backupId).changes === 1
		);
	}

	listDue(now = Date.now(), limit = 5): BackupFailover[] {
		return this.sqlite
			.prepare(
				`SELECT * FROM managed_backup_failovers WHERE status IN ('verify-pending','verified') AND next_attempt_at<=? ORDER BY created_at LIMIT ?`
			)
			.all(now, Math.max(1, Math.min(25, limit)))
			.map(row => decode(row)!);
	}

	claim(
		backupId: string,
		from: 'verify-pending' | 'verified',
		ownerToken: string,
		now = Date.now()
	): BackupFailover | null {
		const to = from === 'verify-pending' ? 'verifying' : 'copying';
		const changed = this.sqlite
			.prepare(
				`UPDATE managed_backup_failovers SET status=?,owner_token=?,attempts=attempts+1,updated_at=? WHERE backup_id=? AND status=? AND owner_token IS NULL`
			)
			.run(to, ownerToken, now, backupId, from).changes;
		return changed === 1 ? this.getByBackup(backupId) : null;
	}

	/** A transient failure: the step returns to its waiting state and is retried later. */
	release(backupId: string, ownerToken: string, code: string, delayMs: number, now = Date.now()) {
		this.sqlite
			.prepare(
				`UPDATE managed_backup_failovers SET status=CASE status WHEN 'verifying' THEN 'verify-pending' WHEN 'copying' THEN 'verified' ELSE status END,owner_token=NULL,last_error_code=?,next_attempt_at=?,updated_at=? WHERE backup_id=? AND owner_token=?`
			)
			.run(code, now + Math.max(0, delayMs), now, backupId, ownerToken);
	}

	/** A permanent refusal; the data already written stays where it is. */
	fail(backupId: string, ownerToken: string, code: string, now = Date.now()) {
		this.sqlite
			.prepare(
				`UPDATE managed_backup_failovers SET status='failed',owner_token=NULL,last_error_code=?,updated_at=? WHERE backup_id=? AND owner_token=?`
			)
			.run(code, now, backupId, ownerToken);
	}

	/**
	 * The failover snapshot is verified in the replica. The same transaction records it as a
	 * completed replication receipt, so replica recovery and mirror status treat it like a copy.
	 */
	recordVerified(
		failover: BackupFailover,
		ownerToken: string,
		replicaSnapshotId: string,
		receipt: FailoverReceipt,
		now = Date.now()
	): boolean {
		if (
			!fullId(replicaSnapshotId) ||
			!fullId(receipt.sourceTreeId) ||
			!fullId(receipt.sourceBindingHash)
		)
			throw new Error('Failover proof is incomplete.');
		return this.sqlite
			.transaction(() => {
				const owned = this.sqlite
					.prepare(
						`SELECT 1 FROM managed_backup_failovers WHERE backup_id=? AND status='verifying' AND owner_token=?`
					)
					.get(failover.backupId, ownerToken);
				if (!owned) return false;
				this.sqlite
					.prepare(
						`INSERT INTO managed_replication_jobs(id,backup_id,plan_id,repository_id,agent_id,source_storage_id,source_storage_path,source_snapshot_id,source_repository_config_id,source_tree_id,source_binding_hash,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,destination_snapshot_id,status,attempts,created_at,updated_at,verified_at)
						VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'completed',1,?,?,?)`
					)
					.run(
						receipt.id,
						failover.backupId,
						failover.planId,
						failover.repositoryId,
						failover.agentId,
						receipt.sourceStorageId,
						receipt.sourceStoragePath,
						replicaSnapshotId,
						failover.primaryRepositoryConfigId,
						receipt.sourceTreeId,
						receipt.sourceBindingHash,
						failover.replicationId,
						failover.destinationStorageId,
						failover.destinationStoragePath,
						failover.destinationFingerprint,
						replicaSnapshotId,
						now,
						now,
						now
					);
				this.sqlite
					.prepare(
						`UPDATE managed_backup_failovers SET status='verified',replica_snapshot_id=?,owner_token=NULL,last_error_code=NULL,next_attempt_at=0,verified_at=?,updated_at=? WHERE backup_id=?`
					)
					.run(replicaSnapshotId, now, now, failover.backupId);
				return true;
			})
			.immediate();
	}

	/**
	 * The snapshot now exists in the primary. The backup row, its replica receipt and the plan
	 * statistics move to the primary snapshot ID in one transaction; the replica keeps the original.
	 */
	recordCopiedBack(
		failover: BackupFailover,
		ownerToken: string,
		primarySnapshotId: string,
		receiptId: string,
		bindingHash: string,
		now = Date.now()
	): boolean {
		if (!fullId(primarySnapshotId) || !fullId(bindingHash) || !failover.replicaSnapshotId)
			throw new Error('Copy-back proof is incomplete.');
		return this.sqlite
			.transaction(() => {
				const owned = this.sqlite
					.prepare(
						`SELECT 1 FROM managed_backup_failovers WHERE backup_id=? AND status='copying' AND owner_token=?`
					)
					.get(failover.backupId, ownerToken);
				if (!owned) return false;
				const backup = this.sqlite
					.prepare(
						`UPDATE backups SET completion_stats=json_set(completion_stats,'$.snapshot_id',?) WHERE id=? AND json_extract(completion_stats,'$.snapshot_id')=?`
					)
					.run(primarySnapshotId, failover.backupId, failover.replicaSnapshotId);
				const receipt = this.sqlite
					.prepare(
						`UPDATE managed_replication_jobs SET source_snapshot_id=?,source_binding_hash=?,updated_at=? WHERE id=? AND backup_id=? AND status='completed' AND destination_snapshot_id=?`
					)
					.run(
						primarySnapshotId,
						bindingHash,
						now,
						receiptId,
						failover.backupId,
						failover.replicaSnapshotId
					);
				if (backup.changes !== 1 || receipt.changes !== 1)
					throw new Error('Failover copy-back records changed concurrently.');
				const plan = this.sqlite
					.prepare('SELECT stats FROM plans WHERE id=?')
					.get(failover.planId) as { stats?: string | null } | undefined;
				if (plan?.stats) {
					try {
						const stats = JSON.parse(plan.stats) as { snapshots?: string[] };
						if (Array.isArray(stats.snapshots)) {
							stats.snapshots = [
								...new Set(
									stats.snapshots.map(id =>
										id === failover.replicaSnapshotId ? primarySnapshotId : id
									)
								),
							];
							this.sqlite
								.prepare('UPDATE plans SET stats=? WHERE id=?')
								.run(JSON.stringify(stats), failover.planId);
						}
					} catch {
						// Statistics are informational; the snapshot binding above is authoritative.
					}
				}
				this.sqlite
					.prepare(
						`UPDATE managed_backup_failovers SET status='copied-back',primary_snapshot_id=?,owner_token=NULL,last_error_code=NULL,copied_back_at=?,updated_at=? WHERE backup_id=?`
					)
					.run(primarySnapshotId, now, now, failover.backupId);
				return true;
			})
			.immediate();
	}

	/** Queued failover runs whose backup already finished (a restart between completion and handoff). */
	queuedFinished(limit = 10): { backupId: string; succeeded: boolean }[] {
		return this.sqlite
			.prepare(
				`SELECT f.backup_id AS backupId, (b.status='completed' AND b.success=1) AS succeeded FROM managed_backup_failovers f JOIN backups b ON b.id=f.backup_id WHERE f.status='queued' AND coalesce(b.in_progress,0)=0 AND b.status IN ('completed','failed','cancelled') ORDER BY f.created_at LIMIT ?`
			)
			.all(Math.max(1, Math.min(25, limit)))
			.map(row => {
				const value = row as { backupId: string; succeeded: number };
				return { backupId: value.backupId, succeeded: value.succeeded === 1 };
			});
	}

	/** An unclaimed step waits, for example while the primary is still unreachable. */
	defer(backupId: string, code: string, delayMs: number, now = Date.now()) {
		this.sqlite
			.prepare(
				`UPDATE managed_backup_failovers SET last_error_code=?,next_attempt_at=?,updated_at=? WHERE backup_id=? AND owner_token IS NULL AND status IN ('verify-pending','verified')`
			)
			.run(code, now + Math.max(0, delayMs), now, backupId);
	}

	/**
	 * Primary repository identity proven by the newest verified copy of this replica; undefined
	 * when the replica holds no verified copy of the plan's current repository yet.
	 */
	verifiedPrimaryIdentity(
		planId: string,
		repositoryId: string,
		replicationId: string
	): string | undefined {
		const row = this.sqlite
			.prepare(
				`SELECT source_repository_config_id AS id FROM managed_replication_jobs WHERE plan_id=? AND repository_id=? AND replication_id=? AND status='completed' AND verified_at IS NOT NULL AND last_error_code IS NULL AND destination_snapshot_id IS NOT NULL ORDER BY verified_at DESC LIMIT 1`
			)
			.get(planId, repositoryId, replicationId) as { id?: string } | undefined;
		return fullId(row?.id) ? row!.id : undefined;
	}

	/** A later run of the plan supersedes a failure; failover only follows the newest run. */
	hasNewerBackup(planId: string, backupId: string): boolean {
		return !!this.sqlite
			.prepare(
				`SELECT 1 FROM backups n, backups b WHERE b.id=? AND n.plan_id=? AND n.id!=b.id AND (coalesce(n.started_at,n.created_at)>coalesce(b.started_at,b.created_at) OR coalesce(n.in_progress,0)=1) LIMIT 1`
			)
			.get(backupId, planId);
	}

	/** Recent failed runs of failover plans without a decision record (crash reconciliation). */
	undecidedFailures(sinceSeconds: number, limit = 10): string[] {
		return this.sqlite
			.prepare(
				`SELECT b.id FROM backups b JOIN plans p ON p.id=b.plan_id WHERE b.status='failed' AND b.method='backup' AND b.source_type='device' AND b.source_id!='main' AND coalesce(b.ended_at,b.started_at,b.created_at)>=? AND json_valid(p.settings) AND json_extract(p.settings,'$.replication.backupFailover')='automatic' AND NOT EXISTS(SELECT 1 FROM managed_backup_failovers f WHERE f.failed_backup_id=b.id OR f.backup_id=b.id) ORDER BY b.id LIMIT ?`
			)
			.all(sinceSeconds, Math.max(1, Math.min(25, limit)))
			.map(row => (row as { id: string }).id);
	}

	/** After a restart nothing is executing: claimed steps return to their waiting state. */
	markInterrupted(now = Date.now()): number {
		return this.sqlite
			.prepare(
				`UPDATE managed_backup_failovers SET status=CASE status WHEN 'verifying' THEN 'verify-pending' ELSE 'verified' END,owner_token=NULL,last_error_code='interrupted',next_attempt_at=0,updated_at=? WHERE status IN ('verifying','copying')`
			)
			.run(now).changes;
	}
}
