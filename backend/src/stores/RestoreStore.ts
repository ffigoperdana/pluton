import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm/sql';
import { DatabaseType } from '../db';
import { Restore, NewRestore, restores } from '../db/schema/restores';
import { agentCommands } from '../db/schema/agents';

/** Thrown inside the Agent host restore transaction; mapped to HTTP 409 by the service. */
export class RestoreConflictError extends Error {}

/**
 * RestoreStore is a class for managing restore records in the database.
 */
export class RestoreStore {
	constructor(private db: DatabaseType) {}

	async getAll(): Promise<Restore[] | null> {
		const restores = await this.db.query.restores.findMany();
		return restores || null;
	}

	async getById(restoreId: string): Promise<Restore | null> {
		const restore = await this.db.query.restores.findFirst({
			where: eq(restores.id, restoreId),
		});

		return restore || null;
	}

	async create(restoreData: NewRestore): Promise<Restore | null> {
		const result = await this.db
			.insert(restores)
			.values({ ...restoreData, started: sql`(unixepoch())` })
			.returning();
		return result[0] || null;
	}

	/**
	 * Restore to an Agent host (docs/AGENT_HOST_RESTORE.md 8.1): the restore row and its
	 * reference-only RESTORE_FILESYSTEM command are written in one transaction, after
	 * checking that no restore of the backup and no restore into the same host folder
	 * is still in progress.
	 */
	async createAgentHostRestore(input: {
		restore: NewRestore;
		command: {
			id: string;
			agentId: string;
			idempotencyKey: string;
			payload: { restoreId: string; planId: string; backupId: string; repositoryId: string };
		};
	}): Promise<Restore> {
		const backupId = input.restore.backupId;
		const target = input.restore.config?.target;
		if (!backupId || !target) throw new Error('Agent host restore requires a backup and target.');
		return this.db.transaction(tx => {
			const running = tx
				.select({ id: restores.id, backupId: restores.backupId, config: restores.config })
				.from(restores)
				.where(eq(restores.inProgress, true))
				.all();
			if (running.some(row => row.backupId === backupId))
				throw new RestoreConflictError('A restoration is already in progress for this backup.');
			if (
				running.some(
					row =>
						row.config?.agentHost &&
						row.config.agentHost.agentId === input.command.agentId &&
						row.config.target === target
				)
			)
				throw new RestoreConflictError('Another restore into this host folder is in progress.');
			const restore = tx
				.insert(restores)
				.values({ ...input.restore, started: sql`(unixepoch())` })
				.returning()
				.get();
			if (!restore) throw new Error('Could not create the restore record.');
			const command = tx
				.insert(agentCommands)
				.values({
					id: input.command.id,
					agentId: input.command.agentId,
					type: 'RESTORE_FILESYSTEM',
					payload: input.command.payload,
					idempotencyKey: input.command.idempotencyKey,
				})
				.returning()
				.get();
			if (!command) throw new Error('Could not enqueue the Agent host restore command.');
			return restore;
		});
	}

	async update(
		id: string,
		updates: Partial<NewRestore>,
		identifier: 'id' | 'backupId' = 'id'
	): Promise<Restore | null> {
		const ended =
			updates.status === 'completed' ||
			updates.status === 'failed' ||
			updates.status === 'cancelled';

		const result = await this.db
			.update(restores)
			.set({
				...updates,
				updatedAt: sql`(unixepoch())`,
				ended: ended ? sql`(unixepoch())` : null,
			})
			.where(eq(identifier === 'backupId' ? restores.backupId : restores.id, id))
			.returning();

		return result[0] || null;
	}

	async isRestoreRunning(backupId: string): Promise<boolean> {
		const restore = await this.db.query.restores.findFirst({
			where: and(eq(restores.backupId, backupId), eq(restores.inProgress, true)),
		});

		return restore?.inProgress === true || false;
	}

	async delete(id: string): Promise<boolean> {
		const result = await this.db.delete(restores).where(eq(restores.id, id));

		return result.changes > 0;
	}

	async deleteByPlanId(planId: string): Promise<boolean> {
		const result = await this.db.delete(restores).where(eq(restores.planId, planId));
		return result.changes > 0;
	}
}
