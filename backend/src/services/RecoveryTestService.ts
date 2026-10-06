import crypto from 'crypto';
import path from 'path';
import type { BackupStore } from '../stores/BackupStore';
import type { PlanStore } from '../stores/PlanStore';
import type { RecoveryTestStore } from '../stores/RecoveryTestStore';
import type { RecoveryTest } from '../db/schema/recoveryTests';
import type {
	RecoveryCode,
	RecoveryResult,
	RecoveryStage,
	RecoveryWarning,
} from '../types/recoveryTests';
import type { RemoteRepositoryRecoveryService } from './RemoteRepositoryRecoveryService';
import { RemoteBackupService } from './RemoteBackupService';
import { ManagedRepositoryAccessError } from '../utils/restic/ManagedSftpRepositorySession';
import { RecoveryDatabaseImporter } from '../utils/recoveryDatabaseImport';
import {
	checkRecoveryCancellation,
	recoveryArtifacts,
	RecoveryTestError,
	validateRecoveryArtifact,
} from '../utils/recoveryValidation';
import { RecoveryWorkspace } from '../utils/recoveryWorkspace';
import { appPaths } from '../utils/AppPaths';
import { AppError, NotFoundError } from '../utils/AppError';
import { planLogger } from '../utils/logger';

/** Durable jobs and a separate result. No backup writes or source-agent calls. */
export class RecoveryTestService {
	private tickCompletion?: Promise<void>;
	private stopping = false;
	private running?: { id: string; controller: AbortController; done: Promise<void> };
	private readonly workspace: RecoveryWorkspace;
	private readonly importer: RecoveryDatabaseImporter;
	constructor(
		private readonly store: RecoveryTestStore,
		private readonly plans: PlanStore,
		private readonly backups: BackupStore,
		private readonly recovery: Pick<RemoteRepositoryRecoveryService, 'testBinding' | 'testRestore'>,
		root = path.join(appPaths.getDataDir(), 'recovery-tests'),
		importer?: RecoveryDatabaseImporter
	) {
		this.workspace = new RecoveryWorkspace(root);
		this.importer = importer || new RecoveryDatabaseImporter(store);
	}
	private async ownedPlan(planId: string) {
		const plan = await this.plans.getById(planId, false);
		if (!plan) throw new NotFoundError('Plan not found.');
		if (!RemoteBackupService.isRemoteFilesystemPlan(plan))
			throw new AppError(400, 'Recovery testing supports remote managed filesystem plans only.');
		return plan;
	}
	async configuration(planId: string) {
		await this.ownedPlan(planId);
		return { policy: await this.store.policy(planId), targets: await this.store.targets(planId) };
	}
	async savePolicy(planId: string, input: unknown) {
		await this.ownedPlan(planId);
		return this.store.savePolicy(planId, input);
	}
	async saveTarget(planId: string, input: unknown) {
		await this.ownedPlan(planId);
		await this.store.saveTarget(planId, input);
		return this.configuration(planId);
	}
	async list(planId: string, backupIds?: string[]) {
		await this.ownedPlan(planId);
		return this.store.list(planId, backupIds);
	}
	async get(planId: string, id: string) {
		await this.ownedPlan(planId);
		const row = await this.store.get(id);
		if (!row || row.planId !== planId) throw new NotFoundError('Recovery test not found.');
		return row;
	}
	async enqueue(planId: string, backupId: string, trigger: 'manual' | 'after_backup' = 'manual') {
		await this.ownedPlan(planId);
		const policy = await this.store.policy(planId);
		if (trigger === 'after_backup' && !policy.enabled) return null;
		let binding;
		try {
			binding = await this.recovery.testBinding(backupId, planId);
		} catch {
			throw new RecoveryTestError('snapshot-validation', 'snapshot-binding-mismatch');
		}
		return this.store.enqueue({
			id: crypto.randomBytes(12).toString('hex'),
			...binding,
			status: 'queued',
			trigger,
			policy,
			automationKey:
				trigger === 'after_backup' ? `after-backup:${backupId}:${binding.snapshotId}` : null,
		});
	}
	/** Non-blocking task, dispatched by the existing JobProcessor. Global concurrency = 1. */
	tick(): Promise<void> {
		if (this.running || this.stopping) return Promise.resolve();
		return (this.tickCompletion ||= this.dispatch().finally(() => {
			this.tickCompletion = undefined;
		}));
	}
	private async dispatch(): Promise<void> {
		for (const backupId of await this.store.automaticCandidates()) {
			const backup = await this.backups.getById(backupId);
			if (backup?.planId) {
				try {
					await this.enqueue(backup.planId, backupId, 'after_backup');
				} catch {
					this.log(
						backup.planId,
						backupId,
						'automatic-enqueue-failed',
						'job',
						'snapshot-binding-mismatch'
					);
				}
			}
		}
		const row = await this.store.claim();
		if (!row) return;
		const controller = new AbortController();
		if (this.stopping || (await this.store.get(row.id))?.cancelRequested) controller.abort();
		// Install the active controller before execution starts, including a
		// cancellation that races a queued -> running transactional claim.
		const done = Promise.resolve().then(() => this.execute(row, controller.signal));
		this.running = { id: row.id, controller, done };
		void done
			.catch(() =>
				this.log(row.planId, row.backupId, 'result-persistence-failed', 'job', 'unexpected', row.id)
			)
			.finally(() => {
				this.running = undefined;
			});
	}
	/** Useful for orderly shutdown/tests; HTTP disconnect never cancels a durable job. */
	async idle() {
		await this.running?.done;
	}
	async cancel(planId: string, id: string) {
		const row = await this.get(planId, id);
		if (!['queued', 'running'].includes(row.status)) return row;
		await this.store.requestCancellation(id);
		if (this.running?.id === id) {
			this.running.controller.abort();
			await this.running.done;
		}
		return this.get(planId, id);
	}
	async shutdown() {
		this.stopping = true;
		await this.tickCompletion;
		if (this.running) {
			this.running.controller.abort();
			await this.running.done;
		}
	}
	private log(
		planId: string,
		backupId: string,
		event: string,
		stage: RecoveryStage,
		code?: RecoveryCode,
		recoveryTestId?: string
	) {
		planLogger('restore', planId, backupId).warn(
			{ event: `recovery_test_${event}`, recoveryTestId, stage, code },
			'Recovery test checkpoint.'
		);
	}
	private async execute(row: RecoveryTest, signal: AbortSignal) {
		let stage: RecoveryStage = 'snapshot-validation';
		let failure: RecoveryTestError | undefined;
		const warnings: RecoveryWarning[] = [];
		const result: RecoveryResult = {
			databases: [],
			cleanup: { workspace: false, databases: false },
		};
		const setStage = (value: RecoveryStage) => {
			stage = value;
			this.log(row.planId, row.backupId, 'stage', value, undefined, row.id);
		};
		let directory: string | undefined;
		try {
			checkRecoveryCancellation(signal);
			const backup = await this.backups.getById(row.backupId);
			if (
				!backup ||
				backup.planId !== row.planId ||
				backup.completionStats?.snapshot_id !== row.snapshotId
			)
				throw new RecoveryTestError('snapshot-validation', 'snapshot-binding-mismatch');
			if ((await this.store.get(row.id))?.cancelRequested)
				throw new RecoveryTestError('job', 'cancelled');
			directory = await this.workspace.create(row.id);
			const files = path.join(directory, 'files');
			const { databaseArtifactPaths, ...filesystem } = await this.recovery.testRestore(
				row,
				files,
				signal,
				setStage,
				async () => {
					await this.workspace.assert(row.id);
				},
				1024 ** 4,
				() => {
					warnings.push({ stage: 'workspace-cleanup', code: 'workspace-cleanup-failed' });
				}
			);
			result.filesystem = filesystem;
			setStage('database-artifact-validation');
			result.databases = recoveryArtifacts(backup.completionStats?.lifecycle);
			if (
				databaseArtifactPaths.some(
					artifact => !result.databases.some(entry => entry.path === artifact)
				)
			)
				throw new RecoveryTestError('database-artifact-validation', 'database-metadata-incomplete');
			const artifacts = new Map<string, string>();
			for (const entry of result.databases)
				artifacts.set(entry.path, await validateRecoveryArtifact(entry, files, signal));
			for (const entry of result.databases) {
				checkRecoveryCancellation(signal);
				if (row.policy.databaseImport === 'disabled') {
					entry.importValidation = 'disabled';
					warnings.push({ stage: 'database-import', code: 'import-disabled' });
					continue;
				}
				setStage('database-target-preflight');
				if (!entry.engine || !entry.database) {
					entry.importValidation = 'not_configured';
					entry.failureCode = 'database-metadata-incomplete';
					throw new RecoveryTestError(stage, 'database-metadata-incomplete');
				}
				let saved;
				try {
					saved = await this.store.target(row.planId, entry.engine);
				} catch {
					entry.importValidation = 'not_configured';
					entry.failureCode = 'recovery-target-not-configured';
					throw new RecoveryTestError(stage, 'recovery-target-not-configured');
				}
				if (!saved) {
					entry.importValidation = 'not_configured';
					entry.failureCode = 'recovery-target-not-configured';
					throw new RecoveryTestError(stage, 'recovery-target-not-configured');
				}
				const { id: targetId, ...target } = saved;
				await this.importer.importDatabase({
					testId: row.id,
					targetId,
					target,
					entry,
					file: artifacts.get(entry.path)!,
					directory,
					signal,
					stage: setStage,
					allowedDatabases: result.databases
						.filter(value => value.engine === entry.engine)
						.map(value => value.database!)
						.filter(Boolean),
				});
			}
		} catch (error) {
			failure = signal.aborted
				? new RecoveryTestError(stage, 'cancelled')
				: error instanceof RecoveryTestError
					? error
					: error instanceof ManagedRepositoryAccessError
						? new RecoveryTestError(
								stage,
								error.code === 'wrong-password'
									? 'repository-auth-failed'
									: error.code === 'timeout'
										? 'restore-timeout'
										: 'repository-access-failed'
							)
						: new RecoveryTestError(
								stage,
								stage === 'snapshot-validation' ? 'snapshot-binding-mismatch' : 'unexpected'
							);
			this.log(row.planId, row.backupId, 'failed', failure.stage, failure.code, row.id);
		} finally {
			setStage('database-cleanup');
			let databasesClean = true;
			try {
				for (const lease of await this.store.leases(row.id)) {
					if (!directory) {
						databasesClean = false;
						warnings.push({ stage: 'database-cleanup', code: 'database-cleanup-failed' });
						continue;
					}
					try {
						await this.importer.cleanup(lease, directory);
					} catch {
						databasesClean = false;
						warnings.push({ stage: 'database-cleanup', code: 'database-cleanup-failed' });
					}
				}
			} catch {
				databasesClean = false;
				warnings.push({ stage: 'database-cleanup', code: 'database-cleanup-failed' });
			}
			result.cleanup.databases = databasesClean;
			setStage('workspace-cleanup');
			try {
				await this.workspace.remove(row.id);
				result.cleanup.workspace = true;
			} catch {
				warnings.push({ stage: 'workspace-cleanup', code: 'workspace-cleanup-failed' });
				planLogger('restore', row.planId, row.backupId).warn(
					{
						event: 'recovery_test_workspace_cleanup_failed',
						recoveryTestId: row.id,
						workspace: this.workspace.path(row.id),
					},
					'Inspect this exact inactive recovery workspace.'
				);
			}
		}
		const cancelled = signal.aborted || (await this.store.get(row.id))?.cancelRequested;
		await this.store.update(row.id, {
			status: cancelled
				? 'cancelled'
				: failure
					? 'failed'
					: warnings.length
						? 'passed_with_warning'
						: 'passed',
			completedAt: new Date(),
			result,
			warnings,
			failureStage: cancelled ? 'job' : failure?.stage || null,
			failureCode: cancelled ? 'cancelled' : failure?.code || null,
		});
	}
	/** Running work is not resumed after a crash. Cleanup requires the durable DB owner marker. */
	async recoverInterrupted() {
		const interrupted = await this.store.interrupted();
		const leases = await this.store.leases();
		const ids = new Set([
			...interrupted.map(row => row.id),
			...leases.map(lease => lease.testId),
			...(await this.store.cleanupCandidates()).map(row => row.id),
		]);
		for (const id of ids) {
			const row = await this.store.get(id);
			if (!row || ['queued', 'running'].includes(row.status)) continue;
			let directory: string | undefined;
			const warnings = row.warnings.filter(
				warning => !['database-cleanup', 'workspace-cleanup'].includes(warning.stage)
			);
			let databasesClean = true,
				workspaceClean = true;
			try {
				try {
					directory = await this.workspace.assert(id);
				} catch {
					directory = await this.workspace.create(id);
				}
				for (const lease of leases.filter(value => value.testId === id)) {
					try {
						await this.importer.cleanup(lease, directory);
					} catch {
						databasesClean = false;
						warnings.push({ stage: 'database-cleanup', code: 'database-cleanup-failed' });
					}
				}
			} catch {
				databasesClean = !leases.some(lease => lease.testId === id);
				workspaceClean = false;
				warnings.push({ stage: 'workspace-cleanup', code: 'unsafe-workspace' });
			}
			try {
				await this.workspace.remove(id);
			} catch {
				workspaceClean = false;
				warnings.push({ stage: 'workspace-cleanup', code: 'workspace-cleanup-failed' });
			}
			await this.store.update(id, {
				warnings,
				...(row.result
					? {
							result: {
								...row.result,
								cleanup: { databases: databasesClean, workspace: workspaceClean },
							},
						}
					: {}),
			});
		}
	}
}
