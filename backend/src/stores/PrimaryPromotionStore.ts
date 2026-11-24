import type Database from 'better-sqlite3';
import { AppError } from '../utils/AppError';

/**
 * Stage 4 (docs/PRIMARY_PROMOTION.md): a verified replica becomes the plan's primary and the
 * previous primary becomes the replica of the same slot. Every transition is a compare-and-set;
 * the switch rewrites every binding in one transaction.
 */
export type PromotionStatus = 'catching-up' | 'switching' | 'switched' | 'failed' | 'cancelled';
export const ACTIVE_PROMOTION: readonly PromotionStatus[] = ['catching-up', 'switching'];

/** A backup the replica could not receive. It stays in the previous primary. */
export type LeftBehindBackup = {
	backupId: string;
	code: string;
	/** True when a receipt lets Verified Replica Recovery restore it from the previous primary. */
	restorable?: boolean;
};

export type PrimaryPromotion = {
	id: string;
	planId: string;
	repositoryId: string;
	replicationId: string;
	previousStorageId: string;
	previousStoragePath: string;
	previousRepositoryConfigId: string;
	promotedStorageId: string;
	promotedStoragePath: string;
	promotedFingerprint: string;
	promotedRepositoryConfigId: string;
	status: PromotionStatus;
	planWasActive: boolean | null;
	totalBackups: number;
	copiedBackups: number;
	retried: string[];
	leftBehind: LeftBehindBackup[];
	lastErrorCode: string | null;
	createdAt: number;
	updatedAt: number;
	switchedAt: number | null;
};

export type PromotionInput = Pick<
	PrimaryPromotion,
	| 'id'
	| 'planId'
	| 'repositoryId'
	| 'replicationId'
	| 'previousStorageId'
	| 'previousStoragePath'
	| 'previousRepositoryConfigId'
	| 'promotedStorageId'
	| 'promotedStoragePath'
	| 'promotedFingerprint'
	| 'promotedRepositoryConfigId'
>;

/** A copied backup: the replica copy becomes the primary snapshot, the receipt is inverted. */
export type SwappedBackup = {
	jobId: string;
	backupId: string;
	previousSnapshotId: string;
	promotedSnapshotId: string;
	bindingHash: string;
	/** After the swap: 1 when the previous primary holds the original snapshot. */
	destinationOriginal: boolean;
};

/** A backup whose only snapshot already is in the promoted replica (source and copy are one). */
export type ResidentBackup = { jobId: string; backupId: string; snapshotId: string };

/** A left-behind backup that the previous primary was proven to hold. */
export type LeftBehindReceipt = {
	receiptId: string;
	backupId: string;
	snapshotId: string;
	treeId: string;
	bindingHash: string;
};

export type PromotionSwitch = {
	previous: {
		fingerprint: string;
		authority: string;
		prefix: string;
		storageType: string;
		storageName: string;
	};
	swapped: SwappedBackup[];
	resident: ResidentBackup[];
	leftBehind: LeftBehindReceipt[];
	leftBehindRecord: LeftBehindBackup[];
	/** Refuses while a backup, restore, replication, recovery test or import of the plan runs. */
	assertPlanIdle: (planId: string) => void;
};

export type CompletedBackupRow = { id: string; snapshotId: string | null };

const fullId = (value: unknown): value is string =>
	typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const conflict = (message: string) => new AppError(409, message);

type Row = Record<string, unknown>;
const decode = (raw: unknown): PrimaryPromotion | null => {
	if (!raw) return null;
	const row = raw as Row;
	const list = <T>(value: unknown): T[] => {
		try {
			const parsed = JSON.parse(String(value ?? '[]'));
			return Array.isArray(parsed) ? (parsed as T[]) : [];
		} catch {
			return [];
		}
	};
	return {
		id: String(row.id),
		planId: String(row.plan_id),
		repositoryId: String(row.repository_id),
		replicationId: String(row.replication_id),
		previousStorageId: String(row.previous_storage_id),
		previousStoragePath: String(row.previous_storage_path),
		previousRepositoryConfigId: String(row.previous_repository_config_id),
		promotedStorageId: String(row.promoted_storage_id),
		promotedStoragePath: String(row.promoted_storage_path),
		promotedFingerprint: String(row.promoted_fingerprint),
		promotedRepositoryConfigId: String(row.promoted_repository_config_id),
		status: row.status as PromotionStatus,
		planWasActive:
			row.plan_was_active === null || row.plan_was_active === undefined
				? null
				: Number(row.plan_was_active) === 1,
		totalBackups: Number(row.total_backups || 0),
		copiedBackups: Number(row.copied_backups || 0),
		retried: list<string>(row.retried),
		leftBehind: list<LeftBehindBackup>(row.left_behind),
		lastErrorCode: (row.last_error_code as string | null) ?? null,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		switchedAt:
			row.switched_at === null || row.switched_at === undefined ? null : Number(row.switched_at),
	};
};

