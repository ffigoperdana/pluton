import Cryptr from 'cryptr';
import {
	RemoteBackupService,
	RemoteCommandPreparationError,
} from '../../src/services/RemoteBackupService';
import type { AgentCommand } from '../../src/db/schema/agents';
import { serverLogger } from '../../src/utils/logger';
import {
	AgentCommandSealingError,
	openAgentCommandSecrets,
} from '../../src/utils/agentCommandSealing';

jest.mock('../../src/services/events/BackupEventService', () => ({
	BackupEventService: jest.fn().mockImplementation(() => ({
		onBackupCancelled: jest.fn(),
		onBackupFailure: jest.fn(),
		onBackupComplete: jest.fn(),
	})),
}));

jest.mock('../../src/services/ConfigService', () => ({
	configService: {
		config: {
			SECRET: 'remote-backup-default-secret-for-tests',
			AGENT_OFFLINE_TIMEOUT_SECONDS: 90,
		},
	},
}));

const encryptionSecret = 'remote-backup-service-test-secret-that-is-long-enough';
const repositoryPassword = 'test-only-managed-repository-password';
const storagePassword = 'test-only-sftp-password';

const plan = {
	id: 'plan-remote-filesystem',
	title: 'Example remote filesystem plan',
	description: '',
	isActive: true,
	storageId: 'storage-sftp',
	storagePath: 'managed-repositories/example-plan',
	sourceId: 'remote-device-01',
	sourceType: 'device',
	sourceConfig: { includes: ['/srv/example-app'], excludes: [] },
	method: 'backup',
	settings: {
		encryption: true,
		compression: false,
		interval: { type: 'daily', time: '01:00AM' },
		replication: { enabled: false, concurrent: false, storages: [] },
		scripts: {},
	},
	stats: null,
} as any;

const capableAgent = {
	agentId: 'agent-example-01',
	deviceId: 'remote-device-01',
	revokedAt: null,
	lastSeen: new Date(),
	agentVersion: '0.2.0',
	resticVersion: 'restic 0.19.1',
	rcloneVersion: 'rclone v1.75.1',
	capabilities: {
		filesystemRootsConfigured: true,
		commandTypes: ['PING', 'INVENTORY_REFRESH', 'BACKUP_FILESYSTEM'],
	},
} as any;

const s3AccessKey = 'SYNTHETICKEY01';
const s3SecretKey = 'synthetic-secret-key-01';
const s3Plan = { ...plan, storageId: 'storage-s3', storagePath: 'bucket-01/agents/app-01' } as any;
const s3Agent = {
	...capableAgent,
	agentVersion: '0.8.0',
	capabilities: {
		...capableAgent.capabilities,
		repositoryBackends: ['sftp', 's3'],
		backupPayloadVersion: 5,
	},
} as any;
const s3StorageRecord = (
	crypt: Cryptr,
	settings: Record<string, unknown> = { hcp_mode: true, endpoint: 'https://s3.example.internal' }
) => ({
	id: 'storage-s3',
	type: 's3compatible',
	settings,
	credentials: {
		bucket: crypt.encrypt('bucket-01'),
		access_key_id: crypt.encrypt(s3AccessKey),
		secret_access_key: crypt.encrypt(s3SecretKey),
	},
});

