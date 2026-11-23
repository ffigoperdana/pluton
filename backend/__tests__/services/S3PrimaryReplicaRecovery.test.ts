import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Cryptr from 'cryptr';
import { configService } from '../../src/services/ConfigService';
import { VerifiedReplicaRecoveryService } from '../../src/services/VerifiedReplicaRecoveryService';
import { sftpRepositoryIdentity } from '../../src/utils/managedReplicaIdentity';
import { replicaFixture } from '../fixtures/replicaRecovery.fixture';

jest.mock('../../src/utils/logger', () => ({
	initializeLogger: jest.fn(),
	planLogger: () => ({ warn: jest.fn(), info: jest.fn() }),
}));

/** Recovery from a verified SFTP replica of an S3 primary (docs/S3_PRIMARY_REPLICATION.md). */
describe('verified SFTP replica of an S3 primary', () => {
	let root: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 's3-primary-replica-'));
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function reversed() {
		const session = {
			identity: jest.fn(async () => 'e'.repeat(64)),
			snapshot: jest.fn(async () => f.snapshot),
			streamFiles: jest.fn(async () => undefined),
		};
		const provider = { withSession: jest.fn(async (_access: any, consume: any) => consume(session)) };
		const f = replicaFixture(path.join(root, 'cache'), provider as any);
		const secret = configService.config.SECRET!;
		const sftp: any = {
			id: 'mirror-01',
			type: 'sftp',
			settings: {},
			credentials: Object.fromEntries(
				Object.entries({ host: 'sftp.example.internal', user: 'fixture', pass: 'synthetic-replica-password' }).map(
					([key, value]) => [key, new Cryptr(secret).encrypt(value)]
				)
			),
		};
		f.replica.storagePath = 'replicas/plan-01';
		f.replica.storageType = 'sftp';
		const identity = sftpRepositoryIdentity(sftp, f.replica.storagePath);
		Object.assign(f.receipt, { destinationStoragePath: f.replica.storagePath, destinationFingerprint: identity.fingerprint });
		Object.assign(f.destination, {
			fingerprint: identity.fingerprint,
			destinationStoragePath: f.replica.storagePath,
			destinationAuthority: identity.authority,
			destinationPrefix: identity.prefix,
		});
		const records: Record<string, any> = {
			'mirror-01': sftp,
			'primary-01': { id: 'primary-01', type: 's3compatible', settings: { hcp_mode: true } },
		};
		const sessions: string[] = [];
		const sftpOptions = jest.fn(async () => ({ host: 'sftp.example.internal', user: 'fixture', pass: 'synthetic-replica-password' }));
		const create = (options = sftpOptions as any) =>
			new VerifiedReplicaRecoveryService(
				f.stores.jobs as any,
				f.stores.backups as any,
				f.stores.plans as any,
				f.stores.repositories as any,
				f.stores.agents as any,
				{ getById: async (id: string) => records[id] } as any,
				root,
				secret,
				(_trust, kind) => {
					sessions.push(kind);
					return provider as any;
				},
				options
			);
		return { f, provider, session, records, sessions, sftpOptions, create };
	}

	it('reads the SFTP replica with the SFTP session and the server SFTP allowlist', async () => {
		const r = reversed();
		const binding = await r.create().preflight('backup-01', 'plan-01', 'replica-01', new AbortController().signal);
		expect(binding).toMatchObject({ sourceSnapshotId: 'a'.repeat(64), destinationSnapshotId: 'd'.repeat(64) });
		expect(r.sessions).toEqual(['sftp']);
		expect(r.sftpOptions).toHaveBeenCalledWith('mirror-01');
		expect(r.provider.withSession.mock.calls[0][0]).toEqual({
			options: { host: 'sftp.example.internal', user: 'fixture', pass: 'synthetic-replica-password' },
			password: 'synthetic-restic-password',
			repositoryPath: 'replicas/plan-01',
		});
		expect(JSON.stringify(binding)).not.toMatch(/synthetic|sftp\.example/);
	});

	it('refuses an S3 replica of an S3 primary', async () => {
		const r = reversed();
		r.records['mirror-01'] = r.f.storage;
		await expect(
			r.create().preflight('backup-01', 'plan-01', 'replica-01', new AbortController().signal)
		).rejects.toMatchObject({ code: 'destination-changed' });
		expect(r.provider.withSession).not.toHaveBeenCalled();
	});

	it('refuses an SFTP replica whose account changed after verification', async () => {
		const r = reversed();
		r.records['mirror-01'] = {
			...r.records['mirror-01'],
			credentials: {
				...r.records['mirror-01'].credentials,
				user: new Cryptr(configService.config.SECRET!).encrypt('other-account'),
			},
		};
		await expect(
			r.create().preflight('backup-01', 'plan-01', 'replica-01', new AbortController().signal)
		).rejects.toMatchObject({ code: 'destination-changed' });
		expect(r.provider.withSession).not.toHaveBeenCalled();
	});

	it('fails closed without the SFTP option provider or when it refuses the storage', async () => {
		const missing = reversed();
		await expect(
			missing.create(null).preflight('backup-01', 'plan-01', 'replica-01', new AbortController().signal)
		).rejects.toMatchObject({ code: 'destination-changed' });
		const refused = reversed();
		refused.sftpOptions.mockRejectedValueOnce(new Error('unsupported SFTP option'));
		await expect(
			refused.create().preflight('backup-01', 'plan-01', 'replica-01', new AbortController().signal)
		).rejects.toMatchObject({ code: 'destination-changed' });
		expect(refused.provider.withSession).not.toHaveBeenCalled();
	});
});
