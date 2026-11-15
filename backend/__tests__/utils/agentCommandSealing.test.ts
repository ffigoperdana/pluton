import crypto from 'crypto';
import {
	AGENT_COMMAND_SECRETS_ALG,
	AGENT_COMMAND_SECRETS_KID,
	AgentCommandSealingError,
	deriveAgentCommandSealingKey,
	openAgentCommandSecrets,
	sealAgentCommandSecrets,
	type SealedAgentCommandSecrets,
} from '../../src/utils/agentCommandSealing';

/** docs/S3_AGENT_REPOSITORY_DESIGN.md 10.4, copied verbatim. The Agent suite uses the same values. */
const vector = {
	secret: 'synthetic-agent-secret-0123456789abcdef',
	commandId: 'cmd-synthetic-01',
	leaseToken: '0123456789abcdef0123456789abcdef0123456789abcdef',
	key: '1f35dc3e9cf013165a2353883369bbfa7edd62b56072b3413c8074e2ffb93fac',
	nonce: 'AAECAwQFBgcICQoL',
	plaintext:
		'{"repositoryPassword":"synthetic-repository-password-01","rclone":{"access_key_id":"SYNTHETICKEY01","secret_access_key":"synthetic-secret-key-01"}}',
	ciphertext:
		'jh0qetVE17GJz08s3DXhomumBqDIVOhzX3A4LgVFJeiH9JSKr4qR7OowvN0duifn639ReyzbjXGWiSEWAaymlLJKNnxwbrP+vLmuRdk9vI+wuUG8cJhENnxGV0LXHElNyPLQME0jaSjTfM7T0n9LTBr7V76enQuphACHq53aFDwiyFLa5p/2ML2748FcdivP43U+',
	tag: 'pUKJ+stiEzlyVi8BFN6biQ==',
};
const sealedVector: SealedAgentCommandSecrets = {
	alg: 'A256GCM',
	kid: 'pluton-agent-command-secrets-v1',
	nonce: vector.nonce,
	ciphertext: vector.ciphertext,
	tag: vector.tag,
};
const flipByte = (value: string, index: number): string => {
	const bytes = Buffer.from(value, 'base64');
	bytes[index] ^= 0x01;
	return bytes.toString('base64');
};
const openVector = (sealed: unknown, commandId = vector.commandId, leaseToken = vector.leaseToken) =>
	openAgentCommandSecrets(vector.secret, commandId, leaseToken, sealed);

