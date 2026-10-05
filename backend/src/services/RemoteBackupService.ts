import crypto from 'crypto';
import Cryptr from 'cryptr';
import { Plan, NewPlan } from '../db/schema/plans';
import { type AgentCommand, type AgentIdentity } from '../db/schema/agents';
import { type NewBackup } from '../db/schema/backups';
import { AgentStore } from '../stores/AgentStore';
import { BackupStore } from '../stores/BackupStore';
import { PlanStore } from '../stores/PlanStore';
import { RemoteManagedRepositoryStore } from '../stores/RemoteManagedRepositoryStore';
import { StorageStore } from '../stores/StorageStore';
import { CronManager } from '../managers/CronManager';
import { BackupEventService } from './events/BackupEventService';
import { intervalToCron } from '../utils/intervalToCron';
import { AppError, NotFoundError } from '../utils/AppError';
import { generateUID } from '../utils/helpers';
import type { PlanAddRunSettings, PlanSource } from '../types/plans';
import type { BackupCompletionStats, BackupProgressStats } from '../types/backups';
import { configService } from './ConfigService';
import {
	RemoteCommandPreparationError,
	type RemoteCommandPreparationFailure,
	type RemoteCommandPreparationStage,
} from './remoteCommandPreparation';

export { RemoteCommandPreparationError } from './remoteCommandPreparation';

const MINIMUM_AGENT_VERSION = [0, 2, 0] as const;
const MAX_SOURCE_PATH_LENGTH = 4_096;

/**
 * The first agent transport deliberately supports only the password-auth SFTP
 * settings already used by the standard storage form. Do not pass generic
 * rclone settings through this boundary: several SFTP options can execute an
 * external SSH binary or remote shell command, and agent-local file paths
 * would not be portable or safe to materialize.
 */
const SFTP_AGENT_OPTION_KEYS = new Set(['host', 'port', 'user', 'pass']);

type CommandReference = { backupId: string; planId: string; repositoryId: string };

type RemoteProgressEvent = {
	phase?: string;
	progress?: {
		bytesProcessed?: number;
		filesProcessed?: number;
		totalBytesProcessed?: number;
		totalFilesProcessed?: number;
	};
};

type RemoteCompletion = {
	success: boolean;
	cancelled?: boolean;
	error?: string;
	result?: {
		snapshotId?: string;
		summary?: BackupCompletionStats;
	};
};

function versionAtLeast(value: string): boolean {
	const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
	if (!match) return false;
	const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
	for (let index = 0; index < MINIMUM_AGENT_VERSION.length; index += 1) {
		if (actual[index] > MINIMUM_AGENT_VERSION[index]) return true;
		if (actual[index] < MINIMUM_AGENT_VERSION[index]) return false;
	}
	return true;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function hasUnsafeControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function validateAbsoluteLinuxPath(value: string): void {
	if (
		!value ||
		value.length > MAX_SOURCE_PATH_LENGTH ||
		!value.startsWith('/') ||
		hasUnsafeControlCharacters(value) ||
		value.split(/[\\/]+/).includes('..')
	) {
		throw new AppError(400, 'Remote backup source must be one safe absolute Linux path.');
	}
}

function validateRepositoryPath(value: string): void {
	if (!value || value.length > MAX_SOURCE_PATH_LENGTH || hasUnsafeControlCharacters(value)) {
		throw new AppError(400, 'Remote backup destination path is invalid.');
	}
	if (value.split(/[\\/]+/).includes('..')) {
		throw new AppError(400, 'Remote backup destination path cannot contain traversal.');
	}
}

function commandReference(payload: Record<string, unknown>): CommandReference {
	const backupId = payload.backupId;
	const planId = payload.planId;
	const repositoryId = payload.repositoryId;
	if (
		!isNonEmptyString(backupId) ||
		!isNonEmptyString(planId) ||
		!isNonEmptyString(repositoryId) ||
		Object.keys(payload).some(key => !['backupId', 'planId', 'repositoryId'].includes(key))
	) {
		throw new AppError(400, 'Remote backup command payload is invalid.');
	}
	return { backupId, planId, repositoryId };
}

function hasEnabledScripts(plan: Pick<Plan | NewPlan, 'settings'>): boolean {
	return Object.values(plan.settings?.scripts || {}).some(
		items => Array.isArray(items) && items.length > 0
	);
}

function toFiniteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isMeaningfulStorageValue(value: unknown): boolean {
	if (typeof value === 'string') return value.trim().length > 0;
	if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
	return value === true;
}

function isSafeSnapshotId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Fa-f0-9]{8,128}$/.test(value);
}

