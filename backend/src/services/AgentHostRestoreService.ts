import crypto from 'crypto';
import path from 'path';
import { z } from 'zod';
import type { AgentCommand, AgentIdentity } from '../db/schema/agents';
import type { Restore } from '../db/schema/restores';
import type { Backup } from '../db/schema/backups';
import type { Plan } from '../db/schema/plans';
import type { RemoteManagedRepository } from '../db/schema/remoteManagedRepositories';
import { AgentStore } from '../stores/AgentStore';
import { BackupStore } from '../stores/BackupStore';
import { PlanStore } from '../stores/PlanStore';
import { RemoteManagedRepositoryStore } from '../stores/RemoteManagedRepositoryStore';
import { RestoreConflictError, RestoreStore } from '../stores/RestoreStore';
import type { AgentCommandSealingContext } from '../utils/agentCommandSealing';
import {
	agentHostRestoreCapability,
	agentHostRestoreFailureAdvice,
	agentHostSelectionProblem,
	AGENT_HOST_ARTIFACT_PATH,
	isAgentHostRestoreName,
	restoreFailureCodeSchema,
	restoreFailureStageSchema,
	storedRestoreAccess,
	suggestedAgentHostRestoreName,
	writableRestoreRoots,
	type AgentHostRestoreUnsupportedReason,
} from '../utils/agentHostRestore';
import { AppError, NotFoundError } from '../utils/AppError';
import { databaseIdSchema } from '../utils/remoteLifecycle';
import { serverLogger } from '../utils/logger';
import type { AgentHostRestoreConfig } from '../types/restores';
import { RemoteBackupService } from './RemoteBackupService';

const requestSchema = z
	.object({
		backupId: z.string().trim().min(1).max(160),
		planId: z.string().trim().min(1).max(160),
		root: z.string().min(1).max(1024),
		name: z.string().min(1).max(100),
		includes: z.array(z.string()).max(1024).optional(),
		excludes: z.array(z.string()).max(1024).optional(),
		databaseId: z.union([databaseIdSchema, z.literal('legacy')]).optional(),
	})
	.strict();

const referenceSchema = z
	.object({
		restoreId: z.string().regex(/^[a-f0-9]{24}$/),
		planId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
		backupId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
		repositoryId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
	})
	.strict();

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** The Agent's closed completion for RESTORE_FILESYSTEM. Never provider text. */
export const agentHostRestoreCompletionSchema = z
	.object({
		sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		leaseToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
		success: z.boolean(),
		error: z.string().trim().min(1).max(500).optional(),
		failureStage: restoreFailureStageSchema.optional(),
		failureCode: restoreFailureCodeSchema.optional(),
		cancelled: z.boolean().optional(),
		result: z
			.object({
				restoreId: z.string().regex(/^[a-f0-9]{24}$/),
				restoredSnapshotId: z.string().regex(/^[a-f0-9]{64}$/),
				targetPath: z.string().min(2).max(1200),
				totalFiles: count,
				filesRestored: count,
				totalBytes: count,
				bytesRestored: count,
				verified: z.literal(true),
				artifactSha256: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.optional(),
			})
			.strict()
			.optional(),
	})
	.strict()
	.refine(value =>
		value.success
			? !!value.result && !value.failureCode && !value.cancelled
			: !value.result && !!value.error
	);

export type AgentHostRestoreCompletion = z.infer<typeof agentHostRestoreCompletionSchema>;

export type AgentHostRestoreEvent = {
	phase?: 'accepted' | 'running';
	restoreStage?: string;
	progress?: {
		bytesProcessed?: number;
		filesProcessed?: number;
		totalBytesProcessed?: number;
		totalFilesProcessed?: number;
	};
};

type DatabaseArtifactOption = {
	databaseId: string;
	engine?: string;
	database?: string;
	path: string;
	bytes: number;
	sha256: string;
};

const unsupportedMessages: Record<AgentHostRestoreUnsupportedReason, string> = {
	'agent-missing': 'The remote agent of this plan is not enrolled.',
	'agent-revoked': 'The remote agent of this plan is revoked.',
	'agent-version': 'Restore to the Agent host needs Agent 0.9.0 or later. Upgrade the Agent first.',
	'capability-missing':
		'The Agent does not offer restore to its host. It needs Agent 0.9.0 on Linux with root-owned private Restic and Rclone.',
	'restore-policy-error':
		'The host restore policy on the Agent is invalid. The host administrator must fix /etc/pluton-agent/restore-roots.json.',
	'no-writable-root':
		'The host administrator has not approved a writable restore folder. Run "pluton-agent restore-roots approve" on the host.',
};

