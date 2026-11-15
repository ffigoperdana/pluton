/**
 * S3 as a Managed Agent repository (docs/S3_AGENT_REPOSITORY_DESIGN.md, stage 1):
 * capability gating, the Agent S3 option allowlist and prefix isolation.
 */
export type AgentRepositoryBackend = 'sftp' | 's3';
type AgentCapabilities = Record<string, unknown> | null | undefined;

export const AGENT_S3_UNSUPPORTED_MESSAGE =
	'Remote agent does not support S3 repositories. Update the agent first.';

/** Section 10.1: an Agent that omits the field is an SFTP-only Agent. */
export function agentRepositoryBackends(capabilities: AgentCapabilities): AgentRepositoryBackend[] {
	const reported = capabilities?.repositoryBackends;
	if (!Array.isArray(reported)) return ['sftp'];
	return reported.filter(
		(backend): backend is AgentRepositoryBackend => backend === 'sftp' || backend === 's3'
	);
}

/** Section 10.1: an Agent that omits the field accepts payload versions up to 4. */
export function agentBackupPayloadVersion(capabilities: AgentCapabilities): 4 | 5 {
	return capabilities?.backupPayloadVersion === 5 ? 5 : 4;
}

export function agentSupportsS3Repository(capabilities: AgentCapabilities): boolean {
	return (
		agentRepositoryBackends(capabilities).includes('s3') &&
		agentBackupPayloadVersion(capabilities) === 5
	);
}

/** Section 6.1.1: exactly the AWS S3 and S3 Compatible Storage providers. */
export function isAgentS3StorageType(
	type: string | null | undefined
): type is 's3' | 's3compatible' {
	return type === 's3' || type === 's3compatible';
}