/**
 * A narrow orchestration path for a managed remote filesystem backup. It is
 * intentionally not a replacement for RemoteStrategy: repair, unlock, prune,
 * restores, scripts, database dumps and generic commands remain unavailable.
 */
export class RemoteBackupService {
	private readonly cronManager: CronManager<any>;
	private readonly eventService: BackupEventService;

	constructor(
		private readonly repositories: RemoteManagedRepositoryStore,
		private readonly agentStore: AgentStore,
		private readonly planStore: PlanStore,
		private readonly backupStore: BackupStore,
		private readonly storageStore: StorageStore,
		private readonly encryptionSecret = configService.config.SECRET
	) {
		this.cronManager = CronManager.getInstance<any>({
			'remote-backup': async (planId: string) => this.queueScheduledBackup(planId),
		});
		this.eventService = new BackupEventService(planStore, backupStore);
	}

	static isRemoteFilesystemPlan(plan: Pick<Plan | NewPlan, 'sourceId' | 'sourceType'>): boolean {
		return plan.sourceType === 'device' && plan.sourceId !== 'main';
	}

	async validatePlanCreation(plan: NewPlan): Promise<void> {
		await this.assertSupportedPlan(plan);
	}

	async createManagedPlan(plan: Plan, runSettings?: PlanAddRunSettings): Promise<void> {
		await this.assertSupportedPlan(plan);
		const agent = await this.getCapableAgent(plan.sourceId);
		const existing = await this.repositories.getByPlanId(plan.id);
		if (existing) throw new AppError(409, 'Remote backup repository already exists for this plan.');
		const storagePath = plan.storagePath || '';
		validateRepositoryPath(storagePath);
		const password = crypto.randomBytes(32).toString('base64url');
		const encryptedPassword = new Cryptr(this.encryptionSecret).encrypt(password);
		await this.repositories.create({
			id: `remote-repo-${generateUID(20)}`,
			planId: plan.id,
			agentId: agent.agentId,
			storageId: plan.storageId as string,
			storagePath,
			encryptedPassword,
		});
		try {
			await this.ensureSchedule(plan);
			if (runSettings?.runNow ?? true) await this.queuePlanBackup(plan.id);
		} catch (error) {
			// Queue creation can fail after the scheduler has already persisted the
			// remote entry. Remove only this workflow's schedule; another scheduler
			// type may legitimately share the plan ID.
			await this.cronManager.removeSchedulesByType(plan.id, 'remote-backup');
			await this.repositories.deleteByPlanId(plan.id);
			throw error;
		}
	}

	async updateManagedPlan(plan: Plan): Promise<void> {
		await this.assertSupportedPlan(plan);
		const repository = await this.repositories.getByPlanId(plan.id);
		if (!repository) throw new NotFoundError('Managed remote repository was not found.');
		const agent = await this.getCapableAgent(plan.sourceId);
		if (repository.agentId !== agent.agentId) {
			throw new AppError(400, 'Changing a remote backup plan to another agent is not supported.');
		}
		await this.ensureSchedule(plan);
	}

	async removeManagedPlan(plan: Plan): Promise<{ storagePath: string }> {
		const repository = await this.repositories.getByPlanId(plan.id);
		if (!repository) throw new NotFoundError('Managed remote repository was not found.');
		const backups = ((await this.backupStore.getAll()) || []).filter(
			backup => backup.planId === plan.id && backup.inProgress
		);
		for (const backup of backups) {
			await this.agentStore.cancelCommand(`remote-backup-${backup.id}`);
			await this.eventService.onBackupCancelled({ planId: plan.id, backupId: backup.id });
		}
		await this.cronManager.removeSchedulesByType(plan.id, 'remote-backup');
		await this.repositories.deleteByPlanId(plan.id);
		// This phase intentionally never deletes a remote Restic repository.
		return { storagePath: repository.storagePath };
	}