describe('Agent command secret sealing (S3_AGENT_REPOSITORY_DESIGN.md 10.3 and 10.4)', () => {
	it('derives the section 10.4 key, which differs from the HMAC key', () => {
		const key = deriveAgentCommandSealingKey(vector.secret);
		expect(key.toString('hex')).toBe(vector.key);
		expect(key.equals(Buffer.from(vector.secret, 'utf8'))).toBe(false);
		expect(AGENT_COMMAND_SECRETS_KID).toBe('pluton-agent-command-secrets-v1');
		expect(AGENT_COMMAND_SECRETS_ALG).toBe('A256GCM');
	});

	it('reproduces the section 10.4 ciphertext and tag for the fixed nonce', () => {
		expect(
			sealAgentCommandSecrets(
				vector.secret,
				vector.commandId,
				vector.leaseToken,
				JSON.parse(vector.plaintext),
				Buffer.from(vector.nonce, 'base64')
			)
		).toEqual(sealedVector);
	});

	it('opens the section 10.4 vector to the exact plaintext', () => {
		expect(JSON.stringify(openVector(sealedVector))).toBe(vector.plaintext);
	});

	it('refuses any changed byte of the ciphertext, tag or nonce', () => {
		for (const field of ['ciphertext', 'tag', 'nonce'] as const) {
			const length = Buffer.from(sealedVector[field], 'base64').length;
			for (let index = 0; index < length; index += 1) {
				const changed = { ...sealedVector, [field]: flipByte(sealedVector[field], index) };
				expect(() => openVector(changed)).toThrow(AgentCommandSealingError);
			}
		}
	});

	it('refuses another command ID, lease token or Agent secret', () => {
		expect(() => openVector(sealedVector, 'cmd-synthetic-02')).toThrow(AgentCommandSealingError);
		expect(() => openVector(sealedVector, vector.commandId, `1${vector.leaseToken.slice(1)}`)).toThrow(
			AgentCommandSealingError
		);
		expect(() =>
			openAgentCommandSecrets(
				'synthetic-agent-secret-0123456789abcdeX',
				vector.commandId,
				vector.leaseToken,
				sealedVector
			)
		).toThrow(AgentCommandSealingError);
	});

	it('refuses another algorithm, key ID, extra field or malformed encoding', () => {
		for (const changed of [
			{ ...sealedVector, alg: 'A128GCM' },
			{ ...sealedVector, kid: 'pluton-agent-command-secrets-v2' },
			{ ...sealedVector, extra: 'x' },
			{ ...sealedVector, nonce: 'AAECAwQFBgcICQ' },
			{ ...sealedVector, tag: `${sealedVector.tag}AA` },
			{ ...sealedVector, ciphertext: '' },
			{ ...sealedVector, ciphertext: `${sealedVector.ciphertext}!` },
			null,
			'sealed',
		]) {
			expect(() => openVector(changed)).toThrow(AgentCommandSealingError);
		}
	});

	it('uses a fresh 12-byte nonce and a 16-byte tag for every seal', () => {
		const secrets = {
			repositoryPassword: 'synthetic-repository-password-01',
			rclone: { pass: 'synthetic-sftp-password' },
		};
		const first = sealAgentCommandSecrets(vector.secret, vector.commandId, vector.leaseToken, secrets);
		const second = sealAgentCommandSecrets(vector.secret, vector.commandId, vector.leaseToken, secrets);
		expect(first.nonce).not.toBe(second.nonce);
		expect(Buffer.from(first.nonce, 'base64')).toHaveLength(12);
		expect(Buffer.from(first.tag, 'base64')).toHaveLength(16);
		expect(openVector(second)).toEqual(secrets);
	});

	describe('sealed database passwords (design 10.3, "Database passwords")', () => {
		const base = {
			repositoryPassword: 'synthetic-repository-password-01',
			rclone: { pass: 'synthetic-sftp-password' },
		};
		/** Seals raw JSON through the same cipher path, so malformed plaintexts can be refused by open. */
		const sealRaw = (plaintext: unknown) => {
			const nonce = Buffer.alloc(12, 7);
			const cipher = crypto.createCipheriv(
				'aes-256-gcm',
				deriveAgentCommandSealingKey(vector.secret),
				nonce,
				{ authTagLength: 16 }
			);
			cipher.setAAD(
				Buffer.from(`${AGENT_COMMAND_SECRETS_KID}\n${vector.commandId}\n${vector.leaseToken}`, 'utf8')
			);
			const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), 'utf8'), cipher.final()]);
			return {
				alg: 'A256GCM',
				kid: AGENT_COMMAND_SECRETS_KID,
				nonce: nonce.toString('base64'),
				ciphertext: ciphertext.toString('base64'),
				tag: cipher.getAuthTag().toString('base64'),
			};
		};

		it('round trips a databases object keyed by databaseId', () => {
			const secrets = {
				...base,
				lifecycle: {
					databases: { 'db-01': 'synthetic-db-password-01', 'db-02': 'synthetic-db-password-02' },
				},
			};
			const sealed = sealAgentCommandSecrets(vector.secret, vector.commandId, vector.leaseToken, secrets);
			expect(openVector(sealed)).toEqual(secrets);
		});

		it('round trips the single database password of lifecycle version 1', () => {
			const secrets = { ...base, lifecycle: { database: 'synthetic-db-password-01' } };
			const sealed = sealAgentCommandSecrets(vector.secret, vector.commandId, vector.leaseToken, secrets);
			expect(openVector(sealed)).toEqual(secrets);
		});

		it('refuses an unknown lifecycle key, an empty password and a non-string value', () => {
			for (const lifecycle of [
				{ other: 'x' },
				{ databases: { 'db-01': '' } },
				{ database: '' },
				{ database: 7 },
				{ databases: { 'db-01': 7 } },
				{ databases: ['x'] },
				{ database: 'x', extra: 'y' },
				'x',
				null,
			]) {
				expect(() => openVector(sealRaw({ ...base, lifecycle }))).toThrow(AgentCommandSealingError);
			}
		});
	});
});
