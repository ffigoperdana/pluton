import type { Storage } from '../db/schema/storages';
import { AppError } from './AppError';
import { providers } from './providers';
import { isHcpMode, storageRcloneOptions, validateHcpConfiguration } from './storageSecurity';

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

export const AGENT_S3_REPLICATION_MESSAGE =
	'Replication is not available for an S3 primary repository yet.';
export const AGENT_S3_OVERLAP_MESSAGE =
	'The S3 repository prefix overlaps another plan or replica. Select a separate prefix.';
export const AGENT_S3_SCOPE_UNVERIFIED_MESSAGE =
	'Another plan uses an S3 location that cannot be verified, so the S3 repository prefix cannot be checked for overlap.';

/** Section 10.2: the only plain S3 options an Agent accepts. */
export const AGENT_S3_PLAIN_OPTION_KEYS: readonly string[] = [
	'provider',
	'endpoint',
	'region',
	'location_constraint',
	'acl',
	'force_path_style',
	'use_accept_encoding_gzip',
	'no_check_bucket',
];
const AGENT_S3_SECRET_OPTION_KEYS: readonly string[] = ['access_key_id', 'secret_access_key'];
// Mirrors the Agent 0.8.0 parser (backupFilesystem.ts validateS3PlainOptions / validateS3RepositoryPath).
const MAX_OPTION_LENGTH = 1_024;
const MAX_SECRET_LENGTH = 16_384;
const AGENT_S3_SAFE_VALUE_KEYS: readonly string[] = ['provider', 'region', 'location_constraint', 'acl'];
const AGENT_S3_SAFE_VALUE = /^[A-Za-z0-9._-]{1,128}$/;
const AWS_ENDPOINT = /^(?:s3|s3[.-][a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/;

export type AgentS3Secrets = { access_key_id: string; secret_access_key: string };
export type AgentS3OptionRule =
	| 'unsupported-field'
	| 'unsafe-control-character'
	| 'value-too-long'
	| 'unsupported-value';

type S3StorageConfiguration = Pick<Storage, 'type' | 'credentials' | 'settings'>;

/** Names the refused option and the rule, never the value. */
export class AgentS3OptionError extends AppError {
	constructor(
		readonly field: string,
		readonly rule: AgentS3OptionRule
	) {
		super(
			400,
			rule === 'unsupported-field'
				? 'S3 repositories for Agent plans support only the provider, endpoint, region, location constraint, ACL and access keys.'
				: 'S3 configuration contains an unsafe value.'
		);
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

const hasControl = (value: string): boolean =>
	Array.from(value).some(
		character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
	);

/** The Storage UI keeps empty fields and toggled-off defaults; those mean "unset". */
function isUnsetS3Setting(type: string, key: string, value: string): boolean {
	if (value === '') return true;
	const setting = providers[type]?.settings?.find(entry => entry.value === key);
	if (!setting) return false;
	if (String(setting.default).toLowerCase() === value.toLowerCase()) return true;
	return setting.fieldType === 'bool' && value === 'false';
}

/**
 * Sections 6.1.1 and 10.2: apply the replication-destination HCP rules, then project
 * storageRcloneOptions onto the Agent allowlist. Keys stay apart so that payload
 * version 5 can seal them. Throws instead of silently dropping a meaningful setting.
 */
export function agentS3RepositoryOptions(
	storage: S3StorageConfiguration,
	credentials: Record<string, string>
): { options: Record<string, string>; secrets: AgentS3Secrets } {
	if (!isAgentS3StorageType(storage.type))
		throw new AppError(400, 'An S3 or S3-compatible storage is required.');
	const settings = (storage.settings || {}) as Record<string, any>;
	if (String(credentials.env_auth ?? settings.env_auth) === 'true')
		throw new AppError(
			400,
			'S3 repositories for Agent plans use explicit protected credentials, not env_auth.'
		);
	validateHcpConfiguration(credentials, settings);
	const resolved = storageRcloneOptions(storage, credentials);
	const hostname = new URL(resolved.endpoint).hostname;
	if ((storage.type === 's3compatible' || !AWS_ENDPOINT.test(hostname)) && !isHcpMode(settings))
		throw new AppError(
			400,
			'Enable protected HCP / pre-existing namespace mode before using this S3 storage for an Agent plan.'
		);
	if (resolved.force_path_style === 'false')
		throw new AppError(400, 'S3 repositories for Agent plans require path-style access.');
	const options: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (key === 'type' || key === 'env_auth' || AGENT_S3_SECRET_OPTION_KEYS.includes(key)) continue;
		if (AGENT_S3_PLAIN_OPTION_KEYS.includes(key)) {
			if (value !== '') options[key] = value;
			continue;
		}
		if (isUnsetS3Setting(storage.type, key, value)) continue;
		throw new AgentS3OptionError(key, 'unsupported-field');
	}
	Object.assign(options, {
		force_path_style: 'true',
		use_accept_encoding_gzip: 'false',
		no_check_bucket: 'true',
	});
	const secrets: AgentS3Secrets = {
		access_key_id: resolved.access_key_id,
		secret_access_key: resolved.secret_access_key,
	};
	for (const [key, value] of Object.entries({ ...options, ...secrets })) {
		// Plain options are limited like the Agent; sealed secrets keep the wider limit.
		const limit = key in options ? MAX_OPTION_LENGTH : MAX_SECRET_LENGTH;
		if (value.length > limit) throw new AgentS3OptionError(key, 'value-too-long');
		if (hasControl(value)) throw new AgentS3OptionError(key, 'unsafe-control-character');
		if (AGENT_S3_SAFE_VALUE_KEYS.includes(key) && !AGENT_S3_SAFE_VALUE.test(value))
			throw new AgentS3OptionError(key, 'unsupported-value');
	}
	return { options, secrets };
}

export const AGENT_S3_PATH_MESSAGE =
	'The S3 repository path must be bucket/prefix with no leading or trailing slash, empty, dot or backslash segment.';

/**
 * Agent 0.8.0 validateS3RepositoryPath: bucket plus at least one prefix segment, no empty,
 * "." or ".." segment and no backslash. Stored paths are refused, never rewritten.
 */
export function assertAgentS3RepositoryPath(repositoryPath: string): void {
	const segments = repositoryPath.split('/');
	if (
		!repositoryPath ||
		repositoryPath.includes('\\') ||
		hasControl(repositoryPath) ||
		segments.length < 2 ||
		segments.some(segment => !segment || segment === '.' || segment === '..')
	)
		throw new AppError(400, AGENT_S3_PATH_MESSAGE);
}

/** The replication overlap rule; an empty prefix is a bucket root and overlaps everything in it. */
export function agentS3ScopesOverlap(
	a: { authority: string; prefix: string },
	b: { authority: string; prefix: string }
): boolean {
	return (
		a.authority === b.authority &&
		(!a.prefix ||
			!b.prefix ||
			a.prefix === b.prefix ||
			a.prefix.startsWith(`${b.prefix}/`) ||
			b.prefix.startsWith(`${a.prefix}/`))
	);
}