/**
 * Restore to an Agent host (docs/AGENT_HOST_RESTORE.md). The server only queues a
 * reference-only RESTORE_FILESYSTEM command and seals the repository secrets at poll
 * time; the Agent restores into a new folder on its own host. No restored byte
 * passes through this server.
 */
export class AgentHostRestoreService {
	constructor(
		private readonly agentStore: AgentStore,
		private readonly planStore: PlanStore,
		private readonly backupStore: BackupStore,
		private readonly restoreStore: RestoreStore,
		private readonly repositories: RemoteManagedRepositoryStore,
		private readonly remoteBackupService: RemoteBackupService,
		private readonly now: () => Date = () => new Date()
	) {}

	private async binding(
		backupId: string,
		planId: string
	): Promise<{
		backup: Backup;
		plan: Plan;
		snapshotId: string;
		repository: RemoteManagedRepository;
		agent: AgentIdentity | null;
	}> {
		const backup = await this.backupStore.getById(backupId);
		if (!backup || backup.planId !== planId) throw new NotFoundError('Backup not found.');
		if (backup.method !== 'backup' || !RemoteBackupService.isRemoteFilesystemPlan(backup))
			throw new AppError(400, 'Restore to the Agent host is available only for Managed Agent backups.');
		const plan = await this.planStore.getById(planId);
		if (!plan) throw new NotFoundError('Plan not found.');
		if (plan.sourceId !== backup.sourceId)
			throw new AppError(409, 'The backup no longer belongs to the plan source.');
		const snapshotId = backup.completionStats?.snapshot_id;
		if (
			backup.status !== 'completed' ||
			backup.success === false ||
			backup.inProgress ||
			typeof snapshotId !== 'string' ||
			!/^[a-f0-9]{64}$/.test(snapshotId)
		)
			throw new AppError(409, 'Only a completed backup with a recorded full snapshot ID can be restored.');
		const repository = await this.repositories.getByPlanId(planId);
		if (!repository) throw new AppError(409, 'The managed repository of this plan was not found.');
		const agent = await this.agentStore.getAgentByDeviceId(plan.sourceId);
		if (agent && repository.agentId !== agent.agentId)
			throw new AppError(
				409,
				'The managed repository belongs to another Agent. Restore runs only on the host that made the backup.'
			);
		return { backup, plan, snapshotId, repository, agent };
	}

	private artifacts(backup: Backup): DatabaseArtifactOption[] {
		const lifecycle = backup.completionStats?.lifecycle;
		const artifacts: DatabaseArtifactOption[] = [];
		for (const entry of lifecycle?.databases || [])
			artifacts.push({
				databaseId: entry.databaseId,
				engine: entry.engine,
				database: entry.database,
				path: entry.path,
				bytes: entry.bytes,
				sha256: entry.sha256,
			});
		if (lifecycle?.database)
			artifacts.push({ databaseId: 'legacy', ...lifecycle.database });
		return artifacts.filter(
			artifact =>
				AGENT_HOST_ARTIFACT_PATH.test(artifact.path) &&
				Number.isSafeInteger(artifact.bytes) &&
				artifact.bytes > 0 &&
				/^[a-f0-9]{64}$/.test(artifact.sha256)
		);
	}

	private support(agent: AgentIdentity | null):
		| { supported: true }
		| { supported: false; reason: AgentHostRestoreUnsupportedReason } {
		const capability = agentHostRestoreCapability(agent);
		if (!capability.supported) return capability;
		const report = storedRestoreAccess(agent?.capabilities);
		if (report?.policyError) return { supported: false, reason: 'restore-policy-error' };
		if (!writableRestoreRoots(agent?.capabilities).length)
			return { supported: false, reason: 'no-writable-root' };
		return { supported: true };
	}

