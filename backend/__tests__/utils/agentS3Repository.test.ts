import { AppError } from '../../src/utils/AppError';
import {
	AgentS3OptionError,
	agentBackupPayloadVersion,
	agentRepositoryBackends,
	agentS3RepositoryOptions,
	agentS3ScopesOverlap,
	agentSupportsS3Repository,
	isAgentS3StorageType,
} from '../../src/utils/agentS3Repository';

jest.mock('../../src/services/ConfigService', () => ({
	configService: { config: { SECRET: 'synthetic-storage-secret' } },
}));

describe('Agent repository capabilities (S3_AGENT_REPOSITORY_DESIGN.md 10.1)', () => {
	it('treats an Agent that omits the fields as SFTP-only with payload version 4', () => {
		expect(agentRepositoryBackends({ filesystemRootsConfigured: true })).toEqual(['sftp']);
		expect(agentRepositoryBackends(undefined)).toEqual(['sftp']);
		expect(agentRepositoryBackends(null)).toEqual(['sftp']);
		expect(agentBackupPayloadVersion({})).toBe(4);
		expect(agentSupportsS3Repository({ filesystemRootsConfigured: true })).toBe(false);
	});

	it('requires both s3 in repositoryBackends and payload version 5 for S3', () => {
		expect(
			agentSupportsS3Repository({ repositoryBackends: ['sftp', 's3'], backupPayloadVersion: 5 })
		).toBe(true);
		expect(agentSupportsS3Repository({ repositoryBackends: ['sftp', 's3'] })).toBe(false);
		expect(agentSupportsS3Repository({ repositoryBackends: ['sftp'], backupPayloadVersion: 5 })).toBe(
			false
		);
		expect(agentBackupPayloadVersion({ repositoryBackends: ['sftp'], backupPayloadVersion: 5 })).toBe(5);
		expect(agentRepositoryBackends({ repositoryBackends: ['sftp', 's3'] })).toEqual(['sftp', 's3']);
	});

	it('accepts exactly the s3 and s3compatible storage types', () => {
		expect(
			['s3', 's3compatible', 'sftp', 'minio', 'local', undefined, null].map(isAgentS3StorageType)
		).toEqual([true, true, false, false, false, false, false]);
	});
});

const s3Settings = { hcp_mode: true, endpoint: 'https://s3.example.internal' };
const s3Credentials = {
	bucket: 'bucket-01',
	access_key_id: 'SYNTHETICKEY01',
	secret_access_key: 'synthetic-secret-key-01',
};
const s3compatible = (settings: Record<string, unknown> = s3Settings) =>
	({ type: 's3compatible', settings, credentials: {} }) as any;

