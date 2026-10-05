import { eq } from 'drizzle-orm';
import { and, sql } from 'drizzle-orm/sql';
import { DatabaseType } from '../db';
import { NewPlan, Plan, plans } from '../db/schema/plans';
import { backups } from '../db/schema/backups';
import { PlanBackupSettings, PlanFull } from '../types/plans';
import { restores } from '../db/schema/restores';
import {
	remotePlanDatabaseCredentials,
	remotePlanDatabaseEntryCredentials,
} from '../db/schema/remotePlanCredentials';
import type { DatabaseCredential } from '../types/remoteLifecycle';

/**
 * PlanStore is a class for managing plan records in the database.
 */
export class PlanStore {
	constructor(protected db: DatabaseType) {}

	async getAll(history: boolean = true): Promise<PlanFull[] | null> {
		const result = await this.db.query.plans.findMany({
			with: {
				device: {
					columns: {
						id: true,
						name: true,
						hostname: true,
					},
				},
				storage: {
					columns: {
						id: true,
						name: true,
						type: true,
					},
				},
				backups: {
					limit: history ? 90 : 10,
					orderBy: (backups, { desc }) => [desc(backups.ended)],
					columns: {
						id: true,
						title: true,
						description: true,
						status: true,
						errorMsg: true,
						download: true,
						started: true,
						ended: true,
						completionStats: true,
						taskStats: true,
						inProgress: true,
						mirrors: true,
					},
				},
				restores: {
					limit: history ? 90 : 0,
					orderBy: (restores, { desc }) => [desc(restores.ended)],
					columns: {
						id: true,
						backupId: true,
						started: true,
						ended: true,
						config: true,
						status: true,
						completionStats: true,
						taskStats: true,
						errorMsg: true,
					},
				},
			},
		});

		if (result) {
			const plans = result.map(async plan => {
				return {
					...plan,
					backups: this.handleBackupStats(
						plan.method,
						plan.backups,
						plan.stats,
						plan.sourceType === 'device' && plan.sourceId !== 'main'
					),
				};
			});
			return Promise.all(plans);
		}

		return null;
	}

	async getById(planId: string, history: boolean = false): Promise<PlanFull | null> {
		const thePlan = await this.db.query.plans.findFirst({
			where: eq(plans.id, planId),
			with: {
				device: {
					columns: {
						id: true,
						name: true,
						hostname: true,
					},
				},
				storage: {
					columns: {
						id: true,
						name: true,
						type: true,
					},
				},
				backups: {
					limit: history ? 999 : 10,
					orderBy: (backups, { desc }) => [desc(backups.ended)],
					columns: {
						id: true,
						title: true,
						description: true,
						status: true,
						errorMsg: true,
						download: true,
						started: true,
						ended: true,
						inProgress: true,
						completionStats: true,
						taskStats: true,
						mirrors: true,
					},
				},
				restores: {
					limit: history ? 999 : 0,
					orderBy: (restores, { desc }) => [desc(restores.ended)],
					columns: {
						id: true,
						backupId: true,
						started: true,
						ended: true,
						config: true,
						status: true,
						inProgress: true,
						completionStats: true,
						taskStats: true,
						errorMsg: true,
					},
				},
			},
		});

		if (thePlan && thePlan.backups) {
			thePlan.backups = this.handleBackupStats(
				thePlan.method,
				thePlan.backups,
				thePlan.stats,
				thePlan.sourceType === 'device' && thePlan.sourceId !== 'main'
			);
		}
		// clear out backup mirrors that are missing from the plan's replication settings
		// e.g. if the storage was removed after the backup was taken
		if (thePlan && thePlan.backups && thePlan.backups.length > 0 && thePlan.settings?.replication) {
			thePlan.backups = this.handleBackupMirrors(thePlan, thePlan.backups);
		}

		return thePlan || null;
	}

	async getStoragePlans(storageId: string): Promise<Plan[] | null> {
		const result = await this.db.query.plans.findMany({
			where: eq(plans.storageId, storageId),
		});
		return result;
	}

	async getDevicePlans(deviceId: string): Promise<Plan[] | null> {
		const result = await this.db.query.plans.findMany({
			where: eq(plans.sourceId, deviceId),
		});
		return result;
	}

