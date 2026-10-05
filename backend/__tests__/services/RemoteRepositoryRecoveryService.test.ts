import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Cryptr from 'cryptr';
import { RemoteRepositoryRecoveryService } from '../../src/services/RemoteRepositoryRecoveryService';
import { ManagedRepositoryAccessError } from '../../src/utils/restic/ManagedSftpRepositorySession';
import type {
	ManagedRepositorySession,
	ManagedSftpAccess,
} from '../../src/utils/restic/ManagedSftpRepositorySession';
import type { RestoreConfig } from '../../src/types/restores';

jest.mock('../../src/utils/logger', () => ({
	initializeLogger: jest.fn(),
	planLogger: jest.fn(() => ({ warn: jest.fn() })),
}));

const secret = 'synthetic-recovery-encryption-key';
const password = 'synthetic-repository-password';
const snapshotId = 'a'.repeat(64);
const config: RestoreConfig = {
	target: '',
	overwrite: 'never',
	includes: [],
	excludes: [],
	delete: false,
};
const nodes = [
	{ path: '/srv', type: 'dir', size: 0 },
	{ path: '/srv/example-app', type: 'dir', size: 0 },
	{ path: '/srv/example-app/index.txt', type: 'file', size: 7 },
	{ path: '/srv/example-app/nested', type: 'dir', size: 0 },
	{ path: '/srv/example-app/nested/data.txt', type: 'file', size: 5 },
].map(file => ({
	...file,
	struct_type: 'node',
	name: path.posix.basename(file.path),
	mtime: '2026-01-01T00:00:00Z',
	mode: 0o644,
}));