describe('RemoteBackupService', () => {
	let repositories: any;
	let agentStore: any;
	let planStore: any;
	let backupStore: any;
	let storageStore: any;
	let service: RemoteBackupService;

	beforeEach(() => {
		const crypt = new Cryptr(encryptionSecret);
		repositories = {
			getByPlanId: jest.fn().mockResolvedValue({
				id: 'remote-repo-example-01',
				planId: plan.id,
				agentId: capableAgent.agentId,
				storageId: plan.storageId,
				storagePath: plan.storagePath,
				encryptedPassword: crypt.encrypt(repositoryPassword),
				initializedAt: null,
			}),
			getById: jest.fn().mockResolvedValue({
				id: 'remote-repo-example-01',
				planId: plan.id,
				agentId: capableAgent.agentId,
				storageId: plan.storageId,
				storagePath: plan.storagePath,
				encryptedPassword: crypt.encrypt(repositoryPassword),
				initializedAt: null,
			}),
			createBackupAndCommand: jest.fn().mockResolvedValue({}),
			markInitialized: jest.fn(),
		};
		agentStore = {
			getAgentByDeviceId: jest.fn().mockResolvedValue({ ...capableAgent, lastSeen: new Date() }),
			hasLiveCommand: jest.fn().mockResolvedValue(false),
		};
		planStore = {
			getById: jest.fn().mockResolvedValue(plan),
			hasActiveBackups: jest.fn().mockResolvedValue(false),
			getAll: jest.fn().mockResolvedValue([]),
			getStorageRemovalReferences: jest.fn().mockResolvedValue([]),
		};
		backupStore = {
			getById: jest.fn().mockResolvedValue({
				id: 'backup-example-01',
				planId: plan.id,
				sourceId: plan.sourceId,
				status: 'queued',
				inProgress: true,
			}),
		};
		storageStore = {
			getById: jest.fn().mockResolvedValue({
				id: plan.storageId,
				type: 'sftp',
				settings: {},
				credentials: {
					host: crypt.encrypt('sftp.example.internal'),
					port: crypt.encrypt('22'),
					user: crypt.encrypt('backup-user'),
					pass: crypt.encrypt(storagePassword),
				},
			}),
		};
		service = new RemoteBackupService(
			repositories,
			agentStore,
			planStore,
			backupStore,
			storageStore,
			encryptionSecret
		);
	});

	it('rejects a remote device without the filesystem-backup capability', async () => {
		agentStore.getAgentByDeviceId.mockResolvedValue({
			...capableAgent,
			capabilities: { filesystemRootsConfigured: true, commandTypes: ['PING'] },
		});
		await expect(service.validatePlanCreation(plan)).rejects.toThrow(
			'Remote agent does not yet support filesystem backup'
		);
	});
	it('does not erase repository credentials before PlanStore archival commits', async () => {
		repositories.deleteByPlanId = jest.fn();
		backupStore.getAll = jest.fn().mockResolvedValue([]);
		(service as any).cronManager.removeSchedulesByType = jest.fn();
		await expect(service.removeManagedPlan(plan)).resolves.toEqual({
			storagePath: plan.storagePath,
		});
		expect(repositories.deleteByPlanId).not.toHaveBeenCalled();
	});

	it('rejects an offline agent before creating or queueing a plan', async () => {
		agentStore.getAgentByDeviceId.mockResolvedValue({
			...capableAgent,
			lastSeen: new Date(Date.now() - 91_000),
		});
		await expect(service.validatePlanCreation(plan)).rejects.toThrow(
			'Remote agent is not available'
		);
	});

	it('enforces opt-in Source Access at plan validation and queue time while preserving old-agent behavior', async () => {
		const sourceAccess = {
			assertPlanSource: jest.fn().mockResolvedValue(undefined),
			assertModeChangeIdle: jest.fn().mockResolvedValue(undefined),
		};
		service.setSourceAccessService(sourceAccess as any);
		await service.validatePlanCreation(plan);
		expect(sourceAccess.assertPlanSource).not.toHaveBeenCalled();
		agentStore.getAgentByDeviceId.mockResolvedValue({
			...capableAgent,
			lastSeen: new Date(),
			capabilities: { ...capableAgent.capabilities, sourceAccessVersion: 1 },
		});
		await service.validatePlanCreation(plan);
		expect(sourceAccess.assertPlanSource).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: capableAgent.agentId }),
			'/srv/example-app'
		);
		sourceAccess.assertPlanSource.mockRejectedValue(
			new Error('Source Access needs a fresh healthy report.')
		);
		await expect(service.queuePlanBackup(plan.id)).rejects.toThrow('fresh healthy');
		expect(repositories.createBackupAndCommand).not.toHaveBeenCalled();
	});

	it('refuses normal plan Resume while a guarded authorization mode setup is pending', async () => {
		const sourceAccess = {
			assertModeChangeIdle: jest
				.fn()
				.mockRejectedValue(new Error('Keep this agent backup plans paused.')),
		};
		service.setSourceAccessService(sourceAccess as any);
		agentStore.getAgentByDeviceId.mockResolvedValue({
			...capableAgent,
			capabilities: { ...capableAgent.capabilities, sourceAccessModesVersion: 1 },
		});
		await expect(service.resumePlan(plan.id)).rejects.toThrow('Keep this agent');
		expect(sourceAccess.assertModeChangeIdle).toHaveBeenCalledWith(capableAgent.agentId);
	});

	it('rechecks Source Access before materializing a queued command, including database lifecycle plans', async () => {
		const sourceAccess = {
			assertPlanSource: jest.fn().mockRejectedValue(new Error('Source Access changed.')),
			assertModeChangeIdle: jest.fn().mockResolvedValue(undefined),
		};
		service.setSourceAccessService(sourceAccess as any);
		agentStore.getAgentByDeviceId.mockResolvedValue({
			...capableAgent,
			lastSeen: new Date(),
			capabilities: {
				...capableAgent.capabilities,
				sourceAccessVersion: 1,
				backupLifecycleVersion: 2,
				databaseEngines: ['mysql'],
			},
		});
		const command = {
			id: 'remote-backup-example-01',
			agentId: capableAgent.agentId,
			type: 'BACKUP_FILESYSTEM',
			payload: {
				backupId: 'backup-example-01',
				planId: plan.id,
				repositoryId: 'remote-repo-example-01',
			},
		} as AgentCommand;
		await expect(service.materializeCommand(capableAgent.agentId, command)).rejects.toMatchObject({
			stage: 'source-validation',
		});
		expect(sourceAccess.assertPlanSource).toHaveBeenCalledTimes(1);
	});

	it('rejects malformed remote excludes with a client-safe validation error', async () => {
		await expect(
			service.validatePlanCreation({
				...plan,
				sourceConfig: { includes: ['/srv/example-app'], excludes: [123] },
			} as any)
		).rejects.toThrow('Invalid Backup Exclusions');
	});

	it('refuses exclusions with HTTP 409 on legacy Agents but preserves empty-exclusion plans', async () => {
		await expect(service.validatePlanCreation(plan)).resolves.toBeUndefined();
		await expect(
			service.validatePlanCreation({
				...plan,
				sourceConfig: { ...plan.sourceConfig, excludes: ['.git/'] },
			})
		).rejects.toMatchObject({ statusCode: 409 });
		expect(repositories.createBackupAndCommand).not.toHaveBeenCalled();
	});

	it('validates relative exclusions before persistence and sends v4 only to an explicitly capable Agent', async () => {
		const configured = {
			...plan,
			sourceConfig: { ...plan.sourceConfig, excludes: ['.git/', '**/node_modules/', '*.sql'] },
		};
		agentStore.getAgentByDeviceId.mockResolvedValue({
			...capableAgent,
			agentVersion: '0.7.0',
			capabilities: { ...capableAgent.capabilities, backupExclusionsVersion: 1 },
		});
		planStore.getById.mockResolvedValue(configured);
		backupStore.getById.mockResolvedValue({
			id: 'backup-example-01',
			planId: plan.id,
			sourceId: plan.sourceId,
			status: 'queued',
			inProgress: true,
			sourceConfig: configured.sourceConfig,
		});
		await expect(service.validatePlanCreation(configured)).resolves.toBeUndefined();
		await service.queuePlanBackup(plan.id);
		expect(repositories.createBackupAndCommand.mock.calls[0][0].backup.sourceConfig).toEqual(
			configured.sourceConfig
		);
		const command = {
			agentId: capableAgent.agentId,
			type: 'BACKUP_FILESYSTEM',
			payload: {
				backupId: 'backup-example-01',
				planId: plan.id,
				repositoryId: 'remote-repo-example-01',
			},
		} as AgentCommand;
		await expect(service.materializeCommand(capableAgent.agentId, command)).resolves.toMatchObject({
			version: 4,
			excludes: ['.git', '**/node_modules', '*.sql'],
		});
		backupStore.getById.mockResolvedValue({
			id: 'backup-example-01',
			planId: plan.id,
			sourceId: plan.sourceId,
			status: 'queued',
			inProgress: true,
			sourceConfig: { ...configured.sourceConfig, excludes: ['other'] },
		});
		await expect(service.materializeCommand(capableAgent.agentId, command)).rejects.toThrow(
			'changed after queuing'
		);
		agentStore.getAgentByDeviceId.mockResolvedValue(capableAgent);
		await expect(service.materializeCommand(capableAgent.agentId, command)).rejects.toBeInstanceOf(
			RemoteCommandPreparationError
		);
	});

	it.each(['/absolute', '../escape', '!keep', '**bad', 'a//b', '$(command)', '[ab]'])(
		'rejects unsupported exclusion %s with HTTP 400',
		async pattern => {
			await expect(
				service.validatePlanCreation({
					...plan,
					sourceConfig: { ...plan.sourceConfig, excludes: [pattern] },
				})
			).rejects.toMatchObject({ statusCode: 400 });
		}
	);

	it('queues a non-secret durable command reference for a capable agent', async () => {
		await expect(service.queuePlanBackup(plan.id)).resolves.toBe(
			'Remote filesystem backup queued.'
		);
		const queued = repositories.createBackupAndCommand.mock.calls[0][0];
		expect(queued.command).toMatchObject({
			agentId: capableAgent.agentId,
			payload: {
				planId: plan.id,
				repositoryId: 'remote-repo-example-01',
				backupId: expect.any(String),
			},
		});
		const persistedPayload = JSON.stringify(queued.command.payload);
		expect(persistedPayload).not.toContain(storagePassword);
		expect(persistedPayload).not.toContain(repositoryPassword);
		expect(persistedPayload).not.toContain(encryptionSecret);
	});
	it('requires the server replication lifecycle and never sends mirror credentials to the Agent', async () => {
		const replicated = {
			...plan,
			settings: {
				...plan.settings,
				replication: {
					enabled: true,
					concurrent: false,
					storages: [
						{
							replicationId: 'replica-01',
							storageId: 'mirror-01',
							storagePath: 'bucket-01/owned',
							storageType: 's3compatible',
							storageName: 'Mirror',
							addedAt: 1,
						},
					],
				},
			},
		};
		await expect(service.validatePlanCreation(replicated)).rejects.toMatchObject({
			statusCode: 503,
		});
		const replication = {
			validatePlan: jest.fn(async () => undefined),
			enqueueBackup: jest.fn(async () => undefined),
		};
		service.setReplicationService(replication);
		planStore.getById.mockResolvedValue(replicated);
		await expect(service.validatePlanCreation(replicated)).resolves.toBeUndefined();
		const command = backupCommand();
		const payload = await service.materializeCommand(capableAgent.agentId, command);
		expect(replication.validatePlan).toHaveBeenCalledWith(replicated);
		expect(JSON.stringify(payload)).not.toContain('mirror-01');
		expect(payload).not.toHaveProperty('replication');
		replication.validatePlan.mockRejectedValue(
			new Error('synthetic mirror credentials unavailable')
		);
		await expect(service.materializeCommand(capableAgent.agentId, command)).resolves.toHaveProperty(
			'repository'
		);
		await expect(service.queuePlanBackup(replicated.id)).resolves.toContain('queued');
		await expect(service.validatePlanCreation(replicated)).rejects.toThrow(
			'mirror credentials unavailable'
		);
	});

	it('does not cancel a completed remote backup record', async () => {
		backupStore.getById.mockResolvedValue({
			id: 'backup-example-01',
			planId: plan.id,
			inProgress: false,
			status: 'completed',
			sourceId: plan.sourceId,
		});
		await expect(service.cancelBackup(plan.id, 'backup-example-01')).rejects.toThrow(
			'no longer in progress'
		);
	});

	describe('failed history removal', () => {
		const failed = {
			id: 'backup-example-01',
			planId: plan.id,
			sourceId: plan.sourceId,
			sourceType: 'device',
			status: 'failed',
			success: false,
			inProgress: false,
			completionStats: null,
			mirrors: [],
		} as any;

		beforeEach(() => {
			agentStore.getCommand = jest.fn().mockResolvedValue({
				id: 'remote-backup-backup-example-01',
				state: 'failed',
			});
		});

		it.each(['failed', 'completed', 'cancelled'])(
			'allows a failed run whose Agent command is %s and checks the exact command',
			async state => {
				agentStore.getCommand.mockResolvedValue({ id: 'remote-backup-backup-example-01', state });
				await expect(service.assertFailedHistoryRemovable(failed)).resolves.toBeUndefined();
				expect(agentStore.getCommand).toHaveBeenCalledWith('remote-backup-backup-example-01');
			}
		);

		it('allows a failed run whose Agent command no longer exists', async () => {
			agentStore.getCommand.mockResolvedValue(null);
			await expect(service.assertFailedHistoryRemovable(failed)).resolves.toBeUndefined();
		});

		it.each([
			['completed', { status: 'completed', success: true }],
			['cancelled', { status: 'cancelled' }],
			['queued', { status: 'queued', inProgress: true }],
			['retrying', { status: 'retrying' }],
			['in progress', { inProgress: true }],
			['successful', { success: true }],
			['with a recorded snapshot', { completionStats: { snapshot_id: 'a1b2c3d4e5f60718' } }],
			['with replica records', { mirrors: [{ replicationId: 'replica-01', status: 'failed' }] }],
		])('refuses a %s backup without asking the Agent store', async (_label, override) => {
			await expect(
				service.assertFailedHistoryRemovable({ ...failed, ...override })
			).rejects.toMatchObject({ statusCode: 501, message: 'REMOTE_CAPABILITY_NOT_IMPLEMENTED' });
			expect(agentStore.getCommand).not.toHaveBeenCalled();
		});

		it.each(['queued', 'leased', 'acknowledged', 'running'])(
			'refuses while the Agent command is still %s',
			async state => {
				agentStore.getCommand.mockResolvedValue({ id: 'remote-backup-backup-example-01', state });
				await expect(service.assertFailedHistoryRemovable(failed)).rejects.toMatchObject({
					statusCode: 409,
				});
			}
		);
	});

	it('materializes the minimum SFTP and repository credentials only at poll time', async () => {
		const command = {
			id: 'remote-backup-backup-example-01',
			type: 'BACKUP_FILESYSTEM',
			agentId: capableAgent.agentId,
			payload: {
				backupId: 'backup-example-01',
				planId: plan.id,
				repositoryId: 'remote-repo-example-01',
			},
		} as AgentCommand;
		const payload = await service.materializeCommand(capableAgent.agentId, command);
		expect(payload).toMatchObject({
			sourcePath: '/srv/example-app',
			repositoryPassword,
			rclone: {
				type: 'sftp',
				options: {
					host: 'sftp.example.internal',
					port: '22',
					user: 'backup-user',
					pass: storagePassword,
				},
			},
		});
		expect(JSON.stringify(command.payload)).not.toContain(storagePassword);
		expect(JSON.stringify(command.payload)).not.toContain(repositoryPassword);
		expect(payload).not.toHaveProperty('encryptionKey');
	});

	it('ignores disabled and empty SFTP UI defaults without widening the agent allowlist', async () => {
		const crypt = new Cryptr(encryptionSecret);
		storageStore.getById.mockResolvedValue({
			id: plan.storageId,
			type: 'sftp',
			// These are the values the normal Storage UI can persist when an
			// optional switch is toggled and left off. Empty text fields are also
			// retained by the edit form when it saves the storage.
			settings: {
				key_use_agent: false,
				use_insecure_cipher: false,
				disable_hashcheck: false,
				ask_password: false,
				known_hosts_file: '',
				path_override: '',
			},
			credentials: {
				host: crypt.encrypt('sftp.example.internal'),
				port: crypt.encrypt('22'),
				user: crypt.encrypt('backup-user'),
				pass: crypt.encrypt(storagePassword),
			},
		});
		const command = {
			id: 'remote-backup-backup-example-01',
			type: 'BACKUP_FILESYSTEM',
			agentId: capableAgent.agentId,
			payload: {
				backupId: 'backup-example-01',
				planId: plan.id,
				repositoryId: 'remote-repo-example-01',
			},
		} as AgentCommand;

		const payload = await service.materializeCommand(capableAgent.agentId, command);
		expect(payload).toMatchObject({
			rclone: {
				type: 'sftp',
				options: {
					host: 'sftp.example.internal',
					port: '22',
					user: 'backup-user',
					pass: storagePassword,
				},
			},
		});
		expect((payload.rclone as any).options).not.toHaveProperty('disable_hashcheck');
		expect((payload.rclone as any).options).not.toHaveProperty('key_use_agent');
		expect((payload.rclone as any).options).not.toHaveProperty('use_insecure_cipher');
	});

	it('classifies an SFTP credential decryption failure without retaining credential material', async () => {
		const foreignSecret = 'foreign-fixture-secret-that-is-long-enough';
		const foreignCrypt = new Cryptr(foreignSecret);
		const fixturePassword = 'fixture-sftp-password-must-not-appear-in-diagnostics';
		storageStore.getById.mockResolvedValue({
			id: plan.storageId,
			type: 'sftp',
			settings: {},
			credentials: {
				host: foreignCrypt.encrypt('sftp.example.internal'),
				user: foreignCrypt.encrypt('backup-user'),
				pass: foreignCrypt.encrypt(fixturePassword),
			},
		});
		const command = {
			id: 'remote-backup-backup-example-01',
			type: 'BACKUP_FILESYSTEM',
			agentId: capableAgent.agentId,
			payload: {
				backupId: 'backup-example-01',
				planId: plan.id,
				repositoryId: 'remote-repo-example-01',
			},
		} as AgentCommand;

		const error = await service
			.materializeCommand(capableAgent.agentId, command)
			.then(() => null)
			.catch(error => error);

		expect(error).toBeInstanceOf(RemoteCommandPreparationError);
		expect(error).toMatchObject({
			stage: 'sftp-credential-decryption',
			backupId: 'backup-example-01',
			planId: plan.id,
			storageId: plan.storageId,
			message: 'Storage credentials could not be prepared for the remote agent.',
			safeMessage: 'Remote SFTP credentials could not be decrypted or validated.',
		});
		expect(JSON.stringify(error)).not.toContain(fixturePassword);
		expect(JSON.stringify(error)).not.toContain(foreignSecret);
	});

	it('does not materialize credentials for a finalized backup command', async () => {
		backupStore.getById.mockResolvedValue({
			id: 'backup-example-01',
			planId: plan.id,
			sourceId: plan.sourceId,
			status: 'completed',
			inProgress: false,
		});
		const command = {
			id: 'remote-backup-backup-example-01',
			type: 'BACKUP_FILESYSTEM',
			agentId: capableAgent.agentId,
			payload: {
				backupId: 'backup-example-01',
				planId: plan.id,
				repositoryId: 'remote-repo-example-01',
			},
		} as AgentCommand;
		await expect(service.materializeCommand(capableAgent.agentId, command)).rejects.toThrow(
			'no longer has a valid managed plan'
		);
	});

	it('refuses storage settings that would enable external SSH or a shell command', async () => {
		const crypt = new Cryptr(encryptionSecret);
		storageStore.getById.mockResolvedValue({
			id: plan.storageId,
			type: 'sftp',
			settings: { ssh: 'ssh -o ProxyCommand=unsafe' },
			credentials: {
				host: crypt.encrypt('sftp.example.internal'),
				user: crypt.encrypt('backup-user'),
				pass: crypt.encrypt(storagePassword),
			},
		});
		const command = {
			id: 'remote-backup-backup-example-01',
			type: 'BACKUP_FILESYSTEM',
			agentId: capableAgent.agentId,
			payload: {
				backupId: 'backup-example-01',
				planId: plan.id,
				repositoryId: 'remote-repo-example-01',
			},
		} as AgentCommand;
		const error = await service
			.materializeCommand(capableAgent.agentId, command)
			.then(() => null)
			.catch(error => error);
		expect(error).toMatchObject({
			stage: 'sftp-setting-allowlist',
			rejectedField: 'ssh',
			ruleCategory: 'unsupported-field',
			message:
				'Remote filesystem backups support only SFTP host, port, username, and encrypted password credentials.',
		});
	});

	it('reports the rejected SFTP field and rule without retaining its value', async () => {
		const crypt = new Cryptr(encryptionSecret);
		const unsafeHost = 'sftp.example.internal\u0001';
		storageStore.getById.mockResolvedValue({
			id: plan.storageId,
			type: 'sftp',
			settings: {},
			credentials: {
				host: crypt.encrypt(unsafeHost),
				user: crypt.encrypt('backup-user'),
				pass: crypt.encrypt(storagePassword),
			},
		});
		const command = {
			id: 'remote-backup-backup-example-01',
			type: 'BACKUP_FILESYSTEM',
			agentId: capableAgent.agentId,
			payload: {
				backupId: 'backup-example-01',
				planId: plan.id,
				repositoryId: 'remote-repo-example-01',
			},
		} as AgentCommand;

		const error = await service
			.materializeCommand(capableAgent.agentId, command)
			.then(() => null)
			.catch(error => error);

		expect(error).toBeInstanceOf(RemoteCommandPreparationError);
		expect(error).toMatchObject({
			stage: 'sftp-option-validation',
			rejectedField: 'host',
			ruleCategory: 'unsafe-control-character',
			safeMessage: 'Remote SFTP configuration contains an unsafe value.',
		});
		expect(JSON.stringify(error)).not.toContain(unsafeHost);
		expect(JSON.stringify(error)).not.toContain(storagePassword);
	});

	const database = {
		engine: 'mariadb',
		host: 'localhost',
		port: 3306,
		tls: 'local',
		database: 'example_db',
		username: 'backup_reader',
		dumpFilename: 'app.sql',
		timeoutSeconds: 60,
		maxDumpBytes: 1024 ** 3,
		includeRoutines: false,
		includeEvents: false,
		passwordConfigured: true,
	};
	const lifecyclePlan = () => ({
		...plan,
		settings: { ...plan.settings, remoteLifecycle: { version: 1, database } },
	});
	const backupCommand = () =>
		({
			id: 'remote-backup-backup-example-01',
			type: 'BACKUP_FILESYSTEM',
			agentId: capableAgent.agentId,
			payload: {
				backupId: 'backup-example-01',
				planId: plan.id,
				repositoryId: 'remote-repo-example-01',
			},
		}) as AgentCommand;
	const advertiseLifecycle = () =>
		agentStore.getAgentByDeviceId.mockResolvedValue({
			...capableAgent,
			lastSeen: new Date(),
			capabilities: {
				...capableAgent.capabilities,
				backupLifecycleVersion: 1,
				databaseEngines: ['mariadb'],
				hooksConfigured: true,
			},
		});
	it('Phase 5 requires declared lifecycle/client capabilities without breaking Phase 4', async () => {
		await expect(service.validatePlanCreation(lifecyclePlan())).rejects.toThrow(
			'does not support the selected'
		);
		await expect(service.validatePlanCreation(plan)).resolves.toBeUndefined();
		advertiseLifecycle();
		await expect(service.validatePlanCreation(lifecyclePlan())).resolves.toBeUndefined();
		await expect(
			service.validatePlanCreation({
				...lifecyclePlan(),
				settings: {
					...lifecyclePlan().settings,
					remoteLifecycle: { version: 1, database: { ...database, engine: 'mysql' } },
				},
			})
		).rejects.toThrow('does not support the selected');
	});
	it('materializes database password only in the signed ephemeral version 2 payload', async () => {
		advertiseLifecycle();
		planStore.getById.mockResolvedValue(lifecyclePlan());
		const dbPassword = 'test-only-db-password';
		planStore.getDatabaseCredential = jest
			.fn()
			.mockResolvedValue(new Cryptr(encryptionSecret).encrypt(dbPassword));
		const command = backupCommand();
		const result = await service.materializeCommand(capableAgent.agentId, command);
		expect(result).toMatchObject({
			version: 2,
			lifecycle: { version: 1, database: { password: dbPassword } },
		});
		expect(JSON.stringify(command.payload)).not.toContain(dbPassword);
		expect(JSON.stringify(lifecyclePlan().settings)).not.toContain(dbPassword);
	});
	it('missing or undecryptable DB secret fails at a closed stage without provider text', async () => {
		advertiseLifecycle();
		planStore.getById.mockResolvedValue(lifecyclePlan());
		planStore.getDatabaseCredential = jest.fn().mockResolvedValue('synthetic-invalid-ciphertext');
		const error = await service
			.materializeCommand(capableAgent.agentId, backupCommand())
			.catch(error => error);
		expect(error).toMatchObject({
			stage: 'database-credential-preparation',
			safeMessage: 'Database backup credentials could not be prepared.',
		});
		expect(JSON.stringify(error)).not.toContain('synthetic-invalid-ciphertext');
	});
	it('materializes a mixed collection with independent password binding only into ephemeral version 3', async () => {
		const databases = [
			{ ...database, databaseId: 'db_maria' },
			{
				...database,
				databaseId: 'db_pg',
				engine: 'postgresql',
				port: 5432,
				database: 'analytics',
				dumpFilename: 'analytics.sql',
			},
		];
		const mixedPlan = {
			...plan,
			settings: { ...plan.settings, remoteLifecycle: { version: 2, databases } },
		};
		planStore.getById.mockResolvedValue(mixedPlan);
		agentStore.getAgentByDeviceId.mockResolvedValue({
			...capableAgent,
			lastSeen: new Date(),
			capabilities: {
				...capableAgent.capabilities,
				backupLifecycleVersion: 2,
				databaseEngines: ['mariadb', 'postgresql'],
			},
		});
		planStore.getDatabaseCredentials = jest.fn().mockResolvedValue([
			{
				databaseId: 'db_pg',
				encryptedPassword: new Cryptr(encryptionSecret).encrypt('synthetic-pg-password'),
				legacySingle: false,
			},
			{
				databaseId: 'db_maria',
				encryptedPassword: new Cryptr(encryptionSecret).encrypt('synthetic-maria-password'),
				legacySingle: false,
			},
		]);
		const command = backupCommand();
		const payload = await service.materializeCommand(capableAgent.agentId, command);
		expect(payload).toMatchObject({
			version: 3,
			lifecycle: {
				version: 2,
				databases: [
					{ databaseId: 'db_maria', password: 'synthetic-maria-password' },
					{ databaseId: 'db_pg', password: 'synthetic-pg-password' },
				],
			},
		});
		expect(JSON.stringify(mixedPlan)).not.toContain('synthetic-pg-password');
		expect(JSON.stringify(command)).not.toContain('synthetic-maria-password');
		advertiseLifecycle();
		await expect(service.validatePlanCreation(mixedPlan)).rejects.toThrow('does not support');
		const single = {
			...mixedPlan,
			settings: {
				...mixedPlan.settings,
				remoteLifecycle: { version: 2, databases: [databases[0]] },
			},
		};
		planStore.getById.mockResolvedValue(single);
		const legacy = await service.materializeCommand(capableAgent.agentId, command);
		expect(legacy).toMatchObject({
			version: 2,
			lifecycle: { version: 1, database: { password: 'synthetic-maria-password' } },
		});
		expect((legacy.lifecycle as any).database).not.toHaveProperty('databaseId');
	});
	it('snapshot success with post/cleanup warnings remains completed and exposes a safe warning separately', async () => {
		backupStore.update = jest.fn();
		planStore.update = jest.fn();
		const id = 'a'.repeat(64);
		const summary = {
			message_type: 'summary',
			snapshot_id: id,
			total_bytes_processed: 1024,
		} as any;
		const warnings = [{ stage: 'post-backup', code: 'hook-failed' }] as any;
		await service.completeCommand(backupCommand(), {
			success: true,
			result: { snapshotId: id, summary, lifecycle: { warnings } },
		});
		expect((service as any).eventService.onBackupComplete).toHaveBeenCalledWith(
			expect.objectContaining({ success: true, summary: { ...summary, lifecycle: { warnings } } })
		);
		expect((service as any).eventService.onBackupFailure).not.toHaveBeenCalled();
		expect(backupStore.update).toHaveBeenCalledWith('backup-example-01', {
			errorMsg: expect.stringContaining('post-backup/hook-failed'),
		});
	});
	it('a snapshot without vanished source entries stays completed and says how many are missing', async () => {
		backupStore.update = jest.fn();
		planStore.update = jest.fn();
		const id = 'b'.repeat(64);
		const summary = { message_type: 'summary', snapshot_id: id, total_bytes_processed: 1024 } as any;
		const warn = jest.spyOn(serverLogger, 'warn').mockImplementation(() => undefined as any);
		try {
			await service.completeCommand(backupCommand(), {
				success: true,
				result: { snapshotId: id, summary, sourceWarnings: { vanishedEntries: 3 } },
			});
			expect((service as any).eventService.onBackupComplete).toHaveBeenCalledWith(
				expect.objectContaining({ success: true })
			);
			expect((service as any).eventService.onBackupFailure).not.toHaveBeenCalled();
			expect(backupStore.update).toHaveBeenCalledWith('backup-example-01', {
				errorMsg:
					'Snapshot completed; 3 source entries vanished while the backup ran and are not in this snapshot.',
			});
			expect(warn).toHaveBeenCalledWith(
				expect.objectContaining({ agentEvent: 'backup_source_entries_vanished', vanishedEntries: 3 }),
				expect.any(String)
			);
			backupStore.update.mockClear();
			const warnings = [{ stage: 'post-backup', code: 'hook-failed' }] as any;
			await service.completeCommand(backupCommand(), {
				success: true,
				result: { snapshotId: id, summary, lifecycle: { warnings }, sourceWarnings: { vanishedEntries: 1 } },
			});
			expect(backupStore.update).toHaveBeenCalledTimes(1);
			expect(backupStore.update).toHaveBeenCalledWith('backup-example-01', {
				errorMsg:
					'Snapshot completed; lifecycle cleanup needs attention: post-backup/hook-failed; 1 source entry vanished while the backup ran and is not in this snapshot.',
			});
		} finally {
			warn.mockRestore();
		}
	});
	it('accepts only complete multi-DB snapshot metadata bound to every configured entry', async () => {
		planStore.update = jest.fn();
		const databases = [
			{ ...database, databaseId: 'db_one' },
			{
				...database,
				databaseId: 'db_two',
				engine: 'postgresql',
				database: 'analytics',
				dumpFilename: 'analytics.sql',
			},
		];
		planStore.getById.mockResolvedValue({
			...plan,
			settings: { ...plan.settings, remoteLifecycle: { version: 2, databases } },
		});
		const id = 'a'.repeat(64);
		const artifacts = databases.map(entry => ({
			databaseId: entry.databaseId,
			engine: entry.engine,
			database: entry.database,
			path: `/pluton/database/${entry.dumpFilename}`,
			bytes: 1024,
			sha256: 'b'.repeat(64),
		})) as any;
		const summary = { message_type: 'summary', snapshot_id: id } as any;
		for (const reported of [
			undefined,
			artifacts.slice(0, 1),
			[{ ...artifacts[0], databaseId: 'db_foreign' }, artifacts[1]],
			[{ ...artifacts[0], bytes: 1024 ** 4 }, artifacts[1]],
		]) {
			await service.completeCommand(backupCommand(), {
				success: true,
				result: { snapshotId: id, summary, lifecycle: { warnings: [], databases: reported } },
			});
			expect((service as any).eventService.onBackupFailure).toHaveBeenLastCalledWith(
				expect.objectContaining({ error: expect.stringContaining('snapshot-confirmation-failed') })
			);
		}
		expect((service as any).eventService.onBackupComplete).not.toHaveBeenCalled();
		await service.completeCommand(backupCommand(), {
			success: true,
			result: { snapshotId: id, summary, lifecycle: { warnings: [], databases: artifacts } },
		});
		expect((service as any).eventService.onBackupComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: { ...summary, lifecycle: { warnings: [], databases: artifacts } },
			})
		);
	});
	it('schedules a capable standalone Agent 0.7.0 in WIB without changing the durable command reference contract', async () => {
		agentStore.getAgentByDeviceId.mockResolvedValue({ ...capableAgent, agentVersion: '0.7.0', lastSeen: new Date() });
		const clockPlan = { ...plan, settings: { ...plan.settings, interval: { type: 'daily', time: '04:00AM', timeZone: 'Asia/Jakarta' } } };
		planStore.getById.mockResolvedValue(clockPlan);
		const cron = { getSchedule: jest.fn().mockResolvedValue([]), scheduleTask: jest.fn(), activateLoadedSchedule: jest.fn() };
		(service as any).cronManager = cron;
		await (service as any).ensureSchedule(clockPlan);
		const [id, expression, options, type] = cron.scheduleTask.mock.calls[0];
		expect([id, expression, type]).toEqual([plan.id, '00 4 * * *', 'remote-backup']);
		expect(options.timeZone).toBe('Asia/Jakarta');
		await options.taskCallback(plan.id);
		expect(repositories.createBackupAndCommand).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ payload: expect.objectContaining({ planId: plan.id, repositoryId: 'remote-repo-example-01' }) }) }));
		agentStore.getAgentByDeviceId.mockResolvedValue({ ...capableAgent, lastSeen: new Date(Date.now() - 91_000) });
		await options.taskCallback(plan.id);
		expect(repositories.createBackupAndCommand).toHaveBeenCalledTimes(1);
		expect(agentStore.hasLiveCommand).toHaveBeenCalledWith(capableAgent.agentId);
	});

	it('queues a scheduled run behind a long backup instead of skipping it while the Agent renews a lease', async () => {
		const clockPlan = { ...plan, settings: { ...plan.settings, interval: { type: 'daily', time: '01:00AM', timeZone: 'Asia/Jakarta' } } };
		planStore.getById.mockResolvedValue(clockPlan);
		const cron = { getSchedule: jest.fn().mockResolvedValue([]), scheduleTask: jest.fn(), activateLoadedSchedule: jest.fn() };
		(service as any).cronManager = cron;
		await (service as any).ensureSchedule(clockPlan);
		const options = cron.scheduleTask.mock.calls[0][2];
		// No heartbeat for hours: the Agent is executing another command and renewing its lease.
		agentStore.getAgentByDeviceId.mockResolvedValue({ ...capableAgent, lastSeen: new Date(Date.now() - 6 * 3_600_000) });
		agentStore.hasLiveCommand.mockResolvedValue(true);
		await options.taskCallback(plan.id);
		expect(repositories.createBackupAndCommand).toHaveBeenCalledTimes(1);
		// A revoked Agent is never available, busy or not.
		agentStore.getAgentByDeviceId.mockResolvedValue({ ...capableAgent, lastSeen: new Date(), revokedAt: new Date() });
		await expect(service.queuePlanBackup(plan.id)).rejects.toThrow('Remote agent is not available');
		expect(repositories.createBackupAndCommand).toHaveBeenCalledTimes(1);
	});

	it('pauses only the schedule: Backup Now still queues a paused plan, its schedule does not', async () => {
		const pausedPlan = {
			...plan,
			isActive: false,
			settings: { ...plan.settings, interval: { type: 'daily', time: '01:00AM', timeZone: 'Asia/Jakarta' } },
		};
		planStore.getById.mockResolvedValue(pausedPlan);
		const cron = { getSchedule: jest.fn().mockResolvedValue([]), scheduleTask: jest.fn(), activateLoadedSchedule: jest.fn() };
		(service as any).cronManager = cron;
		await (service as any).ensureSchedule(pausedPlan);
		const options = cron.scheduleTask.mock.calls[0][2];
		await options.taskCallback(plan.id);
		expect(repositories.createBackupAndCommand).not.toHaveBeenCalled();
		await expect(service.queuePlanBackup(plan.id)).resolves.toBe('Remote filesystem backup queued.');
		expect(repositories.createBackupAndCommand).toHaveBeenCalledTimes(1);
		expect(repositories.createBackupAndCommand.mock.calls[0][0].backup).toMatchObject({
			planId: plan.id,
			status: 'queued',
			inProgress: true,
		});
	});

	it('refuses Backup Now of a paused plan while a Source Access mode setup is pending', async () => {
		planStore.getById.mockResolvedValue({ ...plan, isActive: false });
		const sourceAccess = {
			assertModeChangeIdle: jest
				.fn()
				.mockRejectedValue(new Error('Keep this agent backup plans paused.')),
		};
		service.setSourceAccessService(sourceAccess as any);
		await expect(service.queuePlanBackup(plan.id)).rejects.toThrow('Keep this agent');
		expect(sourceAccess.assertModeChangeIdle).toHaveBeenCalledWith(capableAgent.agentId);
		expect(repositories.createBackupAndCommand).not.toHaveBeenCalled();
	});

	it.each([
		['0.8.0', undefined],
		['0.8.1', 1],
	])('sends the signed vanished-entry opt-in to Agent %s as %s', async (agentVersion, expected) => {
		agentStore.getAgentByDeviceId.mockResolvedValue({ ...capableAgent, agentVersion, lastSeen: new Date() });
		const payload = await service.materializeCommand(capableAgent.agentId, backupCommand());
		expect(payload.vanishedSourceEntriesVersion).toBe(expected);
		expect(payload.sourceDiagnosticsVersion).toBe(1);
	});

	it.each(['0.7.0', '0.7.1'])(
		'negotiates diagnostics for %s without altering old payload versions or durable command references',
		async agentVersion => {
			agentStore.getAgentByDeviceId.mockResolvedValue({
				...capableAgent,
				agentVersion,
				lastSeen: new Date(),
			});
			const payload = await service.materializeCommand(capableAgent.agentId, backupCommand());
			expect(payload.version).toBe(1);
			expect(payload.sourceDiagnosticsVersion).toBe(agentVersion === '0.7.1' ? 1 : undefined);
			expect(backupCommand().payload).toEqual({
				backupId: 'backup-example-01',
				planId: plan.id,
				repositoryId: 'remote-repo-example-01',
			});
		}
	);
	it('passes diagnostics only to the terminal failure update; cancelled and finalized jobs stay terminal', async () => {
		const sourceDiagnostics = {
			version: 1 as const,
			origin: 'restic' as const,
			problemCount: 1,
			countIsLowerBound: true,
			entries: [
				{
					relativePath: 'app/logs/id_rsa',
					entryType: 'unknown' as const,
					errno: 'EACCES' as const,
					excluded: false as const,
				},
			],
		};
		const completion = {
			success: false,
			failureStage: 'restic-backup',
			failureCode: 'source-entry-inaccessible',
			sourceDiagnostics,
		};
		await service.completeCommand(backupCommand(), completion);
		expect((service as any).eventService.onBackupFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceFailure: {
					failureStage: completion.failureStage,
					failureCode: completion.failureCode,
					sourceDiagnostics,
				},
				error: expect.not.stringContaining('app/logs/id_rsa'),
			})
		);
		(service as any).eventService.onBackupFailure.mockClear();
		for (const status of ['failed', 'completed', 'cancelled']) {
			backupStore.getById.mockResolvedValue({ status });
			await service.completeCommand(backupCommand(), completion);
		}
		expect((service as any).eventService.onBackupFailure).not.toHaveBeenCalled();
		expect((service as any).eventService.onBackupComplete).not.toHaveBeenCalled();
	});

	describe('S3 primary eligibility (S3_AGENT_REPOSITORY_DESIGN.md 6.1.1)', () => {
		let s3Storage: any;
		beforeEach(async () => {
			const crypt = new Cryptr(encryptionSecret);
			const sftpStorage = await storageStore.getById(plan.storageId);
			s3Storage = s3StorageRecord(crypt);
			storageStore.getById.mockImplementation(async (id: string) =>
				id === s3Plan.storageId ? s3Storage : sftpStorage
			);
			agentStore.getAgentByDeviceId.mockResolvedValue({ ...s3Agent, lastSeen: new Date() });
			planStore.getById.mockResolvedValue(s3Plan);
			const s3Repository = {
				id: 'remote-repo-example-01',
				planId: plan.id,
				agentId: capableAgent.agentId,
				storageId: s3Plan.storageId,
				storagePath: s3Plan.storagePath,
				encryptedPassword: crypt.encrypt(repositoryPassword),
				initializedAt: null,
			};
			repositories.getByPlanId.mockResolvedValue(s3Repository);
			repositories.getById.mockResolvedValue(s3Repository);
		});

		it('offers an S3 primary only to an Agent that reports s3 and payload version 5', async () => {
			await expect(service.validatePlanCreation(s3Plan)).resolves.toBeUndefined();
			for (const capabilities of [
				capableAgent.capabilities,
				{ ...capableAgent.capabilities, repositoryBackends: ['sftp', 's3'] },
				{ ...capableAgent.capabilities, repositoryBackends: ['sftp'], backupPayloadVersion: 5 },
			]) {
				agentStore.getAgentByDeviceId.mockResolvedValue({
					...s3Agent,
					capabilities,
					lastSeen: new Date(),
				});
				await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject({
					statusCode: 409,
					message: 'Remote agent does not support S3 repositories. Update the agent first.',
				});
			}
		});

		it('refuses to queue an S3 plan for an Agent without S3 support and stores no command', async () => {
			agentStore.getAgentByDeviceId.mockResolvedValue({ ...capableAgent, lastSeen: new Date() });
			await expect(service.queuePlanBackup(s3Plan.id)).rejects.toMatchObject({
				statusCode: 409,
				message: 'Remote agent does not support S3 repositories. Update the agent first.',
			});
			expect(repositories.createBackupAndCommand).not.toHaveBeenCalled();
			agentStore.getAgentByDeviceId.mockResolvedValue({ ...s3Agent, lastSeen: new Date() });
			await expect(service.queuePlanBackup(s3Plan.id)).resolves.toBe(
				'Remote filesystem backup queued.'
			);
			expect(repositories.createBackupAndCommand.mock.calls[0][0].command.payload).toEqual({
				backupId: expect.any(String),
				planId: s3Plan.id,
				repositoryId: 'remote-repo-example-01',
			});
		});

		it('applies the replication-destination HCP rules to the S3 storage', async () => {
			const crypt = new Cryptr(encryptionSecret);
			s3Storage = s3StorageRecord(crypt, { endpoint: 'https://s3.example.internal' });
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject({
				statusCode: 400,
				message: expect.stringContaining('HCP'),
			});
			s3Storage = s3StorageRecord(crypt, { hcp_mode: true, endpoint: 'http://s3.example.internal' });
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject({
				statusCode: 400,
				message: expect.stringContaining('HTTPS'),
			});
			s3Storage = s3StorageRecord(crypt, {
				hcp_mode: true,
				endpoint: 'https://s3.example.internal',
				env_auth: true,
			});
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject({ statusCode: 400 });
		});

		it('refuses the bucket root and a path outside the bucket', async () => {
			for (const storagePath of ['bucket-01', 'other-bucket/agents/app-01']) {
				await expect(service.validatePlanCreation({ ...s3Plan, storagePath })).rejects.toMatchObject({
					statusCode: 400,
					message: expect.stringContaining('bucket roots are forbidden'),
				});
			}
		});

		it('refuses S3 primary paths the Agent would refuse, without echoing them, and accepts a plain prefix', async () => {
			for (const storagePath of [
				'//bucket-01/agents/app-01',
				'bucket-01/agents/app-01//',
				'/bucket-01/agents/app-01',
				'bucket-01/agents/app-01/',
				'bucket-01//agents/app-01',
				'bucket-01/./app-01',
				'bucket-01/agents/../app-01',
				'bucket-01/agents\\app-01',
			]) {
				const error = await service
					.validatePlanCreation({ ...s3Plan, storagePath })
					.then(() => null)
					.catch(caught => caught);
				expect({ storagePath, status: error?.statusCode }).toEqual({ storagePath, status: 400 });
				expect(error.message).not.toContain('app-01');
			}
			await expect(
				service.validatePlanCreation({ ...s3Plan, storagePath: 'bucket-01/agents/app-01' })
			).resolves.toBeUndefined();
		});

		it('refuses a prefix that overlaps another plan primary or replica, and accepts a separate prefix', async () => {
			const overlap = {
				statusCode: 409,
				message: 'The S3 repository prefix overlaps another plan or replica. Select a separate prefix.',
			};
			planStore.getAll.mockResolvedValue([
				{ id: 'plan-other', storageId: 'storage-s3', storagePath: 'bucket-01/agents', settings: {} },
			]);
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject(overlap);
			planStore.getAll.mockResolvedValue([
				{
					id: 'plan-sftp',
					storageId: plan.storageId,
					storagePath: plan.storagePath,
					settings: {
						replication: {
							enabled: true,
							storages: [
								{
									replicationId: 'replica-01',
									storageId: 'storage-s3',
									storagePath: 'bucket-01/agents/app-01/mirror',
								},
							],
						},
					},
				},
			]);
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject(overlap);
			planStore.getAll.mockResolvedValue([
				{ id: s3Plan.id, storageId: 'storage-s3', storagePath: s3Plan.storagePath, settings: {} },
				{ id: 'plan-sibling', storageId: 'storage-s3', storagePath: 'bucket-01/agents/app-010', settings: {} },
			]);
			await expect(service.validatePlanCreation(s3Plan)).resolves.toBeUndefined();
			planStore.getAll.mockResolvedValue([
				{ id: 'plan-foreign', storageId: 'storage-s3', storagePath: 'other-bucket/data', settings: {} },
			]);
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject({
				statusCode: 409,
				message:
					'Another plan uses an S3 location that cannot be verified, so the S3 repository prefix cannot be checked for overlap.',
			});
		});

		it('refuses replication settings for an S3 primary before any replica validation', async () => {
			const replication = {
				validatePlan: jest.fn(async () => undefined),
				enqueueBackup: jest.fn(async () => undefined),
			};
			service.setReplicationService(replication);
			const replicated = {
				...s3Plan,
				settings: {
					...s3Plan.settings,
					replication: {
						enabled: true,
						concurrent: false,
						storages: [
							{
								replicationId: 'replica-01',
								storageId: 'mirror-01',
								storagePath: 'bucket-02/owned',
								storageType: 's3compatible',
								storageName: 'Mirror',
								addedAt: 1,
							},
						],
					},
				},
			};
			await expect(service.validatePlanCreation(replicated)).rejects.toMatchObject({
				statusCode: 400,
				message: 'Replication is not available for an S3 primary repository yet.',
			});
			await expect(
				service.validatePlanCreation({
					...replicated,
					settings: {
						...replicated.settings,
						replication: { ...replicated.settings.replication, enabled: false },
					},
				})
			).rejects.toMatchObject({ statusCode: 400 });
			expect(replication.validatePlan).not.toHaveBeenCalled();
			await expect(
				service.validatePlanCreation({
					...s3Plan,
					settings: {
						...s3Plan.settings,
						replication: { enabled: false, concurrent: false, storages: [] },
					},
				})
			).resolves.toBeUndefined();
		});

		it('refuses a prefix inside a retained repository of a deleted plan and allows a sibling prefix', async () => {
			const retained = (storagePath: string) => [
				{ planId: null, storageId: 'storage-s3', storagePath, kind: 'retained' },
			];
			planStore.getStorageRemovalReferences.mockResolvedValue(retained('bucket-01/agents/app-01'));
			await expect(
				service.validatePlanCreation({ ...s3Plan, storagePath: 'bucket-01/agents/app-01/x' })
			).rejects.toMatchObject({
				statusCode: 409,
				message: 'The S3 repository prefix overlaps another plan or replica. Select a separate prefix.',
			});
			planStore.getStorageRemovalReferences.mockResolvedValue(retained('bucket-01/agents/app-010'));
			await expect(service.validatePlanCreation(s3Plan)).resolves.toBeUndefined();
		});

		it('refuses a non primary-only recovery policy on an S3 primary even with replication off', async () => {
			for (const recoveryPolicy of ['assisted', 'automatic']) {
				await expect(
					service.validatePlanCreation({
						...s3Plan,
						settings: {
							...s3Plan.settings,
							replication: { enabled: false, concurrent: false, recoveryPolicy, storages: [] },
						},
					})
				).rejects.toMatchObject({
					statusCode: 400,
					message: 'Replication is not available for an S3 primary repository yet.',
				});
			}
			await expect(
				service.validatePlanCreation({
					...s3Plan,
					settings: {
						...s3Plan.settings,
						replication: { enabled: false, concurrent: false, recoveryPolicy: 'primary-only', storages: [] },
					},
				})
			).resolves.toBeUndefined();
		});

		it('names a rejected S3 setting in the preparation diagnostics without its value', async () => {
			s3Storage = s3StorageRecord(new Cryptr(encryptionSecret), {
				hcp_mode: true,
				endpoint: 'https://s3.example.internal',
				chunk_size: '64Mi',
			});
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject({ statusCode: 400 });
			const error = await service
				.materializeCommand(capableAgent.agentId, backupCommand())
				.then(() => null)
				.catch(caught => caught);
			expect(error).toBeInstanceOf(RemoteCommandPreparationError);
			expect(error).toMatchObject({
				stage: 's3-storage-validation',
				rejectedField: 'chunk_size',
				ruleCategory: 'unsupported-field',
				storageId: s3Plan.storageId,
			});
			expect(JSON.stringify(error)).not.toContain('64Mi');
		});

		it('refuses a destination that is neither SFTP nor S3', async () => {
			storageStore.getById.mockResolvedValue({
				id: plan.storageId,
				type: 'local',
				settings: {},
				credentials: {},
			});
			await expect(service.validatePlanCreation(plan)).rejects.toMatchObject({
				statusCode: 400,
				message: 'Remote filesystem backups require an SFTP or S3 destination.',
			});
		});
	});
	describe('Payload version 5 (S3_AGENT_REPOSITORY_DESIGN.md 10.2 and 10.3)', () => {
		const sealing = {
			agentSecret: 'synthetic-agent-secret-0123456789abcdef',
			leaseToken: '0123456789abcdef0123456789abcdef0123456789abcdef',
		};
		beforeEach(async () => {
			const sftpStorage = await storageStore.getById(plan.storageId);
			const s3Storage = s3StorageRecord(new Cryptr(encryptionSecret));
			storageStore.getById.mockImplementation(async (id: string) =>
				id === s3Plan.storageId ? s3Storage : sftpStorage
			);
			agentStore.getAgentByDeviceId.mockResolvedValue({ ...s3Agent, lastSeen: new Date() });
		});
		const useS3Plan = () => {
			const s3Repository = {
				id: 'remote-repo-example-01',
				planId: plan.id,
				agentId: capableAgent.agentId,
				storageId: s3Plan.storageId,
				storagePath: s3Plan.storagePath,
				encryptedPassword: new Cryptr(encryptionSecret).encrypt(repositoryPassword),
				initializedAt: null,
			};
			planStore.getById.mockResolvedValue(s3Plan);
			repositories.getById.mockResolvedValue(s3Repository);
			repositories.getByPlanId.mockResolvedValue(s3Repository);
		};

		it('sends an S3 Agent version 5 with only allowlisted plain options and every secret sealed', async () => {
			useS3Plan();
			const command = backupCommand();
			const payload: any = await service.materializeCommand(capableAgent.agentId, command, sealing);
			expect(payload).toEqual({
				version: 5,
				sourceDiagnosticsVersion: 1,
				backupId: 'backup-example-01',
				planId: plan.id,
				sourcePath: '/srv/example-app',
				excludes: [],
				repository: { remoteName: 'pluton', path: 'bucket-01/agents/app-01', initialize: true },
				rclone: {
					type: 's3',
					options: {
						provider: 'Other',
						endpoint: 'https://s3.example.internal',
						force_path_style: 'true',
						use_accept_encoding_gzip: 'false',
						no_check_bucket: 'true',
					},
				},
				sealed: {
					alg: 'A256GCM',
					kid: 'pluton-agent-command-secrets-v1',
					nonce: expect.any(String),
					ciphertext: expect.any(String),
					tag: expect.any(String),
				},
			});
			const serialized = JSON.stringify(payload);
			for (const value of [repositoryPassword, s3AccessKey, s3SecretKey, encryptionSecret])
				expect(serialized).not.toContain(value);
			expect(
				openAgentCommandSecrets(sealing.agentSecret, command.id, sealing.leaseToken, payload.sealed)
			).toEqual({
				repositoryPassword,
				rclone: { access_key_id: s3AccessKey, secret_access_key: s3SecretKey },
			});
			expect(() =>
				openAgentCommandSecrets(sealing.agentSecret, command.id, 'a'.repeat(32), payload.sealed)
			).toThrow(AgentCommandSealingError);
			expect(() =>
				openAgentCommandSecrets(sealing.agentSecret, 'remote-backup-other', sealing.leaseToken, payload.sealed)
			).toThrow(AgentCommandSealingError);
		});

		it('seals the SFTP password for a version 5 Agent and keeps host, port and user plain', async () => {
			const command = backupCommand();
			const payload: any = await service.materializeCommand(capableAgent.agentId, command, sealing);
			expect(payload.version).toBe(5);
			expect(payload.rclone).toEqual({
				type: 'sftp',
				options: { host: 'sftp.example.internal', port: '22', user: 'backup-user' },
			});
			expect(payload).not.toHaveProperty('repositoryPassword');
			expect(JSON.stringify(payload)).not.toContain(storagePassword);
			expect(
				openAgentCommandSecrets(sealing.agentSecret, command.id, sealing.leaseToken, payload.sealed)
			).toEqual({ repositoryPassword, rclone: { pass: storagePassword } });
		});

		it('seals Agent host restore repository access with the same split (AGENT_HOST_RESTORE.md 3.2)', async () => {
			const commandId = 'agent-restore-0123456789abcdef01234567';
			const input = {
				repositoryId: 'remote-repo-example-01',
				planId: plan.id,
				agentId: capableAgent.agentId,
				capabilities: s3Agent.capabilities,
				commandId,
				sealing,
			};
			const sftp: any = await service.sealedRestoreRepository(input);
			expect(sftp.repository).toEqual({ remoteName: 'pluton', path: plan.storagePath });
			expect(sftp.rclone).toEqual({
				type: 'sftp',
				options: { host: 'sftp.example.internal', port: '22', user: 'backup-user' },
			});
			for (const value of [repositoryPassword, storagePassword, encryptionSecret])
				expect(JSON.stringify(sftp)).not.toContain(value);
			expect(openAgentCommandSecrets(sealing.agentSecret, commandId, sealing.leaseToken, sftp.sealed)).toEqual({
				repositoryPassword,
				rclone: { pass: storagePassword },
			});
			// Bound to the restore command and lease, never to a backup command.
			expect(() =>
				openAgentCommandSecrets(sealing.agentSecret, 'remote-backup-other', sealing.leaseToken, sftp.sealed)
			).toThrow(AgentCommandSealingError);
			useS3Plan();
			const s3: any = await service.sealedRestoreRepository(input);
			expect(s3.rclone.type).toBe('s3');
			expect(s3.repository).toEqual({ remoteName: 'pluton', path: 'bucket-01/agents/app-01' });
			for (const value of [repositoryPassword, s3AccessKey, s3SecretKey])
				expect(JSON.stringify(s3)).not.toContain(value);
			expect(openAgentCommandSecrets(sealing.agentSecret, commandId, sealing.leaseToken, s3.sealed)).toEqual({
				repositoryPassword,
				rclone: { access_key_id: s3AccessKey, secret_access_key: s3SecretKey },
			});
			await expect(
				service.sealedRestoreRepository({ ...input, capabilities: capableAgent.capabilities })
			).rejects.toThrow('does not support S3');
			await expect(
				service.sealedRestoreRepository({ ...input, agentId: 'agent-other' })
			).rejects.toThrow('another agent');
			await expect(
				service.sealedRestoreRepository({ ...input, planId: 'plan-other' })
			).rejects.toThrow('no longer exists');
		});

		it('keeps payload versions 1 to 4 unchanged for an Agent without version 5', async () => {
			agentStore.getAgentByDeviceId.mockResolvedValue({
				...capableAgent,
				capabilities: { ...capableAgent.capabilities, repositoryBackends: ['sftp'] },
				lastSeen: new Date(),
			});
			const payload: any = await service.materializeCommand(
				capableAgent.agentId,
				backupCommand(),
				sealing
			);
			expect(payload.version).toBe(1);
			expect(payload.repositoryPassword).toBe(repositoryPassword);
			expect(payload.rclone).toEqual({
				type: 'sftp',
				options: {
					host: 'sftp.example.internal',
					port: '22',
					user: 'backup-user',
					pass: storagePassword,
				},
			});
			expect(payload).not.toHaveProperty('sealed');
		});

		describe('database passwords sealed in version 5', () => {
			const commandId = 'remote-backup-backup-example-01';
			const agentWithLifecycle = (version: 1 | 2) =>
				agentStore.getAgentByDeviceId.mockResolvedValue({
					...s3Agent,
					lastSeen: new Date(),
					capabilities: {
						...s3Agent.capabilities,
						backupLifecycleVersion: version,
						databaseEngines: ['mariadb', 'postgresql'],
					},
				});
			const credentials = (entries: Array<[string, string]>) =>
				entries.map(([databaseId, value]) => ({
					databaseId,
					encryptedPassword: new Cryptr(encryptionSecret).encrypt(value),
					legacySingle: false,
				}));
			const openSealed = (payload: any) =>
				openAgentCommandSecrets(sealing.agentSecret, commandId, sealing.leaseToken, payload.sealed);

			it('moves every collection password into the sealed secrets keyed by databaseId', async () => {
				const databases = [
					{ ...database, databaseId: 'db_01' },
					{
						...database,
						databaseId: 'db_02',
						engine: 'postgresql',
						port: 5432,
						database: 'analytics',
						dumpFilename: 'analytics.sql',
					},
				];
				planStore.getById.mockResolvedValue({
					...plan,
					settings: { ...plan.settings, remoteLifecycle: { version: 2, databases } },
				});
				agentWithLifecycle(2);
				planStore.getDatabaseCredentials = jest.fn().mockResolvedValue(
					credentials([
						['db_02', 'synthetic-db-password-02'],
						['db_01', 'synthetic-db-password-01'],
					])
				);
				const payload: any = await service.materializeCommand(
					capableAgent.agentId,
					backupCommand(),
					sealing
				);
				const serialized = JSON.stringify(payload);
				expect(serialized).not.toContain('synthetic-db-password-01');
				expect(serialized).not.toContain('synthetic-db-password-02');
				expect(payload.lifecycle.databases).toHaveLength(2);
				for (const entry of payload.lifecycle.databases) expect(entry).not.toHaveProperty('password');
				expect(payload.lifecycle.databases[0]).toMatchObject({
					databaseId: 'db_01',
					engine: 'mariadb',
					database: 'example_db',
					dumpFilename: 'app.sql',
				});
				expect(openSealed(payload)).toEqual({
					repositoryPassword,
					rclone: { pass: storagePassword },
					lifecycle: {
						databases: { 'db_01': 'synthetic-db-password-01', 'db_02': 'synthetic-db-password-02' },
					},
				});
			});

			it('moves the single database password of lifecycle version 1 into sealed lifecycle.database', async () => {
				planStore.getById.mockResolvedValue(lifecyclePlan());
				agentWithLifecycle(1);
				planStore.getDatabaseCredential = jest
					.fn()
					.mockResolvedValue(new Cryptr(encryptionSecret).encrypt('synthetic-db-password-01'));
				const payload: any = await service.materializeCommand(
					capableAgent.agentId,
					backupCommand(),
					sealing
				);
				expect(payload.lifecycle.version).toBe(1);
				expect(payload.lifecycle.database).not.toHaveProperty('password');
				expect(payload.lifecycle.database).toMatchObject({
					engine: 'mariadb',
					database: 'example_db',
				});
				expect(JSON.stringify(payload)).not.toContain('synthetic-db-password-01');
				expect(openSealed(payload)).toEqual({
					repositoryPassword,
					rclone: { pass: storagePassword },
					lifecycle: { database: 'synthetic-db-password-01' },
				});
			});

			it('has no sealed lifecycle key without a lifecycle or without a database', async () => {
				const plain: any = await service.materializeCommand(
					capableAgent.agentId,
					backupCommand(),
					sealing
				);
				expect(openSealed(plain)).not.toHaveProperty('lifecycle');
				planStore.getById.mockResolvedValue({
					...plan,
					settings: { ...plan.settings, remoteLifecycle: { version: 2, databases: [] } },
				});
				agentWithLifecycle(2);
				planStore.getDatabaseCredentials = jest.fn().mockResolvedValue([]);
				const hookOnly: any = await service.materializeCommand(
					capableAgent.agentId,
					backupCommand(),
					sealing
				);
				expect(openSealed(hookOnly)).not.toHaveProperty('lifecycle');
			});

			it('keeps the password in the plain lifecycle for payload version 4 and below', async () => {
				planStore.getById.mockResolvedValue(lifecyclePlan());
				agentStore.getAgentByDeviceId.mockResolvedValue({
					...capableAgent,
					lastSeen: new Date(),
					capabilities: {
						...capableAgent.capabilities,
						backupLifecycleVersion: 1,
						databaseEngines: ['mariadb'],
					},
				});
				planStore.getDatabaseCredential = jest
					.fn()
					.mockResolvedValue(new Cryptr(encryptionSecret).encrypt('synthetic-db-password-01'));
				const payload: any = await service.materializeCommand(
					capableAgent.agentId,
					backupCommand(),
					sealing
				);
				expect(payload.version).toBe(2);
				expect(payload.lifecycle.database.password).toBe('synthetic-db-password-01');
				expect(payload).not.toHaveProperty('sealed');
			});
		});

		it('refuses to build version 5 without the lease sealing context', async () => {
			const error = await service
				.materializeCommand(capableAgent.agentId, backupCommand())
				.then(() => null)
				.catch(caught => caught);
			expect(error).toBeInstanceOf(RemoteCommandPreparationError);
			expect(error).toMatchObject({
				stage: 'payload-sealing',
				safeMessage: 'Remote backup secrets could not be sealed for the agent.',
			});
		});

		it('fails a queued S3 command closed when the Agent no longer reports S3 at poll time', async () => {
			useS3Plan();
			agentStore.getAgentByDeviceId.mockResolvedValue({ ...capableAgent, lastSeen: new Date() });
			const error = await service
				.materializeCommand(capableAgent.agentId, backupCommand(), sealing)
				.then(() => null)
				.catch(caught => caught);
			expect(error).toBeInstanceOf(RemoteCommandPreparationError);
			expect(error).toMatchObject({
				stage: 'repository-backend',
				message: 'Remote agent does not support S3 repositories. Update the agent first.',
			});
		});

		it('records an S3 primary snapshot exactly like an SFTP one and never queues replication', async () => {
			useS3Plan();
			planStore.update = jest.fn();
			const replication = {
				validatePlan: jest.fn(async () => undefined),
				enqueueBackup: jest.fn(async () => undefined),
			};
			service.setReplicationService(replication);
			const id = 'b'.repeat(64);
			const summary = { message_type: 'summary', snapshot_id: id, total_bytes_processed: 2048 } as any;
			await service.completeCommand(backupCommand(), {
				success: true,
				result: { snapshotId: id, summary },
			});
			expect((service as any).eventService.onBackupComplete).toHaveBeenCalledWith(
				expect.objectContaining({ success: true, summary })
			);
			expect(repositories.markInitialized).toHaveBeenCalledWith('remote-repo-example-01');
			expect(planStore.update).toHaveBeenCalledWith(
				plan.id,
				expect.objectContaining({ stats: { size: 2048, snapshots: [id] } })
			);
			expect(replication.enqueueBackup).not.toHaveBeenCalled();
		});
	});

	describe('Server read access by storage type (S3_AGENT_REPOSITORY_DESIGN.md 6.1.3)', () => {
		it('keeps SFTP read options unchanged and returns S3 session options without asking the Agent', async () => {
			const sftpOptions = await service.getSftpRecoveryOptions(plan.storageId);
			await expect(service.getRepositoryAccessOptions(plan.storageId)).resolves.toEqual(sftpOptions);
			const sftpStorage = await storageStore.getById(plan.storageId);
			const s3Storage = s3StorageRecord(new Cryptr(encryptionSecret));
			storageStore.getById.mockImplementation(async (id: string) =>
				id === s3Plan.storageId ? s3Storage : sftpStorage
			);
			agentStore.getAgentByDeviceId.mockResolvedValue(null);
			await expect(service.getRepositoryAccessOptions(s3Plan.storageId)).resolves.toEqual({
				type: 's3',
				provider: 'Other',
				endpoint: 'https://s3.example.internal',
				no_check_bucket: 'true',
				use_accept_encoding_gzip: 'false',
				force_path_style: 'true',
				access_key_id: s3AccessKey,
				secret_access_key: s3SecretKey,
				env_auth: 'false',
			});
			expect(agentStore.getAgentByDeviceId).not.toHaveBeenCalled();
			await expect(service.getSftpRecoveryOptions(s3Plan.storageId)).rejects.toMatchObject({
				statusCode: 400,
			});
		});
	});
});