/** SQLite trigger refusals become operator-readable conflicts. */
function translate(error: unknown): never {
	// Read the message without `instanceof Error`: a SqliteError can come from another realm
	// (better-sqlite3 binds its error constructor once per process).
	const raw = (error as { message?: unknown } | null)?.message;
	const message = typeof raw === 'string' ? raw : '';
	if (message.includes('MANAGED_PROMOTION_BUSY'))
		throw conflict(
			'Finish the repository relocation or the open backup failover of this plan before promoting a replica.'
		);
	if (message.includes('UNIQUE constraint failed: managed_primary_promotions.plan_id'))
		throw conflict('A promotion of this plan is already running.');
	throw error;
}

export class PrimaryPromotionStore {
	constructor(private readonly sqlite: Database.Database) {}

	get(id: string): PrimaryPromotion | null {
		return decode(
			this.sqlite.prepare('SELECT * FROM managed_primary_promotions WHERE id=?').get(id)
		);
	}

	activeForPlan(planId: string): PrimaryPromotion | null {
		return decode(
			this.sqlite
				.prepare(
					"SELECT * FROM managed_primary_promotions WHERE plan_id=? AND status IN ('catching-up','switching') LIMIT 1"
				)
				.get(planId)
		);
	}

	listActive(): PrimaryPromotion[] {
		return this.sqlite
			.prepare(
				"SELECT * FROM managed_primary_promotions WHERE status IN ('catching-up','switching') ORDER BY created_at,id"
			)
			.all()
			.map(row => decode(row)!);
	}

	listForPlan(planId: string, limit = 5): PrimaryPromotion[] {
		return this.sqlite
			.prepare(
				'SELECT * FROM managed_primary_promotions WHERE plan_id=? ORDER BY created_at DESC,id DESC LIMIT ?'
			)
			.all(planId, Math.max(1, Math.min(50, limit)))
			.map(row => decode(row)!);
	}

	/** Completed backups bound to the plan's current primary, oldest first. */
	completedBackups(planId: string, storageId: string, storagePath: string): CompletedBackupRow[] {
		return this.sqlite
			.prepare(
				`SELECT id, CASE WHEN json_valid(completion_stats) THEN json_extract(completion_stats,'$.snapshot_id') END AS snapshot_id FROM backups WHERE plan_id=? AND storage_id=? AND storage_path=? AND method='backup' AND status='completed' AND success=1 AND coalesce(in_progress,0)=0 ORDER BY coalesce(started_at,created_at),id`
			)
			.all(planId, storageId, storagePath)
			.map(row => {
				const value = row as { id: string; snapshot_id?: unknown };
				return { id: value.id, snapshotId: fullId(value.snapshot_id) ? value.snapshot_id : null };
			});
	}

	create(input: PromotionInput, now = Date.now()): PrimaryPromotion {
		if (
			![
				input.previousRepositoryConfigId,
				input.promotedRepositoryConfigId,
				input.promotedFingerprint,
			].every(fullId)
		)
			throw conflict('The replica and the primary need verified repository identities.');
		try {
			this.sqlite
				.prepare(
					`INSERT INTO managed_primary_promotions(id,plan_id,repository_id,replication_id,previous_storage_id,previous_storage_path,previous_repository_config_id,promoted_storage_id,promoted_storage_path,promoted_fingerprint,promoted_repository_config_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'catching-up',?,?)`
				)
				.run(
					input.id,
					input.planId,
					input.repositoryId,
					input.replicationId,
					input.previousStorageId,
					input.previousStoragePath,
					input.previousRepositoryConfigId,
					input.promotedStorageId,
					input.promotedStoragePath,
					input.promotedFingerprint,
					input.promotedRepositoryConfigId,
					now,
					now
				);
		} catch (error) {
			translate(error);
		}
		return this.get(input.id)!;
	}

