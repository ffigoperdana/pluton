import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import tar from 'tar-stream';
import { pipeline } from 'stream/promises';
import { replicaFixture } from '../fixtures/replicaRecovery.fixture';
import { ManagedRepositoryAccessError } from '../../src/utils/restic/ManagedSftpRepositorySession';

jest.mock('../../src/utils/logger', () => ({
	initializeLogger: jest.fn(),
	planLogger: () => ({ warn: jest.fn(), info: jest.fn() }),
}));
const content = 'synthetic file\n',
	sql = 'SELECT 1;\n';
const nodes = [
	['/srv', 'dir'],
	['/srv/example-app', 'dir'],
	['/srv/example-app/file.txt', 'file'],
	['/pluton', 'dir'],
	['/pluton/database', 'dir'],
	['/pluton/database/example.sql', 'file'],
].map(([p, type]) => ({
	struct_type: 'node',
	path: p,
	name: path.posix.basename(p),
	type,
	size: type === 'file' ? Buffer.byteLength(p.endsWith('.sql') ? sql : content) : 0,
	mtime: '2026-01-01T00:00:00Z',
	mode: 0o644,
}));
const config = {
	target: '',
	overwrite: 'never' as const,
	delete: false,
	includes: [],
	excludes: [],
};
describe('verified replica recovery eligibility and isolated integrity', () => {
	let root: string, f: ReturnType<typeof replicaFixture>, session: any, provider: any;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'replica-recovery-'));
		session = {
			identity: jest.fn(async () => f.destination.actualRepositoryId),
			snapshot: jest.fn(async () => f.snapshot),
			streamFiles: jest.fn(async (_id, consume) => {
				for (const node of nodes) await consume(node);
			}),
			archive: jest.fn(async (_id, destination) => {
				const pack = tar.pack();
				const stream = pipeline(pack, destination, { end: false });
				for (const node of nodes)
					pack.entry(
						{
							name: node.path.slice(1) + (node.type === 'dir' ? '/' : ''),
							type: node.type === 'dir' ? 'directory' : 'file',
							size: node.size,
							mtime: new Date(node.mtime),
							mode: node.mode,
						},
						node.type === 'file' ? (node.path.endsWith('.sql') ? sql : content) : undefined
					);
				pack.finalize();
				await stream;
			}),
			restore: jest.fn(async (_id, includes, target) => {
				for (const node of nodes) {
					if (
						includes.length &&
						!includes.some((p: string) => node.path === p || node.path.startsWith(p + '/'))
					)
						continue;
					const dest = path.join(target, node.path.slice(1));
					if (node.type === 'dir') await fs.mkdir(dest, { recursive: true });
					else {
						await fs.mkdir(path.dirname(dest), { recursive: true });
						await fs.writeFile(dest, node.path.endsWith('.sql') ? sql : content);
					}
				}
				return { files_restored: 2, bytes_restored: Buffer.byteLength(content + sql) };
			}),
		};
		provider = { withSession: jest.fn(async (_access, consume) => consume(session)) };
		f = replicaFixture(path.join(root, 'cache'), provider);
		f.backup.completionStats.lifecycle = {
			database: {
				path: '/pluton/database/example.sql',
				bytes: Buffer.byteLength(sql),
				sha256: crypto.createHash('sha256').update(sql).digest('hex'),
			},
		};
		f.refreshBinding();
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});
	it('validates destination config, copied original ID, tree, owners and SQL metadata without primary access or writes', async () => {
		const proof = await f.service.preflight(
			'backup-01',
			'plan-01',
			'replica-01',
			new AbortController().signal
		);
		expect(proof).toMatchObject({
			sourceSnapshotId: 'a'.repeat(64),
			destinationSnapshotId: 'd'.repeat(64),
		});
		expect(session.restore).not.toHaveBeenCalled();
		expect(session.archive).not.toHaveBeenCalled();
		expect(JSON.stringify(proof)).not.toMatch(/synthetic|https|bucket/);
	});

	it.each(['missing', 'failed', 'active', 'unencrypted', 'wrong-source', 'wrong-method'])(
		'refuses unsafe backup or receipt %s before access',
		async kind => {
			if (kind === 'missing') f.rows.splice(0);
			if (kind === 'failed') f.backup.success = false;
			if (kind === 'active') f.backup.inProgress = true;
			if (kind === 'unencrypted') f.backup.encryption = false;
			if (kind === 'wrong-source') f.backup.sourceId = 'main';
			if (kind === 'wrong-method') f.backup.method = 'sync';
			await expect(
				f.service.preflight('backup-01', 'plan-01', 'replica-01', new AbortController().signal)
			).rejects.toBeDefined();
			expect(provider.withSession).not.toHaveBeenCalled();
		}
	);
	it.each([
		'plan',
		'agent',
		'revoked',
		'source-storage',
		'source-path',
		'receipt-status',
		'receipt-hash',
		'receipt-snapshot',
		'receipt-repository',
		'receipt-agent',
		'receipt-config',
		'receipt-error',
		'receipt-time',
		'receipt-duplicate',
		'destination-state',
		'destination-plan',
		'destination-storage',
		'destination-prefix',
		'destination-fingerprint',
		'destination-id',
		'disabled',
		'deleted-config',
		'changed-endpoint',
	])('refuses %s before repository access', async kind => {
		if (kind === 'plan') f.backup.planId = 'other';
		if (kind === 'agent') f.agent.deviceId = 'other';
		if (kind === 'revoked') f.agent.revokedAt = new Date();
		if (kind === 'source-storage') f.backup.storageId = 'other';
		if (kind === 'source-path') f.repository.storagePath = 'other';
		if (kind === 'receipt-status') f.receipt.status = 'failed';
		if (kind === 'receipt-hash') f.receipt.sourceBindingHash = '0'.repeat(64);
		if (kind === 'receipt-snapshot') f.receipt.sourceSnapshotId = 'f'.repeat(64);
		if (kind === 'receipt-repository') f.receipt.repositoryId = 'other';
		if (kind === 'receipt-agent') f.receipt.agentId = 'other';
		if (kind === 'receipt-config') f.receipt.sourceRepositoryConfigId = 'short';
		if (kind === 'receipt-error') f.receipt.lastErrorCode = 'failure';
		if (kind === 'receipt-time') f.receipt.verifiedAt = null;
		if (kind === 'receipt-duplicate') f.rows.push({ ...f.receipt });
		if (kind === 'destination-state') f.destination.initState = 'uncertain';
		if (kind === 'destination-plan') f.destination.planId = 'other';
		if (kind === 'destination-storage') f.destination.destinationStorageId = 'other';
		if (kind === 'destination-prefix') f.destination.destinationPrefix = 'other';
		if (kind === 'destination-fingerprint') f.receipt.destinationFingerprint = 'f'.repeat(64);
		if (kind === 'destination-id') f.destination.actualRepositoryId = null;
		if (kind === 'disabled') f.plan.settings.replication.enabled = false;
		if (kind === 'deleted-config') f.plan.settings.replication.storages = [];
		if (kind === 'changed-endpoint') f.storage.settings.endpoint = 'https://other.example.internal';
		await expect(
			f.service.preflight('backup-01', 'plan-01', 'replica-01', new AbortController().signal)
		).rejects.toBeDefined();
		expect(provider.withSession).not.toHaveBeenCalled();
	});
	it.each([
		'config',
		'tree',
		'id',
		'original',
		'plan-tag',
		'backup-tag',
		'duplicate-owner',
		'missing-owner',
	])('rejects live %s mismatch', async kind => {
		if (kind === 'config') session.identity.mockResolvedValue('f'.repeat(64));
		if (kind === 'tree') f.snapshot.tree = 'f'.repeat(64);
		if (kind === 'id') f.snapshot.id = 'f'.repeat(64);
		if (kind === 'original') delete f.snapshot.original;
		if (kind === 'plan-tag') f.snapshot.tags[0] = 'pluton-plan-other';
		if (kind === 'backup-tag') f.snapshot.tags[1] = 'pluton-backup-other';
		if (kind === 'duplicate-owner') f.snapshot.tags.push('pluton-plan-other');
		if (kind === 'missing-owner') f.snapshot.tags = [];
		await expect(
			f.service.preflight('backup-01', 'plan-01', 'replica-01', new AbortController().signal)
		).rejects.toMatchObject({
			code: kind === 'config' ? 'repository-identity-mismatch' : 'snapshot-identity-mismatch',
		});
		expect(session.restore).not.toHaveBeenCalled();
	});
	it.each(['wrong-password', 'timeout', 'cancelled', 'repository-unavailable'])(
		'preserves closed adapter failure %s',
		async code => {
			session.identity.mockRejectedValue(new ManagedRepositoryAccessError(code as any));
			await expect(
				f.service.preflight('backup-01', 'plan-01', 'replica-01', new AbortController().signal)
			).rejects.toMatchObject(
				code === 'timeout' ? { code: 'index-unavailable', reason: 'timeout' } : { code }
			);
		}
	);
	it.each(
		[[], ['/srv/example-app'], ['/srv/example-app/file.txt'], ['/pluton/database/example.sql']].map(
			includes => ({ includes })
		)
	)('recovers only selected files with mandatory SHA readback %j', async ({ includes }) => {
		const target = path.join(root, 'target');
		await fs.mkdir(target);
		await f.service.withReplica(
			'backup-01',
			'plan-01',
			'replica-01',
			new AbortController().signal,
			async recovery =>
				recovery.replicaStage(
					await recovery.testBinding('backup-01', 'plan-01'),
					{ ...config, includes },
					target,
					new AbortController().signal,
					() => {},
					async () => {}
				)
		);
		expect(session.archive).toHaveBeenCalledTimes(1);
		expect(session.restore).toHaveBeenCalledTimes(1);
		if (includes[0]?.endsWith('.sql'))
			await expect(fs.stat(path.join(target, 'srv'))).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('detects same-length staged corruption and never reports successful recovery', async () => {
		const target = path.join(root, 'target');
		await fs.mkdir(target);
		const restore = session.restore.getMockImplementation();
		session.restore.mockImplementation(async (...args: any[]) => {
			const result = await restore(...args);
			await fs.writeFile(path.join(target, 'srv/example-app/file.txt'), 'X'.repeat(content.length));
			return result;
		});
		await expect(
			f.service.withReplica(
				'backup-01',
				'plan-01',
				'replica-01',
				new AbortController().signal,
				async recovery =>
					recovery.replicaStage(
						await recovery.testBinding('backup-01', 'plan-01'),
						config,
						target,
						new AbortController().signal,
						() => {},
						async () => {}
					)
			)
		).rejects.toMatchObject({ code: 'restored-file-hash-mismatch' });
	});

	it('propagates job cancellation through the index-builder signal and removes job-owned credentials/cache', async () => {
		let activeSignal: AbortSignal, entered!: () => void;
		const started = new Promise<void>(resolve => (entered = resolve));
		provider.withSession.mockImplementation(
			async (_access: any, consume: any, signal: AbortSignal) => {
				activeSignal = signal;
				return consume(session);
			}
		);
		session.identity.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					activeSignal.addEventListener(
						'abort',
						() => reject(new ManagedRepositoryAccessError('cancelled')),
						{ once: true }
					);
					entered();
				})
		);
		const controller = new AbortController();
		const work = f.service.preflight('backup-01', 'plan-01', 'replica-01', controller.signal);
		const failed = expect(work).rejects.toMatchObject({ code: 'cancelled' });
		await started;
		controller.abort();
		await failed;
		expect(await fs.readdir(path.join(root, 'cache'))).toEqual([]);
	});
	it('does not invalidate replica approval for scheduled backup progress or mirror projection changes', async () => {
		const proof = await f.service.preflight(
			'backup-01',
			'plan-01',
			'replica-01',
			new AbortController().signal
		);
		f.plan.inProgress = true;
		f.plan.stats = { latestBackup: 'backup-02' };
		f.backup.mirrors = [{ status: 'completed' }];
		await expect(
			f.service.withReplica(
				'backup-01',
				'plan-01',
				'replica-01',
				new AbortController().signal,
				async () => true,
				proof.fingerprint
			)
		).resolves.toBe(true);
	});
	it('invalidates approval when credentials or receipt change and rechecks after repository reads', async () => {
		const proof = await f.service.preflight(
			'backup-01',
			'plan-01',
			'replica-01',
			new AbortController().signal
		);
		f.receipt.updatedAt++;
		await expect(
			f.service.withReplica(
				'backup-01',
				'plan-01',
				'replica-01',
				new AbortController().signal,
				async () => {},
				proof.fingerprint
			)
		).rejects.toMatchObject({ code: 'approval-binding-changed' });
		session.streamFiles.mockImplementation(async (_id, consume) => {
			for (const node of nodes) await consume(node);
			f.agent.revokedAt = new Date();
		});
		await expect(
			f.service.preflight('backup-01', 'plan-01', 'replica-01', new AbortController().signal)
		).rejects.toMatchObject({ code: 'source-binding-invalid' });
	});
});