	async pausePlan(planId: string): Promise<boolean> {
		return this.cronManager.pauseSchedule(planId, 'remote-backup');
	}

	async resumePlan(planId: string): Promise<boolean> {
		return this.cronManager.resumeSchedule(planId, 'remote-backup');
	}

	async queuePlanBackup(planId: string): Promise<string> {
		const plan = await this.planStore.getById(planId);
		if (!plan) throw new NotFoundError('Plan not found.');
		await this.assertSupportedPlan(plan);
		if (!plan.isActive) return 'Remote backup plan is paused.';
		if (await this.planStore.hasActiveBackups(planId)) {
			throw new AppError(409, 'A backup is already in progress for this plan.');
		}
		const repository = await this.repositories.getByPlanId(planId);
		if (!repository) throw new NotFoundError('Managed remote repository was not found.');
		const agent = await this.getCapableAgent(plan.sourceId);
		if (agent.agentId !== repository.agentId)
			throw new AppError(409, 'Remote agent identity changed.');

		const backupId = generateUID();
		const backup: NewBackup = {
			id: backupId,
			status: 'queued',
			inProgress: true,
			started: new Date(),
			planId,
			storageId: plan.storageId,
			storagePath: repository.storagePath,
			sourceId: plan.sourceId,
			sourceType: plan.sourceType,
			sourceConfig: plan.sourceConfig,
			method: 'backup',
			encryption: true,
			compression: Boolean(plan.settings.compression),
			taskStats: null,
		};
		await this.repositories.createBackupAndCommand({
			backup,
			command: {
				id: `remote-backup-${backupId}`,
				agentId: agent.agentId,
				idempotencyKey: `remote-backup:${backupId}`,
				// Credentials and the repository password are materialized only at poll time.
				payload: { backupId, planId, repositoryId: repository.id },
			},
		});
		return 'Remote filesystem backup queued.';
	}

	async cancelBackup(
		planId: string,
		backupId: string
	): Promise<{ success: boolean; result: string }> {
		const backup = await this.backupStore.getById(backupId);
		const repository = await this.repositories.getByPlanId(planId);
		if (!backup || !repository || backup.planId !== planId || backup.sourceId === 'main') {
			throw new AppError(501, 'REMOTE_CAPABILITY_NOT_IMPLEMENTED');
		}
		if (!backup.inProgress) {
			throw new AppError(409, 'The remote backup is no longer in progress.');
		}
		await this.agentStore.cancelCommand(`remote-backup-${backupId}`);
		await this.eventService.onBackupCancelled({ planId, backupId });
		return { success: true, result: 'Remote backup cancellation requested.' };
	}

	async getBackupProgress(backupId: string): Promise<BackupProgressStats | null> {
		const backup = await this.backupStore.getById(backupId);
		const repository = backup?.planId ? await this.repositories.getByPlanId(backup.planId) : null;
		if (!backup || !repository || backup.sourceId === 'main') {
			throw new AppError(501, 'REMOTE_CAPABILITY_NOT_IMPLEMENTED');
		}
		return backup.progressStats || null;
	}