	recordProgress(
		id: string,
		progress: { total: number; copied: number; retried: string[]; leftBehind: LeftBehindBackup[] },
		now = Date.now()
	): void {
		this.sqlite
			.prepare(
				"UPDATE managed_primary_promotions SET total_backups=?,copied_backups=?,retried=?,left_behind=?,updated_at=? WHERE id=? AND status IN ('catching-up','switching')"
			)
			.run(
				progress.total,
				progress.copied,
				JSON.stringify([...new Set(progress.retried)]),
				JSON.stringify(progress.leftBehind),
				now,
				id
			);
	}

	/** Catch-up is complete; the plan is paused for the final step. */
	toSwitching(id: string, planWasActive: boolean, now = Date.now()): PrimaryPromotion | null {
		const changed = this.sqlite
			.prepare(
				"UPDATE managed_primary_promotions SET status='switching',plan_was_active=?,updated_at=? WHERE id=? AND status='catching-up'"
			)
			.run(planWasActive ? 1 : 0, now, id).changes;
		return changed ? this.get(id) : null;
	}

	fail(id: string, code: string, now = Date.now()): PrimaryPromotion | null {
		const safe = /^[a-z][a-z0-9-]{0,79}$/.test(code) ? code : 'execution-failed';
		const changed = this.sqlite
			.prepare(
				"UPDATE managed_primary_promotions SET status='failed',last_error_code=?,updated_at=? WHERE id=? AND status IN ('catching-up','switching')"
			)
			.run(safe, now, id).changes;
		return changed ? this.get(id) : null;
	}

	cancel(id: string, now = Date.now()): PrimaryPromotion | null {
		const changed = this.sqlite
			.prepare(
				"UPDATE managed_primary_promotions SET status='cancelled',last_error_code='cancelled',updated_at=? WHERE id=? AND status IN ('catching-up','switching')"
			)
			.run(now, id).changes;
		return changed ? this.get(id) : null;
	}

