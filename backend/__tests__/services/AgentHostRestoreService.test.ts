import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Cryptr from 'cryptr';
import { agentCommands } from '../../src/db/schema/agents';
import { restores } from '../../src/db/schema/restores';
import { RestoreStore } from '../../src/stores/RestoreStore';
import {
	AgentHostRestoreService,
	agentHostRestoreCompletionSchema,
} from '../../src/services/AgentHostRestoreService';
import { AgentService } from '../../src/services/AgentService';
import { RestoreService } from '../../src/services/RestoreService';
import { verifyAgentSignature, signAgentCommand } from '../../src/utils/agentProtocol';
import {
	agentHostRestoreCapability,
	agentHostSelectionProblem,
	isAgentHostRestoreName,
	restoreAccessReportSchema,
	suggestedAgentHostRestoreName,
	supportsAgentHostRestoreVersion,
	writableRestoreRoots,
} from '../../src/utils/agentHostRestore';
import { agentCommandRenewalMs, AGENT_BACKUP_LEASE_RENEWAL_MS } from '../../src/types/agents';

jest.mock('../../src/services/ConfigService', () => ({
	configService: {
		config: {
			SECRET: 'agent-host-restore-test-secret-that-is-long-enough',
			APP_URL: 'https://pluton.example.internal',
			AGENT_OFFLINE_TIMEOUT_SECONDS: 90,
		},
	},
}));

const GiB = 1024 ** 3;
const SNAPSHOT = 'ab'.repeat(32);
const DUMP_SHA = 'c'.repeat(64);
const restoreAccess = {
	version: 1,
	roots: [
		{ path: '/srv/pluton-restore', status: 'writable', availableBytes: 500 * GiB, availableInodes: 4_000_000 },
		{ path: '/srv/other-restore', status: 'rejected', code: 'restore-root-mode' },
	],
};
const capabilities = {
	filesystemRootsConfigured: true,
	commandTypes: ['PING', 'INVENTORY_REFRESH', 'BACKUP_FILESYSTEM', 'RESTORE_FILESYSTEM'],
	repositoryBackends: ['sftp', 's3'],
	backupPayloadVersion: 5,
	restoreFilesystemVersion: 1,
	restoreAccess,
};
const agent = {
	agentId: 'agent-example-01',
	deviceId: 'remote-device-01',
	hostname: 'app-01',
	agentVersion: '0.9.0',
	revokedAt: null,
	capabilities,
} as any;
const plan = {
	id: 'plan-01',
	sourceId: 'remote-device-01',
	sourceType: 'device',
	method: 'backup',
	storageId: 'storage-sftp',
	storagePath: 'managed/app-01',
} as any;
const backup = {
	id: 'backup-01',
	planId: 'plan-01',
	sourceId: 'remote-device-01',
	sourceType: 'device',
	method: 'backup',
	status: 'completed',
	success: true,
	inProgress: false,
	storageId: 'storage-sftp',
	completionStats: {
		snapshot_id: SNAPSHOT,
		lifecycle: {
			warnings: [],
			databases: [
				{
					databaseId: 'db_odoo',
					engine: 'postgresql',
					database: 'odoo',
					path: '/pluton/database/odoo.sql',
					bytes: 2048,
					sha256: DUMP_SHA,
				},
			],
		},
	},
} as any;
const repository = {
	id: 'remote-repo-01',
	planId: 'plan-01',
	agentId: 'agent-example-01',
	storageId: 'storage-sftp',
	storagePath: 'managed/app-01',
} as any;
const sealed = {
	alg: 'A256GCM',
	kid: 'pluton-agent-command-secrets-v1',
	nonce: 'bm9uY2U=',
	ciphertext: 'Y2lwaGVy',
	tag: 'dGFn',
};