	/** Called during authenticated poll; returned data is never persisted in agent_commands. */
	async materializeCommand(
		agentId: string,
		command: AgentCommand
	): Promise<Record<string, unknown>> {
		if (command.type !== 'BACKUP_FILESYSTEM') return command.payload;
		const failure: RemoteCommandPreparationFailure = { stage: 'command-ownership' };
		const setStage = (stage: RemoteCommandPreparationStage): void => {
			failure.stage = stage;
		};
		try {
			if (command.agentId !== agentId)
				throw new AppError(403, 'Command does not belong to this agent.');
			setStage('command-reference');
			const reference = commandReference(command.payload);
			failure.backupId = reference.backupId;
			failure.planId = reference.planId;
			setStage('managed-records');
			const [repository, plan, backup] = await Promise.all([
				this.repositories.getById(reference.repositoryId),
				this.planStore.getById(reference.planId),
				this.backupStore.getById(reference.backupId),
			]);
			if (
				!repository ||
				!plan ||
				!backup ||
				backup.planId !== plan.id ||
				repository.planId !== plan.id ||
				!backup.inProgress ||
				backup.status === 'cancelled' ||
				backup.sourceId !== plan.sourceId
			) {
				setStage('managed-plan-consistency');
				throw new AppError(409, 'Remote backup command no longer has a valid managed plan.');
			}
			failure.storageId = repository.storageId;
			if (repository.agentId !== agentId) {
				setStage('repository-agent');
				throw new AppError(403, 'Managed repository belongs to another agent.');
			}
			if (repository.storageId !== plan.storageId || repository.storagePath !== plan.storagePath) {
				setStage('repository-metadata');
				throw new AppError(409, 'Managed repository metadata no longer matches the plan.');
			}
			await this.assertSupportedPlan(plan, setStage);
			setStage('repository-path');
			validateRepositoryPath(repository.storagePath);
			const storage = await this.materializeSftpStorage(repository.storageId, setStage);
			setStage('repository-secret-decryption');
			let repositoryPassword: string;
			try {
				repositoryPassword = new Cryptr(this.encryptionSecret).decrypt(repository.encryptedPassword);
			} catch {
				throw new AppError(500, 'Remote repository credentials could not be prepared.');
			}
			setStage('source-validation');
			const source = this.getSingleSource(plan.sourceConfig);
			const excludes = this.getSafeExcludes(plan.sourceConfig);
			setStage('payload');
			return {
				version: 1,
				backupId: backup.id,
				planId: plan.id,
				sourcePath: source,
				excludes,
				repository: {
					remoteName: 'pluton',
					path: repository.storagePath,
					initialize: !repository.initializedAt,
				},
				rclone: storage,
				repositoryPassword,
			};
		} catch (error) {
			if (error instanceof RemoteCommandPreparationError) throw error;
			// AgentService logs only RemoteCommandPreparationError.safeMessage.
			// Preserve the established internal AppError text for callers that need it,
			// but never retain arbitrary provider/decryption exception text.
			throw new RemoteCommandPreparationError(
				failure,
				error instanceof AppError ? error.message : undefined
			);
		}
	}

	async recordCommandEvent(command: AgentCommand, event: RemoteProgressEvent): Promise<void> {
		if (command.type !== 'BACKUP_FILESYSTEM') return;
		const reference = commandReference(command.payload);
		const backup = await this.backupStore.getById(reference.backupId);
		if (!backup || !backup.inProgress || backup.status === 'cancelled') return;
		const progress = event.progress;
		const progressStats: BackupProgressStats | undefined = progress
			? {
					bytesProcessed: toFiniteNumber(progress.bytesProcessed) || 0,
					filesProcessed: toFiniteNumber(progress.filesProcessed) || 0,
					total_bytes_processed: toFiniteNumber(progress.totalBytesProcessed) || 0,
					total_files_processed: toFiniteNumber(progress.totalFilesProcessed) || 0,
				}
			: undefined;
		await this.backupStore.update(backup.id, {
			status: event.phase === 'accepted' ? 'queued' : 'started',
			...(progressStats ? { progressStats } : {}),
		});
	}

	async completeCommand(command: AgentCommand, completion: RemoteCompletion): Promise<void> {
		if (command.type !== 'BACKUP_FILESYSTEM') return;
		const reference = commandReference(command.payload);
		if (command.state === 'cancelled' || completion.cancelled) {
			await this.eventService.onBackupCancelled({
				planId: reference.planId,
				backupId: reference.backupId,
			});
			return;
		}
		if (!completion.success) {
			await this.eventService.onBackupFailure({
				planId: reference.planId,
				backupId: reference.backupId,
				error: completion.error || 'Remote filesystem backup failed.',
			});
			return;
		}
		const summary = completion.result?.summary;
		const snapshotId = completion.result?.snapshotId;
		if (!summary || !isSafeSnapshotId(snapshotId) || summary.snapshot_id !== snapshotId) {
			await this.eventService.onBackupFailure({
				planId: reference.planId,
				backupId: reference.backupId,
				error: 'Remote agent completed without valid snapshot metadata.',
			});
			return;
		}
		await this.eventService.onBackupComplete({
			planId: reference.planId,
			backupId: reference.backupId,
			success: true,
			summary,
		});
		await this.repositories.markInitialized(reference.repositoryId);
		const plan = await this.planStore.getById(reference.planId);
		if (plan) {
			const snapshotIds = new Set([...(plan.stats?.snapshots || []), snapshotId]);
			await this.planStore.update(plan.id, {
				stats: {
					size: Math.max(plan.stats?.size || 0, summary.total_bytes_processed || 0),
					snapshots: [...snapshotIds],
				},
				lastBackupTime: new Date(),
			});
		}
	}

