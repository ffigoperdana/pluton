import crypto from 'crypto';
import Cryptr from 'cryptr';
import { and, asc, desc, eq, inArray, sql, notExists, or, gt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DatabaseType } from '../db';
import { backups } from '../db/schema/backups';
import { plans } from '../db/schema/plans';
import { remoteManagedRepositories } from '../db/schema/remoteManagedRepositories';
import {
	recoveryTests,
	recoveryTargets,
	recoveryTestPolicies,
	recoveryImportLeases,
	type RecoveryTest,
	type NewRecoveryTest,
	type RecoveryImportLease,
} from '../db/schema/recoveryTests';
import type {
	RecoveryEngine,
	RecoveryPolicy,
	RecoveryTarget,
	RecoveryTargetView,
} from '../types/recoveryTests';
import {
	defaultRecoveryPolicy,
	parseRecoveryInput,
	recoveryPolicySchema,
	recoveryTargetSchema,
} from '../utils/recoveryTestPolicy';
import { AppError, NotFoundError } from '../utils/AppError';

const active = ['queued', 'running'] as const;
export class RecoveryTestStore {
	constructor(
		private readonly db: DatabaseType,
		private readonly secret: string
	) {}

	async get(id: string): Promise<RecoveryTest | null> {
		return this.db.select().from(recoveryTests).where(eq(recoveryTests.id, id)).get() || null;
	}
	async list(planId: string, backupIds: string[] = []): Promise<RecoveryTest[]> {
		const recent = this.db
			.select()
			.from(recoveryTests)
			.where(eq(recoveryTests.planId, planId))
			.orderBy(desc(recoveryTests.createdAt), desc(sql`rowid`))
			.limit(200)
			.all();
		if (!backupIds.length) return recent;
		// Keep the latest result for every displayed backup, even after many
		// manual retests push it outside the bounded recent-attempt history.
		const newer = alias(recoveryTests, 'newer');
		return this.db
			.select()
			.from(recoveryTests)
			.where(
				and(
					eq(recoveryTests.planId, planId),
					or(
						inArray(
							recoveryTests.id,
							recent.map(row => row.id)
						),
						and(
							inArray(recoveryTests.backupId, backupIds),
							notExists(
								this.db
									.select({ id: newer.id })
									.from(newer)
									.where(
										and(
											eq(newer.planId, recoveryTests.planId),
											eq(newer.backupId, recoveryTests.backupId),
											or(
												gt(newer.createdAt, recoveryTests.createdAt),
												and(
													eq(newer.createdAt, recoveryTests.createdAt),
													sql`newer.rowid > recovery_tests.rowid`
												)
											)
										)
									)
							)
						)
					)
				)
			)
			.orderBy(desc(recoveryTests.createdAt), desc(sql`recovery_tests.rowid`))
			.all();
	}
	async update(id: string, changes: Partial<RecoveryTest>) {
		return this.db
			.update(recoveryTests)
			.set(changes)
			.where(eq(recoveryTests.id, id))
			.returning()
			.get();
	}
	async policy(planId: string): Promise<RecoveryPolicy> {
		return (
			this.db
				.select()
				.from(recoveryTestPolicies)
				.where(eq(recoveryTestPolicies.planId, planId))
				.get()?.policy || defaultRecoveryPolicy
		);
	}
	async savePolicy(planId: string, input: unknown): Promise<RecoveryPolicy> {
		const policy = parseRecoveryInput(recoveryPolicySchema, input);
		return this.db.transaction(tx => {
			if (!tx.select().from(plans).where(eq(plans.id, planId)).get())
				throw new NotFoundError('Plan not found.');
			const previous = tx
				.select()
				.from(recoveryTestPolicies)
				.where(eq(recoveryTestPolicies.planId, planId))
				.get()?.policy;
			const saved = {
				...policy,
				enabledAt: policy.enabled
					? previous?.enabled
						? previous.enabledAt
						: Math.floor(Date.now() / 1000) * 1000
					: undefined,
			};
			tx.insert(recoveryTestPolicies)
				.values({ planId, policy: saved })
				.onConflictDoUpdate({
					target: recoveryTestPolicies.planId,
					set: { policy: saved },
				})
				.run();
			return saved;
		});
	}
	async targets(planId: string): Promise<RecoveryTargetView[]> {
		return this.db
			.select()
			.from(recoveryTargets)
			.where(eq(recoveryTargets.planId, planId))
			.all()
			.map(row => ({ ...row.config, passwordConfigured: !!row.encryptedPassword }));
	}
	async saveTarget(planId: string, input: unknown): Promise<void> {
		const parsed = parseRecoveryInput(recoveryTargetSchema, input);
		const { password, ...config } = parsed;
		this.db.transaction(tx => {
			if (
				tx
					.select()
					.from(recoveryTests)
					.where(and(eq(recoveryTests.planId, planId), inArray(recoveryTests.status, [...active])))
					.get()
			)
				throw new AppError(409, 'Wait for the recovery test to finish before changing its target.');
			const previous = tx
				.select()
				.from(recoveryTargets)
				.where(and(eq(recoveryTargets.planId, planId), eq(recoveryTargets.engine, config.engine)))
				.get();
			if (
				previous &&
				tx
					.select()
					.from(recoveryImportLeases)
					.where(eq(recoveryImportLeases.targetId, previous.id))
					.get()
			)
				throw new AppError(
					409,
					'Resolve the outstanding recovery database cleanup before changing this target.'
				);
			if (!tx.select().from(plans).where(eq(plans.id, planId)).get())
				throw new NotFoundError('Plan not found.');
			const encryptedPassword = password
				? new Cryptr(this.secret).encrypt(password)
				: previous?.encryptedPassword;
			if (!encryptedPassword)
				throw new AppError(400, 'A separate recovery target password is required.');
			tx.insert(recoveryTargets)
				.values({
					id: previous?.id || crypto.randomBytes(12).toString('hex'),
					planId,
					engine: config.engine,
					config,
					encryptedPassword,
				})
				.onConflictDoUpdate({
					target: [recoveryTargets.planId, recoveryTargets.engine],
					set: { config, encryptedPassword },
				})
				.run();
		});
	}
	async target(
		planId: string,
		engine: RecoveryEngine
	): Promise<(RecoveryTarget & { id: string }) | null> {
		const row = this.db
			.select()
			.from(recoveryTargets)
			.where(and(eq(recoveryTargets.planId, planId), eq(recoveryTargets.engine, engine)))
			.get();
		if (!row?.config.enabled) return null;
		return this.materialize(row);
	}
	async leaseTarget(targetId: string): Promise<RecoveryTarget | null> {
		const row = this.db
			.select()
			.from(recoveryTargets)
			.where(eq(recoveryTargets.id, targetId))
			.get();
		if (!row) return null;
		const { id: _id, ...target } = this.materialize(row);
		return target;
	}
	async assertPlanRemovable(planId: string): Promise<void> {
		if (
			this.db
				.select()
				.from(recoveryTests)
				.where(and(eq(recoveryTests.planId, planId), inArray(recoveryTests.status, [...active])))
				.get() ||
			this.db
				.select()
				.from(recoveryImportLeases)
				.innerJoin(recoveryTests, eq(recoveryTests.id, recoveryImportLeases.testId))
				.where(eq(recoveryTests.planId, planId))
				.get()
		)
			throw new AppError(409, 'Finish recovery testing and its cleanup before removing this plan.');
	}
	async requestCancellation(id: string): Promise<RecoveryTest | null> {
		return this.db.transaction(tx => {
			const row = tx.select().from(recoveryTests).where(eq(recoveryTests.id, id)).get();
			if (!row || !active.includes(row.status as (typeof active)[number])) return row || null;
			return tx
				.update(recoveryTests)
				.set({
					cancelRequested: true,
					...(row.status === 'queued'
						? {
								status: 'cancelled' as const,
								completedAt: new Date(),
								failureStage: 'job' as const,
								failureCode: 'cancelled' as const,
							}
						: {}),
				})
				.where(eq(recoveryTests.id, id))
				.returning()
				.get();
		});
	}
	async cleanupCandidates(): Promise<RecoveryTest[]> {
		return this.db
			.select()
			.from(recoveryTests)
			.all()
			.filter(
				row =>
					!active.includes(row.status as (typeof active)[number]) &&
					row.warnings.some(
						warning =>
							warning.code === 'workspace-cleanup-failed' || warning.code === 'unsafe-workspace'
					)
			);
	}
	private materialize(row: typeof recoveryTargets.$inferSelect): RecoveryTarget & { id: string } {
		try {
			const target = parseRecoveryInput(recoveryTargetSchema, {
				...row.config,
				password: new Cryptr(this.secret).decrypt(row.encryptedPassword),
			});
			if (!target.password) throw new Error();
			return { ...target, password: target.password, id: row.id };
		} catch {
			throw new AppError(409, 'Recovery target credentials are unavailable.');
		}
	}