	/** What the UI may offer for this backup. Never secret; roots are host-approved paths. */
	async options(backupId: string, planId: string) {
		const { backup, snapshotId, agent } = await this.binding(backupId, planId);
		const support = this.support(agent);
		const report = storedRestoreAccess(agent?.capabilities);
		return {
			supported: support.supported,
			...(support.supported
				? {}
				: { reason: support.reason, message: unsupportedMessages[support.reason] }),
			agent: agent
				? { hostname: agent.hostname, agentVersion: agent.agentVersion }
				: null,
			snapshotId,
			roots: writableRestoreRoots(agent?.capabilities).map(root => ({
				path: root.path,
				...(root.availableBytes !== undefined ? { availableBytes: root.availableBytes } : {}),
				...(root.availableInodes !== undefined ? { availableInodes: root.availableInodes } : {}),
			})),
			unavailableRoots: (report?.roots || [])
				.filter(root => root.status !== 'writable')
				.map(root => ({ path: root.path, status: root.status, code: root.code })),
			suggestedName: suggestedAgentHostRestoreName(
				agent?.hostname || 'agent',
				crypto.randomBytes(4).toString('hex'),
				this.now()
			),
			databases: this.artifacts(backup),
		};
	}

	async create(input: unknown): Promise<{ restoreId: string; target: string }> {
		const parsed = requestSchema.safeParse(input);
		if (!parsed.success) throw new AppError(400, 'The Agent host restore request is invalid.');
		const request = parsed.data;
		const { backup, plan, snapshotId, repository, agent } = await this.binding(
			request.backupId,
			request.planId
		);
		const support = this.support(agent);
		if (!support.supported || !agent)
			throw new AppError(409, unsupportedMessages[support.supported ? 'agent-missing' : support.reason]);
		if (!writableRestoreRoots(agent.capabilities).some(root => root.path === request.root))
			throw new AppError(
				409,
				'The restore folder is not a writable host-approved root reported by the Agent.'
			);
		if (!isAgentHostRestoreName(request.name))
			throw new AppError(
				400,
				'The folder name must be 1 to 100 letters, digits, dots, underscores or hyphens, start with a letter or digit and not end in .partial.'
			);
		let includes = request.includes || [];
		let excludes = request.excludes || [];
		let artifact: AgentHostRestoreConfig['artifact'];
		if (request.databaseId) {
			const found = this.artifacts(backup).find(entry => entry.databaseId === request.databaseId);
			if (!found) throw new AppError(404, 'The database dump was not found in this backup.');
			if (
				excludes.length ||
				(includes.length && (includes.length !== 1 || includes[0] !== found.path))
			)
				throw new AppError(400, 'A database dump restore restores exactly the dump file.');
			artifact = { path: found.path, bytes: found.bytes, sha256: found.sha256 };
			includes = [found.path];
			excludes = [];
		}
		const problem = agentHostSelectionProblem({ includes, excludes });
		if (problem) throw new AppError(400, problem);
		const restoreId = crypto.randomBytes(12).toString('hex');
		const target = path.posix.join(request.root, request.name);
		const commandId = `agent-restore-${restoreId}`;
		const agentHost: AgentHostRestoreConfig = {
			version: 1,
			agentId: agent.agentId,
			root: request.root,
			name: request.name,
			commandId,
			...(request.databaseId ? { databaseId: request.databaseId } : {}),
			...(artifact ? { artifact } : {}),
		};
		try {
			await this.restoreStore.createAgentHostRestore({
				restore: {
					id: restoreId,
					backupId: backup.id,
					planId: plan.id,
					storageId: backup.storageId,
					// The Agent executes this restore; a Pluton restart must not fail it.
					sourceId: plan.sourceId,
					sourceType: 'device',
					method: 'backup',
					status: 'queued',
					inProgress: true,
					taskStats: {
						total_files: 0,
						files_restored: 0,
						total_bytes: artifact?.bytes || 0,
						bytes_restored: 0,
					},
					config: {
						target,
						overwrite: 'never',
						includes,
						excludes,
						delete: false,
						snapshotId,
						agentHost,
					},
				},
				command: {
					id: commandId,
					agentId: agent.agentId,
					idempotencyKey: `agent-restore:${restoreId}`,
					payload: {
						restoreId,
						planId: plan.id,
						backupId: backup.id,
						repositoryId: repository.id,
					},
				},
			});
		} catch (error) {
			if (error instanceof RestoreConflictError) throw new AppError(409, error.message);
			throw new AppError(500, 'Could not queue the Agent host restore.');
		}
		this.audit('agent_host_restore_requested', {
			restoreId,
			planId: plan.id,
			backupId: backup.id,
			agentId: agent.agentId,
			root: request.root,
			name: request.name,
			scope: artifact ? 'database-dump' : includes.length || excludes.length ? 'partial' : 'whole',
			includeCount: includes.length,
			excludeCount: excludes.length,
			...(request.databaseId ? { databaseId: request.databaseId } : {}),
		});
		return { restoreId, target };
	}