	async reconcileSchedules(): Promise<void> {
		const plans = (await this.planStore.getAll(false)) || [];
		const plansById = new Map(plans.map(plan => [plan.id, plan]));
		const schedules = await this.cronManager.getSchedules();
		for (const [planId, entries] of schedules) {
			if (!entries.some(entry => entry.type === 'remote-backup')) continue;
			const plan = plansById.get(planId);
			if (
				!plan ||
				!RemoteBackupService.isRemoteFilesystemPlan(plan) ||
				!(await this.repositories.getByPlanId(planId))
			) {
				await this.cronManager.removeSchedulesByType(planId, 'remote-backup');
			}
		}
		for (const plan of plans) {
			if (!RemoteBackupService.isRemoteFilesystemPlan(plan)) continue;
			if (!(await this.repositories.getByPlanId(plan.id))) continue;
			try {
				await this.ensureSchedule(plan);
			} catch {
				// Capability degradation is surfaced when the user runs the plan; startup must continue.
			}
		}
	}

	private async queueScheduledBackup(planId: string): Promise<void> {
		try {
			await this.queuePlanBackup(planId);
		} catch {
			// A later schedule run can retry; detailed source/provider diagnostics are not logged.
		}
	}

	private async ensureSchedule(plan: Plan): Promise<void> {
		const cronExpression = intervalToCron(plan.settings.interval);
		const options = {
			isActive: plan.isActive,
			taskCallback: async (planId: string) => this.queueScheduledBackup(planId),
		};
		const existing = await this.cronManager.getSchedule(plan.id);
		if (existing?.some(entry => entry.type === 'remote-backup')) {
			await this.cronManager.updateSchedule(plan.id, cronExpression, options, 'remote-backup');
		} else {
			await this.cronManager.scheduleTask(plan.id, cronExpression, options, 'remote-backup');
		}
	}

	private async assertSupportedPlan(
		plan: Plan | NewPlan,
		setPreparationStage?: (stage: RemoteCommandPreparationStage) => void
	): Promise<void> {
		setPreparationStage?.('plan-shape');
		if (!RemoteBackupService.isRemoteFilesystemPlan(plan) || plan.method !== 'backup') {
			throw new AppError(400, 'Only remote filesystem incremental backup is available.');
		}
		if (plan.settings.encryption !== true) {
			throw new AppError(
				400,
				'Remote filesystem backups require their managed repository password.'
			);
		}
		if (plan.settings.replication?.enabled || hasEnabledScripts(plan)) {
			throw new AppError(
				400,
				'Replication and scripts are not available for remote filesystem backups.'
			);
		}
		setPreparationStage?.('source-validation');
		this.getSingleSource(plan.sourceConfig);
		this.getSafeExcludes(plan.sourceConfig);
		setPreparationStage?.('repository-path');
		validateRepositoryPath(plan.storagePath || '');
		setPreparationStage?.('agent-capability');
		await this.getCapableAgent(plan.sourceId);
		setPreparationStage?.('sftp-storage-lookup');
		const storage = await this.storageStore.getById(plan.storageId as string);
		if (!storage || storage.type !== 'sftp') {
			throw new AppError(400, 'Remote filesystem backups currently require an SFTP destination.');
		}
	}

	private async getCapableAgent(deviceId: string): Promise<AgentIdentity> {
		const agent = await this.agentStore.getAgentByDeviceId(deviceId);
		const offlineTimeoutMs = (configService.config.AGENT_OFFLINE_TIMEOUT_SECONDS || 90) * 1_000;
		if (
			!agent ||
			agent.revokedAt ||
			!agent.lastSeen ||
			Date.now() - agent.lastSeen.getTime() > offlineTimeoutMs
		) {
			throw new AppError(409, 'Remote agent is not available.');
		}
		const capabilities = agent.capabilities as {
			filesystemRootsConfigured?: unknown;
			commandTypes?: unknown;
		};
		const commands = Array.isArray(capabilities.commandTypes) ? capabilities.commandTypes : [];
		if (
			capabilities.filesystemRootsConfigured !== true ||
			!commands.includes('BACKUP_FILESYSTEM') ||
			!isNonEmptyString(agent.resticVersion) ||
			!isNonEmptyString(agent.rcloneVersion) ||
			!versionAtLeast(agent.agentVersion)
		) {
			throw new AppError(409, 'Remote agent does not yet support filesystem backup.');
		}
		return agent;
	}

