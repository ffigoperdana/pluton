import {
	ManagedRepositorySessionRouter,
	defaultManagedRepositorySessionFactory,
	managedRepositoryAccessType,
} from '../../../src/utils/restic/ManagedRepositorySessionRouter';
import { ManagedS3RecoverySession } from '../../../src/utils/restic/ManagedS3RecoverySession';
import { ManagedSftpRepositorySession } from '../../../src/utils/restic/ManagedSftpRepositorySession';

const sftpAccess = {
	options: { host: '192.0.2.10', user: 'fixture-user', pass: 'synthetic-sftp-password' },
	repositoryPath: 'managed/app-01',
	password: 'synthetic-repository-password',
};
const s3Access = {
	options: {
		type: 's3',
		provider: 'Other',
		endpoint: 'https://s3.example.internal',
		access_key_id: 'SYNTHETICKEY01',
		secret_access_key: 'synthetic-secret-key-01',
		force_path_style: 'true',
	},
	repositoryPath: 'bucket-01/agents/app-01',
	password: 'synthetic-repository-password',
};

describe('ManagedRepositorySessionRouter (S3_AGENT_REPOSITORY_DESIGN.md 6.1.3)', () => {
	const originalCa = process.env.PLUTON_STORAGE_CA_FILE;
	afterEach(() => {
		if (originalCa === undefined) delete process.env.PLUTON_STORAGE_CA_FILE;
		else process.env.PLUTON_STORAGE_CA_FILE = originalCa;
	});

	it('keys the access type on options.type', () => {
		expect(managedRepositoryAccessType(s3Access)).toBe('s3');
		expect(managedRepositoryAccessType(sftpAccess)).toBe('sftp');
	});

	it('routes every call to a provider created for its access type', async () => {
		const calls: string[] = [];
		const provider = (type: 'sftp' | 's3') => ({
			withSession: jest.fn(async (access: any, consume: any, _signal?: AbortSignal, limits?: any) => {
				calls.push(`${type}:${access.repositoryPath}:${limits?.restoreTimeoutMs ?? '-'}`);
				return consume({ kind: type } as any);
			}),
		});
		const factory = jest.fn(provider);
		const router = new ManagedRepositorySessionRouter(factory);
		await expect(router.withSession(s3Access, async session => (session as any).kind)).resolves.toBe(
			's3'
		);
		await expect(
			router.withSession(sftpAccess, async session => (session as any).kind, undefined, {
				restoreTimeoutMs: 5,
			})
		).resolves.toBe('sftp');
		expect(factory.mock.calls.map(call => call[0])).toEqual(['s3', 'sftp']);
		expect(calls).toEqual(['s3:bucket-01/agents/app-01:-', 'sftp:managed/app-01:5']);
	});

	it('builds an S3 session with operator trust and a plain SFTP session by default', () => {
		delete process.env.PLUTON_STORAGE_CA_FILE;
		expect(defaultManagedRepositorySessionFactory('s3')).toBeInstanceOf(ManagedS3RecoverySession);
		const sftp = defaultManagedRepositorySessionFactory('sftp');
		expect(sftp).toBeInstanceOf(ManagedSftpRepositorySession);
		expect(sftp).not.toBeInstanceOf(ManagedS3RecoverySession);
	});

	it('rejects, rather than throws, when the operator CA setting is invalid', async () => {
		process.env.PLUTON_STORAGE_CA_FILE = 'relative/ca.pem';
		const result = new ManagedRepositorySessionRouter().withSession(s3Access, async () => 'unreachable');
		await expect(result).rejects.toMatchObject({
			statusCode: 500,
			message: 'Operator storage CA configuration is invalid or inaccessible.',
		});
	});
});