	async enqueue(row: NewRecoveryTest): Promise<RecoveryTest> {
		return this.db.transaction(tx => {
			const backup = tx.select().from(backups).where(eq(backups.id, row.backupId)).get();
			const plan = tx.select().from(plans).where(eq(plans.id, row.planId)).get();
			const repo = tx
				.select()
				.from(remoteManagedRepositories)
				.where(eq(remoteManagedRepositories.id, row.repositoryId))
				.get();
			if (
				!backup ||
				!plan ||
				!repo ||
				backup.planId !== row.planId ||
				repo.planId !== row.planId ||
				backup.completionStats?.snapshot_id !== row.snapshotId ||
				!/^[a-f0-9]{64}$/.test(row.snapshotId) ||
				backup.status !== 'completed' ||
				backup.inProgress ||
				backup.success === false ||
				backup.method !== 'backup' ||
				backup.sourceType !== 'device' ||
				backup.sourceId === 'main' ||
				backup.storageId !== repo.storageId ||
				backup.storagePath !== repo.storagePath ||
				plan.storageId !== repo.storageId ||
				plan.storagePath !== repo.storagePath ||
				!repo.initializedAt
			)
				throw new AppError(409, 'Recovery snapshot binding is unavailable.');
			if (row.automationKey) {
				const prior = tx
					.select()
					.from(recoveryTests)
					.where(eq(recoveryTests.automationKey, row.automationKey))
					.get();
				if (prior) return prior;
			}
			const current = tx
				.select()
				.from(recoveryTests)
				.where(
					and(eq(recoveryTests.planId, row.planId), inArray(recoveryTests.status, [...active]))
				)
				.get();
			if (current) {
				if (current.backupId === row.backupId && current.snapshotId === row.snapshotId)
					return current;
				throw new AppError(409, 'One recovery test is already queued or running for this plan.');
			}
			return tx.insert(recoveryTests).values(row).returning().get();
		});
	}
	/** One global worker, claimed transactionally even if multiple ticks arrive. */
	async claim(): Promise<RecoveryTest | null> {
		return this.db.transaction(tx => {
			if (tx.select().from(recoveryTests).where(eq(recoveryTests.status, 'running')).get())
				return null;
			const row = tx
				.select()
				.from(recoveryTests)
				.where(eq(recoveryTests.status, 'queued'))
				.orderBy(asc(recoveryTests.createdAt))
				.get();
			if (!row) return null;
			return (
				tx
					.update(recoveryTests)
					.set({ status: 'running', startedAt: new Date() })
					.where(and(eq(recoveryTests.id, row.id), eq(recoveryTests.status, 'queued')))
					.returning()
					.get() || null
			);
		});
	}
	async automaticCandidates() {
		const policies = this.db
			.select()
			.from(recoveryTestPolicies)
			.all()
			.filter(row => row.policy.enabled);
		const candidates: string[] = [];
		for (const row of policies) {
			if (
				this.db
					.select()
					.from(recoveryTests)
					.where(
						and(eq(recoveryTests.planId, row.planId), inArray(recoveryTests.status, [...active]))
					)
					.get()
			)
				continue;
			const history = this.db
				.select()
				.from(backups)
				.where(and(eq(backups.planId, row.planId), eq(backups.status, 'completed')))
				.orderBy(asc(backups.ended))
				.all();
			for (const backup of history) {
				const snapshot = backup.completionStats?.snapshot_id;
				if (
					!backup.inProgress &&
					backup.success !== false &&
					backup.ended &&
					backup.ended.getTime() >= (row.policy.enabledAt || Number.MAX_SAFE_INTEGER) &&
					snapshot &&
					/^[a-f0-9]{64}$/.test(snapshot) &&
					!this.db
						.select()
						.from(recoveryTests)
						.where(
							and(eq(recoveryTests.backupId, backup.id), eq(recoveryTests.snapshotId, snapshot))
						)
						.get()
				) {
					candidates.push(backup.id);
					break;
				}
			}
		}
		return candidates;
	}
	async interrupted() {
		const rows = this.db
			.select()
			.from(recoveryTests)
			.where(eq(recoveryTests.status, 'running'))
			.all();
		for (const row of rows)
			await this.update(row.id, {
				status: row.cancelRequested ? 'cancelled' : 'failed',
				completedAt: new Date(),
				failureStage: 'job',
				failureCode: 'interrupted',
			});
		return rows;
	}
	async leases(testId?: string): Promise<RecoveryImportLease[]> {
		return testId
			? this.db
					.select()
					.from(recoveryImportLeases)
					.where(eq(recoveryImportLeases.testId, testId))
					.all()
			: this.db.select().from(recoveryImportLeases).all();
	}
	async addLease(lease: RecoveryImportLease) {
		this.db.insert(recoveryImportLeases).values(lease).run();
	}
	async removeLease(id: string) {
		this.db.delete(recoveryImportLeases).where(eq(recoveryImportLeases.id, id)).run();
	}
}