	private getSingleSource(sourceConfig: PlanSource): string {
		if (!Array.isArray(sourceConfig?.includes) || sourceConfig.includes.length !== 1) {
			throw new AppError(400, 'Remote filesystem backup requires exactly one source path.');
		}
		const source = sourceConfig.includes[0]?.trim() || '';
		validateAbsoluteLinuxPath(source);
		return source;
	}

	private getSafeExcludes(sourceConfig: PlanSource): string[] {
		const excludes = sourceConfig?.excludes || [];
		if (!Array.isArray(excludes) || excludes.length > 100) {
			throw new AppError(400, 'Remote backup excludes are invalid.');
		}
		return excludes.map(exclude => {
			if (typeof exclude !== 'string') {
				throw new AppError(400, 'Remote backup exclude is invalid.');
			}
			const value = exclude.trim();
			if (!value || value.length > MAX_SOURCE_PATH_LENGTH || hasUnsafeControlCharacters(value)) {
				throw new AppError(400, 'Remote backup exclude is invalid.');
			}
			if (value.split(/[\\/]+/).includes('..')) {
				throw new AppError(400, 'Remote backup exclude cannot contain traversal.');
			}
			return value;
		});
	}

	private async materializeSftpStorage(
		storageId: string,
		setPreparationStage?: (stage: RemoteCommandPreparationStage) => void
	): Promise<{
		type: 'sftp';
		options: Record<string, string>;
	}> {
		setPreparationStage?.('sftp-storage-lookup');
		const storage = await this.storageStore.getById(storageId);
		if (!storage || storage.type !== 'sftp') {
			throw new AppError(400, 'Remote filesystem backups currently require an SFTP destination.');
		}
		const encrypted = storage.credentials || {};
		const decrypted: Record<string, string> = {};
		setPreparationStage?.('sftp-credential-decryption');
		try {
			const crypt = new Cryptr(this.encryptionSecret);
			for (const [key, value] of Object.entries(encrypted)) {
				if (!SFTP_AGENT_OPTION_KEYS.has(key) || typeof value !== 'string') {
					throw new Error('unsupported SFTP credential');
				}
				decrypted[key] = crypt.decrypt(value);
			}
		} catch {
			throw new AppError(500, 'Storage credentials could not be prepared for the remote agent.');
		}
		const settings = storage.settings || {};
		const options: Record<string, string> = {};
		setPreparationStage?.('sftp-setting-allowlist');
		for (const [key, value] of Object.entries(settings)) {
			if (!isMeaningfulStorageValue(value)) continue;
			if (!SFTP_AGENT_OPTION_KEYS.has(key) || key === 'pass') {
				throw new AppError(
					400,
					'Remote filesystem backups support only SFTP host, port, username, and encrypted password credentials.'
				);
			}
		}
		setPreparationStage?.('sftp-option-validation');
		for (const [key, value] of Object.entries({ ...settings, ...decrypted })) {
			if (value === undefined || value === null || value === '') continue;
			if (!SFTP_AGENT_OPTION_KEYS.has(key)) {
				throw new AppError(400, 'Remote filesystem backup SFTP configuration is unsupported.');
			}
			const normalized = String(value).replace(/\r?\n/g, '\\n');
			if (!normalized || normalized.length > 16_384 || hasUnsafeControlCharacters(normalized)) {
				throw new AppError(400, 'SFTP configuration contains an unsafe value.');
			}
			options[key] = normalized;
		}
		setPreparationStage?.('sftp-required-credentials');
		if (!options.host || !options.user || !options.pass) {
			throw new AppError(
				400,
				'Remote filesystem backups require SFTP host, username, and password credentials.'
			);
		}
		return { type: 'sftp', options };
	}
}
