import crypto from 'crypto';

/**
 * Sealed secrets of a BACKUP_FILESYSTEM payload version 5
 * (docs/S3_AGENT_REPOSITORY_DESIGN.md, sections 10.3 and 10.4). The HMAC command
 * signature proves integrity; this layer keeps the repository password and storage
 * keys confidential on Agent links that may use plain HTTP.
 */
export const AGENT_COMMAND_SECRETS_KID = 'pluton-agent-command-secrets-v1';
export const AGENT_COMMAND_SECRETS_ALG = 'A256GCM';

export type AgentCommandSecrets = {
	repositoryPassword: string;
	rclone: { pass?: string; access_key_id?: string; secret_access_key?: string };
	/** Database passwords of a lifecycle that was stripped of them (section 10.3). */
	lifecycle?: { database?: string; databases?: Record<string, string> };
};

export type SealedAgentCommandSecrets = {
	alg: typeof AGENT_COMMAND_SECRETS_ALG;
	kid: typeof AGENT_COMMAND_SECRETS_KID;
	nonce: string;
	ciphertext: string;
	tag: string;
};

/** What AgentService.poll knows about the lease it is delivering. */
export type AgentCommandSealingContext = { agentSecret: string; leaseToken: string };

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const RCLONE_SECRET_KEYS = new Set(['pass', 'access_key_id', 'secret_access_key']);

/** One fixed message: never reveal which check failed. */
export class AgentCommandSealingError extends Error {
	constructor() {
		super('Sealed command secrets could not be opened.');
		this.name = 'AgentCommandSealingError';
	}
}

export function deriveAgentCommandSealingKey(agentSecret: string): Buffer {
	return Buffer.from(
		crypto.hkdfSync(
			'sha256',
			Buffer.from(agentSecret, 'utf8'),
			Buffer.alloc(0),
			Buffer.from(AGENT_COMMAND_SECRETS_KID, 'utf8'),
			32
		)
	);
}

function additionalData(commandId: string, leaseToken: string): Buffer {
	return Buffer.from(`${AGENT_COMMAND_SECRETS_KID}\n${commandId}\n${leaseToken}`, 'utf8');
}

/** Buffer.from ignores invalid base64 characters, so require an exact round trip. */
function decodeBase64(value: unknown, length?: number): Buffer {
	if (typeof value !== 'string' || !value) throw new AgentCommandSealingError();
	const bytes = Buffer.from(value, 'base64');
	if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length))
		throw new AgentCommandSealingError();
	return bytes;
}

const nonEmptyString = (value: unknown): boolean => typeof value === 'string' && value !== '';

/** Absent is valid; present means exactly one of database or databases, with non-empty string passwords. */
function validLifecycleSecrets(value: unknown): boolean {
	if (value === undefined) return true;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const entries = Object.entries(value);
	if (entries.length !== 1) return false;
	const [key, entry] = entries[0];
	if (key === 'database') return nonEmptyString(entry);
	if (key !== 'databases' || !entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
	const passwords = Object.entries(entry);
	return passwords.length > 0 && passwords.every(([id, password]) => id !== '' && nonEmptyString(password));
}

export function sealAgentCommandSecrets(
	agentSecret: string,
	commandId: string,
	leaseToken: string,
	secrets: AgentCommandSecrets,
	nonce: Buffer = crypto.randomBytes(NONCE_BYTES)
): SealedAgentCommandSecrets {
	if (nonce.length !== NONCE_BYTES) throw new Error('A sealing nonce must be 12 bytes.');
	const cipher = crypto.createCipheriv(
		'aes-256-gcm',
		deriveAgentCommandSealingKey(agentSecret),
		nonce,
		{ authTagLength: TAG_BYTES }
	);
	cipher.setAAD(additionalData(commandId, leaseToken));
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
	return {
		alg: AGENT_COMMAND_SECRETS_ALG,
		kid: AGENT_COMMAND_SECRETS_KID,
		nonce: nonce.toString('base64'),
		ciphertext: ciphertext.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
	};
}

/** The server opens sealed blobs only in tests today; the Agent implements the same contract. */
export function openAgentCommandSecrets(
	agentSecret: string,
	commandId: string,
	leaseToken: string,
	sealed: unknown
): AgentCommandSecrets {
	const value = sealed as Record<string, unknown> | null;
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(',') !== 'alg,ciphertext,kid,nonce,tag' ||
		value.alg !== AGENT_COMMAND_SECRETS_ALG ||
		value.kid !== AGENT_COMMAND_SECRETS_KID
	)
		throw new AgentCommandSealingError();
	const nonce = decodeBase64(value.nonce, NONCE_BYTES);
	const tag = decodeBase64(value.tag, TAG_BYTES);
	const ciphertext = decodeBase64(value.ciphertext);
	let plaintext: string;
	try {
		const decipher = crypto.createDecipheriv(
			'aes-256-gcm',
			deriveAgentCommandSealingKey(agentSecret),
			nonce,
			{ authTagLength: TAG_BYTES }
		);
		decipher.setAAD(additionalData(commandId, leaseToken));
		decipher.setAuthTag(tag);
		plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
	} catch {
		throw new AgentCommandSealingError();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintext);
	} catch {
		throw new AgentCommandSealingError();
	}
	const secrets = parsed as { repositoryPassword?: unknown; rclone?: unknown } | null;
	const rclone = secrets?.rclone as Record<string, unknown> | undefined;
	if (
		!secrets ||
		typeof secrets !== 'object' ||
		!['rclone,repositoryPassword', 'lifecycle,rclone,repositoryPassword'].includes(
			Object.keys(secrets).sort().join(',')
		) ||
		typeof secrets.repositoryPassword !== 'string' ||
		!secrets.repositoryPassword ||
		!rclone ||
		typeof rclone !== 'object' ||
		Array.isArray(rclone) ||
		Object.entries(rclone).some(
			([key, entry]) => !RCLONE_SECRET_KEYS.has(key) || typeof entry !== 'string' || !entry
		) ||
		!validLifecycleSecrets((secrets as { lifecycle?: unknown }).lifecycle)
	)
		throw new AgentCommandSealingError();
	return parsed as AgentCommandSecrets;
}