	private reference(command: AgentCommand) {
		const parsed = referenceSchema.safeParse(command.payload);
		if (!parsed.success) throw new AppError(409, 'Agent host restore command reference is invalid.');
		return parsed.data;
	}

	/**
	 * Called during the authenticated poll. Re-checks ownership, the restore row and the
	 * Agent capability (an Agent rolled back below 0.9.0 would never acknowledge the
	 * command), then seals the repository secrets to this command and lease.
	 */
	async materializeCommand(
		agentId: string,
		command: AgentCommand,
		sealing: AgentCommandSealingContext
	): Promise<Record<string, unknown>> {
		if (command.agentId !== agentId) throw new AppError(403, 'Command does not belong to this agent.');
		const reference = this.reference(command);
		const row = await this.restoreStore.getById(reference.restoreId);
		const config = row?.config;
		const agentHost = config?.agentHost;
		if (
			!row ||
			!config ||
			!agentHost ||
			!row.inProgress ||
			row.status === 'cancelled' ||
			agentHost.commandId !== command.id ||
			agentHost.agentId !== agentId ||
			row.backupId !== reference.backupId ||
			row.planId !== reference.planId ||
			!config.snapshotId
		)
			throw new AppError(409, 'The Agent host restore is no longer valid.');
		const agent = await this.agentStore.getAgentById(agentId);
		if (!agentHostRestoreCapability(agent).supported)
			throw new AppError(409, 'The Agent no longer supports restore to its host.');
		const binding = await this.binding(reference.backupId, reference.planId);
		if (
			binding.snapshotId !== config.snapshotId ||
			binding.repository.id !== reference.repositoryId ||
			binding.plan.sourceId !== row.sourceId
		)
			throw new AppError(409, 'The backup of this restore changed.');
		const access = await this.remoteBackupService.sealedRestoreRepository({
			repositoryId: reference.repositoryId,
			planId: reference.planId,
			agentId,
			capabilities: agent?.capabilities,
			commandId: command.id,
			sealing,
		});
		if (row.status === 'queued') await this.restoreStore.update(row.id, { status: 'started' });
		this.audit('agent_host_restore_delivered', {
			restoreId: row.id,
			planId: row.planId,
			backupId: row.backupId,
			agentId,
			attempt: command.attemptCount,
		});
		return {
			version: 1,
			restoreId: row.id,
			planId: reference.planId,
			backupId: reference.backupId,
			snapshotId: config.snapshotId,
			target: { root: agentHost.root, name: agentHost.name },
			selection: { includes: config.includes || [], excludes: config.excludes || [] },
			...(agentHost.artifact ? { artifact: agentHost.artifact } : {}),
			repository: access.repository,
			rclone: access.rclone,
			sealed: access.sealed,
		};
	}

	/** A command that could not be prepared at poll is failed, never delivered. */
	async failUndeliverable(command: AgentCommand): Promise<void> {
		const parsed = referenceSchema.safeParse(command.payload);
		if (!parsed.success) return;
		const row = await this.restoreStore.getById(parsed.data.restoreId);
		if (!row?.inProgress || row.config?.agentHost?.commandId !== command.id) return;
		await this.restoreStore.update(row.id, {
			status: 'failed',
			inProgress: false,
			errorMsg:
				'The Agent host restore could not be prepared (Agent capability, plan or repository changed). Nothing was restored.',
		});
		this.audit('agent_host_restore_failed', {
			restoreId: row.id,
			planId: row.planId,
			backupId: row.backupId,
			failureStage: 'server-preparation',
		});
	}