describe('Agent S3 repository options (S3_AGENT_REPOSITORY_DESIGN.md 6.1.1 and 10.2)', () => {
	it('projects an HCP storage onto exactly the section 10.2 options and keeps the keys apart', () => {
		expect(agentS3RepositoryOptions(s3compatible(), s3Credentials)).toEqual({
			options: {
				provider: 'Other',
				endpoint: 'https://s3.example.internal',
				force_path_style: 'true',
				use_accept_encoding_gzip: 'false',
				no_check_bucket: 'true',
			},
			secrets: { access_key_id: 'SYNTHETICKEY01', secret_access_key: 'synthetic-secret-key-01' },
		});
	});

	it('keeps region, location constraint and ACL, and drops unset or default-valued settings', () => {
		const settings = {
			...s3Settings,
			upload_cutoff: '200Mi',
			disable_checksum: false,
			storage_class: '',
			force_path_style: true,
		};
		expect(
			agentS3RepositoryOptions(s3compatible(settings), {
				...s3Credentials,
				region: 'eu-01',
				location_constraint: 'eu-01',
				acl: 'private',
			}).options
		).toEqual({
			provider: 'Other',
			region: 'eu-01',
			location_constraint: 'eu-01',
			acl: 'private',
			endpoint: 'https://s3.example.internal',
			force_path_style: 'true',
			use_accept_encoding_gzip: 'false',
			no_check_bucket: 'true',
		});
	});

	it('allows an AWS endpoint without HCP mode and refuses s3compatible or other endpoints without it', () => {
		const aws = { type: 's3', settings: {}, credentials: {} } as any;
		expect(
			agentS3RepositoryOptions(aws, { ...s3Credentials, region: 'eu-central-1' }).options
		).toMatchObject({
			provider: 'AWS',
			region: 'eu-central-1',
			endpoint: 'https://s3.eu-central-1.amazonaws.com',
		});
		expect(() =>
			agentS3RepositoryOptions(s3compatible({ endpoint: 'https://s3.example.internal' }), s3Credentials)
		).toThrow('Enable protected HCP / pre-existing namespace mode');
		expect(() =>
			agentS3RepositoryOptions(
				{ type: 's3', settings: { endpoint: 'https://s3.example.internal' }, credentials: {} } as any,
				s3Credentials
			)
		).toThrow('Enable protected HCP / pre-existing namespace mode');
	});

	it('refuses env_auth, a plain HTTP endpoint and virtual-hosted style', () => {
		expect(() =>
			agentS3RepositoryOptions(s3compatible({ ...s3Settings, env_auth: true }), s3Credentials)
		).toThrow('not env_auth');
		expect(() =>
			agentS3RepositoryOptions(
				s3compatible({ hcp_mode: true, endpoint: 'http://s3.example.internal' }),
				s3Credentials
			)
		).toThrow('HTTPS');
		expect(() =>
			agentS3RepositoryOptions(s3compatible({ ...s3Settings, force_path_style: false }), s3Credentials)
		).toThrow('path-style');
	});

	it('names an unsupported setting that has a meaningful value, without the value', () => {
		let error: unknown;
		try {
			agentS3RepositoryOptions(s3compatible({ ...s3Settings, chunk_size: '64Mi' }), s3Credentials);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(AgentS3OptionError);
		expect(error).toMatchObject({ statusCode: 400, field: 'chunk_size', rule: 'unsupported-field' });
		expect((error as Error).message).not.toContain('64Mi');
		expect(() =>
			agentS3RepositoryOptions(s3compatible(), {
				...s3Credentials,
				session_token: 'synthetic-session-token',
			})
		).toThrow(AgentS3OptionError);
	});

	it('refuses control characters in keys and options', () => {
		expect(() =>
			agentS3RepositoryOptions(s3compatible(), {
				...s3Credentials,
				secret_access_key: 'synthetic\nsecret',
			})
		).toThrow(AppError);
	});

	it('applies the Agent option limits: 1024 characters and a closed character set', () => {
		const refused = (settings: Record<string, unknown>) => {
			try {
				agentS3RepositoryOptions(s3compatible({ ...s3Settings, ...settings }), s3Credentials);
			} catch (error) {
				return error;
			}
			return null;
		};
		expect(refused({ region: 'us east' })).toMatchObject({
			field: 'region',
			rule: 'unsupported-value',
		});
		expect(refused({ acl: 'private/x' })).toMatchObject({ field: 'acl', rule: 'unsupported-value' });
		expect(refused({ location_constraint: 'a'.repeat(129) })).toMatchObject({
			field: 'location_constraint',
			rule: 'unsupported-value',
		});
		expect(refused({ endpoint: `https://${'a'.repeat(1020)}.example.internal` })).toMatchObject({
			field: 'endpoint',
			rule: 'value-too-long',
		});
		expect(refused({ region: 'eu-west-1', acl: 'private', provider: 'Other' })).toBeNull();
		expect(JSON.stringify(refused({ region: 'us east' }))).not.toContain('us east');
	});

	it('refuses a storage type other than s3 and s3compatible', () => {
		expect(() =>
			agentS3RepositoryOptions(
				{ type: 'minio', settings: s3Settings, credentials: {} } as any,
				s3Credentials
			)
		).toThrow('S3 or S3-compatible');
	});
});

describe('Agent S3 prefix overlap', () => {
	const authority = 'https://s3.example.internal/bucket-01';
	it.each([
		['agents/app-01', 'agents/app-01', true],
		['agents/app-01', 'agents', true],
		['agents', 'agents/app-01/inner', true],
		['agents/app-01', '', true],
		['agents/app-01', 'agents/app-010', false],
		['agents/app-01', 'agents/app-02', false],
	])('%s against %s overlaps: %s', (a, b, expected) => {
		expect(agentS3ScopesOverlap({ authority, prefix: a }, { authority, prefix: b })).toBe(expected);
	});

	it('never overlaps another endpoint or bucket', () => {
		expect(
			agentS3ScopesOverlap(
				{ authority, prefix: 'agents' },
				{ authority: 'https://s3.example.internal/bucket-02', prefix: 'agents' }
			)
		).toBe(false);
	});
});