function database() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE restores (
			id text PRIMARY KEY NOT NULL, created_at integer NOT NULL DEFAULT (unixepoch()), updated_at integer,
			started_at integer, ended_at integer, in_progress integer, status text, error_msg text, backup_id text,
			plan_id text, storage_id text, source_id text NOT NULL, source_type text NOT NULL DEFAULT 'device',
			config text, method text NOT NULL DEFAULT 'backup', task_stats text, progress_stats text, completion_stats text
		);
		CREATE TABLE agent_commands (
			id text PRIMARY KEY NOT NULL, agent_id text NOT NULL, type text NOT NULL, payload text NOT NULL,
			state text NOT NULL DEFAULT 'queued', idempotency_key text NOT NULL UNIQUE,
			created_at integer NOT NULL DEFAULT (unixepoch()), leased_at integer, lease_owner text, lease_expires_at integer,
			acknowledged_at integer, completed_at integer, attempt_count integer NOT NULL DEFAULT 0,
			last_event_sequence integer NOT NULL DEFAULT 0, last_error text
		);
	`);
	return { sqlite, db: drizzle(sqlite, { schema: { restores, agentCommands } }) as any };
}

function setup() {
	const { sqlite, db } = database();
	const restoreStore = new RestoreStore(db);
	const agentStore = {
		getAgentByDeviceId: jest.fn().mockResolvedValue(agent),
		getAgentById: jest.fn().mockResolvedValue(agent),
		cancelCommand: jest.fn().mockResolvedValue({}),
	};
	const planStore = { getById: jest.fn().mockResolvedValue(plan) };
	const backupStore = { getById: jest.fn().mockResolvedValue(backup) };
	const repositories = { getByPlanId: jest.fn().mockResolvedValue(repository) };
	const remoteBackupService = {
		sealedRestoreRepository: jest.fn().mockResolvedValue({
			repository: { remoteName: 'pluton', path: 'managed/app-01' },
			rclone: { type: 'sftp', options: { host: 'sftp.example.internal', port: '22', user: 'backup-user' } },
			sealed,
		}),
	};
	const service = new AgentHostRestoreService(
		agentStore as any,
		planStore as any,
		backupStore as any,
		restoreStore,
		repositories as any,
		remoteBackupService as any,
		() => new Date('2026-11-20T08:00:00.000Z')
	);
	const commands = () => sqlite.prepare('SELECT * FROM agent_commands').all() as any[];
	const leased = async (restoreId: string, overrides: Record<string, unknown> = {}) => {
		const row = commands().find(command => JSON.parse(command.payload).restoreId === restoreId);
		return {
			id: row.id,
			agentId: row.agent_id,
			type: row.type,
			payload: JSON.parse(row.payload),
			state: 'running',
			attemptCount: 1,
			lastEventSequence: 0,
			leaseOwner: 'l'.repeat(32),
			...overrides,
		} as any;
	};
	return { service, restoreStore, agentStore, planStore, backupStore, repositories, remoteBackupService, commands, leased };
}

const request = (overrides: Record<string, unknown> = {}) => ({
	backupId: 'backup-01',
	planId: 'plan-01',
	root: '/srv/pluton-restore',
	name: 'app-01-20261120-01234567',
	...overrides,
});

describe('Agent host restore rules (docs/AGENT_HOST_RESTORE.md)', () => {
	it('gates on capability, command type and version 0.9.0 like the vanished-entry opt-in', () => {
		for (const version of ['0.9.0', 'v0.9.0', '0.10.0', '1.0.0']) expect(supportsAgentHostRestoreVersion(version)).toBe(true);
		for (const version of ['0.8.1', '0.9.0-dev', '', 'latest']) expect(supportsAgentHostRestoreVersion(version)).toBe(false);
		expect(agentHostRestoreCapability(agent)).toEqual({ supported: true });
		expect(agentHostRestoreCapability(null)).toEqual({ supported: false, reason: 'agent-missing' });
		expect(agentHostRestoreCapability({ ...agent, revokedAt: new Date() })).toEqual({ supported: false, reason: 'agent-revoked' });
		expect(agentHostRestoreCapability({ ...agent, agentVersion: '0.8.1' })).toEqual({ supported: false, reason: 'agent-version' });
		expect(
			agentHostRestoreCapability({ ...agent, capabilities: { ...capabilities, restoreFilesystemVersion: undefined } })
		).toEqual({ supported: false, reason: 'capability-missing' });
		expect(
			agentHostRestoreCapability({ ...agent, capabilities: { ...capabilities, commandTypes: ['PING'] } })
		).toEqual({ supported: false, reason: 'capability-missing' });
		expect(writableRestoreRoots(capabilities).map(root => root.path)).toEqual(['/srv/pluton-restore']);
		expect(writableRestoreRoots({ ...capabilities, restoreAccess: { ...restoreAccess, policyError: 'restore-policy-invalid' } })).toEqual([]);
		expect(writableRestoreRoots({ ...capabilities, restoreAccess: { version: 2, roots: [] } })).toEqual([]);
	});

	it('accepts only the closed restore-root report', () => {
		expect(restoreAccessReportSchema.safeParse(restoreAccess).success).toBe(true);
		for (const invalid of [
			{ ...restoreAccess, extra: true },
			{ version: 1, roots: [{ path: 'relative', status: 'writable' }] },
			{ version: 1, roots: [{ path: '/srv/a', status: 'writable', code: 'provider text' }] },
			{ version: 1, roots: [{ path: '/srv/a', status: 'busy' }] },
			{ version: 1, roots: [{ path: '/srv/a', status: 'writable' }, { path: '/srv/a', status: 'writable' }] },
			{ version: 1, roots: Array.from({ length: 9 }, (_, i) => ({ path: `/srv/r${i}`, status: 'writable' })) },
			{ version: 1, roots: [], policyError: 'anything' },
		])
			expect(restoreAccessReportSchema.safeParse(invalid).success).toBe(false);
	});

	it('mirrors the Agent rules for names and selections', () => {
		for (const name of ['app-01-20261120-01234567', 'a', 'restore.v2_1']) expect(isAgentHostRestoreName(name)).toBe(true);
		for (const name of ['', '.hidden', '../x', 'a/b', 'x.partial', 'x'.repeat(101), 'a b']) expect(isAgentHostRestoreName(name)).toBe(false);
		expect(agentHostSelectionProblem({ includes: [], excludes: [] })).toBeUndefined();
		expect(agentHostSelectionProblem({ includes: ['/srv/example-app/filestore'], excludes: [] })).toBeUndefined();
		expect(agentHostSelectionProblem({ includes: ['/srv/a*'], excludes: [] })).toMatch(/wildcard/);
		expect(agentHostSelectionProblem({ includes: ['srv/a'], excludes: [] })).toMatch(/absolute/);
		expect(agentHostSelectionProblem({ includes: ['/srv/a/../b'], excludes: [] })).toMatch(/absolute/);
		expect(agentHostSelectionProblem({ includes: ['/srv/a'], excludes: ['/srv/a/b'] })).toMatch(/not both/);
		expect(agentHostSelectionProblem({ includes: ['/srv/a', '/srv/a/b'], excludes: [] })).toMatch(/inside another/);
		expect(agentHostSelectionProblem({ includes: ['/srv/a', '/srv/a'], excludes: [] })).toMatch(/repeats/);
		expect(suggestedAgentHostRestoreName('App 01.Example.Internal', '0123abcd99', new Date('2026-11-20T00:00:00Z'))).toBe(
			'app-01.example.internal-20261120-0123abcd'
		);
	});

	it('renews a restore lease like a backup lease', () => {
		expect(agentCommandRenewalMs('RESTORE_FILESYSTEM')).toBe(AGENT_BACKUP_LEASE_RENEWAL_MS);
	});
});

describe('AgentHostRestoreService', () => {
	it('offers only writable host-approved roots and the backup database dumps', async () => {
		const { service } = setup();
		const options = await service.options('backup-01', 'plan-01');
		expect(options).toEqual({
			supported: true,
			agent: { hostname: 'app-01', agentVersion: '0.9.0' },
			snapshotId: SNAPSHOT,
			roots: [{ path: '/srv/pluton-restore', availableBytes: 500 * GiB, availableInodes: 4_000_000 }],
			unavailableRoots: [{ path: '/srv/other-restore', status: 'rejected', code: 'restore-root-mode' }],
			suggestedName: expect.stringMatching(/^app-01-20261120-[a-f0-9]{8}$/),
			databases: [
				{
					databaseId: 'db_odoo',
					engine: 'postgresql',
					database: 'odoo',
					path: '/pluton/database/odoo.sql',
					bytes: 2048,
					sha256: DUMP_SHA,
				},
			],
		});
	});

	it('explains why an Agent cannot restore to its host', async () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ agentVersion: '0.8.1' }, 'agent-version'],
			[{ capabilities: { ...capabilities, restoreFilesystemVersion: undefined } }, 'capability-missing'],
			[{ capabilities: { ...capabilities, restoreAccess: { version: 1, roots: [] } } }, 'no-writable-root'],
			[{ capabilities: { ...capabilities, restoreAccess: { version: 1, roots: [], policyError: 'restore-policy-not-protected' } } }, 'restore-policy-error'],
			[{ revokedAt: new Date() }, 'agent-revoked'],
		];
		for (const [override, reason] of cases) {
			const { service, agentStore } = setup();
			agentStore.getAgentByDeviceId.mockResolvedValue({ ...agent, ...override });
			const options = await service.options('backup-01', 'plan-01');
			expect(options.supported).toBe(false);
			expect((options as any).reason).toBe(reason);
			await expect(service.create(request())).rejects.toMatchObject({ statusCode: 409 });
		}
	});

	it('refuses backups that are not completed Managed Agent snapshots', async () => {
		const { service, backupStore } = setup();
		backupStore.getById.mockResolvedValueOnce({ ...backup, sourceId: 'main' });
		await expect(service.options('backup-01', 'plan-01')).rejects.toMatchObject({ statusCode: 400 });
		backupStore.getById.mockResolvedValueOnce({ ...backup, status: 'failed', success: false });
		await expect(service.options('backup-01', 'plan-01')).rejects.toMatchObject({ statusCode: 409 });
		backupStore.getById.mockResolvedValueOnce({ ...backup, completionStats: { snapshot_id: 'abcdef01' } });
		await expect(service.options('backup-01', 'plan-01')).rejects.toMatchObject({ statusCode: 409 });
		backupStore.getById.mockResolvedValueOnce({ ...backup, planId: 'plan-other' });
		await expect(service.options('backup-01', 'plan-01')).rejects.toMatchObject({ statusCode: 404 });
	});

	it('restores only on the host whose Agent owns the managed repository', async () => {
		const { service, repositories } = setup();
		repositories.getByPlanId.mockResolvedValue({ ...repository, agentId: 'agent-other' });
		await expect(service.create(request())).rejects.toThrow('Restore runs only on the host that made the backup');
	});

	it('queues one reference-only command with the restore row in one transaction', async () => {
		const { service, restoreStore, commands } = setup();
		const { restoreId, target } = await service.create(
			request({ includes: ['/srv/example-app/filestore'] })
		);
		expect(restoreId).toMatch(/^[a-f0-9]{24}$/);
		expect(target).toBe('/srv/pluton-restore/app-01-20261120-01234567');
		const row = await restoreStore.getById(restoreId);
		expect(row).toMatchObject({
			status: 'queued',
			inProgress: true,
			sourceId: 'remote-device-01',
			backupId: 'backup-01',
			planId: 'plan-01',
			config: {
				target,
				overwrite: 'never',
				delete: false,
				includes: ['/srv/example-app/filestore'],
				excludes: [],
				snapshotId: SNAPSHOT,
				agentHost: {
					version: 1,
					agentId: 'agent-example-01',
					root: '/srv/pluton-restore',
					name: 'app-01-20261120-01234567',
					commandId: `agent-restore-${restoreId}`,
				},
			},
		});
		const [command] = commands();
		expect(command).toMatchObject({
			id: `agent-restore-${restoreId}`,
			agent_id: 'agent-example-01',
			type: 'RESTORE_FILESYSTEM',
			state: 'queued',
			idempotency_key: `agent-restore:${restoreId}`,
		});
		// No target, secret or repository detail is persisted in the command.
		expect(JSON.parse(command.payload)).toEqual({
			restoreId,
			planId: 'plan-01',
			backupId: 'backup-01',
			repositoryId: 'remote-repo-01',
		});
		await expect(service.create(request({ name: 'another-folder' }))).rejects.toThrow(
			'already in progress for this backup'
		);
	});

	it('refuses unsafe requests before writing anything', async () => {
		const { service, commands } = setup();
		const refusals: [Record<string, unknown>, number][] = [
			[{ root: '/srv/other-restore' }, 409],
			[{ root: '/srv/not-approved' }, 409],
			[{ name: '../escape' }, 400],
			[{ name: 'app.partial' }, 400],
			[{ includes: ['/srv/a*'] }, 400],
			[{ includes: ['/srv/a'], excludes: ['/srv/a/b'] }, 400],
			[{ databaseId: 'db_missing' }, 404],
			[{ databaseId: 'db_odoo', includes: ['/srv/example-app'] }, 400],
			[{ databaseId: 'db_odoo', excludes: ['/pluton'] }, 400],
			[{ extra: true }, 400],
			[{ root: 3 }, 400],
		];
		for (const [override, status] of refusals)
			await expect(service.create(request(override))).rejects.toMatchObject({ statusCode: status });
		expect(commands()).toEqual([]);
	});

	it('refuses a second active restore into the same host folder', async () => {
		const { service, backupStore } = setup();
		await service.create(request());
		backupStore.getById.mockResolvedValue({ ...backup, id: 'backup-02' });
		await expect(service.create(request({ backupId: 'backup-02' }))).rejects.toThrow(
			'Another restore into this host folder'
		);
	});

	it('binds a database dump restore to the receipt size and SHA-256', async () => {
		const { service, restoreStore } = setup();
		const { restoreId } = await service.create(request({ databaseId: 'db_odoo' }));
		const row = await restoreStore.getById(restoreId);
		expect(row?.config?.includes).toEqual(['/pluton/database/odoo.sql']);
		expect(row?.config?.agentHost?.artifact).toEqual({
			path: '/pluton/database/odoo.sql',
			bytes: 2048,
			sha256: DUMP_SHA,
		});
		expect(row?.taskStats?.total_bytes).toBe(2048);
	});

	it('materializes the signed payload at poll with sealed secrets only', async () => {
		const { service, restoreStore, remoteBackupService, leased } = setup();
		const { restoreId } = await service.create(request({ databaseId: 'db_odoo' }));
		const command = await leased(restoreId);
		const sealing = { agentSecret: 'synthetic-agent-secret', leaseToken: 'l'.repeat(32) };
		const payload = await service.materializeCommand('agent-example-01', command, sealing);
		expect(payload).toEqual({
			version: 1,
			restoreId,
			planId: 'plan-01',
			backupId: 'backup-01',
			snapshotId: SNAPSHOT,
			target: { root: '/srv/pluton-restore', name: 'app-01-20261120-01234567' },
			selection: { includes: ['/pluton/database/odoo.sql'], excludes: [] },
			artifact: { path: '/pluton/database/odoo.sql', bytes: 2048, sha256: DUMP_SHA },
			repository: { remoteName: 'pluton', path: 'managed/app-01' },
			rclone: { type: 'sftp', options: { host: 'sftp.example.internal', port: '22', user: 'backup-user' } },
			sealed,
		});
		expect(remoteBackupService.sealedRestoreRepository).toHaveBeenCalledWith({
			repositoryId: 'remote-repo-01',
			planId: 'plan-01',
			agentId: 'agent-example-01',
			capabilities,
			commandId: `agent-restore-${restoreId}`,
			sealing,
		});
		expect((await restoreStore.getById(restoreId))?.status).toBe('started');
	});

	it('never delivers to another Agent, after cancellation or after the capability is lost', async () => {
		const sealing = { agentSecret: 'synthetic-agent-secret', leaseToken: 'l'.repeat(32) };
		const first = setup();
		const { restoreId } = await first.service.create(request());
		await expect(
			first.service.materializeCommand('agent-other', await first.leased(restoreId), sealing)
		).rejects.toThrow('does not belong');
		first.agentStore.getAgentById.mockResolvedValue({ ...agent, agentVersion: '0.8.1' });
		await expect(
			first.service.materializeCommand('agent-example-01', await first.leased(restoreId), sealing)
		).rejects.toThrow('no longer supports');
		await first.service.failUndeliverable(await first.leased(restoreId));
		expect(await first.restoreStore.getById(restoreId)).toMatchObject({ status: 'failed', inProgress: false });
		const second = setup();
		const created = await second.service.create(request());
		await second.service.cancel((await second.restoreStore.getById(created.restoreId))!);
		expect(second.agentStore.cancelCommand).toHaveBeenCalledWith(`agent-restore-${created.restoreId}`);
		await expect(
			second.service.materializeCommand('agent-example-01', await second.leased(created.restoreId), sealing)
		).rejects.toThrow('no longer valid');
		expect(second.remoteBackupService.sealedRestoreRepository).not.toHaveBeenCalled();
	});

	it('records bounded progress and completes only with matching verified metadata', async () => {
		const { service, restoreStore, leased } = setup();
		const { restoreId, target } = await service.create(request());
		const command = await leased(restoreId);
		await service.recordEvent(
			command,
			{
				phase: 'running',
				restoreStage: 'restoring',
				progress: { bytesProcessed: 10, filesProcessed: 1, totalBytesProcessed: 40, totalFilesProcessed: 4 },
			},
			3
		);
		let row = await restoreStore.getById(restoreId);
		expect(row?.taskStats).toEqual({ total_files: 4, files_restored: 1, total_bytes: 40, bytes_restored: 10 });
		expect(row?.progressStats?.backupStage).toBe('restoring');
		expect(service.progress(row!)).toMatchObject({
			restoreId,
			agentHost: { target, stage: 'restoring', verified: false },
			status: 'started',
		});
		const result = {
			restoreId,
			restoredSnapshotId: SNAPSHOT,
			targetPath: target,
			totalFiles: 4,
			filesRestored: 4,
			totalBytes: 40,
			bytesRestored: 40,
			verified: true as const,
		};
		await service.complete(command, {
			sequence: 4,
			leaseToken: 'l'.repeat(32),
			success: true,
			result: { ...result, targetPath: '/srv/pluton-restore/other' },
		});
		expect(await restoreStore.getById(restoreId)).toMatchObject({ status: 'failed', inProgress: false });
		const second = setup();
		const created = await second.service.create(request());
		await second.service.complete(await second.leased(created.restoreId), {
			sequence: 4,
			leaseToken: 'l'.repeat(32),
			success: true,
			result: { ...result, restoreId: created.restoreId },
		});
		row = await second.restoreStore.getById(created.restoreId);
		expect(row).toMatchObject({
			status: 'completed',
			inProgress: false,
			taskStats: { total_files: 4, files_restored: 4, total_bytes: 40, bytes_restored: 40 },
		});
		expect(row?.config?.agentHost?.verified).toBe(true);
		expect(second.service.stats(row!)).toEqual({
			success: true,
			result: {
				target,
				verified: true,
				stats: { total_files: 4, files_restored: 4, total_bytes: 40, bytes_restored: 40 },
				restoredPaths: [],
			},
		});
		expect(() => second.service.assertDeletable(row!)).not.toThrow();
	});

	it('records a closed failure with operator advice and keeps cancellations', async () => {
		const { service, restoreStore, leased } = setup();
		const { restoreId } = await service.create(request());
		expect(() => service.assertDeletable((undefined as any) || ({ inProgress: true } as any))).toThrow(
			'Cancel the Agent host restore'
		);
		await service.complete(await leased(restoreId), {
			sequence: 2,
			leaseToken: 'l'.repeat(32),
			success: false,
			error: 'Agent host restore failed.',
			failureStage: 'target-creation',
			failureCode: 'restore-target-exists',
		});
		const row = await restoreStore.getById(restoreId);
		expect(row?.status).toBe('failed');
		expect(row?.errorMsg).toContain('(target-creation/restore-target-exists)');
		expect(row?.errorMsg).toContain('.partial');
		expect(row?.config?.agentHost).toMatchObject({
			failureStage: 'target-creation',
			failureCode: 'restore-target-exists',
		});
		const cancelled = setup();
		const created = await cancelled.service.create(request());
		await cancelled.service.complete(await cancelled.leased(created.restoreId), {
			sequence: 2,
			leaseToken: 'l'.repeat(32),
			success: false,
			cancelled: true,
			error: 'Restore was cancelled.',
			failureStage: 'restic-restore',
			failureCode: 'cancelled',
		});
		expect(await cancelled.restoreStore.getById(created.restoreId)).toMatchObject({ status: 'cancelled' });
	});

	it('accepts a late verified success after a user cancellation only from the lease that ran it', async () => {
		const { service, restoreStore, leased } = setup();
		const { restoreId, target } = await service.create(request());
		await service.cancel((await restoreStore.getById(restoreId))!);
		const completion = {
			sequence: 9,
			success: true,
			result: {
				restoreId,
				restoredSnapshotId: SNAPSHOT,
				targetPath: target,
				totalFiles: 1,
				filesRestored: 1,
				totalBytes: 1,
				bytesRestored: 1,
				verified: true as const,
			},
		};
		await service.complete(await leased(restoreId, { state: 'cancelled' }), {
			...completion,
			leaseToken: 'x'.repeat(32),
		});
		expect((await restoreStore.getById(restoreId))?.status).toBe('cancelled');
		await service.complete(await leased(restoreId, { state: 'cancelled' }), {
			...completion,
			leaseToken: 'l'.repeat(32),
		});
		const row = await restoreStore.getById(restoreId);
		expect(row?.status).toBe('completed');
		expect(row?.errorMsg).toContain('before the cancellation reached the Agent');
	});

	it('validates the closed completion schema', () => {
		const result = {
			restoreId: 'a'.repeat(24),
			restoredSnapshotId: SNAPSHOT,
			targetPath: '/srv/pluton-restore/x',
			totalFiles: 1,
			filesRestored: 1,
			totalBytes: 1,
			bytesRestored: 1,
			verified: true,
		};
		const base = { sequence: 1, leaseToken: 'l'.repeat(32) };
		expect(agentHostRestoreCompletionSchema.safeParse({ ...base, success: true, result }).success).toBe(true);
		for (const invalid of [
			{ ...base, success: true },
			{ ...base, success: true, result: { ...result, verified: false } },
			{ ...base, success: true, result: { ...result, snapshotId: SNAPSHOT } },
			{ ...base, success: false },
			{ ...base, success: false, error: 'x', failureCode: 'provider-said-no' },
			{ ...base, success: false, error: 'x', failureStage: 'restic-backup' },
			{ ...base, success: false, error: 'x', result },
			{ ...base, success: true, result, extra: 1 },
		])
			expect(agentHostRestoreCompletionSchema.safeParse(invalid).success).toBe(false);
	});
});

describe('AgentService and RestoreService dispatch for RESTORE_FILESYSTEM', () => {
	const secret = 'agent-per-device-test-secret';
	const identity = {
		...agent,
		encryptedSecret: new Cryptr('agent-host-restore-test-secret-that-is-long-enough').encrypt(secret),
	};
	const inventory = {
		hostname: 'app-01',
		os: 'Example Linux',
		architecture: 'x64',
		agentVersion: '0.9.0',
		resticVersion: 'restic 0.19.1',
		rcloneVersion: 'rclone v1.75.1',
		restoreAccess,
		capabilities: {
			filesystemRootsConfigured: true,
			commandTypes: ['PING', 'INVENTORY_REFRESH', 'BACKUP_FILESYSTEM', 'RESTORE_FILESYSTEM'],
			repositoryBackends: ['sftp', 's3'],
			backupPayloadVersion: 5,
			restoreFilesystemVersion: 1,
		},
	};
	const command = {
		id: 'agent-restore-0123456789abcdef01234567',
		agentId: agent.agentId,
		type: 'RESTORE_FILESYSTEM',
		payload: { restoreId: '0123456789abcdef01234567', planId: 'plan-01', backupId: 'backup-01', repositoryId: 'remote-repo-01' },
		idempotencyKey: 'agent-restore:0123456789abcdef01234567',
		leaseExpiresAt: new Date('2026-11-20T08:01:00.000Z'),
		lastEventSequence: 0,
		attemptCount: 1,
		state: 'leased',
	} as any;
	function agentService() {
		const store = {
			updateHeartbeat: jest.fn().mockResolvedValue(identity),
			leaseNext: jest.fn().mockResolvedValue(command),
			completeCommand: jest.fn().mockResolvedValue({ ...command, state: 'failed' }),
			recordCommandEvent: jest.fn().mockResolvedValue({ ...command, state: 'running', lastEventSequence: 2 }),
			getCommandForAgent: jest.fn().mockResolvedValue(command),
		};
		const restore = {
			materializeCommand: jest.fn().mockResolvedValue({ version: 1, restoreId: '0123456789abcdef01234567' }),
			failUndeliverable: jest.fn(),
			recordEvent: jest.fn(),
			complete: jest.fn(),
		};
		const remoteBackupService = { recordCommandEvent: jest.fn(), completeCommand: jest.fn() };
		const service = new AgentService(
			store as any,
			'agent-host-restore-test-secret-that-is-long-enough',
			() => new Date('2026-11-20T08:00:00.000Z'),
			remoteBackupService as any,
			undefined,
			restore as any
		);
		return { store, restore, remoteBackupService, service };
	}

	it('accepts the 0.9.0 inventory and keeps the restore-root report beside the capabilities', async () => {
		const { store, service } = agentService();
		await service.heartbeat(agent.agentId, inventory);
		expect(store.updateHeartbeat).toHaveBeenCalledWith(
			agent.agentId,
			expect.objectContaining({
				capabilities: expect.objectContaining({ restoreFilesystemVersion: 1, restoreAccess }),
			})
		);
		for (const invalid of [
			{ ...inventory, restoreAccess: undefined },
			{ ...inventory, capabilities: { ...inventory.capabilities, restoreFilesystemVersion: undefined } },
			{ ...inventory, capabilities: { ...inventory.capabilities, commandTypes: ['PING'] } },
			{ ...inventory, restoreAccess: { ...restoreAccess, roots: [{ path: '/srv/a', status: 'writable', note: 'x' }] } },
			{ ...inventory, capabilities: { ...inventory.capabilities, restoreFilesystemVersion: 2 } },
		])
			await expect(service.heartbeat(agent.agentId, invalid)).rejects.toThrow('Agent inventory is invalid');
		// An Agent 0.8.x inventory without the new fields is unchanged.
		const { restoreAccess: _omitted, ...older } = inventory;
		await expect(
			service.heartbeat(agent.agentId, {
				...older,
				agentVersion: '0.8.1',
				capabilities: {
					filesystemRootsConfigured: true,
					commandTypes: ['PING', 'INVENTORY_REFRESH', 'BACKUP_FILESYSTEM'],
					repositoryBackends: ['sftp', 's3'],
					backupPayloadVersion: 5,
				},
			})
		).resolves.toBeDefined();
	});

	it('materializes at poll with the lease sealing context and signs the payload', async () => {
		const { restore, service } = agentService();
		const result = await service.poll({ agentId: agent.agentId, deviceId: agent.deviceId, secret });
		expect(restore.materializeCommand).toHaveBeenCalledWith(agent.agentId, command, {
			agentSecret: secret,
			leaseToken: result.command!.leaseToken,
		});
		expect(result.command?.payload).toEqual({ version: 1, restoreId: '0123456789abcdef01234567' });
		const expected = signAgentCommand(
			secret,
			result.command!.signatureTimestamp,
			{ ...command, payload: result.command!.payload },
			result.command!.leaseToken
		);
		expect(verifyAgentSignature(expected, result.command!.signature)).toBe(true);
	});

	it('fails an undeliverable restore at poll instead of leasing it', async () => {
		const { restore, store, service } = agentService();
		restore.materializeCommand.mockRejectedValue(new Error('provider secret text'));
		await expect(
			service.poll({ agentId: agent.agentId, deviceId: agent.deviceId, secret })
		).resolves.toEqual({ command: null });
		expect(store.completeCommand).toHaveBeenCalledWith(
			agent.agentId,
			command.id,
			expect.any(String),
			1,
			false,
			'Agent host restore command could not be prepared.',
			expect.any(Date)
		);
		expect(restore.failUndeliverable).toHaveBeenCalled();
	});

	it('routes restore progress and completion to the restore service with strict schemas', async () => {
		const { restore, remoteBackupService, store, service } = agentService();
		await service.recordEvent(agent.agentId, command.id, {
			sequence: 2,
			leaseToken: 'l'.repeat(32),
			event: { phase: 'running', restoreStage: 'restoring', progress: { bytesProcessed: 1 } },
		});
		expect(restore.recordEvent).toHaveBeenCalled();
		expect(remoteBackupService.recordCommandEvent).not.toHaveBeenCalled();
		await expect(
			service.recordEvent(agent.agentId, command.id, {
				sequence: 3,
				leaseToken: 'l'.repeat(32),
				event: { restoreStage: 'downloading-to-server' },
			})
		).rejects.toThrow('Command event is invalid');
		await service.complete(agent.agentId, command.id, {
			sequence: 3,
			leaseToken: 'l'.repeat(32),
			success: false,
			error: 'Agent host restore failed.',
			failureStage: 'space-check',
			failureCode: 'restore-insufficient-space',
		});
		expect(store.completeCommand).toHaveBeenCalledWith(
			agent.agentId,
			command.id,
			'l'.repeat(32),
			3,
			false,
			'Agent host restore failed (space-check/restore-insufficient-space).',
			expect.any(Date)
		);
		expect(restore.complete).toHaveBeenCalled();
		expect(remoteBackupService.completeCommand).not.toHaveBeenCalled();
		await expect(
			service.complete(agent.agentId, command.id, {
				sequence: 4,
				leaseToken: 'l'.repeat(32),
				success: false,
				error: 'x',
				failureStage: 'restic-backup',
				failureCode: 'restic-backup-failed',
			})
		).rejects.toThrow('Command completion is invalid');
	});

	it('dispatches progress, cancel, stats and delete of Agent host rows', async () => {
		const agentHost = {
			progress: jest.fn().mockReturnValue('progress'),
			cancel: jest.fn().mockResolvedValue('cancelled'),
			stats: jest.fn().mockReturnValue({ success: true, result: {} }),
			assertDeletable: jest.fn(),
			options: jest.fn().mockResolvedValue('options'),
			create: jest.fn().mockResolvedValue({ restoreId: 'r' }),
		};
		const row = { id: 'r', inProgress: false, sourceId: 'remote-device-01', config: { agentHost: { version: 1 } } };
		const restoreStore = { getById: jest.fn().mockResolvedValue(row), delete: jest.fn(), update: jest.fn() };
		const restoreService = new RestoreService(
			{} as any,
			{} as any,
			{} as any,
			restoreStore as any,
			{} as any,
			undefined,
			agentHost as any
		);
		await expect(restoreService.getRestoreProgress('r')).resolves.toBe('progress');
		await expect(restoreService.cancelRestore('r')).resolves.toBe('cancelled');
		await expect(restoreService.getRestoreStats('r')).resolves.toEqual({ success: true, result: {} });
		await restoreService.deleteRestore('r');
		expect(agentHost.assertDeletable).toHaveBeenCalledWith(row);
		expect(restoreStore.update).not.toHaveBeenCalled();
		await expect(restoreService.agentHostOptions('b', 'p')).resolves.toBe('options');
		await expect(restoreService.agentHostRestore({})).resolves.toEqual({ restoreId: 'r' });
		const withoutService = new RestoreService({} as any, {} as any, {} as any, restoreStore as any, {} as any);
		await expect(withoutService.getRestoreProgress('r')).rejects.toMatchObject({ statusCode: 501 });
	});
});