	async recordEvent(command: AgentCommand, event: AgentHostRestoreEvent, sequence: number) {
		const parsed = referenceSchema.safeParse(command.payload);
		if (!parsed.success) return;
		const row = await this.restoreStore.getById(parsed.data.restoreId);
		if (!row?.inProgress || row.status === 'cancelled' || row.config?.agentHost?.commandId !== command.id)
			return;
		const previous = row.progressStats;
		const progress = event.progress;
		await this.restoreStore.update(row.id, {
			status: 'started',
			progressStats: {
				remoteCommandId: command.id,
				remoteAttempt: command.attemptCount,
				remoteEventSequence: sequence,
				backupStage: event.restoreStage || previous?.backupStage || 'preparing-restore',
				bytesProcessed: progress?.bytesProcessed ?? previous?.bytesProcessed ?? 0,
				filesProcessed: progress?.filesProcessed ?? previous?.filesProcessed ?? 0,
				total_bytes_processed:
					progress?.totalBytesProcessed ?? previous?.total_bytes_processed ?? 0,
				total_files_processed:
					progress?.totalFilesProcessed ?? previous?.total_files_processed ?? 0,
			},
			...(progress
				? {
						taskStats: {
							total_files: progress.totalFilesProcessed ?? row.taskStats?.total_files ?? 0,
							files_restored: progress.filesProcessed ?? row.taskStats?.files_restored ?? 0,
							total_bytes: progress.totalBytesProcessed ?? row.taskStats?.total_bytes ?? 0,
							bytes_restored: progress.bytesProcessed ?? row.taskStats?.bytes_restored ?? 0,
						},
					}
				: {}),
		});
	}

	async complete(command: AgentCommand, completion: AgentHostRestoreCompletion): Promise<void> {
		const parsed = referenceSchema.safeParse(command.payload);
		if (!parsed.success) return;
		const row = await this.restoreStore.getById(parsed.data.restoreId);
		const config = row?.config;
		const agentHost = config?.agentHost;
		if (!row || !config || !agentHost || agentHost.commandId !== command.id) return;
		if (row.status === 'completed' || row.status === 'failed') return;
		const cancelledByUser = row.status === 'cancelled';
		if (completion.success) {
			const result = completion.result!;
			const valid =
				result.restoreId === row.id &&
				result.restoredSnapshotId === config.snapshotId &&
				result.targetPath === config.target &&
				(!agentHost.artifact || result.artifactSha256 === agentHost.artifact.sha256);
			// A late success after a user cancellation is accepted only from the lease
			// that ran it (the store returns a cancelled command without checking it).
			if (cancelledByUser && (!valid || command.leaseOwner !== completion.leaseToken)) return;
			if (!valid) {
				await this.restoreStore.update(row.id, {
					status: 'failed',
					inProgress: false,
					errorMsg:
						'The Agent completed without matching restore metadata. Review the host folder before using it.',
				});
				this.audit('agent_host_restore_failed', {
					restoreId: row.id,
					planId: row.planId,
					backupId: row.backupId,
					failureStage: 'result-validation',
				});
				return;
			}
			await this.restoreStore.update(row.id, {
				status: 'completed',
				inProgress: false,
				errorMsg: cancelledByUser
					? 'The restore completed and was verified before the cancellation reached the Agent.'
					: null,
				taskStats: {
					total_files: result.totalFiles,
					files_restored: result.filesRestored,
					total_bytes: result.totalBytes,
					bytes_restored: result.bytesRestored,
				},
				config: { ...config, agentHost: { ...agentHost, verified: true } },
			});
			this.audit('agent_host_restore_completed', {
				restoreId: row.id,
				planId: row.planId,
				backupId: row.backupId,
				filesRestored: result.filesRestored,
				bytesRestored: result.bytesRestored,
				verified: true,
			});
			return;
		}
		if (cancelledByUser) return;
		const cancelled = completion.cancelled === true || completion.failureCode === 'cancelled';
		await this.restoreStore.update(row.id, {
			status: cancelled ? 'cancelled' : 'failed',
			inProgress: false,
			errorMsg: cancelled
				? `Restore cancelled. A partial folder ${agentHost.name}.partial may remain in ${agentHost.root}; review and remove it.`
				: `Agent host restore failed (${completion.failureStage || 'unknown'}/${completion.failureCode || 'unexpected'}). ${agentHostRestoreFailureAdvice(completion.failureCode)}`,
			config: {
				...config,
				agentHost: {
					...agentHost,
					...(completion.failureStage ? { failureStage: completion.failureStage } : {}),
					...(completion.failureCode ? { failureCode: completion.failureCode } : {}),
				},
			},
		});
		this.audit(cancelled ? 'agent_host_restore_cancelled' : 'agent_host_restore_failed', {
			restoreId: row.id,
			planId: row.planId,
			backupId: row.backupId,
			failureStage: completion.failureStage,
			failureCode: completion.failureCode,
		});
	}

