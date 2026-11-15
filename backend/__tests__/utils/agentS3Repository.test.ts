import {
	agentBackupPayloadVersion,
	agentRepositoryBackends,
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