	/**
	 * One transaction: the promoted replica becomes the primary of the plan, its repository row
	 * and every listed backup; the previous primary becomes the replica of the same slot; every
	 * receipt is inverted. Any concurrent change aborts the whole switch.
	 */
	switchPrimary(id: string, input: PromotionSwitch, now = Date.now()): PrimaryPromotion {
		const ids = [
			input.previous.fingerprint,
			...input.swapped.flatMap(row => [
				row.previousSnapshotId,
				row.promotedSnapshotId,
				row.bindingHash,
			]),
			...input.resident.map(row => row.snapshotId),
			...input.leftBehind.flatMap(row => [row.snapshotId, row.treeId, row.bindingHash]),
		];
		if (!ids.every(fullId)) throw conflict('Promotion proof is incomplete.');
		const run = this.sqlite.transaction(() => {
			const promotion = this.get(id);
			if (!promotion || promotion.status !== 'switching')
				throw conflict('The promotion is no longer switching.');
			input.assertPlanIdle(promotion.planId);
			// Leave the active states first: the binding triggers guard everyone else.
			this.sqlite
				.prepare(
					"UPDATE managed_primary_promotions SET status='switched',switched_at=?,updated_at=?,left_behind=?,copied_backups=?,last_error_code=NULL WHERE id=? AND status='switching'"
				)
				.run(
					now,
					now,
					JSON.stringify(input.leftBehindRecord),
					input.swapped.length + input.resident.length,
					id
				);
			const previous = {
				storageId: promotion.previousStorageId,
				storagePath: promotion.previousStoragePath,
			};
			const promoted = {
				storageId: promotion.promotedStorageId,
				storagePath: promotion.promotedStoragePath,
			};

			const plan = this.sqlite
				.prepare('SELECT settings FROM plans WHERE id=? AND storage_id=? AND storage_path=?')
				.get(promotion.planId, previous.storageId, previous.storagePath) as
				| { settings?: string | null }
				| undefined;
			if (!plan) throw conflict('The plan primary changed. Refresh and review.');
			let settings: Record<string, any>;
			try {
				settings = JSON.parse(plan.settings || '{}');
			} catch {
				throw conflict('The plan settings could not be read.');
			}
			const storages: any[] = settings?.replication?.storages;
			const slot = Array.isArray(storages)
				? storages.findIndex(item => item?.replicationId === promotion.replicationId)
				: -1;
			if (
				slot < 0 ||
				!settings.replication?.enabled ||
				storages.length !== 1 ||
				storages[slot].storageId !== promoted.storageId ||
				storages[slot].storagePath !== promoted.storagePath
			)
				throw conflict('The replica of this plan changed. Refresh and review.');
			storages[slot] = {
				...storages[slot],
				storageId: previous.storageId,
				storagePath: previous.storagePath,
				storageType: input.previous.storageType,
				storageName: input.previous.storageName,
				addedAt: now,
			};
			const planChange = this.sqlite
				.prepare(
					'UPDATE plans SET storage_id=?,storage_path=?,settings=?,updated_at=unixepoch() WHERE id=? AND storage_id=? AND storage_path=?'
				)
				.run(
					promoted.storageId,
					promoted.storagePath,
					JSON.stringify(settings),
					promotion.planId,
					previous.storageId,
					previous.storagePath
				);
			const repositoryChange = this.sqlite
				.prepare(
					'UPDATE remote_managed_repositories SET storage_id=?,storage_path=?,updated_at=unixepoch() WHERE id=? AND plan_id=? AND storage_id=? AND storage_path=?'
				)
				.run(
					promoted.storageId,
					promoted.storagePath,
					promotion.repositoryId,
					promotion.planId,
					previous.storageId,
					previous.storagePath
				);
			if (planChange.changes !== 1 || repositoryChange.changes !== 1)
				throw conflict('The plan repository binding changed. Refresh and review.');

			// The promoted location leaves the replica ownership; it is the plan primary now.
			const released = this.sqlite
				.prepare(
					"DELETE FROM managed_replication_destinations WHERE fingerprint=? AND plan_id=? AND replication_id=? AND source_repository_id=? AND init_state='ready' AND actual_repository_id=?"
				)
				.run(
					promotion.promotedFingerprint,
					promotion.planId,
					promotion.replicationId,
					promotion.repositoryId,
					promotion.promotedRepositoryConfigId
				);
			if (released.changes !== 1) throw conflict('The replica repository ownership changed.');
			for (const other of this.sqlite
				.prepare(
					'SELECT destination_authority AS authority,destination_prefix AS prefix FROM managed_replication_destinations'
				)
				.all() as { authority: string; prefix: string }[])
				if (
					other.authority === input.previous.authority &&
					(other.prefix === input.previous.prefix ||
						other.prefix.startsWith(input.previous.prefix + '/') ||
						input.previous.prefix.startsWith(other.prefix + '/'))
				)
					throw conflict('The previous primary overlaps an existing or retained replica.');
			this.sqlite
				.prepare(
					`INSERT INTO managed_replication_destinations(fingerprint,plan_id,replication_id,source_repository_id,destination_storage_id,destination_storage_path,destination_authority,destination_prefix,init_state,actual_repository_id,created_at) VALUES(?,?,?,?,?,?,?,?,'ready',?,?)`
				)
				.run(
					input.previous.fingerprint,
					promotion.planId,
					promotion.replicationId,
					promotion.repositoryId,
					previous.storageId,
					previous.storagePath,
					input.previous.authority,
					input.previous.prefix,
					promotion.previousRepositoryConfigId,
					now
				);

			const moveBackup = this.sqlite.prepare(
				`UPDATE backups SET storage_id=?,storage_path=?,completion_stats=json_set(completion_stats,'$.snapshot_id',?) WHERE id=? AND plan_id=? AND storage_id=? AND storage_path=? AND json_valid(completion_stats) AND json_extract(completion_stats,'$.snapshot_id')=?`
			);
			const move = (backupId: string, from: string, to: string) => {
				const changed = moveBackup.run(
					promoted.storageId,
					promoted.storagePath,
					to,
					backupId,
					promotion.planId,
					previous.storageId,
					previous.storagePath,
					from
				).changes;
				if (changed !== 1) throw conflict('A backup of this plan changed during the promotion.');
			};
			const invert = this.sqlite.prepare(
				`UPDATE managed_replication_jobs SET source_storage_id=?,source_storage_path=?,source_snapshot_id=?,source_repository_config_id=?,source_binding_hash=?,destination_storage_id=?,destination_storage_path=?,destination_fingerprint=?,destination_snapshot_id=?,destination_original=?,updated_at=? WHERE id=? AND backup_id=? AND plan_id=? AND replication_id=? AND status='completed' AND source_snapshot_id=? AND destination_snapshot_id=?`
			);
			const snapshotIds = new Map<string, string>();
			for (const row of input.swapped) {
				move(row.backupId, row.previousSnapshotId, row.promotedSnapshotId);
				const changed = invert.run(
					promoted.storageId,
					promoted.storagePath,
					row.promotedSnapshotId,
					promotion.promotedRepositoryConfigId,
					row.bindingHash,
					previous.storageId,
					previous.storagePath,
					input.previous.fingerprint,
					row.previousSnapshotId,
					row.destinationOriginal ? 1 : 0,
					now,
					row.jobId,
					row.backupId,
					promotion.planId,
					promotion.replicationId,
					row.previousSnapshotId,
					row.promotedSnapshotId
				).changes;
				if (changed !== 1) throw conflict('A replica receipt changed during the promotion.');
				snapshotIds.set(row.previousSnapshotId, row.promotedSnapshotId);
			}
			// The only snapshot is in the promoted repository: the backup needs no copy any more.
			const dropResident = this.sqlite.prepare(
				"DELETE FROM managed_replication_jobs WHERE id=? AND backup_id=? AND plan_id=? AND replication_id=? AND status='completed' AND source_snapshot_id=? AND destination_snapshot_id=?"
			);
			for (const row of input.resident) {
				move(row.backupId, row.snapshotId, row.snapshotId);
				const changed = dropResident.run(
					row.jobId,
					row.backupId,
					promotion.planId,
					promotion.replicationId,
					row.snapshotId,
					row.snapshotId
				).changes;
				if (changed !== 1) throw conflict('A replica receipt changed during the promotion.');
			}
			// Left behind but proven in the previous primary: restorable through replica recovery.
			const dropUnfinished = this.sqlite.prepare(
				"DELETE FROM managed_replication_jobs WHERE backup_id=? AND replication_id=? AND status IN ('failed','cancelled')"
			);
			const insertReceipt = this.sqlite.prepare(
				`INSERT INTO managed_replication_jobs(id,backup_id,plan_id,repository_id,agent_id,source_storage_id,source_storage_path,source_snapshot_id,source_repository_config_id,source_tree_id,source_binding_hash,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,destination_snapshot_id,status,attempts,created_at,updated_at,verified_at,destination_original)
				SELECT ?,?,?,r.id,r.agent_id,?,?,?,?,?,?,?,?,?,?,?,'completed',1,?,?,?,1 FROM remote_managed_repositories r WHERE r.id=? AND r.plan_id=?`
			);
			for (const row of input.leftBehind) {
				move(row.backupId, row.snapshotId, row.snapshotId);
				dropUnfinished.run(row.backupId, promotion.replicationId);
				const changed = insertReceipt.run(
					row.receiptId,
					row.backupId,
					promotion.planId,
					promoted.storageId,
					promoted.storagePath,
					row.snapshotId,
					promotion.promotedRepositoryConfigId,
					row.treeId,
					row.bindingHash,
					promotion.replicationId,
					previous.storageId,
					previous.storagePath,
					input.previous.fingerprint,
					row.snapshotId,
					now,
					now,
					now,
					promotion.repositoryId,
					promotion.planId
				).changes;
				if (changed !== 1)
					throw conflict('The repository of this plan changed during the promotion.');
			}

			const stats = this.sqlite
				.prepare('SELECT stats FROM plans WHERE id=?')
				.get(promotion.planId) as { stats?: string | null } | undefined;
			if (stats?.stats && snapshotIds.size) {
				try {
					const parsed = JSON.parse(stats.stats) as { snapshots?: string[] };
					if (Array.isArray(parsed.snapshots)) {
						parsed.snapshots = [
							...new Set(parsed.snapshots.map(snapshot => snapshotIds.get(snapshot) || snapshot)),
						];
						this.sqlite
							.prepare('UPDATE plans SET stats=? WHERE id=?')
							.run(JSON.stringify(parsed), promotion.planId);
					}
				} catch {
					// Statistics are informational; the snapshot bindings above are authoritative.
				}
			}
			return this.get(id)!;
		});
		try {
			return run.immediate();
		} catch (error) {
			translate(error);
		}
	}
}