	handleBackupStats(
		method: string,
		backups: PlanFull['backups'],
		stats: PlanFull['stats'],
		remoteManaged = false
	) {
		const isRemoteManaged = remoteManaged && method === 'backup';
		return backups.map(backup => {
			const { completionStats: backupCompStats, taskStats: backupTaskStats } = backup;
			const backupStarted = backup.started ? new Date(backup.started).getTime() : 0;
			const backupEnded = backup.ended ? new Date(backup.ended).getTime() : 0;
			const taskStats = backupCompStats || backupTaskStats;
			const counts = isRemoteManaged ? backupCompStats : backupTaskStats;
			return {
				...backup,
				totalFiles: counts?.total_files_processed || 0,
				totalSize: counts?.total_bytes_processed || 0,
				duration: Math.floor((backupEnded - backupStarted) / 1000),
				active: isRemoteManaged
					? !!backupCompStats?.snapshot_id &&
						/^[a-f0-9]{64}$/.test(backupCompStats.snapshot_id) &&
						!!stats?.snapshots?.includes(backupCompStats.snapshot_id)
					: stats?.snapshots?.includes(backup.id) || false,
				changes: {
					new: taskStats?.files_new || 0,
					modified: taskStats?.files_changed || 0,
					removed: 0,
					newDirs: taskStats?.dirs_new || 0,
					modifiedDirs: taskStats?.dirs_changed || 0,
				},
			};
		});
	}

	handleBackupMirrors(plan: PlanFull, backups: PlanFull['backups']) {
		// remove backup mirrors that are missing from the plan's replication settings
		// (e.g. if the storage was removed after the backup was taken)
		const replicationSettings = plan.settings.replication as PlanBackupSettings['replication'];
		const availableMirrorStorages = replicationSettings?.storages.map(s => s.storageId) || [];
		return plan.backups.map(backup => {
			if (backup.mirrors) {
				backup.mirrors = backup.mirrors.filter(mirror =>
					availableMirrorStorages.includes(mirror.storageId)
				);
			}
			return backup;
		});
	}

	async getDatabaseCredential(planId: string): Promise<string | null> {
		const [record] = await this.db
			.select()
			.from(remotePlanDatabaseCredentials)
			.where(eq(remotePlanDatabaseCredentials.planId, planId))
			.limit(1);
		return record?.encryptedPassword || null;
	}

	async getDatabaseCredentials(planId: string): Promise<DatabaseCredential[]> {
		return this.db
			.select({
				databaseId: remotePlanDatabaseEntryCredentials.databaseId,
				encryptedPassword: remotePlanDatabaseEntryCredentials.encryptedPassword,
				legacySingle: remotePlanDatabaseEntryCredentials.legacySingle,
			})
			.from(remotePlanDatabaseEntryCredentials)
			.where(eq(remotePlanDatabaseEntryCredentials.planId, planId));
	}

	private writeDatabaseCredentials(
		tx: Parameters<Parameters<DatabaseType['transaction']>[0]>[0],
		planId: string,
		credentials: DatabaseCredential[]
	): void {
		const old = tx
			.select()
			.from(remotePlanDatabaseEntryCredentials)
			.where(eq(remotePlanDatabaseEntryCredentials.planId, planId))
			.all();
		const ownerPlan = tx.select().from(plans).where(eq(plans.id, planId)).get();
		const expected = ownerPlan?.settings.remoteLifecycle?.databases || [];
		if (
			expected.length !== credentials.length ||
			expected.some(
				entry =>
					entry.password !== undefined ||
					!entry.databaseId ||
					!credentials.some(item => item.databaseId === entry.databaseId)
			)
		)
			throw new Error('Database credential bindings do not match the plan.');
		if (new Set(credentials.map(item => item.databaseId)).size !== credentials.length)
			throw new Error('Duplicate database credential identity.');
		for (const credential of credentials) {
			const owner = tx
				.select()
				.from(remotePlanDatabaseEntryCredentials)
				.where(eq(remotePlanDatabaseEntryCredentials.databaseId, credential.databaseId))
				.get();
			if (owner && owner.planId !== planId)
				throw new Error('Database credential ownership is invalid.');
			tx.insert(remotePlanDatabaseEntryCredentials)
				.values({ ...credential, planId })
				.onConflictDoUpdate({
					target: remotePlanDatabaseEntryCredentials.databaseId,
					set: {
						encryptedPassword: credential.encryptedPassword,
						legacySingle: credential.legacySingle,
					},
				})
				.run();
			if (credential.legacySingle)
				this.writeDatabaseCredential(tx, planId, credential.encryptedPassword);
		}
		for (const entry of old.filter(
			item => !credentials.some(next => next.databaseId === item.databaseId)
		)) {
			tx.delete(remotePlanDatabaseEntryCredentials)
				.where(
					and(
						eq(remotePlanDatabaseEntryCredentials.databaseId, entry.databaseId),
						eq(remotePlanDatabaseEntryCredentials.planId, planId)
					)
				)
				.run();
			if (entry.legacySingle) this.writeDatabaseCredential(tx, planId, null);
		}
	}