describe('Phase 4 remote managed repository recovery', () => {
	let scratch: string;
	let staging: string;
	let service: RemoteRepositoryRecoveryService;
	let backup: any;
	let plan: any;
	let repository: any;
	let stores: any;
	let session: jest.Mocked<ManagedRepositorySession>;
	let options: jest.Mock;
	let withSession: jest.Mock;
	let rows: Map<string, any>;

	beforeEach(async () => {
		scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-recovery-test-'));
		staging = path.join(scratch, 'managed-remote-restores');
		backup = {
			id: 'backup-01',
			planId: 'plan-01',
			storageId: 'storage-01',
			storagePath: 'application',
			sourceId: 'app-01',
			sourceType: 'device',
			method: 'backup',
			status: 'completed',
			success: true,
			inProgress: false,
			completionStats: { snapshot_id: snapshotId },
		};
		plan = {
			id: 'plan-01',
			sourceId: 'app-01',
			sourceType: 'device',
			method: 'backup',
			storageId: 'storage-01',
			storagePath: 'application',
		};
		repository = {
			id: 'remote-repo-01',
			planId: 'plan-01',
			agentId: 'agent-01',
			storageId: 'storage-01',
			storagePath: 'application',
			initializedAt: new Date(),
			encryptedPassword: new Cryptr(secret).encrypt(password),
		};
		rows = new Map();
		stores = {
			agents: {
				getAgentById: jest.fn(async id =>
					id === 'agent-01'
						? { agentId: 'agent-01', deviceId: 'app-01', lastSeen: new Date('2020-01-01') }
						: null
				),
			},
			backups: { getById: jest.fn(async () => backup) },
			plans: { getById: jest.fn(async () => plan) },
			repositories: { getByPlanId: jest.fn(async () => repository) },
			restores: {
				isRestoreRunning: jest.fn(async () => false),
				create: jest.fn(async row => {
					rows.set(row.id, row);
					return row;
				}),
				update: jest.fn(async (id, changes) => {
					const row = { ...rows.get(id), ...changes };
					rows.set(id, row);
					return row;
				}),
			},
		};
		options = jest.fn(async () => ({
			host: '192.0.2.10',
			user: 'fixture-user',
			pass: 'synthetic-sftp-password',
			port: '22',
		}));
		session = {
			snapshot: jest.fn(async () => ({
				id: snapshotId,
				tags: ['pluton-plan-plan-01', 'pluton-backup-backup-01'],
				paths: ['/srv/example-app'],
			})),
			files: jest.fn(async () => nodes as any),
			restore: jest.fn(async (_, includes, target) => {
				const files = nodes.filter(
					file => file.type === 'file' && (!includes.length || includes.includes(file.path))
				);
				for (const file of files) {
					const restored = path.join(target, file.path.slice(1));
					await fs.mkdir(path.dirname(restored), { recursive: true, mode: 0o700 });
					await fs.writeFile(restored, Buffer.alloc(file.size), { mode: 0o600 });
				}
				return {
					files_restored: files.length + 5,
					bytes_restored: files.reduce((sum, file) => sum + file.size, 0),
				};
			}),
		};
		withSession = jest.fn(
			async (
				_: ManagedSftpAccess,
				callback: (session: ManagedRepositorySession) => Promise<unknown>,
				signal?: AbortSignal
			) => {
				if (signal?.aborted) throw new ManagedRepositoryAccessError('cancelled');
				return callback(session);
			}
		);
		service = new RemoteRepositoryRecoveryService(
			stores.repositories,
			stores.backups,
			stores.plans,
			stores.restores,
			{ getSftpRecoveryOptions: options },
			stores.agents,
			{ withSession },
			secret,
			staging
		);
	});
	async function finish(id: string) {
		await (service as any).jobs.get(id)?.done;
	}
	afterEach(async () => {
		for (const job of (service as any).jobs.values()) {
			job.controller.abort();
			await job.done;
		}
		await fs.rm(scratch, { recursive: true, force: true });
	});

	it('browses a historical completed backup by its persisted FULL ID, never latest or tag search', async () => {
		const files = await service.browse('backup-01');
		expect(session.snapshot).toHaveBeenCalledWith(snapshotId);
		expect(session.files).toHaveBeenCalledWith(snapshotId);
		expect(files).toHaveLength(5);
		expect(files.find(file => file.path === '/srv')).toMatchObject({ isDirectory: true });
		expect(files.find(file => file.path === '/srv/example-app/nested')).toMatchObject({
			type: 'dir',
		});
		expect(files.find(file => file.path.endsWith('data.txt'))).toMatchObject({
			name: 'data.txt',
			size: 5,
			modifiedAt: '2026-01-01T00:00:00Z',
			srcPath: '/srv/example-app/nested/data.txt',
		});
		expect(withSession.mock.calls[0][0]).toMatchObject({ password, repositoryPath: 'application' });
		expect(JSON.stringify(files)).not.toMatch(/synthetic-.*password|encryptedPassword|rclone.conf/);
	});

	it.each([undefined, 'aaaaaaaa', 'latest', '../snapshot', 'b'.repeat(63), 'z'.repeat(64)])(
		'refuses absent/short/malformed snapshot ID %s before repository access',
		async id => {
			backup.completionStats.snapshot_id = id;
			await expect(service.browse('backup-01')).rejects.toMatchObject({ statusCode: 409 });
			expect(withSession).not.toHaveBeenCalled();
		}
	);
	it('refuses a missing snapshot without trying a different snapshot', async () => {
		session.snapshot.mockRejectedValue(new ManagedRepositoryAccessError('repository-unavailable'));
		await expect(service.browse('backup-01')).rejects.toMatchObject({
			code: 'repository-unavailable',
		});
		expect(session.files).not.toHaveBeenCalled();
	});
	it.each([
		{ id: 'b'.repeat(64), tags: ['pluton-plan-plan-01', 'pluton-backup-backup-01'] },
		{ id: snapshotId, tags: ['pluton-plan-plan-02', 'pluton-backup-backup-01'] },
		{ id: snapshotId, tags: ['pluton-plan-plan-01', 'pluton-backup-backup-02'] },
	])('refuses a snapshot with a cross-backup/plan identity', async snapshot => {
		session.snapshot.mockResolvedValue({ ...snapshot, paths: ['/srv/example-app'] });
		await expect(service.browse('backup-01')).rejects.toMatchObject({ statusCode: 409 });
		expect(session.files).not.toHaveBeenCalled();
	});
	it.each(['agentId', 'planId', 'storageId', 'storagePath'])(
		'refuses mismatched repository binding %s',
		async field => {
			repository[field] = 'another-binding';
			await expect(service.browse('backup-01')).rejects.toMatchObject({ statusCode: 409 });
			expect(withSession).not.toHaveBeenCalled();
		}
	);
	it('refuses unknown repository and cross-plan restore requests', async () => {
		await expect(service.preview('backup-01', config, 'plan-02')).rejects.toMatchObject({
			statusCode: 400,
		});
		repository = null;
		await expect(service.browse('backup-01')).rejects.toMatchObject({ statusCode: 409 });
	});
	it('does not pass credential decryption exception values to the client', async () => {
		options.mockRejectedValue(new Error('synthetic-sftp-password raw config'));
		await expect(service.browse('backup-01')).rejects.toMatchObject({
			message: 'Managed repository access failed (credentials-unavailable).',
		});
		repository.encryptedPassword = 'corrupted-encryption';
		await expect(service.browse('backup-01')).rejects.toMatchObject({
			code: 'credentials-unavailable',
		});
	});
	it.each(['wrong-password', 'execution-failed'] as const)(
		'sanitizes repository/auth failure %s',
		async code => {
			session.files.mockRejectedValue(new ManagedRepositoryAccessError(code));
			await expect(service.browse('backup-01')).rejects.toMatchObject({
				message: `Managed repository access failed (${code}).`,
			});
		}
	);
	it('rejects snapshot traversal and duplicate logical paths', async () => {
		session.files.mockResolvedValue([{ ...nodes[0], path: '/srv/../outside' }] as any);
		await expect(service.browse('backup-01')).rejects.toMatchObject({ statusCode: 400 });
		session.files.mockResolvedValue([nodes[0], nodes[0]] as any);
		await expect(service.browse('backup-01')).rejects.toMatchObject({ statusCode: 409 });
	});

	it('previews selected paths without creating a job or writing staging', async () => {
		const result = await service.preview(
			'backup-01',
			{ ...config, includes: ['/srv/example-app'], excludes: ['/srv/example-app/index.txt'] },
			'plan-01'
		);
		expect(result.stats).toMatchObject({ files_restored: 1, bytes_restored: 5 });
		expect(result.files.some(file => file.path.endsWith('index.txt'))).toBe(false);
		expect(stores.restores.create).not.toHaveBeenCalled();
		expect(session.restore).not.toHaveBeenCalled();
		await expect(fs.stat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('restores the exact full snapshot only to internal staging and persists normal restore stats', async () => {
		const id = await service.restore('backup-01', config, 'plan-01');
		await finish(id);
		const row = rows.get(id);
		expect(row).toMatchObject({
			sourceId: 'main',
			status: 'completed',
			inProgress: false,
			config: { stagingOnly: true, overwrite: 'never', snapshotId },
		});
		expect(row.config.target).toBe(path.join(staging, `restore-${id}`, 'files'));
		expect(session.restore).toHaveBeenCalledWith(snapshotId, [], row.config.target);
		expect(row.taskStats).toMatchObject({ files_restored: 2, bytes_restored: 12 });
		expect(await service.stats(row)).toMatchObject({
			success: true,
			result: { restoreId: id, stats: { files_restored: 2 }, restoredPaths: expect.any(Array) },
		});
		expect(service.progress(row)).toMatchObject({
			success: true,
			status: 'completed',
			events: [expect.objectContaining({ phase: 'finished', completed: true })],
		});
		if (process.platform !== 'win32')
			expect((await fs.stat(path.dirname(row.config.target))).mode & 0o777).toBe(0o700);
		expect(JSON.stringify(row)).not.toContain(password);
	});
	it('supports granular selection and a custom RELATIVE staging subfolder', async () => {
		const id = await service.restore(
			'backup-01',
			{ ...config, target: 'recovery/check', includes: ['/srv/example-app/nested'] },
			'plan-01'
		);
		await finish(id);
		expect(session.restore).toHaveBeenCalledWith(
			snapshotId,
			['/srv/example-app/nested/data.txt'],
			path.join(staging, `restore-${id}`, 'files', 'recovery', 'check')
		);
		expect(rows.get(id).taskStats).toMatchObject({ files_restored: 1, bytes_restored: 5 });
	});
	it.each(['missing', 'wrong-size'])(
		'does not mark an incomplete staged file as completed: %s',
		async failure => {
			session.restore.mockImplementation(async (_, __, target) => {
				if (failure === 'wrong-size') {
					const directory = path.join(target, 'srv', 'example-app');
					await fs.mkdir(directory, { recursive: true });
					await fs.writeFile(path.join(directory, 'index.txt'), Buffer.alloc(8));
				}
				return { files_restored: 7, bytes_restored: 12 };
			});
			const id = await service.restore('backup-01', config);
			await finish(id);
			expect(rows.get(id)).toMatchObject({ status: 'failed', inProgress: false });
			expect(rows.get(id).errorMsg).not.toMatch(/ENOENT|index\.txt|synthetic-.*password/);
			await expect(fs.stat(path.join(staging, `restore-${id}`))).rejects.toMatchObject({
				code: 'ENOENT',
			});
		}
	);
	it.each([
		'../escape',
		'/srv/example-app',
		'C:/outside',
		'a/../../escape',
		'a\\escape',
		'%2e%2e/escape',
		'a//b',
		'file:stream',
	])('refuses target traversal/host destination %s before accessing repository', async target => {
		await expect(service.restore('backup-01', { ...config, target })).rejects.toMatchObject({
			statusCode: 400,
		});
		expect(withSession).not.toHaveBeenCalled();
		expect(session.restore).not.toHaveBeenCalled();
	});
	it.each(['/srv/../outside', '//srv/example-app', '/srv/example-app/*', '/srv/%2e%2e/outside'])(
		'refuses unsafe snapshot selections %s',
		async file => {
			await expect(
				service.preview('backup-01', { ...config, includes: [file] })
			).rejects.toMatchObject({ statusCode: 400 });
		}
	);
	it.each([
		{ overwrite: 'always' },
		{ delete: true },
		{ fromStorage: true },
		{ replicationId: 'mirror-01' },
		{ storageId: 'other-storage' },
	])('refuses destructive/alternate recovery option %p', async invalid => {
		await expect(
			service.restore('backup-01', { ...config, ...invalid } as RestoreConfig)
		).rejects.toMatchObject({ statusCode: 400 });
		expect(session.restore).not.toHaveBeenCalled();
	});
	it('rejects individually selected links and special nodes before restore', async () => {
		session.files.mockResolvedValue([{ ...nodes[2], type: 'symlink' }] as any);
		await expect(
			service.restore('backup-01', { ...config, includes: ['/srv/example-app/index.txt'] })
		).rejects.toMatchObject({ statusCode: 400 });
		expect(session.restore).not.toHaveBeenCalled();
	});
	it('cleans partial staging and persists only a closed error category on failure', async () => {
		session.restore.mockImplementation(async (_, __, target) => {
			await fs.writeFile(path.join(target, 'partial.txt'), 'synthetic partial data');
			throw new Error(`${password} synthetic-sftp-password raw stderr`);
		});
		const id = await service.restore('backup-01', config);
		await finish(id);
		expect(rows.get(id)).toMatchObject({
			status: 'failed',
			inProgress: false,
			errorMsg: 'Internal staged restore failed (staged-restore-failed).',
		});
		await expect(fs.stat(path.join(staging, `restore-${id}`))).rejects.toMatchObject({
			code: 'ENOENT',
		});
		expect(JSON.stringify(rows.get(id))).not.toContain(password);
		expect(service.progress(rows.get(id))).toMatchObject({
			success: false,
			status: 'failed',
			events: [
				expect.objectContaining({
					action: 'TASK_FAILED',
					completed: true,
					resticData: expect.objectContaining({ message_type: 'status', percent_done: 0 }),
				}),
			],
		});
	});
	it('cancels an executing restore before cleaning credentials/workspace', async () => {
		let executing: () => void;
		const started = new Promise<void>(resolve => {
			executing = resolve;
		});
		withSession.mockImplementation(async (_access, callback, signal) => {
			if (signal) {
				session.restore.mockImplementation(async () => {
					executing();
					return new Promise((_, reject) =>
						signal.addEventListener('abort', () =>
							reject(new ManagedRepositoryAccessError('cancelled'))
						)
					);
				});
			}
			return callback(session);
		});
		const id = await service.restore('backup-01', config);
		await started;
		await service.cancel(rows.get(id));
		expect(rows.get(id)).toMatchObject({ status: 'cancelled', inProgress: false });
		await expect(fs.stat(path.join(staging, `restore-${id}`))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});
	it('refuses a symlinked staging root without writing its destination', async () => {
		const outside = path.join(scratch, 'outside');
		await fs.mkdir(outside);
		await fs.symlink(outside, staging, process.platform === 'win32' ? 'junction' : 'dir');
		await expect(service.restore('backup-01', config)).rejects.toMatchObject({ statusCode: 400 });
		expect(await fs.readdir(outside)).toEqual([]);
		expect(session.restore).not.toHaveBeenCalled();
	});
	it('prevents duplicate restore preparation and respects existing running records', async () => {
		stores.restores.isRestoreRunning.mockResolvedValue(true);
		await expect(service.restore('backup-01', config)).rejects.toMatchObject({ statusCode: 409 });
		expect(session.restore).not.toHaveBeenCalled();
	});
	it('rejects a concurrent request while repository preflight is still running', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const snapshot = session.snapshot.getMockImplementation()!;
		session.snapshot.mockImplementationOnce(async id => {
			await gate;
			return snapshot(id);
		});
		const pending = service.restore('backup-01', config);
		try {
			await expect(service.restore('backup-01', config)).rejects.toMatchObject({ statusCode: 409 });
		} finally {
			release();
		}
		const id = await pending;
		await finish(id);
		expect(stores.restores.create).toHaveBeenCalledTimes(1);
		expect(rows.get(id).status).toBe('completed');
	});
	it('rejects an unsafe result artifact without following it outside staging', async () => {
		const id = await service.restore('backup-01', config);
		await finish(id);
		const artifact = path.join(staging, `restore-${id}`, 'stats.json');
		await fs.unlink(artifact);
		const outside = path.join(scratch, 'outside');
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, 'proof.txt'), 'unchanged fixture');
		await fs.symlink(outside, artifact, process.platform === 'win32' ? 'junction' : 'dir');
		await expect(service.stats(rows.get(id))).rejects.toMatchObject({
			statusCode: 404,
			message: 'Staged restore results are unavailable.',
		});
		expect(await fs.readFile(path.join(outside, 'proof.txt'), 'utf8')).toBe('unchanged fixture');
	});
});