	async cancel(row: Restore) {
		const agentHost = row.config?.agentHost;
		if (!agentHost) throw new AppError(400, 'Not an Agent host restore.');
		if (!row.inProgress) throw new AppError(409, 'The restore is no longer in progress.');
		await this.agentStore.cancelCommand(agentHost.commandId);
		await this.restoreStore.update(row.id, {
			status: 'cancelled',
			inProgress: false,
			errorMsg: `Cancellation requested. The Agent stops Restic at its next status check; a partial folder ${agentHost.name}.partial may remain in ${agentHost.root}.`,
		});
		this.audit('agent_host_restore_cancel_requested', {
			restoreId: row.id,
			planId: row.planId,
			backupId: row.backupId,
		});
		return { success: true, result: 'Agent host restore cancellation requested.' };
	}

	progress(row: Restore) {
		const agentHost = row.config?.agentHost;
		const stats = row.taskStats;
		const progress = row.progressStats;
		const finished = !row.inProgress;
		const total = stats?.total_bytes || 0;
		const done = stats?.bytes_restored || 0;
		return {
			planId: row.planId,
			backupId: row.backupId,
			restoreId: row.id,
			agentHost: agentHost
				? {
						target: row.config?.target,
						root: agentHost.root,
						name: agentHost.name,
						stage: progress?.backupStage || (row.status === 'queued' ? 'queued' : undefined),
						verified: agentHost.verified === true,
						...(agentHost.failureStage ? { failureStage: agentHost.failureStage } : {}),
						...(agentHost.failureCode ? { failureCode: agentHost.failureCode } : {}),
					}
				: undefined,
			events: [
				{
					phase: finished ? 'finished' : 'restore',
					completed: finished,
					timestamp: new Date().toISOString(),
					action: !finished
						? 'RESTORE_OPERATION_START'
						: row.status === 'completed'
							? 'TASK_COMPLETED'
							: row.status === 'cancelled'
								? 'TASK_CANCELLED'
								: 'TASK_FAILED',
					message:
						row.errorMsg ||
						(row.status === 'queued'
							? 'Waiting for the Agent to pick up the restore.'
							: !finished
								? `Restoring on the Agent host into ${row.config?.target}.partial.`
								: `Restored and verified on the Agent host in ${row.config?.target}.`),
					resticData: {
						...stats,
						message_type: row.status === 'completed' ? 'summary' : 'status',
						percent_done: row.status === 'completed' ? 1 : total ? Math.min(done / total, 0.99) : 0,
					},
					progress: {
						totalFilesProcessed: stats?.total_files || 0,
						filesProcessed: stats?.files_restored || 0,
						totalBytesProcessed: total,
						bytesProcessed: done,
					},
				},
			],
			status: row.status,
			success: row.status === 'completed',
		};
	}

	stats(row: Restore) {
		if (row.status !== 'completed')
			return { success: false, result: 'Agent host restore results are not available.' };
		return {
			success: true,
			result: {
				target: row.config?.target,
				verified: row.config?.agentHost?.verified === true,
				stats: row.taskStats,
				// The file list stays on the host; Pluton never reads restored content back.
				restoredPaths: [],
			},
		};
	}

	assertDeletable(row: Restore): void {
		if (row.inProgress)
			throw new AppError(409, 'Cancel the Agent host restore before removing its record.');
	}

	private audit(event: string, details: Record<string, unknown>): void {
		serverLogger?.info({ agentEvent: event, ...details }, 'Agent host restore');
	}
}

export { unsupportedMessages as agentHostRestoreUnsupportedMessages };