	private writeDatabaseCredential(
		tx: Parameters<Parameters<DatabaseType['transaction']>[0]>[0],
		planId: string,
		credential: string | null
	): void {
		if (credential === null) {
			tx.delete(remotePlanDatabaseCredentials)
				.where(eq(remotePlanDatabaseCredentials.planId, planId))
				.run();
		} else {
			tx.insert(remotePlanDatabaseCredentials)
				.values({ planId, encryptedPassword: credential })
				.onConflictDoUpdate({
					target: remotePlanDatabaseCredentials.planId,
					set: { encryptedPassword: credential },
				})
				.run();
		}
	}

	async create(
		planData: NewPlan,
		databaseCredential?: string | null | DatabaseCredential[]
	): Promise<Plan | null> {
		if (databaseCredential !== undefined) {
			return this.db.transaction(tx => {
				const [plan] = tx
					.insert(plans)
					.values({
						...planData,
						createdAt: sql`(unixepoch())`,
						isActive: true,
						stats: { size: 0, snapshots: [] },
					})
					.returning()
					.all();
				if (plan) {
					if (Array.isArray(databaseCredential))
						this.writeDatabaseCredentials(tx, plan.id, databaseCredential);
					else this.writeDatabaseCredential(tx, plan.id, databaseCredential);
				}
				return plan || null;
			});
		}
		const result = await this.db
			.insert(plans)
			.values({
				...planData,
				createdAt: sql`(unixepoch())`,
				isActive: true,
				stats: { size: 0, snapshots: [] },
			})
			.returning();
		return result[0] || null;
	}

	async update(
		id: string,
		updates: Partial<PlanFull | Plan>,
		databaseCredential?: string | null | DatabaseCredential[]
	): Promise<Plan | null> {
		// Only allow certain fields to be updated
		const allowedFields = [
			'title',
			'description',
			'isActive',
			'inProgress',
			'storagePath',
			'sourceConfig',
			'verified',
			'lastBackupTime',
			'tags',
			'stats',
			'settings',
		] as const;

		// Only pick allowed fields
		const updatedPlan = Object.fromEntries(
			Object.entries(updates).filter(([key]) => allowedFields.includes(key as any))
		);

		// No valid fields to update
		if (Object.keys(updatedPlan).length === 0) {
			return null;
		}
		if (databaseCredential !== undefined) {
			return this.db.transaction(tx => {
				const [plan] = tx
					.update(plans)
					.set({ ...updatedPlan, updatedAt: sql`(unixepoch())` })
					.where(eq(plans.id, id))
					.returning()
					.all();
				if (plan) {
					if (Array.isArray(databaseCredential))
						this.writeDatabaseCredentials(tx, id, databaseCredential);
					else this.writeDatabaseCredential(tx, id, databaseCredential);
				}
				return plan || null;
			});
		}

		const result = await this.db
			.update(plans)
			.set({
				...updatedPlan,
				updatedAt: sql`(unixepoch())`,
			})
			.where(eq(plans.id, id))
			.returning();

		return result[0] || null;
	}

	async delete(id: string): Promise<boolean> {
		return this.db.transaction(tx => {
			// Existing migrations can leave FK checks disabled; erase the owned
			// credential explicitly as well as using ON DELETE CASCADE.
			tx.delete(remotePlanDatabaseEntryCredentials)
				.where(eq(remotePlanDatabaseEntryCredentials.planId, id))
				.run();
			tx.delete(remotePlanDatabaseCredentials)
				.where(eq(remotePlanDatabaseCredentials.planId, id))
				.run();
			return tx.delete(plans).where(eq(plans.id, id)).run().changes > 0;
		});
	}

	async hasActiveBackups(planId: string): Promise<boolean> {
		const result = await this.db
			.select()
			.from(backups)
			.where(and(eq(backups.planId, planId), eq(backups.inProgress, true)))
			.limit(1);

		return result.length > 0;
	}

	async hasActiveRestore(planId: string): Promise<boolean> {
		const result = await this.db
			.select()
			.from(restores)
			.where(and(eq(restores.planId, planId), eq(restores.inProgress, true)))
			.limit(1);

		return result.length > 0;
	}

	async setActive(id: string, isActive: boolean): Promise<Plan | null> {
		return this.update(id, { isActive });
	}
}
