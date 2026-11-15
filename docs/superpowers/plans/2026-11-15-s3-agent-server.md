# S3 Agent Repository, Server and Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a new Managed Agent plan use an `s3` or `s3compatible` storage as its primary repository, written directly by an Agent that reports S3 support, with every secret sealed in command payload version 5, and make every server read operation work against that S3 primary.

**Architecture:** A pure module (`agentS3Repository.ts`) owns capability gating, the Agent S3 option allowlist and prefix overlap; a second pure module (`agentCommandSealing.ts`) implements section 10.3 sealing. `RemoteBackupService` uses both for eligibility (create, update, queue, poll) and for payload version 5, with `AgentService.poll` handing it the per-Agent secret and lease token. The read path stays one `RemoteRepositoryRecoveryService`: `context()` asks `RemoteBackupService.getRepositoryAccessOptions()` for SFTP or S3 options, and a session router picks `ManagedSftpRepositorySession` or `ManagedS3RecoverySession` per call by `options.type`. The frontend reads the Agent capabilities it already receives from `/devices`.

**Tech Stack:** Node 24, Express 5, TypeScript, zod, better-sqlite3 and Drizzle, Jest with ts-jest, `node:crypto` (HKDF-SHA256, AES-256-GCM); Restic 0.19.1 and Rclone 1.75.1 inside the Docker replica lab; React 18, Vite 6, TanStack Query, `node:test` with jsdom and esbuild for frontend tests.

## Global Constraints

- Spec: `docs/S3_AGENT_REPOSITORY_DESIGN.md`. Section 10 is binding: field names, labels, error behaviour and test vector are copied below verbatim.
- Eligible primary storage types: exactly `s3` and `s3compatible`.
- Capability `repositoryBackends`: array of `'sftp'` and `'s3'`, 1 to 2 entries, no duplicates, must contain `'sftp'`; optional.
- Capability `backupPayloadVersion`: literal `5`; optional.
- An Agent that omits both fields is treated as `repositoryBackends: ['sftp']` and payload version 4.
- S3 support means `repositoryBackends` contains `'s3'` and `backupPayloadVersion` is `5`.
- Refusal for an Agent without S3 support: `AppError(409, 'Remote agent does not support S3 repositories. Update the agent first.')`.
- Payload version 5 goes to every Agent that reports `backupPayloadVersion: 5`, for SFTP and S3; Agents without it keep versions 1 to 4, unchanged and SFTP-only.
- Version 5 top-level fields: `version` (5), `lifecycle` (unchanged, optional), `backupId`, `planId`, `sourcePath`, `excludes`, `sourceDiagnosticsVersion` (`1`), `repository` `{ "remoteName": "pluton", "path": <sftp directory, or bucket/prefix for s3>, "initialize": <bool> }`, `rclone` `{ "type": "sftp" | "s3", "options": {...} }`, `sealed`. No top-level `repositoryPassword`.
- `sourceDiagnosticsVersion` is sent exactly as today (Agents 0.7.1 and later already receive it) and must be accepted in version 5.
- Allowed plain options: SFTP `host`, `port`, `user`; S3 `provider`, `endpoint`, `region`, `location_constraint`, `acl`, `force_path_style` (must be `"true"`), `use_accept_encoding_gzip` (must be `"false"`), `no_check_bucket`. The S3 `endpoint` must be an `https://` origin.
- Plain `options` never contain `pass`, `access_key_id`, `secret_access_key` or a repository password.
- `sealed`: `{ "alg": "A256GCM", "kid": "pluton-agent-command-secrets-v1", "nonce": "<base64, 12 bytes>", "ciphertext": "<base64>", "tag": "<base64, 16 bytes>" }`.
- Sealed plaintext: UTF-8 JSON `{"repositoryPassword": string, "rclone": {"pass"?: string, "access_key_id"?: string, "secret_access_key"?: string}}`. SFTP carries `pass`; S3 carries both keys.
- Key: `HKDF-SHA256(ikm = UTF-8 bytes of the per-Agent secret, salt = empty, info = "pluton-agent-command-secrets-v1", length = 32)`.
- Cipher: AES-256-GCM, random 12-byte nonce per command, 16-byte tag.
- Additional data: UTF-8 of `"pluton-agent-command-secrets-v1\n" + commandId + "\n" + leaseToken`.
- The HMAC command signature (`signAgentCommand`) is computed over the payload that contains `sealed`, as today.
- Test vector secret: `synthetic-agent-secret-0123456789abcdef`
- Test vector commandId: `cmd-synthetic-01`
- Test vector leaseToken: `0123456789abcdef0123456789abcdef0123456789abcdef`
- Test vector derived key (hex): `1f35dc3e9cf013165a2353883369bbfa7edd62b56072b3413c8074e2ffb93fac`
- Test vector nonce (base64): `AAECAwQFBgcICQoL`
- Test vector plaintext: `{"repositoryPassword":"synthetic-repository-password-01","rclone":{"access_key_id":"SYNTHETICKEY01","secret_access_key":"synthetic-secret-key-01"}}`
- Test vector ciphertext (base64): `jh0qetVE17GJz08s3DXhomumBqDIVOhzX3A4LgVFJeiH9JSKr4qR7OowvN0duifn639ReyzbjXGWiSEWAaymlLJKNnxwbrP+vLmuRdk9vI+wuUG8cJhENnxGV0LXHElNyPLQME0jaSjTfM7T0n9LTBr7V76enQuphACHq53aFDwiyFLa5p/2ML2748FcdivP43U+`
- Test vector tag (base64): `pUKJ+stiEzlyVi8BFN6biQ==`
- Changing any byte of the ciphertext, tag, nonce, command ID or lease token must make opening fail.
- HCP rules for the S3 primary are the replication-destination rules: `hcp_mode` required for `s3compatible` and non-AWS endpoints, HTTPS endpoint, no `env_auth`.
- The path is a prefix inside the bucket, never the bucket root.
- The canonical identity must not overlap any other plan's primary or any replication destination.
- Replication settings are refused for an S3-primary Agent plan in stage 1.
- The payload carries no trust or CA setting; the Agent uses its own `PLUTON_AGENT_STORAGE_CA_FILE` (6.2 point 4), and the server applies `trustEnvironment` only on its own read path.
- Accepted `AGENT_INSTALL_VERSION` values: `0.7.0`, `0.7.1` and `0.8.0`. The `.env` pin to the reviewed 0.8.0 commit is an operator step after the Agent pull request merges.
- No database migration (see Verified findings).
- Commits: `git add <explicit paths>` (never `git add .`), then `git diff --cached --check`, Conventional Commit messages, no Co-Authored-By or AI attribution lines. Never push; the user pushes.
- Tests use synthetic data only: `app-01`, `192.0.2.10`, `example.internal`, `s3.example.internal`, `bucket-01`.
- Never weaken or skip existing tests. The only existing assertion this plan edits (Task 6) gains one expected argument; nothing is removed.
- UI: keep the existing components, classes and dark theme; text and gating only, no redesign.

---

## Before you start

- Run every command from the repository root in Git Bash unless the command itself starts with `cd backend`.
- Node 24 (Windows: 24.16.0 via nvm4w is fine), pnpm 10.20.0, dependencies installed (`pnpm install --frozen-lockfile`).
- Jest on Windows needs a short private temp directory: `mkdir -p /c/laragon/www/pluton/tmp/t` once.
- The spec lives on branch `claude/s3-agent-repository-design` (`f2ada0c`); its section 10 was still an uncommitted edit in worktree `goofy-shirley-53b716` when this plan was written. Every binding value is copied into Global Constraints, so the implementation branch starts from `origin/main`.

## Verified findings (read on 15 November 2026)

- **No migration.** Agent capabilities are stored as JSON: `agent_identities.capabilities` is `text('capabilities', { mode: 'json' })` (`backend/src/db/schema/agents.ts:67`), and `AgentStore.updateHeartbeat` writes `inventory.capabilities` verbatim (`backend/src/stores/AgentStore.ts:175-189`). `remote_managed_repositories` (migration 0006) stores a generic `storage_id`/`storage_path`. Only the strict zod schema (`AgentService.ts:43-69`) and the `AgentInventory` type change.
- **Frontend capability source.** `useGetDevices()` calls `/devices`; `DeviceService` attaches `agentService.getPublicAgent(device.id)` (`DeviceService.ts:298`), whose `capabilities` is the stored JSON (`AgentService.toPublic`). `PlanSourceSettings` already reads `device.agent.capabilities`.
- **Lease token.** `materializeCommand(agentId, command)` (`RemoteBackupService.ts:358-499`) never sees the lease token; `AgentService.poll` creates it (`:445`) and holds `agent.secret`, then signs with `signAgentCommand(agent.secret, signatureTimestamp, signedCommand, leaseToken)` (`:492-505`). This plan passes `{ agentSecret, leaseToken }` as a third argument.
- **Options.** `storageRcloneOptions` (`storageSecurity.ts:173-218`) returns `type`, `env_auth: 'false'` and every provider setting that has a stored value. The Agent allowlist excludes these, so the server projects the result onto section 10.2 and refuses meaningful unsupported settings by name.
- **Secret.** `decryptStorageCredentials` (`storageSecurity.ts:58-77`) always uses `configService.config.SECRET`; `RemoteBackupService` uses its injected `encryptionSecret` (`:186`). The function gets an optional `secret` parameter.
- **Routing key.** SFTP access options never contain `type` (`ManagedSftpRepositorySession.validateAccess`, `:222-238`, refuses it); `ManagedS3RecoverySession.validateAccess` requires `type: 's3'` (`ManagedS3RecoverySession.ts:46-74`). The session router keys on `options.type`.
- **Existing isolation backstops.** `PlanStore.create` already calls `assertPlanReplicaIsolation` (registered replica destinations, inside the write transaction) and export namespace reservations already cover plan primaries. The new check adds other plans' configured primaries and replicas.
- **Agent failure codes.** Spec 6.2.6 maps S3 failures to existing stages and codes. `backupFailureStageSchema`/`backupFailureCodeSchema` (`AgentService.ts:85-163`) and the messages in `remoteBackupDiagnostics.ts` are already storage-neutral ("Storage authentication failed.", "The storage connection failed.", "Repository initialization was refused because the target is not empty."). No server change.
- **Relocation.** `PlanRepositoryRelocationService.start` (`:99-122`) checks only the destination type. For an S3 primary it would create a relocation record and fail later in `getSftpRecoveryOptions`. Task 8 refuses it up front.

## Decisions recorded in the spec (updated 15 November 2026)

1. **`sourceDiagnosticsVersion` in version 5.** Section 10.2 lists `sourceDiagnosticsVersion: 1`, sent exactly as today (`supportsSourceDiagnostics`, Agents 0.7.1 and later), and the Agent must accept it in version 5. Task 5 keeps it in the shared `common` payload fields.
2. **Installing 0.8.0.** Spec 6.7 pins `AGENT_INSTALL_VERSION` to the reviewed 0.8.0 commit, but `SUPPORTED_AGENT_INSTALL_VERSIONS` (`backend/src/utils/agentDistribution.ts:20`, `frontend/src/utils/agentEnrollment.ts:14`) is `['0.7.0', '0.7.1']` today. Task 14 adds `0.8.0` to both allowlists. Setting `AGENT_INSTALL_COMMIT` and `AGENT_INSTALL_VERSION` in the server `.env` stays an operator step after the Agent pull request merges.
3. **Trust.** Section 6.1 point 2: the payload carries no trust or CA setting; the Agent uses its own `PLUTON_AGENT_STORAGE_CA_FILE`, and the server applies `trustEnvironment()` only on its read path (the S3 session built by the Task 7 router).

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `backend/src/utils/agentCommandSealing.ts` | create | Section 10.3 key derivation, seal and open; test vector target |
| `backend/src/utils/agentS3Repository.ts` | create | Capability helpers, refusal messages, Agent S3 option projection, prefix overlap |
| `backend/src/utils/restic/ManagedRepositorySessionRouter.ts` | create | Session factory keyed by access type (`sftp` or `s3`) |
| `backend/src/utils/storageSecurity.ts` | modify | `decryptStorageCredentials` accepts an explicit secret |
| `backend/src/types/agents.ts` | modify | `AgentInventory.capabilities` gains the two fields |
| `backend/src/services/AgentService.ts` | modify | Strict inventory schema; `poll` passes the sealing context |
| `backend/src/services/remoteCommandPreparation.ts` | modify | Four new closed preparation stages |
| `backend/src/services/RemoteBackupService.ts` | modify | Eligibility, payload version 5, `getRepositoryAccessOptions` |
| `backend/src/services/RemoteRepositoryRecoveryService.ts` | modify | `context()` uses storage-typed access; router as default provider |
| `backend/src/services/PlanRepositoryRelocationService.ts` | modify | Refuse to move a non-SFTP primary |
| `backend/__tests__/utils/agentCommandSealing.test.ts` | create | Vector, tamper and shape tests |
| `backend/__tests__/utils/agentS3Repository.test.ts` | create | Capability, projection and overlap tests |
| `backend/__tests__/utils/restic/ManagedRepositorySessionRouter.test.ts` | create | Routing and default factory tests |
| `backend/__tests__/utils/storageSecurity.test.ts` | modify | Explicit-secret decryption test |
| `backend/__tests__/services/AgentService.test.ts` | modify | Capability schema and sealing-context tests |
| `backend/__tests__/services/RemoteBackupService.test.ts` | modify | Eligibility, payload version 5, read access tests |
| `backend/__tests__/services/RemoteRepositoryRecoveryService.test.ts` | modify | S3 primary context test |
| `backend/__tests__/services/PlanRepositoryRelocationService.test.ts` | modify | S3 primary relocation refusal test |
| `backend/__tests__/integration/replicaRecovery.lab.ts` | modify | S3 primary read scenario in the Docker lab |
| `frontend/src/utils/agentRepository.ts` | create | Capability gating, notices, replication reset, Move Repository rule |
| `frontend/src/@types/devices.ts` | modify | `AgentInfo.capabilities` gains the two fields |
| `frontend/src/components/Plan/PlanForm/PlanForm.tsx` | modify | S3 offered per Agent, hidden-S3 notice, destination wording, replication gate |
| `frontend/src/components/Plan/PlanSettings/PlanReplicationSettings.tsx` | modify | `unavailableReason` prop; generalised primary wording |
| `frontend/src/utils/assistedRecovery.ts` | modify | Generalised primary wording |
| `frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.tsx` | modify | Generalised primary wording |
| `frontend/src/routes/PlanSingle/PlanSingle.tsx` | modify | Move Repository only for SFTP primaries |
| `frontend/__tests__/agentS3Repository.test.ts` | create | Helper tests |
| `frontend/__tests__/managedReplication.test.ts` | modify | Replication unavailable and wording tests |
| `frontend/__tests__/assistedRecovery.test.ts` | modify | Wording test |
| `frontend/__tests__/agentSourceAccessUi.test.ts` | modify | PlanForm gating test (mocks expose props) |
| `frontend/__tests__/docs.test.ts` | modify | Managed Agent guide covers the S3 primary |
| `frontend/src/docs/manifest.ts` | modify | Article title |
| `frontend/src/docs/articles/backup-plans/managed-agent.md` | modify | Title and S3 primary section |
| `frontend/src/docs/articles/remote-agent.md` | modify | Generalised primary wording |
| `frontend/src/docs/articles/getting-started.md` | modify | Generalised primary wording |
| `backend/src/utils/agentDistribution.ts` | modify | Accept `AGENT_INSTALL_VERSION` 0.8.0 |
| `frontend/src/utils/agentEnrollment.ts` | modify | Same allowlist at the rendering boundary |
| `backend/__tests__/utils/agentDistribution.test.ts` | modify | Allowlist expectations include 0.8.0 |
| `frontend/__tests__/agentEnrollment.test.ts` | modify | Allowlist expectations include 0.8.0 |
| `.env.template`, `deploy/.env.example` | modify | Comment lists the accepted versions |
| `frontend/src/docs/articles/deployment/configuration.md`, `reference/configuration.md`, `remote-agent/enrollment.md`, `getting-started/complete-backup-setup.md` | modify | Accepted versions in the in-app guides |
| `docs/AGENT_ENROLLMENT_DISTRIBUTION.md`, `docs/ARCHITECTURE.md` | modify | Accepted versions in the repository docs |
| `docs/S3_AGENT_REPOSITORY_SERVER.md` | create | Final report |

---

### Task 1: Command secret sealing (sections 10.3 and 10.4)

**Files:**
- Create: `backend/src/utils/agentCommandSealing.ts`
- Test: `backend/__tests__/utils/agentCommandSealing.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export const AGENT_COMMAND_SECRETS_KID = 'pluton-agent-command-secrets-v1'`
  - `export const AGENT_COMMAND_SECRETS_ALG = 'A256GCM'`
  - `export type AgentCommandSecrets = { repositoryPassword: string; rclone: { pass?: string; access_key_id?: string; secret_access_key?: string } }`
  - `export type SealedAgentCommandSecrets = { alg: 'A256GCM'; kid: 'pluton-agent-command-secrets-v1'; nonce: string; ciphertext: string; tag: string }`
  - `export type AgentCommandSealingContext = { agentSecret: string; leaseToken: string }`
  - `export class AgentCommandSealingError extends Error`
  - `export function deriveAgentCommandSealingKey(agentSecret: string): Buffer`
  - `export function sealAgentCommandSecrets(agentSecret: string, commandId: string, leaseToken: string, secrets: AgentCommandSecrets, nonce?: Buffer): SealedAgentCommandSecrets`
  - `export function openAgentCommandSecrets(agentSecret: string, commandId: string, leaseToken: string, sealed: unknown): AgentCommandSecrets`

- [ ] **Step 1: Check the tree and create the branch**

```bash
git status --short
```

Expected: no output, or only `?? docs/superpowers/`. If the output contains ` M docs/S3_AGENT_REPOSITORY_DESIGN.md`, stop and ask the user to commit the section 10 wire contract on `claude/s3-agent-repository-design` first; do not discard it.

```bash
git fetch origin
git switch -c claude/s3-agent-repository-server --no-track origin/main
mkdir -p /c/laragon/www/pluton/tmp/t
```

Expected: `Switched to a new branch 'claude/s3-agent-repository-server'`.

- [ ] **Step 2: Write the failing test**

Create `backend/__tests__/utils/agentCommandSealing.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/utils/agentCommandSealing.test.ts
```

Expected: FAIL, `Cannot find module '../../src/utils/agentCommandSealing'`.

- [ ] **Step 4: Write the implementation**

Create `backend/src/utils/agentCommandSealing.ts`:

```ts
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
		Object.keys(secrets).sort().join(',') !== 'rclone,repositoryPassword' ||
		typeof secrets.repositoryPassword !== 'string' ||
		!secrets.repositoryPassword ||
		!rclone ||
		typeof rclone !== 'object' ||
		Array.isArray(rclone) ||
		Object.entries(rclone).some(
			([key, entry]) => !RCLONE_SECRET_KEYS.has(key) || typeof entry !== 'string' || !entry
		)
	)
		throw new AgentCommandSealingError();
	return parsed as AgentCommandSecrets;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/utils/agentCommandSealing.test.ts
```

Expected: PASS, `Tests:       7 passed, 7 total`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/utils/agentCommandSealing.ts backend/__tests__/utils/agentCommandSealing.test.ts
git diff --cached --check
git commit -m "feat(agent-s3): seal command secrets for payload version 5"
```

Expected: `git diff --cached --check` prints nothing; the commit succeeds.

---

### Task 2: Repository backend capabilities (section 10.1)

**Files:**
- Modify: `backend/src/services/AgentService.ts:66-69` (inventory `capabilities` object)
- Modify: `backend/src/types/agents.ts:32-34`
- Create: `backend/src/utils/agentS3Repository.ts`
- Test: `backend/__tests__/utils/agentS3Repository.test.ts` (create), `backend/__tests__/services/AgentService.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (in `backend/src/utils/agentS3Repository.ts`):
  - `export type AgentRepositoryBackend = 'sftp' | 's3'`
  - `export const AGENT_S3_UNSUPPORTED_MESSAGE = 'Remote agent does not support S3 repositories. Update the agent first.'`
  - `export function agentRepositoryBackends(capabilities: Record<string, unknown> | null | undefined): AgentRepositoryBackend[]`
  - `export function agentBackupPayloadVersion(capabilities: Record<string, unknown> | null | undefined): 4 | 5`
  - `export function agentSupportsS3Repository(capabilities: Record<string, unknown> | null | undefined): boolean`
  - `export function isAgentS3StorageType(type: string | null | undefined): type is 's3' | 's3compatible'`
- Produces (types): `AgentInventory['capabilities']` gains `repositoryBackends?: ('sftp' | 's3')[]` and `backupPayloadVersion?: 5`.

- [ ] **Step 1: Write the failing tests**

Create `backend/__tests__/utils/agentS3Repository.test.ts`:

```ts
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
```

Append to `backend/__tests__/services/AgentService.test.ts`, immediately before the file's last line `});`:

```ts
	it('accepts the S3 repository capability fields of section 10.1 and refuses any other shape', async () => {
		const s3Capable = {
			...inventory,
			agentVersion: '0.8.0',
			capabilities: {
				...inventory.capabilities,
				repositoryBackends: ['sftp', 's3'],
				backupPayloadVersion: 5,
			},
		};
		await service.heartbeat(agent.agentId, s3Capable);
		expect(store.updateHeartbeat).toHaveBeenCalledWith(agent.agentId, s3Capable);
		const sftpOnly = {
			...inventory,
			capabilities: { ...inventory.capabilities, repositoryBackends: ['sftp'] },
		};
		await service.heartbeat(agent.agentId, sftpOnly);
		expect(store.updateHeartbeat).toHaveBeenLastCalledWith(agent.agentId, sftpOnly);
		for (const capabilities of [
			{ repositoryBackends: ['s3'] },
			{ repositoryBackends: [] },
			{ repositoryBackends: ['sftp', 'sftp'] },
			{ repositoryBackends: ['sftp', 's3', 's3'] },
			{ repositoryBackends: ['sftp', 'ftp'] },
			{ backupPayloadVersion: 4 },
			{ backupPayloadVersion: 6 },
			{ backupPayloadVersion: '5' },
		]) {
			await expect(
				service.heartbeat(agent.agentId, {
					...inventory,
					capabilities: { ...inventory.capabilities, ...capabilities },
				})
			).rejects.toThrow('Agent inventory is invalid.');
		}
	});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/utils/agentS3Repository.test.ts __tests__/services/AgentService.test.ts
```

Expected: FAIL. `agentS3Repository.test.ts`: `Cannot find module '../../src/utils/agentS3Repository'`. `AgentService.test.ts`: the new test fails with `Agent inventory is invalid.` on the first heartbeat (the strict schema refuses the unknown keys); the other 45 tests pass.

- [ ] **Step 3: Write the implementation**

In `backend/src/services/AgentService.ts`, replace:

```ts
					sourceAccessVersion: z.literal(1).optional(),
					sourceAccessModesVersion: z.literal(1).optional(),
				})
				.strict(),
```

with:

```ts
					sourceAccessVersion: z.literal(1).optional(),
					sourceAccessModesVersion: z.literal(1).optional(),
					// docs/S3_AGENT_REPOSITORY_DESIGN.md 10.1. Omitted means ['sftp'] and payload version 4.
					repositoryBackends: z
						.array(z.enum(['sftp', 's3']))
						.min(1)
						.max(2)
						.refine(
							backends => new Set(backends).size === backends.length && backends.includes('sftp')
						)
						.optional(),
					backupPayloadVersion: z.literal(5).optional(),
				})
				.strict(),
```

In `backend/src/types/agents.ts`, replace:

```ts
		sourceAccessVersion?: 1;
		sourceAccessModesVersion?: 1;
	};
```

with:

```ts
		sourceAccessVersion?: 1;
		sourceAccessModesVersion?: 1;
		repositoryBackends?: ('sftp' | 's3')[];
		backupPayloadVersion?: 5;
	};
```

Create `backend/src/utils/agentS3Repository.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/utils/agentS3Repository.test.ts __tests__/services/AgentService.test.ts
```

Expected: PASS, `Tests:       49 passed, 49 total` (3 new helper tests, 45 existing plus 1 new AgentService tests).

- [ ] **Step 5: Type-check**

```bash
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
```

Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/AgentService.ts backend/src/types/agents.ts backend/src/utils/agentS3Repository.ts backend/__tests__/utils/agentS3Repository.test.ts backend/__tests__/services/AgentService.test.ts
git diff --cached --check
git commit -m "feat(agent-s3): accept repository backend capabilities from the Agent"
```

---

### Task 3: Agent S3 options and prefix overlap

**Files:**
- Modify: `backend/src/utils/storageSecurity.ts:57-59` (`decryptStorageCredentials` signature)
- Modify: `backend/src/utils/agentS3Repository.ts` (prepend imports, append code)
- Test: `backend/__tests__/utils/agentS3Repository.test.ts` (append), `backend/__tests__/utils/storageSecurity.test.ts` (append)

**Interfaces:**
- Consumes: `isAgentS3StorageType` (Task 2); `storageRcloneOptions(storage, plaintext?)`, `validateHcpConfiguration(credentials, settings)`, `isHcpMode(settings)` from `storageSecurity.ts`; `providers` from `utils/providers.ts`.
- Produces:
  - `export function decryptStorageCredentials(storage: StorageConfiguration, secret?: string): Record<string, string>` (default secret unchanged)
  - `export const AGENT_S3_PLAIN_OPTION_KEYS: readonly string[]`
  - `export type AgentS3Secrets = { access_key_id: string; secret_access_key: string }`
  - `export type AgentS3OptionRule = 'unsupported-field' | 'unsafe-control-character' | 'value-too-long'`
  - `export class AgentS3OptionError extends AppError { readonly field: string; readonly rule: AgentS3OptionRule }`
  - `export function agentS3RepositoryOptions(storage: Pick<Storage, 'type' | 'credentials' | 'settings'>, credentials: Record<string, string>): { options: Record<string, string>; secrets: AgentS3Secrets }`
  - `export function agentS3ScopesOverlap(a: { authority: string; prefix: string }, b: { authority: string; prefix: string }): boolean`
  - `export const AGENT_S3_REPLICATION_MESSAGE = 'Replication is not available for an S3 primary repository yet.'`
  - `export const AGENT_S3_OVERLAP_MESSAGE = 'The S3 repository prefix overlaps another plan or replica. Select a separate prefix.'`
  - `export const AGENT_S3_SCOPE_UNVERIFIED_MESSAGE = 'Another plan uses an S3 location that cannot be verified, so the S3 repository prefix cannot be checked for overlap.'`

- [ ] **Step 1: Write the failing tests**

In `backend/__tests__/utils/agentS3Repository.test.ts`, replace the import block at the top:

```ts
import {
	agentBackupPayloadVersion,
	agentRepositoryBackends,
	agentSupportsS3Repository,
	isAgentS3StorageType,
} from '../../src/utils/agentS3Repository';
```

with:

```ts
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
```

Append to the end of the same file:

```ts
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
```

Append to the end of `backend/__tests__/utils/storageSecurity.test.ts`:

```ts
describe('decryptStorageCredentials with an explicit secret', () => {
	it('uses the supplied application secret instead of the configured one', () => {
		const other = new Cryptr('synthetic-other-secret-0123456789');
		const storage = {
			type: 's3compatible',
			credentials: { access_key_id: other.encrypt('synthetic-access') },
			settings: {},
		} as any;
		expect(decryptStorageCredentials(storage, 'synthetic-other-secret-0123456789')).toEqual({
			access_key_id: 'synthetic-access',
		});
		expect(() => decryptStorageCredentials(storage)).toThrow(
			'Storage credentials could not be decrypted.'
		);
	});
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/utils/agentS3Repository.test.ts __tests__/utils/storageSecurity.test.ts
```

Expected: FAIL. The new option and overlap tests fail with `agentS3RepositoryOptions is not a function` / `agentS3ScopesOverlap is not a function`; the explicit-secret test fails because the configured secret is used (`Storage credentials could not be decrypted.` thrown on the first call).

- [ ] **Step 3: Write the implementation**

In `backend/src/utils/storageSecurity.ts`, replace:

```ts
/** Server-only. Never return this projection through an API or Agent message. */
export function decryptStorageCredentials(storage: StorageConfiguration): Record<string, string> {
	const cryptr = new Cryptr(configService.config.SECRET as string);
```

with:

```ts
/** Server-only. Never return this projection through an API or Agent message.
 * `secret` lets a service with an injected application secret (RemoteBackupService)
 * decrypt with the key it uses for its own records. */
export function decryptStorageCredentials(
	storage: StorageConfiguration,
	secret: string = configService.config.SECRET as string
): Record<string, string> {
	const cryptr = new Cryptr(secret);
```

In `backend/src/utils/agentS3Repository.ts`, insert at the top of the file, above the existing `/**` comment:

```ts
import type { Storage } from '../db/schema/storages';
import { AppError } from './AppError';
import { providers } from './providers';
import { isHcpMode, storageRcloneOptions, validateHcpConfiguration } from './storageSecurity';

```

Append to the end of `backend/src/utils/agentS3Repository.ts`:

```ts
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
const MAX_OPTION_LENGTH = 16_384;
const AWS_ENDPOINT = /^(?:s3|s3[.-][a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/;

export type AgentS3Secrets = { access_key_id: string; secret_access_key: string };
export type AgentS3OptionRule = 'unsupported-field' | 'unsafe-control-character' | 'value-too-long';

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
		if (value.length > MAX_OPTION_LENGTH) throw new AgentS3OptionError(key, 'value-too-long');
		if (hasControl(value)) throw new AgentS3OptionError(key, 'unsafe-control-character');
	}
	return { options, secrets };
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/utils/agentS3Repository.test.ts __tests__/utils/storageSecurity.test.ts
```

Expected: PASS, `Tests:       43 passed, 43 total` (17 in `agentS3Repository.test.ts`, 26 in `storageSecurity.test.ts`).

- [ ] **Step 5: Type-check and lint**

```bash
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-backend lint
```

Expected: both exit 0; lint prints no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/utils/storageSecurity.ts backend/src/utils/agentS3Repository.ts backend/__tests__/utils/agentS3Repository.test.ts backend/__tests__/utils/storageSecurity.test.ts
git diff --cached --check
git commit -m "feat(agent-s3): project S3 storage onto the Agent option allowlist"
```

---

### Task 4: S3 primary eligibility in RemoteBackupService (section 6.1.1)

**Files:**
- Modify: `backend/src/services/remoteCommandPreparation.ts:15-21` (stage union), `:58-66` (messages)
- Modify: `backend/src/services/RemoteBackupService.ts:13` (imports), `:148-152` (helper after `hasEnabledScripts`), `:738-741` and `:799-804` (`assertSupportedPlan`), `:832` (new method after `getCapableAgent`)
- Test: `backend/__tests__/services/RemoteBackupService.test.ts` (constants after `capableAgent`, nested describe at the end)

**Interfaces:**
- Consumes: `AGENT_S3_UNSUPPORTED_MESSAGE`, `agentSupportsS3Repository`, `isAgentS3StorageType` (Task 2); `AGENT_S3_REPLICATION_MESSAGE`, `AGENT_S3_OVERLAP_MESSAGE`, `AGENT_S3_SCOPE_UNVERIFIED_MESSAGE`, `AgentS3OptionError`, `agentS3RepositoryOptions`, `agentS3ScopesOverlap`, `decryptStorageCredentials(storage, secret)` (Task 3); `canonicalS3RepositoryIdentity(storage, repositoryPath, plaintext)`, `s3RepositoryScope(storage, repositoryPath, plaintext)`, `isS3Storage(type)` from `storageSecurity.ts`.
- Produces:
  - Stages `'storage-lookup'`, `'repository-backend'`, `'s3-storage-validation'` in `RemoteCommandPreparationStage`.
  - `private async assertS3PrimaryEligible(plan: Plan | NewPlan, storage: Pick<Storage, 'id' | 'type' | 'credentials' | 'settings'>, setPreparationStage?: SetPreparationStage): Promise<void>`
  - New refusal text for other storage types: `'Remote filesystem backups require an SFTP or S3 destination.'`

- [ ] **Step 1: Write the failing tests**

In `backend/__tests__/services/RemoteBackupService.test.ts`, insert directly after the `capableAgent` constant (the block ending `} as any;` before `describe('RemoteBackupService', () => {`):

```ts
const s3AccessKey = 'SYNTHETICKEY01';
const s3SecretKey = 'synthetic-secret-key-01';
const s3Plan = { ...plan, storageId: 'storage-s3', storagePath: 'bucket-01/agents/app-01' } as any;
const s3Agent = {
	...capableAgent,
	agentVersion: '0.8.0',
	capabilities: {
		...capableAgent.capabilities,
		repositoryBackends: ['sftp', 's3'],
		backupPayloadVersion: 5,
	},
} as any;
const s3StorageRecord = (
	crypt: Cryptr,
	settings: Record<string, unknown> = { hcp_mode: true, endpoint: 'https://s3.example.internal' }
) => ({
	id: 'storage-s3',
	type: 's3compatible',
	settings,
	credentials: {
		bucket: crypt.encrypt('bucket-01'),
		access_key_id: crypt.encrypt(s3AccessKey),
		secret_access_key: crypt.encrypt(s3SecretKey),
	},
});
```

Insert immediately before the file's last line `});`:

```ts
	describe('S3 primary eligibility (S3_AGENT_REPOSITORY_DESIGN.md 6.1.1)', () => {
		let s3Storage: any;
		beforeEach(async () => {
			const crypt = new Cryptr(encryptionSecret);
			const sftpStorage = await storageStore.getById(plan.storageId);
			s3Storage = s3StorageRecord(crypt);
			storageStore.getById.mockImplementation(async (id: string) =>
				id === s3Plan.storageId ? s3Storage : sftpStorage
			);
			agentStore.getAgentByDeviceId.mockResolvedValue({ ...s3Agent, lastSeen: new Date() });
			planStore.getById.mockResolvedValue(s3Plan);
			const s3Repository = {
				id: 'remote-repo-example-01',
				planId: plan.id,
				agentId: capableAgent.agentId,
				storageId: s3Plan.storageId,
				storagePath: s3Plan.storagePath,
				encryptedPassword: crypt.encrypt(repositoryPassword),
				initializedAt: null,
			};
			repositories.getByPlanId.mockResolvedValue(s3Repository);
			repositories.getById.mockResolvedValue(s3Repository);
		});

		it('offers an S3 primary only to an Agent that reports s3 and payload version 5', async () => {
			await expect(service.validatePlanCreation(s3Plan)).resolves.toBeUndefined();
			for (const capabilities of [
				capableAgent.capabilities,
				{ ...capableAgent.capabilities, repositoryBackends: ['sftp', 's3'] },
				{ ...capableAgent.capabilities, repositoryBackends: ['sftp'], backupPayloadVersion: 5 },
			]) {
				agentStore.getAgentByDeviceId.mockResolvedValue({
					...s3Agent,
					capabilities,
					lastSeen: new Date(),
				});
				await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject({
					statusCode: 409,
					message: 'Remote agent does not support S3 repositories. Update the agent first.',
				});
			}
		});

		it('refuses to queue an S3 plan for an Agent without S3 support and stores no command', async () => {
			agentStore.getAgentByDeviceId.mockResolvedValue({ ...capableAgent, lastSeen: new Date() });
			await expect(service.queuePlanBackup(s3Plan.id)).rejects.toMatchObject({
				statusCode: 409,
				message: 'Remote agent does not support S3 repositories. Update the agent first.',
			});
			expect(repositories.createBackupAndCommand).not.toHaveBeenCalled();
			agentStore.getAgentByDeviceId.mockResolvedValue({ ...s3Agent, lastSeen: new Date() });
			await expect(service.queuePlanBackup(s3Plan.id)).resolves.toBe(
				'Remote filesystem backup queued.'
			);
			expect(repositories.createBackupAndCommand.mock.calls[0][0].command.payload).toEqual({
				backupId: expect.any(String),
				planId: s3Plan.id,
				repositoryId: 'remote-repo-example-01',
			});
		});

		it('applies the replication-destination HCP rules to the S3 storage', async () => {
			const crypt = new Cryptr(encryptionSecret);
			s3Storage = s3StorageRecord(crypt, { endpoint: 'https://s3.example.internal' });
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject({
				statusCode: 400,
				message: expect.stringContaining('HCP'),
			});
			s3Storage = s3StorageRecord(crypt, { hcp_mode: true, endpoint: 'http://s3.example.internal' });
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject({
				statusCode: 400,
				message: expect.stringContaining('HTTPS'),
			});
			s3Storage = s3StorageRecord(crypt, {
				hcp_mode: true,
				endpoint: 'https://s3.example.internal',
				env_auth: true,
			});
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject({ statusCode: 400 });
		});

		it('refuses the bucket root and a path outside the bucket', async () => {
			for (const storagePath of ['bucket-01', 'other-bucket/agents/app-01']) {
				await expect(service.validatePlanCreation({ ...s3Plan, storagePath })).rejects.toMatchObject({
					statusCode: 400,
					message: expect.stringContaining('bucket roots are forbidden'),
				});
			}
		});

		it('refuses a prefix that overlaps another plan primary or replica, and accepts a separate prefix', async () => {
			const overlap = {
				statusCode: 409,
				message: 'The S3 repository prefix overlaps another plan or replica. Select a separate prefix.',
			};
			planStore.getAll.mockResolvedValue([
				{ id: 'plan-other', storageId: 'storage-s3', storagePath: 'bucket-01/agents', settings: {} },
			]);
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject(overlap);
			planStore.getAll.mockResolvedValue([
				{
					id: 'plan-sftp',
					storageId: plan.storageId,
					storagePath: plan.storagePath,
					settings: {
						replication: {
							enabled: true,
							storages: [
								{
									replicationId: 'replica-01',
									storageId: 'storage-s3',
									storagePath: 'bucket-01/agents/app-01/mirror',
								},
							],
						},
					},
				},
			]);
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject(overlap);
			planStore.getAll.mockResolvedValue([
				{ id: s3Plan.id, storageId: 'storage-s3', storagePath: s3Plan.storagePath, settings: {} },
				{ id: 'plan-sibling', storageId: 'storage-s3', storagePath: 'bucket-01/agents/app-010', settings: {} },
			]);
			await expect(service.validatePlanCreation(s3Plan)).resolves.toBeUndefined();
			planStore.getAll.mockResolvedValue([
				{ id: 'plan-foreign', storageId: 'storage-s3', storagePath: 'other-bucket/data', settings: {} },
			]);
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject({
				statusCode: 409,
				message:
					'Another plan uses an S3 location that cannot be verified, so the S3 repository prefix cannot be checked for overlap.',
			});
		});

		it('refuses replication settings for an S3 primary before any replica validation', async () => {
			const replication = {
				validatePlan: jest.fn(async () => undefined),
				enqueueBackup: jest.fn(async () => undefined),
			};
			service.setReplicationService(replication);
			const replicated = {
				...s3Plan,
				settings: {
					...s3Plan.settings,
					replication: {
						enabled: true,
						concurrent: false,
						storages: [
							{
								replicationId: 'replica-01',
								storageId: 'mirror-01',
								storagePath: 'bucket-02/owned',
								storageType: 's3compatible',
								storageName: 'Mirror',
								addedAt: 1,
							},
						],
					},
				},
			};
			await expect(service.validatePlanCreation(replicated)).rejects.toMatchObject({
				statusCode: 400,
				message: 'Replication is not available for an S3 primary repository yet.',
			});
			await expect(
				service.validatePlanCreation({
					...replicated,
					settings: {
						...replicated.settings,
						replication: { ...replicated.settings.replication, enabled: false },
					},
				})
			).rejects.toMatchObject({ statusCode: 400 });
			expect(replication.validatePlan).not.toHaveBeenCalled();
			await expect(
				service.validatePlanCreation({
					...s3Plan,
					settings: {
						...s3Plan.settings,
						replication: { enabled: false, concurrent: false, storages: [] },
					},
				})
			).resolves.toBeUndefined();
		});

		it('names a rejected S3 setting in the preparation diagnostics without its value', async () => {
			s3Storage = s3StorageRecord(new Cryptr(encryptionSecret), {
				hcp_mode: true,
				endpoint: 'https://s3.example.internal',
				chunk_size: '64Mi',
			});
			await expect(service.validatePlanCreation(s3Plan)).rejects.toMatchObject({ statusCode: 400 });
			const error = await service
				.materializeCommand(capableAgent.agentId, backupCommand())
				.then(() => null)
				.catch(caught => caught);
			expect(error).toBeInstanceOf(RemoteCommandPreparationError);
			expect(error).toMatchObject({
				stage: 's3-storage-validation',
				rejectedField: 'chunk_size',
				ruleCategory: 'unsupported-field',
				storageId: s3Plan.storageId,
			});
			expect(JSON.stringify(error)).not.toContain('64Mi');
		});

		it('refuses a destination that is neither SFTP nor S3', async () => {
			storageStore.getById.mockResolvedValue({
				id: plan.storageId,
				type: 'local',
				settings: {},
				credentials: {},
			});
			await expect(service.validatePlanCreation(plan)).rejects.toMatchObject({
				statusCode: 400,
				message: 'Remote filesystem backups require an SFTP or S3 destination.',
			});
		});
	});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/services/RemoteBackupService.test.ts
```

Expected: FAIL. The 8 new tests fail (S3 storage is refused with `Remote filesystem backups currently require an SFTP destination.`); the 35 existing tests pass.

- [ ] **Step 3: Add the preparation stages**

In `backend/src/services/remoteCommandPreparation.ts`, replace:

```ts
	| 'agent-capability'
	| 'sftp-storage-lookup'
```

with:

```ts
	| 'agent-capability'
	| 'storage-lookup'
	| 'repository-backend'
	| 'sftp-storage-lookup'
```

Replace:

```ts
	| 'sftp-required-credentials'
	| 'repository-secret-decryption'
```

with:

```ts
	| 'sftp-required-credentials'
	| 's3-storage-validation'
	| 'repository-secret-decryption'
```

Replace:

```ts
		'agent-capability': 'The remote agent no longer supports filesystem backup.',
```

with:

```ts
		'agent-capability': 'The remote agent no longer supports filesystem backup.',
		'storage-lookup': 'The remote backup destination could not be loaded.',
		'repository-backend':
			'The remote backup destination is not available to this agent or overlaps another repository.',
```

Replace:

```ts
		'sftp-required-credentials':
			'Remote filesystem backups require SFTP host, username, and password credentials.',
```

with:

```ts
		'sftp-required-credentials':
			'Remote filesystem backups require SFTP host, username, and password credentials.',
		's3-storage-validation': 'Remote S3 settings are not supported for filesystem backup.',
```

- [ ] **Step 4: Add the eligibility checks**

In `backend/src/services/RemoteBackupService.ts`, replace:

```ts
import { StorageStore } from '../stores/StorageStore';
```

with:

```ts
import { StorageStore } from '../stores/StorageStore';
import type { Storage } from '../db/schema/storages';
import {
	canonicalS3RepositoryIdentity,
	decryptStorageCredentials,
	isS3Storage,
	s3RepositoryScope,
} from '../utils/storageSecurity';
import {
	AGENT_S3_OVERLAP_MESSAGE,
	AGENT_S3_REPLICATION_MESSAGE,
	AGENT_S3_SCOPE_UNVERIFIED_MESSAGE,
	AGENT_S3_UNSUPPORTED_MESSAGE,
	AgentS3OptionError,
	agentS3RepositoryOptions,
	agentS3ScopesOverlap,
	agentSupportsS3Repository,
	isAgentS3StorageType,
} from '../utils/agentS3Repository';
```

Replace:

```ts
function hasEnabledScripts(plan: Pick<Plan | NewPlan, 'settings'>): boolean {
	return Object.values(plan.settings?.scripts || {}).some(
		items => Array.isArray(items) && items.length > 0
	);
}
```

with:

```ts
function hasEnabledScripts(plan: Pick<Plan | NewPlan, 'settings'>): boolean {
	return Object.values(plan.settings?.scripts || {}).some(
		items => Array.isArray(items) && items.length > 0
	);
}

/** Stage 1 has no replication from an S3 primary; listed but disabled replicas are refused too. */
function hasReplicationSettings(plan: Pick<Plan | NewPlan, 'settings'>): boolean {
	const replication = plan.settings?.replication;
	return Boolean(replication?.enabled || replication?.storages?.length);
}
```

In `assertSupportedPlan`, replace:

```ts
		if (hasEnabledScripts(plan)) {
			throw new AppError(400, 'Scripts are not available for remote filesystem backups.');
		}
		if (plan.settings.replication?.enabled) {
```

with:

```ts
		if (hasEnabledScripts(plan)) {
			throw new AppError(400, 'Scripts are not available for remote filesystem backups.');
		}
		// The primary storage type decides the repository backend (S3_AGENT_REPOSITORY_DESIGN.md 6.1.1).
		setPreparationStage?.('storage-lookup');
		const storage = await this.storageStore.getById(plan.storageId as string);
		const s3Primary = Boolean(storage && isAgentS3StorageType(storage.type));
		if (s3Primary && hasReplicationSettings(plan)) {
			setPreparationStage?.('repository-backend');
			throw new AppError(400, AGENT_S3_REPLICATION_MESSAGE);
		}
		setPreparationStage?.('plan-shape');
		if (plan.settings.replication?.enabled) {
```

Replace the end of `assertSupportedPlan`:

```ts
		setPreparationStage?.('sftp-storage-lookup');
		const storage = await this.storageStore.getById(plan.storageId as string);
		if (!storage || storage.type !== 'sftp') {
			throw new AppError(400, 'Remote filesystem backups currently require an SFTP destination.');
		}
	}
```

with:

```ts
		if (s3Primary) {
			setPreparationStage?.('repository-backend');
			if (!agentSupportsS3Repository(sourceAgent.capabilities))
				throw new AppError(409, AGENT_S3_UNSUPPORTED_MESSAGE);
			await this.assertS3PrimaryEligible(plan, storage!, setPreparationStage);
			return;
		}
		setPreparationStage?.('sftp-storage-lookup');
		if (!storage || storage.type !== 'sftp') {
			throw new AppError(400, 'Remote filesystem backups require an SFTP or S3 destination.');
		}
	}
```

Insert this method directly after the closing `}` of `getCapableAgent` (before `private getSingleSource(`):

```ts
	/**
	 * docs/S3_AGENT_REPOSITORY_DESIGN.md 6.1.1: the replication-destination HCP rules, a
	 * prefix inside the bucket, and no overlap with another plan's primary or replica
	 * (disabled replicas still own their prefix). PlanStore re-checks registered replica
	 * destinations inside its write transaction; the Agent refuses a non-empty prefix.
	 */
	private async assertS3PrimaryEligible(
		plan: Plan | NewPlan,
		storage: Pick<Storage, 'id' | 'type' | 'credentials' | 'settings'>,
		setPreparationStage?: SetPreparationStage
	): Promise<void> {
		const credentials = decryptStorageCredentials(storage, this.encryptionSecret);
		try {
			agentS3RepositoryOptions(storage, credentials);
		} catch (error) {
			if (error instanceof AgentS3OptionError)
				setPreparationStage?.('s3-storage-validation', {
					rejectedField: error.field,
					ruleCategory: error.rule,
				});
			throw error;
		}
		const identity = canonicalS3RepositoryIdentity(storage, plan.storagePath || '', credentials);
		for (const other of (await this.planStore.getAll(false)) || []) {
			if (other.id === plan.id) continue;
			const references = [
				{ storageId: other.storageId, storagePath: other.storagePath },
				...(other.settings?.replication?.storages || []),
			];
			for (const reference of references) {
				if (!reference.storageId) continue;
				const candidate =
					reference.storageId === storage.id
						? storage
						: await this.storageStore.getById(reference.storageId);
				if (!candidate || !isS3Storage(candidate.type)) continue;
				let scope: { authority: string; prefix: string };
				try {
					scope = s3RepositoryScope(
						candidate,
						reference.storagePath,
						decryptStorageCredentials(candidate, this.encryptionSecret)
					);
				} catch {
					throw new AppError(409, AGENT_S3_SCOPE_UNVERIFIED_MESSAGE);
				}
				if (agentS3ScopesOverlap(identity, scope)) throw new AppError(409, AGENT_S3_OVERLAP_MESSAGE);
			}
		}
	}
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/services/RemoteBackupService.test.ts __tests__/services/AgentService.test.ts
```

Expected: PASS, `Tests:       89 passed, 89 total` (43 RemoteBackupService, 46 AgentService).

- [ ] **Step 6: Type-check and lint**

```bash
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-backend lint
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/remoteCommandPreparation.ts backend/src/services/RemoteBackupService.ts backend/__tests__/services/RemoteBackupService.test.ts
git diff --cached --check
git commit -m "feat(agent-s3): allow an S3 primary for Agents that report S3 support"
```

---

### Task 5: Payload version 5 with sealed secrets (sections 6.1.2 and 10.2)

**Files:**
- Modify: `backend/src/services/remoteCommandPreparation.ts:24-25` (stage), `:71` (message)
- Modify: `backend/src/services/RemoteBackupService.ts` imports (the `agentS3Repository` block from Task 4), `:55` (new type after `CommandReference`), `:358-362` (signature), `:413` (storage lookup), `:472-488` (payload), new method before `materializeSftpStorage`
- Test: `backend/__tests__/services/RemoteBackupService.test.ts` (import, nested describe at the end)

**Interfaces:**
- Consumes: `sealAgentCommandSecrets`, `AgentCommandSealingContext`, `AgentCommandSecrets` (Task 1); `agentBackupPayloadVersion` (Task 2); `agentS3RepositoryOptions`, `AgentS3Secrets`, `AgentS3OptionError` (Task 3); `decryptStorageCredentials(storage, secret)` (Task 3).
- Produces:
  - Stage `'payload-sealing'`.
  - `async materializeCommand(agentId: string, command: AgentCommand, sealing?: AgentCommandSealingContext): Promise<Record<string, unknown>>`
  - `type RepositoryTarget = { type: 'sftp'; options: Record<string, string> } | { type: 's3'; options: Record<string, string>; secrets: AgentS3Secrets }` (module-private)
  - `private async materializeRepositoryStorage(storageId: string, setPreparationStage?: SetPreparationStage): Promise<RepositoryTarget>`

- [ ] **Step 1: Write the failing tests**

In `backend/__tests__/services/RemoteBackupService.test.ts`, replace:

```ts
import type { AgentCommand } from '../../src/db/schema/agents';
```

with:

```ts
import type { AgentCommand } from '../../src/db/schema/agents';
import {
	AgentCommandSealingError,
	openAgentCommandSecrets,
} from '../../src/utils/agentCommandSealing';
```

Insert immediately before the file's last line `});`:

```ts
	describe('Payload version 5 (S3_AGENT_REPOSITORY_DESIGN.md 10.2 and 10.3)', () => {
		const sealing = {
			agentSecret: 'synthetic-agent-secret-0123456789abcdef',
			leaseToken: '0123456789abcdef0123456789abcdef0123456789abcdef',
		};
		beforeEach(async () => {
			const sftpStorage = await storageStore.getById(plan.storageId);
			const s3Storage = s3StorageRecord(new Cryptr(encryptionSecret));
			storageStore.getById.mockImplementation(async (id: string) =>
				id === s3Plan.storageId ? s3Storage : sftpStorage
			);
			agentStore.getAgentByDeviceId.mockResolvedValue({ ...s3Agent, lastSeen: new Date() });
		});
		const useS3Plan = () => {
			const s3Repository = {
				id: 'remote-repo-example-01',
				planId: plan.id,
				agentId: capableAgent.agentId,
				storageId: s3Plan.storageId,
				storagePath: s3Plan.storagePath,
				encryptedPassword: new Cryptr(encryptionSecret).encrypt(repositoryPassword),
				initializedAt: null,
			};
			planStore.getById.mockResolvedValue(s3Plan);
			repositories.getById.mockResolvedValue(s3Repository);
			repositories.getByPlanId.mockResolvedValue(s3Repository);
		};

		it('sends an S3 Agent version 5 with only allowlisted plain options and every secret sealed', async () => {
			useS3Plan();
			const command = backupCommand();
			const payload: any = await service.materializeCommand(capableAgent.agentId, command, sealing);
			expect(payload).toEqual({
				version: 5,
				sourceDiagnosticsVersion: 1,
				backupId: 'backup-example-01',
				planId: plan.id,
				sourcePath: '/srv/example-app',
				excludes: [],
				repository: { remoteName: 'pluton', path: 'bucket-01/agents/app-01', initialize: true },
				rclone: {
					type: 's3',
					options: {
						provider: 'Other',
						endpoint: 'https://s3.example.internal',
						force_path_style: 'true',
						use_accept_encoding_gzip: 'false',
						no_check_bucket: 'true',
					},
				},
				sealed: {
					alg: 'A256GCM',
					kid: 'pluton-agent-command-secrets-v1',
					nonce: expect.any(String),
					ciphertext: expect.any(String),
					tag: expect.any(String),
				},
			});
			const serialized = JSON.stringify(payload);
			for (const value of [repositoryPassword, s3AccessKey, s3SecretKey, encryptionSecret])
				expect(serialized).not.toContain(value);
			expect(
				openAgentCommandSecrets(sealing.agentSecret, command.id, sealing.leaseToken, payload.sealed)
			).toEqual({
				repositoryPassword,
				rclone: { access_key_id: s3AccessKey, secret_access_key: s3SecretKey },
			});
			expect(() =>
				openAgentCommandSecrets(sealing.agentSecret, command.id, 'a'.repeat(32), payload.sealed)
			).toThrow(AgentCommandSealingError);
			expect(() =>
				openAgentCommandSecrets(sealing.agentSecret, 'remote-backup-other', sealing.leaseToken, payload.sealed)
			).toThrow(AgentCommandSealingError);
		});

		it('seals the SFTP password for a version 5 Agent and keeps host, port and user plain', async () => {
			const command = backupCommand();
			const payload: any = await service.materializeCommand(capableAgent.agentId, command, sealing);
			expect(payload.version).toBe(5);
			expect(payload.rclone).toEqual({
				type: 'sftp',
				options: { host: 'sftp.example.internal', port: '22', user: 'backup-user' },
			});
			expect(payload).not.toHaveProperty('repositoryPassword');
			expect(JSON.stringify(payload)).not.toContain(storagePassword);
			expect(
				openAgentCommandSecrets(sealing.agentSecret, command.id, sealing.leaseToken, payload.sealed)
			).toEqual({ repositoryPassword, rclone: { pass: storagePassword } });
		});

		it('keeps payload versions 1 to 4 unchanged for an Agent without version 5', async () => {
			agentStore.getAgentByDeviceId.mockResolvedValue({
				...capableAgent,
				capabilities: { ...capableAgent.capabilities, repositoryBackends: ['sftp'] },
				lastSeen: new Date(),
			});
			const payload: any = await service.materializeCommand(
				capableAgent.agentId,
				backupCommand(),
				sealing
			);
			expect(payload.version).toBe(1);
			expect(payload.repositoryPassword).toBe(repositoryPassword);
			expect(payload.rclone).toEqual({
				type: 'sftp',
				options: {
					host: 'sftp.example.internal',
					port: '22',
					user: 'backup-user',
					pass: storagePassword,
				},
			});
			expect(payload).not.toHaveProperty('sealed');
		});

		it('refuses to build version 5 without the lease sealing context', async () => {
			const error = await service
				.materializeCommand(capableAgent.agentId, backupCommand())
				.then(() => null)
				.catch(caught => caught);
			expect(error).toBeInstanceOf(RemoteCommandPreparationError);
			expect(error).toMatchObject({
				stage: 'payload-sealing',
				safeMessage: 'Remote backup secrets could not be sealed for the agent.',
			});
		});

		it('fails a queued S3 command closed when the Agent no longer reports S3 at poll time', async () => {
			useS3Plan();
			agentStore.getAgentByDeviceId.mockResolvedValue({ ...capableAgent, lastSeen: new Date() });
			const error = await service
				.materializeCommand(capableAgent.agentId, backupCommand(), sealing)
				.then(() => null)
				.catch(caught => caught);
			expect(error).toBeInstanceOf(RemoteCommandPreparationError);
			expect(error).toMatchObject({
				stage: 'repository-backend',
				message: 'Remote agent does not support S3 repositories. Update the agent first.',
			});
		});

		it('records an S3 primary snapshot exactly like an SFTP one and never queues replication', async () => {
			useS3Plan();
			planStore.update = jest.fn();
			const replication = {
				validatePlan: jest.fn(async () => undefined),
				enqueueBackup: jest.fn(async () => undefined),
			};
			service.setReplicationService(replication);
			const id = 'b'.repeat(64);
			const summary = { message_type: 'summary', snapshot_id: id, total_bytes_processed: 2048 } as any;
			await service.completeCommand(backupCommand(), {
				success: true,
				result: { snapshotId: id, summary },
			});
			expect((service as any).eventService.onBackupComplete).toHaveBeenCalledWith(
				expect.objectContaining({ success: true, summary })
			);
			expect(repositories.markInitialized).toHaveBeenCalledWith('remote-repo-example-01');
			expect(planStore.update).toHaveBeenCalledWith(
				plan.id,
				expect.objectContaining({ stats: { size: 2048, snapshots: [id] } })
			);
			expect(replication.enqueueBackup).not.toHaveBeenCalled();
		});
	});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/services/RemoteBackupService.test.ts
```

Expected: FAIL in three of the six new tests: the S3 test (`Remote filesystem backups currently require an SFTP destination.` from `materializeSftpStorage`), the SFTP version 5 test (`version` is `1`) and the missing-sealing test (no error is thrown, so `null` is not a `RemoteCommandPreparationError`). Three new tests already pass because they guard behaviour that exists after Task 4 or never changes: version 1 to 4 unchanged, the poll-time 409 (raised by `assertSupportedPlan`) and completion. All 43 earlier tests pass.

- [ ] **Step 3: Write the implementation**

In `backend/src/services/remoteCommandPreparation.ts`, replace:

```ts
	| 'payload'
	| 'materializer-unavailable'
```

with:

```ts
	| 'payload'
	| 'payload-sealing'
	| 'materializer-unavailable'
```

Replace:

```ts
		'payload': 'The remote backup command payload could not be prepared.',
```

with:

```ts
		'payload': 'The remote backup command payload could not be prepared.',
		'payload-sealing': 'Remote backup secrets could not be sealed for the agent.',
```

In `backend/src/services/RemoteBackupService.ts`, replace the import block added in Task 4:

```ts
import {
	AGENT_S3_OVERLAP_MESSAGE,
	AGENT_S3_REPLICATION_MESSAGE,
	AGENT_S3_SCOPE_UNVERIFIED_MESSAGE,
	AGENT_S3_UNSUPPORTED_MESSAGE,
	AgentS3OptionError,
	agentS3RepositoryOptions,
	agentS3ScopesOverlap,
	agentSupportsS3Repository,
	isAgentS3StorageType,
} from '../utils/agentS3Repository';
```

with:

```ts
import {
	AGENT_S3_OVERLAP_MESSAGE,
	AGENT_S3_REPLICATION_MESSAGE,
	AGENT_S3_SCOPE_UNVERIFIED_MESSAGE,
	AGENT_S3_UNSUPPORTED_MESSAGE,
	AgentS3OptionError,
	agentBackupPayloadVersion,
	agentS3RepositoryOptions,
	agentS3ScopesOverlap,
	agentSupportsS3Repository,
	isAgentS3StorageType,
	type AgentS3Secrets,
} from '../utils/agentS3Repository';
import {
	sealAgentCommandSecrets,
	type AgentCommandSealingContext,
	type AgentCommandSecrets,
} from '../utils/agentCommandSealing';
```

Replace:

```ts
type CommandReference = { backupId: string; planId: string; repositoryId: string };
```

with:

```ts
type CommandReference = { backupId: string; planId: string; repositoryId: string };

/** A materialized primary repository. S3 keys stay apart from the plain options so that
 * payload version 5 can seal them (docs/S3_AGENT_REPOSITORY_DESIGN.md 10.2). */
type RepositoryTarget =
	| { type: 'sftp'; options: Record<string, string> }
	| { type: 's3'; options: Record<string, string>; secrets: AgentS3Secrets };
```

Replace:

```ts
	/** Called during authenticated poll; returned data is never persisted in agent_commands. */
	async materializeCommand(
		agentId: string,
		command: AgentCommand
	): Promise<Record<string, unknown>> {
```

with:

```ts
	/**
	 * Called during authenticated poll; returned data is never persisted in agent_commands.
	 * `sealing` carries the per-Agent secret and this lease's token; payload version 5 seals
	 * every secret with them (docs/S3_AGENT_REPOSITORY_DESIGN.md 10.3).
	 */
	async materializeCommand(
		agentId: string,
		command: AgentCommand,
		sealing?: AgentCommandSealingContext
	): Promise<Record<string, unknown>> {
```

Replace:

```ts
			const storage = await this.materializeSftpStorage(repository.storageId, setStage);
```

with:

```ts
			const target = await this.materializeRepositoryStorage(repository.storageId, setStage);
```

Replace:

```ts
			setStage('payload');
			return {
				version: excludes.length ? 4 : lifecycle ? (lifecycle.version === 2 ? 3 : 2) : 1,
				...(supportsSourceDiagnostics(agent.agentVersion) ? { sourceDiagnosticsVersion: 1 } : {}),
				...(lifecycle ? { lifecycle } : {}),
				backupId: backup.id,
				planId: plan.id,
				sourcePath: source,
				excludes,
				repository: {
					remoteName: 'pluton',
					path: repository.storagePath,
					initialize: !repository.initializedAt,
				},
				rclone: storage,
				repositoryPassword,
			};
```

with:

```ts
			setStage('payload');
			// Shared by every version. sourceDiagnosticsVersion is sent exactly as today and is part
			// of version 5 (section 10.2); the payload carries no trust or CA setting (6.1 point 2).
			const common = {
				...(supportsSourceDiagnostics(agent.agentVersion) ? { sourceDiagnosticsVersion: 1 } : {}),
				...(lifecycle ? { lifecycle } : {}),
				backupId: backup.id,
				planId: plan.id,
				sourcePath: source,
				excludes,
				repository: {
					remoteName: 'pluton',
					path: repository.storagePath,
					initialize: !repository.initializedAt,
				},
			};
			if (agentBackupPayloadVersion(agent.capabilities) !== 5) {
				// Versions 1 to 4 are unchanged and SFTP-only (section 10.2).
				if (target.type !== 'sftp') {
					setStage('repository-backend');
					throw new AppError(409, AGENT_S3_UNSUPPORTED_MESSAGE);
				}
				return {
					version: excludes.length ? 4 : lifecycle ? (lifecycle.version === 2 ? 3 : 2) : 1,
					...common,
					rclone: target,
					repositoryPassword,
				};
			}
			setStage('payload-sealing');
			if (!sealing) throw new AppError(500, 'Remote backup secrets could not be sealed.');
			let plainOptions: Record<string, string>;
			let secrets: AgentCommandSecrets;
			if (target.type === 's3') {
				plainOptions = target.options;
				secrets = {
					repositoryPassword,
					rclone: {
						access_key_id: target.secrets.access_key_id,
						secret_access_key: target.secrets.secret_access_key,
					},
				};
			} else {
				const { pass, ...sftpOptions } = target.options;
				plainOptions = sftpOptions;
				secrets = { repositoryPassword, rclone: { pass } };
			}
			return {
				version: 5,
				...common,
				rclone: { type: target.type, options: plainOptions },
				sealed: sealAgentCommandSecrets(
					sealing.agentSecret,
					command.id,
					sealing.leaseToken,
					secrets
				),
			};
```

Insert this method directly before `	private async materializeSftpStorage(`:

```ts
	/** SFTP storage keeps the existing allowlist; S3 storage uses the section 10.2 projection. */
	private async materializeRepositoryStorage(
		storageId: string,
		setPreparationStage?: SetPreparationStage
	): Promise<RepositoryTarget> {
		setPreparationStage?.('storage-lookup');
		const storage = await this.storageStore.getById(storageId);
		if (!storage || !isAgentS3StorageType(storage.type))
			return this.materializeSftpStorage(storageId, setPreparationStage);
		setPreparationStage?.('s3-storage-validation');
		let credentials: Record<string, string>;
		try {
			credentials = decryptStorageCredentials(storage, this.encryptionSecret);
		} catch {
			throw new AppError(500, 'Storage credentials could not be prepared for the remote agent.');
		}
		try {
			const { options, secrets } = agentS3RepositoryOptions(storage, credentials);
			return { type: 's3', options, secrets };
		} catch (error) {
			if (error instanceof AgentS3OptionError)
				setPreparationStage?.('s3-storage-validation', {
					rejectedField: error.field,
					ruleCategory: error.rule,
				});
			throw error;
		}
	}

```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/services/RemoteBackupService.test.ts __tests__/services/NotificationLifecycle.test.ts
```

Expected: PASS; `RemoteBackupService.test.ts` reports 49 tests, all passed, and `NotificationLifecycle.test.ts` passes unchanged.

- [ ] **Step 5: Type-check and lint**

```bash
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-backend lint
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/remoteCommandPreparation.ts backend/src/services/RemoteBackupService.ts backend/__tests__/services/RemoteBackupService.test.ts
git diff --cached --check
git commit -m "feat(agent-s3): send payload version 5 with sealed repository secrets"
```

---

### Task 6: Seal with the lease being delivered (AgentService.poll)

**Files:**
- Modify: `backend/src/services/AgentService.ts:469`
- Test: `backend/__tests__/services/AgentService.test.ts:5` (import), `:241-244` (existing assertion gains the third argument), new test at the end

**Interfaces:**
- Consumes: `materializeCommand(agentId, command, sealing?: AgentCommandSealingContext)` (Task 5); `signAgentCommand(secret, timestamp, command, leaseToken)` from `utils/agentProtocol.ts`.
- Produces: `poll` calls `materializeCommand(agent.agentId, command, { agentSecret: agent.secret, leaseToken })`; the existing signature then covers `sealed`.

- [ ] **Step 1: Write the failing tests**

In `backend/__tests__/services/AgentService.test.ts`, replace:

```ts
import { signAgentRequest } from '../../src/utils/agentProtocol';
```

with:

```ts
import { signAgentCommand, signAgentRequest } from '../../src/utils/agentProtocol';
```

In the existing test `materializes BACKUP_FILESYSTEM credentials only for the signed leased response`, replace:

```ts
		expect(remoteBackupService.materializeCommand).toHaveBeenCalledWith(
			agent.agentId,
			expect.objectContaining({ id: 'command-backup-01', payload: persistedPayload })
		);
```

with (the same two expected arguments plus the new third one; nothing removed):

```ts
		expect(remoteBackupService.materializeCommand).toHaveBeenCalledWith(
			agent.agentId,
			expect.objectContaining({ id: 'command-backup-01', payload: persistedPayload }),
			{ agentSecret: secret, leaseToken: result.command?.leaseToken }
		);
```

Insert immediately before the file's last line `});`:

```ts
	it('seals with the per-Agent secret and this lease, and signs the payload that contains sealed', async () => {
		const sealedPayload = {
			version: 5,
			backupId: 'backup-05',
			planId: 'plan-05',
			sourcePath: '/srv/example-app',
			excludes: [],
			repository: { remoteName: 'pluton', path: 'bucket-01/agents/app-01', initialize: true },
			rclone: {
				type: 's3',
				options: {
					provider: 'Other',
					endpoint: 'https://s3.example.internal',
					force_path_style: 'true',
					use_accept_encoding_gzip: 'false',
					no_check_bucket: 'true',
				},
			},
			sealed: {
				alg: 'A256GCM',
				kid: 'pluton-agent-command-secrets-v1',
				nonce: 'AAECAwQFBgcICQoL',
				ciphertext: 'c3ludGhldGljLWNpcGhlcnRleHQ=',
				tag: 'pUKJ+stiEzlyVi8BFN6biQ==',
			},
		};
		const remoteBackupService = {
			materializeCommand: jest.fn().mockResolvedValue(sealedPayload),
			completeCommand: jest.fn(),
		};
		service = new AgentService(
			store,
			'agent-service-test-secret-that-is-long-enough',
			() => now,
			remoteBackupService as any
		);
		store.leaseNext.mockImplementation(
			async (_agentId, leaseToken) =>
				({
					id: 'command-backup-05',
					type: 'BACKUP_FILESYSTEM',
					payload: { backupId: 'backup-05', planId: 'plan-05', repositoryId: 'repo-05' },
					idempotencyKey: 'idem-backup-05',
					leaseOwner: leaseToken,
					leaseExpiresAt: new Date(now.getTime() + 60_000),
					lastEventSequence: 0,
				}) as any
		);
		const result = await service.poll({ agentId: agent.agentId, deviceId: agent.deviceId, secret });
		const delivered = result.command!;
		expect(remoteBackupService.materializeCommand).toHaveBeenCalledWith(
			agent.agentId,
			expect.objectContaining({ id: 'command-backup-05' }),
			{ agentSecret: secret, leaseToken: delivered.leaseToken }
		);
		expect(delivered.payload).toEqual(sealedPayload);
		expect(delivered.signature).toBe(
			signAgentCommand(secret, delivered.signatureTimestamp, delivered, delivered.leaseToken)
		);
		const { sealed: _sealed, ...unsealed } = sealedPayload;
		expect(
			signAgentCommand(
				secret,
				delivered.signatureTimestamp,
				{ ...delivered, payload: unsealed },
				delivered.leaseToken
			)
		).not.toBe(delivered.signature);
	});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/services/AgentService.test.ts
```

Expected: FAIL in two tests, both with `toHaveBeenCalledWith` showing the received call has 2 arguments and the expected call has 3. The other 45 tests pass.

- [ ] **Step 3: Write the implementation**

In `backend/src/services/AgentService.ts`, replace:

```ts
				payload = await this.remoteBackupService.materializeCommand(agent.agentId, command);
```

with:

```ts
				// The lease token and per-Agent secret seal payload version 5 (S3_AGENT_REPOSITORY_DESIGN.md 10.3).
				payload = await this.remoteBackupService.materializeCommand(agent.agentId, command, {
					agentSecret: agent.secret,
					leaseToken,
				});
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/services/AgentService.test.ts __tests__/agentControlPlane.integration.test.ts
```

Expected: PASS; `AgentService.test.ts` reports 47 tests, all passed; the control-plane integration suite passes unchanged.

- [ ] **Step 5: Type-check**

```bash
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/AgentService.ts backend/__tests__/services/AgentService.test.ts
git diff --cached --check
git commit -m "feat(agent-s3): seal command secrets with the delivered lease"
```

---

### Task 7: Read path by storage type (section 6.1.3)

**Files:**
- Create: `backend/src/utils/restic/ManagedRepositorySessionRouter.ts`
- Modify: `backend/src/services/RemoteBackupService.ts:206-209` (new method after `getSftpRecoveryOptions`)
- Modify: `backend/src/services/RemoteRepositoryRecoveryService.ts:37-45` (imports), `:123-125` (constructor), `:1334` (`context()`)
- Test: `backend/__tests__/utils/restic/ManagedRepositorySessionRouter.test.ts` (create), `backend/__tests__/services/RemoteBackupService.test.ts` (nested describe at the end), `backend/__tests__/services/RemoteRepositoryRecoveryService.test.ts` (new test at the end)

**Interfaces:**
- Consumes: `materializeRepositoryStorage` (Task 5); `ManagedS3RecoverySession(trust)`, `ManagedSftpRepositorySession`, `ManagedRepositorySessionProvider`, `ManagedSftpAccess`, `ManagedRepositorySession`; `trustEnvironment()`.
- Produces:
  - `export type ManagedRepositoryAccessType = 'sftp' | 's3'`
  - `export type ManagedRepositorySessionFactory = (type: ManagedRepositoryAccessType) => ManagedRepositorySessionProvider`
  - `export function managedRepositoryAccessType(access: ManagedSftpAccess): ManagedRepositoryAccessType`
  - `export const defaultManagedRepositorySessionFactory: ManagedRepositorySessionFactory`
  - `export class ManagedRepositorySessionRouter implements ManagedRepositorySessionProvider` with `constructor(factory?: ManagedRepositorySessionFactory)`
  - `RemoteBackupService.getRepositoryAccessOptions(storageId: string): Promise<Record<string, string>>`
  - `RemoteRepositoryRecoveryService` constructor parameter `remoteBackups: Pick<RemoteBackupService, 'getSftpRecoveryOptions'> & Partial<Pick<RemoteBackupService, 'getRepositoryAccessOptions'>>`; default `sessions` is `new ManagedRepositorySessionRouter()`.

- [ ] **Step 1: Write the failing tests**

Create `backend/__tests__/utils/restic/ManagedRepositorySessionRouter.test.ts`:

```ts
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
```

In `backend/__tests__/services/RemoteBackupService.test.ts`, insert immediately before the file's last line `});`:

```ts
	describe('Server read access by storage type (S3_AGENT_REPOSITORY_DESIGN.md 6.1.3)', () => {
		it('keeps SFTP read options unchanged and returns S3 session options without asking the Agent', async () => {
			const sftpOptions = await service.getSftpRecoveryOptions(plan.storageId);
			await expect(service.getRepositoryAccessOptions(plan.storageId)).resolves.toEqual(sftpOptions);
			const sftpStorage = await storageStore.getById(plan.storageId);
			const s3Storage = s3StorageRecord(new Cryptr(encryptionSecret));
			storageStore.getById.mockImplementation(async (id: string) =>
				id === s3Plan.storageId ? s3Storage : sftpStorage
			);
			agentStore.getAgentByDeviceId.mockResolvedValue(null);
			await expect(service.getRepositoryAccessOptions(s3Plan.storageId)).resolves.toEqual({
				type: 's3',
				provider: 'Other',
				endpoint: 'https://s3.example.internal',
				no_check_bucket: 'true',
				use_accept_encoding_gzip: 'false',
				force_path_style: 'true',
				access_key_id: s3AccessKey,
				secret_access_key: s3SecretKey,
				env_auth: 'false',
			});
			expect(agentStore.getAgentByDeviceId).not.toHaveBeenCalled();
			await expect(service.getSftpRecoveryOptions(s3Plan.storageId)).rejects.toMatchObject({
				statusCode: 400,
			});
		});
	});
```

In `backend/__tests__/services/RemoteRepositoryRecoveryService.test.ts`, insert immediately before the file's last line `});`:

```ts
	it('reads an S3 primary with the S3 access of its storage and never asks for SFTP options', async () => {
		const s3Options = {
			type: 's3',
			provider: 'Other',
			endpoint: 'https://s3.example.internal',
			force_path_style: 'true',
			use_accept_encoding_gzip: 'false',
			no_check_bucket: 'true',
			access_key_id: 'SYNTHETICKEY01',
			secret_access_key: 'synthetic-secret-key-01',
			env_auth: 'false',
		};
		const access = jest.fn(async () => s3Options);
		for (const record of [backup, plan, repository])
			Object.assign(record, { storageId: 'storage-s3', storagePath: 'bucket-01/agents/app-01' });
		const s3Service = new RemoteRepositoryRecoveryService(
			stores.repositories,
			stores.backups,
			stores.plans,
			stores.restores,
			{ getSftpRecoveryOptions: options, getRepositoryAccessOptions: access },
			stores.agents,
			{ withSession },
			secret,
			path.join(scratch, 's3-primary', 'managed-remote-restores')
		);
		try {
			await expect(s3Service.browse('backup-01')).resolves.toHaveLength(5);
			expect(access).toHaveBeenCalledWith('storage-s3');
			expect(options).not.toHaveBeenCalled();
			expect(withSession.mock.calls[0][0]).toEqual({
				options: s3Options,
				password,
				repositoryPath: 'bucket-01/agents/app-01',
			});
		} finally {
			await s3Service.close();
		}
	});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/utils/restic/ManagedRepositorySessionRouter.test.ts __tests__/services/RemoteBackupService.test.ts __tests__/services/RemoteRepositoryRecoveryService.test.ts
```

Expected: FAIL. Router suite: `Cannot find module '../../../src/utils/restic/ManagedRepositorySessionRouter'`. RemoteBackupService: `service.getRepositoryAccessOptions is not a function`. RemoteRepositoryRecoveryService: `expect(access).toHaveBeenCalledWith('storage-s3')` fails (0 calls) because `context()` still calls `getSftpRecoveryOptions`. All existing tests pass.

- [ ] **Step 3: Write the implementation**

Create `backend/src/utils/restic/ManagedRepositorySessionRouter.ts`:

```ts
import { trustEnvironment } from '../storageSecurity';
import { ManagedS3RecoverySession } from './ManagedS3RecoverySession';
import {
	ManagedSftpRepositorySession,
	type ManagedRepositorySession,
	type ManagedRepositorySessionProvider,
	type ManagedSftpAccess,
} from './ManagedSftpRepositorySession';

/**
 * docs/S3_AGENT_REPOSITORY_DESIGN.md 6.1.3 and section 9: repository access is built per
 * storage type, not per service instance. S3 access always carries `type: 's3'`
 * (storageRcloneOptions, RemoteBackupService.getRepositoryAccessOptions); SFTP access
 * never carries `type`, and each session refuses the other's options.
 */
export type ManagedRepositoryAccessType = 'sftp' | 's3';
export type ManagedRepositorySessionFactory = (
	type: ManagedRepositoryAccessType
) => ManagedRepositorySessionProvider;

export function managedRepositoryAccessType(access: ManagedSftpAccess): ManagedRepositoryAccessType {
	return access.options.type === 's3' ? 's3' : 'sftp';
}

/** Operator trust is read per session, as the replica resolver reads it per resolution. */
export const defaultManagedRepositorySessionFactory: ManagedRepositorySessionFactory = type =>
	type === 's3'
		? new ManagedS3RecoverySession(trustEnvironment())
		: new ManagedSftpRepositorySession();

export class ManagedRepositorySessionRouter implements ManagedRepositorySessionProvider {
	constructor(
		private readonly factory: ManagedRepositorySessionFactory = defaultManagedRepositorySessionFactory
	) {}

	async withSession<T>(
		access: ManagedSftpAccess,
		consume: (session: ManagedRepositorySession) => Promise<T>,
		signal?: AbortSignal,
		limits?: { restoreTimeoutMs: number; temporaryRoot?: string; cleanupWarning?: () => void }
	): Promise<T> {
		return this.factory(managedRepositoryAccessType(access)).withSession(
			access,
			consume,
			signal,
			limits
		);
	}
}
```

In `backend/src/services/RemoteBackupService.ts`, replace:

```ts
	/** Internal server recovery shares the same narrow SFTP allowlist/decryption. */
	async getSftpRecoveryOptions(storageId: string): Promise<Record<string, string>> {
		return (await this.materializeSftpStorage(storageId)).options;
	}
```

with:

```ts
	/** Internal server recovery shares the same narrow SFTP allowlist/decryption. */
	async getSftpRecoveryOptions(storageId: string): Promise<Record<string, string>> {
		return (await this.materializeSftpStorage(storageId)).options;
	}

	/**
	 * Server read path of an Agent repository (browse, download, export, restore, recovery
	 * tests): SFTP options exactly as getSftpRecoveryOptions, S3 options keyed by `type: 's3'`
	 * for ManagedS3RecoverySession. Never consults the Agent, so snapshots already in S3 stay
	 * readable after an Agent rollback (S3_AGENT_REPOSITORY_DESIGN.md 6.7).
	 */
	async getRepositoryAccessOptions(storageId: string): Promise<Record<string, string>> {
		const target = await this.materializeRepositoryStorage(storageId);
		if (target.type === 'sftp') return target.options;
		return { type: 's3', ...target.options, ...target.secrets, env_auth: 'false' };
	}
```

In `backend/src/services/RemoteRepositoryRecoveryService.ts`, replace:

```ts
import {
	fullSnapshotId,
	ManagedRepositoryAccessError,
	ManagedRepositorySession,
	ManagedRepositorySessionProvider,
	ManagedSftpAccess,
	ManagedSftpRepositorySession,
	type ManagedSnapshotNode,
} from '../utils/restic/ManagedSftpRepositorySession';
```

with:

```ts
import {
	fullSnapshotId,
	ManagedRepositoryAccessError,
	ManagedRepositorySession,
	ManagedRepositorySessionProvider,
	ManagedSftpAccess,
	type ManagedSnapshotNode,
} from '../utils/restic/ManagedSftpRepositorySession';
import { ManagedRepositorySessionRouter } from '../utils/restic/ManagedRepositorySessionRouter';
```

Replace:

```ts
		private readonly remoteBackups: Pick<RemoteBackupService, 'getSftpRecoveryOptions'>,
		private readonly agents: Pick<AgentStore, 'getAgentById'>,
		private readonly sessions: ManagedRepositorySessionProvider = new ManagedSftpRepositorySession(),
```

with:

```ts
		// getRepositoryAccessOptions chooses SFTP or S3 by the repository's storage type.
		// Callers that only provide the SFTP lookup keep the SFTP-only behaviour.
		private readonly remoteBackups: Pick<RemoteBackupService, 'getSftpRecoveryOptions'> &
			Partial<Pick<RemoteBackupService, 'getRepositoryAccessOptions'>>,
		private readonly agents: Pick<AgentStore, 'getAgentById'>,
		private readonly sessions: ManagedRepositorySessionProvider = new ManagedRepositorySessionRouter(),
```

Replace:

```ts
			options = await this.remoteBackups.getSftpRecoveryOptions(repository.storageId);
```

with:

```ts
			options = this.remoteBackups.getRepositoryAccessOptions
				? await this.remoteBackups.getRepositoryAccessOptions(repository.storageId)
				: await this.remoteBackups.getSftpRecoveryOptions(repository.storageId);
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/utils/restic/ManagedRepositorySessionRouter.test.ts __tests__/services/RemoteBackupService.test.ts __tests__/services/RemoteRepositoryRecoveryService.test.ts __tests__/services/SnapshotComparisonService.test.ts
```

Expected: PASS. Router 4 tests, RemoteBackupService 50, RemoteRepositoryRecoveryService 132, SnapshotComparisonService unchanged; 0 failed.

- [ ] **Step 5: Type-check and lint**

```bash
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-backend lint
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/utils/restic/ManagedRepositorySessionRouter.ts backend/src/services/RemoteBackupService.ts backend/src/services/RemoteRepositoryRecoveryService.ts backend/__tests__/utils/restic/ManagedRepositorySessionRouter.test.ts backend/__tests__/services/RemoteBackupService.test.ts backend/__tests__/services/RemoteRepositoryRecoveryService.test.ts
git diff --cached --check
git commit -m "feat(agent-s3): read Agent repositories through a session chosen by storage type"
```

---

### Task 8: Keep Move Repository SFTP to SFTP

**Files:**
- Modify: `backend/src/services/PlanRepositoryRelocationService.ts:108-118`
- Test: `backend/__tests__/services/PlanRepositoryRelocationService.test.ts` (after the test `refuses a destination that overlaps another repository and a non-remote plan`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `start()` refuses with `AppError(400, 'Move Repository supports only SFTP primary repositories.')` when the current primary storage is not `sftp`.

- [ ] **Step 1: Write the failing test**

In `backend/__tests__/services/PlanRepositoryRelocationService.test.ts`, find the end of the test `refuses a destination that overlaps another repository and a non-remote plan`:

```ts
		exportsBusy = true;
		await expect(start()).rejects.toThrow('Reliable Download');
	});
```

and insert directly after it:

```ts

	it('refuses to move an S3 primary repository and leaves the plan running', async () => {
		context.sqlite.exec(`
			UPDATE plans SET storage_id='storage-s3', storage_path='bucket-01/managed/fixture' WHERE id='plan-01';
			UPDATE remote_managed_repositories SET storage_id='storage-s3', storage_path='bucket-01/managed/fixture' WHERE id='repo-01';
		`);
		await expect(start()).rejects.toThrow('Move Repository supports only SFTP primary repositories.');
		expect(pause).not.toHaveBeenCalled();
		expect(plan()).toEqual({
			active: 1,
			storage_id: 'storage-s3',
			storage_path: 'bucket-01/managed/fixture',
		});
	});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/services/PlanRepositoryRelocationService.test.ts
```

Expected: FAIL in the new test only: `start()` resolves (a relocation is created) instead of rejecting. 23 existing tests pass.

- [ ] **Step 3: Write the implementation**

In `backend/src/services/PlanRepositoryRelocationService.ts`, replace:

```ts
			throw new AppError(
				409,
				'The plan repository is not initialized or its binding changed. Run one successful backup first.'
			);
		const storagePath = validateRelocationPath(input.storagePath);
```

with:

```ts
			throw new AppError(
				409,
				'The plan repository is not initialized or its binding changed. Run one successful backup first.'
			);
		// Relocation copies SFTP to SFTP. Switching an S3 primary is stage 4
		// (docs/S3_AGENT_REPOSITORY_DESIGN.md section 3).
		const sourceStorage = await this.storages.getById(repository.storageId);
		if (!sourceStorage || sourceStorage.type !== 'sftp')
			throw new AppError(400, 'Move Repository supports only SFTP primary repositories.');
		const storagePath = validateRelocationPath(input.storagePath);
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/services/PlanRepositoryRelocationService.test.ts
```

Expected: PASS, `Tests:       24 passed, 24 total`.

- [ ] **Step 5: Type-check**

```bash
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/PlanRepositoryRelocationService.ts backend/__tests__/services/PlanRepositoryRelocationService.test.ts
git diff --cached --check
git commit -m "fix(relocation): refuse to move a primary repository that is not SFTP"
```

---

### Task 9: Prove the read path against a real S3 primary in the replica lab (section 6.6)

The replica lab (`scripts/validate-replica-recovery.py` running `backend/__tests__/integration/replicaRecovery.lab.ts` in Docker, network none) already builds a real HTTPS S3 repository with a private CA (`rclone serve s3`) by copying a snapshot that contains a full source tree, a symlink and a SQL artifact. After the SFTP server is stopped, this task binds that same S3 repository as an Agent plan's primary and reads it through the production path: `RemoteBackupService.getRepositoryAccessOptions` (real method, no scheduler side effects), `context()`, the default session router and `ManagedS3RecoverySession`.

**Files:**
- Modify: `backend/__tests__/integration/replicaRecovery.lab.ts:8` (import), after the line `console.log('PASS replica contents unchanged after preflight and all restores');`

**Interfaces:**
- Consumes: `RemoteBackupService.prototype.getRepositoryAccessOptions` (Task 7) and `materializeRepositoryStorage` (Task 5) through `Object.create(RemoteBackupService.prototype)`; `RemoteRepositoryRecoveryService.browse`, `testBinding`, `testMetadata`, `testRestore`, `databaseRestoreArtifact`; lab locals `f`, `copied`, `source`, `sql`, `root`, `s3root`, `before`, `hashTree`.
- Produces: lab output line `PASS S3 primary: browse, staged restore and SQL artifact read through the routed S3 session with SFTP stopped`.

- [ ] **Step 1: Add the scenario**

In `backend/__tests__/integration/replicaRecovery.lab.ts`, replace:

```ts
import { configService } from '../../src/services/ConfigService';
```

with:

```ts
import { configService } from '../../src/services/ConfigService';
import { RemoteBackupService } from '../../src/services/RemoteBackupService';
```

Find:

```ts
	console.log('PASS replica contents unchanged after preflight and all restores');
```

and insert directly after it:

```ts
	// docs/S3_AGENT_REPOSITORY_DESIGN.md 6.1.3 and 6.6: the same HTTPS S3 repository, bound
	// as an Agent plan's primary. SFTP is already stopped, so every read must use S3.
	console.log('CHECK S3 primary read path');
	const sqlArtifact = {
		databaseId: 'db_example',
		engine: 'mysql' as const,
		database: 'example',
		path: '/pluton/database/example.sql',
		bytes: Buffer.byteLength(sql),
		sha256: crypto.createHash('sha256').update(sql).digest('hex'),
	};
	const s3PrimaryBackup = {
		...f.backup,
		storageId: f.storage.id,
		storagePath: f.replica.storagePath,
		completionStats: {
			...f.backup.completionStats,
			snapshot_id: copied.snapshotId,
			lifecycle: { warnings: [], databases: [sqlArtifact] },
		},
	};
	const s3PrimaryPlan = {
		...f.plan,
		storageId: f.storage.id,
		storagePath: f.replica.storagePath,
		settings: { replication: { enabled: false, concurrent: false, storages: [] } },
	};
	const s3PrimaryRepository = {
		...f.repository,
		storageId: f.storage.id,
		storagePath: f.replica.storagePath,
	};
	// The production read-option method, without constructing scheduler side effects.
	const s3Remote = Object.assign(Object.create(RemoteBackupService.prototype), {
		storageStore: { getById: async (id: string) => (id === f.storage.id ? f.storage : null) },
		encryptionSecret: configService.config.SECRET,
	}) as RemoteBackupService;
	await fs.mkdir(path.join(root, 's3-primary'));
	const s3PrimarySignal = AbortSignal.timeout(120_000);
	const s3PrimaryRecovery = new RemoteRepositoryRecoveryService(
		{ getByPlanId: async () => s3PrimaryRepository } as any,
		{ getById: async () => s3PrimaryBackup } as any,
		{ getById: async () => s3PrimaryPlan } as any,
		{} as any,
		s3Remote,
		f.stores.agents as any,
		undefined,
		configService.config.SECRET,
		path.join(root, 's3-primary', 'stage')
	);
	try {
		const listing = await s3PrimaryRecovery.browse('backup-01');
		assert(listing.some(file => file.path === path.join(source, 'file.txt')));
		assert(listing.some(file => file.path === '/pluton/database/example.sql'));
		const binding = await s3PrimaryRecovery.testBinding('backup-01', 'plan-01');
		assert.equal(binding.snapshotId, copied.snapshotId);
		const metadata = await s3PrimaryRecovery.testMetadata('backup-01', 'plan-01', copied.snapshotId);
		assert.deepEqual(
			metadata.databases.map(entry => entry.path),
			['/pluton/database/example.sql']
		);
		const restored = await fs.mkdtemp(path.join(root, 's3-primary-restore-'));
		const result = await s3PrimaryRecovery.testRestore(
			binding,
			restored,
			s3PrimarySignal,
			() => {},
			async () => {}
		);
		assert.equal(result.sourceTrees, 1);
		assert.deepEqual(await hashTree(path.join(restored, source.slice(1))), await hashTree(source));
		const artifactTarget = await fs.mkdtemp(path.join(root, 's3-primary-sql-'));
		const entry = await s3PrimaryRecovery.databaseRestoreArtifact(
			{ ...binding, databaseId: sqlArtifact.databaseId, sha256: sqlArtifact.sha256 },
			artifactTarget,
			s3PrimarySignal,
			async () => {}
		);
		assert.equal(entry.path, sqlArtifact.path);
		assert.equal(
			await fs.readFile(path.join(artifactTarget, 'pluton/database/example.sql'), 'utf8'),
			sql
		);
	} finally {
		await s3PrimaryRecovery.close();
	}
	assert.deepEqual(await hashTree(s3root), before, 'S3 primary reads must not mutate the repository');
	console.log(
		'PASS S3 primary: browse, staged restore and SQL artifact read through the routed S3 session with SFTP stopped'
	);
```

- [ ] **Step 2: Make sure a lab image exists**

Docker Desktop must be running (the user starts it). Then:

```bash
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^pluton-(replica-recovery|s3-readback-verified):local$'
```

Expected: at least one line. Use `pluton-replica-recovery:local` if listed, otherwise `pluton-s3-readback-verified:local`. The script mounts the current `backend/src` and `backend/__tests__` read-only, so an existing image runs the new source. If neither exists, build the images exactly as CI does:

```bash
docker build -f Dockerfile.source -t pluton-recovery-ci:local .
docker build --target build -f Dockerfile.source -t pluton-replica-build:local .
docker build -f backend/__tests__/fixtures/replica-recovery/Dockerfile -t pluton-replica-recovery:local .
```

Expected: each build ends with `naming to docker.io/library/<name>:local`. If Docker is not available, record the lab as BLOCKED in the report (Task 15) and rely on the hosted `container.yml` step "Verify real SFTP to S3 assisted recovery and one-time approval", which runs the same lab on the pull request. Do not mark it passed.

- [ ] **Step 3: Run the lab**

```bash
py -3 scripts/validate-replica-recovery.py pluton-replica-recovery:local --openssl "$(cygpath -w /ucrt64/bin/openssl)"
```

(Replace the image name with `pluton-s3-readback-verified:local` if that is the one found in Step 2.)

Expected: the output contains `CHECK S3 primary read path` followed by `PASS S3 primary: browse, staged restore and SQL artifact read through the routed S3 session with SFTP stopped`; every earlier `PASS` line still appears; the script exits 0 and prints no `FAIL disposable replica recovery`. If it fails, read the last `CHECK` line before the failure and fix the cause; never weaken an assertion.

- [ ] **Step 4: Commit**

```bash
git add backend/__tests__/integration/replicaRecovery.lab.ts
git diff --cached --check
git commit -m "test(agent-s3): read an S3 primary through the routed session in the replica lab"
```

---

### Task 10: Frontend capability helpers

**Files:**
- Create: `frontend/src/utils/agentRepository.ts`
- Modify: `frontend/src/@types/devices.ts:51-57`
- Test: `frontend/__tests__/agentS3Repository.test.ts` (create)

**Interfaces:**
- Consumes: `AgentInfo` (`frontend/src/@types/devices.ts`), `PlanReplicationSettings` (`frontend/src/@types/plans.ts`).
- Produces (all exported from `frontend/src/utils/agentRepository.ts`):
  - `AGENT_S3_STORAGE_TYPES: string[]` (`['s3', 's3compatible']`)
  - `AGENT_S3_HIDDEN_NOTICE: string`
  - `AGENT_S3_REPLICATION_NOTICE: string`
  - `agentSupportsS3Repository(agent: Pick<AgentInfo, 'capabilities'> | null | undefined): boolean`
  - `agentRepositoryStorageTypes(agent: Pick<AgentInfo, 'capabilities'> | null | undefined): string[]`
  - `agentS3HiddenNotice(agent: Pick<AgentInfo, 'capabilities'> | null | undefined): string | undefined`
  - `isAgentS3Primary(managedAgent: boolean, storageType: string | undefined): boolean`
  - `replicationForAgentPrimary(replication: PlanReplicationSettings | undefined, s3Primary: boolean): PlanReplicationSettings | undefined`
  - `managedDestinationNotice(s3Primary: boolean): string`
  - `agentRepositoryCanMove(storageType: string | undefined): boolean`

- [ ] **Step 1: Write the failing test**

Create `frontend/__tests__/agentS3Repository.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
   AGENT_S3_HIDDEN_NOTICE,
   AGENT_S3_REPLICATION_NOTICE,
   agentRepositoryCanMove,
   agentRepositoryStorageTypes,
   agentS3HiddenNotice,
   agentSupportsS3Repository,
   isAgentS3Primary,
   managedDestinationNotice,
   replicationForAgentPrimary,
} from '../src/utils/agentRepository.ts';
import type { PlanReplicationSettings } from '../src/@types/plans.ts';

const agent = (capabilities: Record<string, unknown>) => ({ capabilities }) as never;
const s3Agent = agent({ repositoryBackends: ['sftp', 's3'], backupPayloadVersion: 5 });

test('S3 is offered only to an Agent that reports s3 and payload version 5 (section 10.1)', () => {
   assert.equal(agentSupportsS3Repository(s3Agent), true);
   for (const capabilities of [{}, { repositoryBackends: ['sftp', 's3'] }, { repositoryBackends: ['sftp'], backupPayloadVersion: 5 }])
      assert.equal(agentSupportsS3Repository(agent(capabilities)), false, JSON.stringify(capabilities));
   assert.equal(agentSupportsS3Repository(undefined), false);
   assert.equal(agentSupportsS3Repository(null), false);
   assert.deepEqual(agentRepositoryStorageTypes(s3Agent), ['sftp', 's3', 's3compatible']);
   assert.deepEqual(agentRepositoryStorageTypes(agent({})), ['sftp']);
   assert.deepEqual(agentRepositoryStorageTypes(undefined), ['sftp']);
});

test('the form explains why S3 is hidden and says nothing when it is offered', () => {
   assert.equal(agentS3HiddenNotice(agent({})), AGENT_S3_HIDDEN_NOTICE);
   assert.match(AGENT_S3_HIDDEN_NOTICE, /Update the Agent to 0\.8\.0/);
   assert.equal(agentS3HiddenNotice(s3Agent), undefined);
});

test('an S3 primary is an S3 or S3-compatible storage on a managed Agent plan only', () => {
   assert.equal(isAgentS3Primary(true, 's3'), true);
   assert.equal(isAgentS3Primary(true, 's3compatible'), true);
   assert.equal(isAgentS3Primary(true, 'sftp'), false);
   assert.equal(isAgentS3Primary(true, undefined), false);
   assert.equal(isAgentS3Primary(false, 's3'), false);
});

test('choosing an S3 primary turns replication off and leaves it untouched otherwise', () => {
   const replication: PlanReplicationSettings = {
      enabled: true,
      concurrent: false,
      recoveryPolicy: 'assisted',
      storages: [{ replicationId: 'replica-01', storageId: 'storage-02', storagePath: 'bucket-01/mirror', storageType: 's3compatible', addedAt: 1 }],
   };
   assert.deepEqual(replicationForAgentPrimary(replication, true), { enabled: false, concurrent: false, recoveryPolicy: 'primary-only', storages: [] });
   assert.equal(replicationForAgentPrimary(replication, false), replication);
   const off: PlanReplicationSettings = { enabled: false, concurrent: false, storages: [] };
   assert.equal(replicationForAgentPrimary(off, true), off);
   assert.equal(replicationForAgentPrimary(undefined, true), undefined);
});

test('destination wording covers both repository types and states what the Agent receives', () => {
   assert.match(managedDestinationNotice(false), /SFTP or S3 primary repository/);
   assert.doesNotMatch(managedDestinationNotice(false), /use SFTP\./);
   assert.match(managedDestinationNotice(true), /writes this plan directly to S3/);
   assert.match(managedDestinationNotice(true), /never any replica key/);
   assert.match(AGENT_S3_REPLICATION_NOTICE, /S3-to-SFTP replication is the next stage/);
});

test('Move Repository stays SFTP to SFTP', () => {
   assert.equal(agentRepositoryCanMove('sftp'), true);
   assert.equal(agentRepositoryCanMove('s3'), false);
   assert.equal(agentRepositoryCanMove('s3compatible'), false);
   assert.equal(agentRepositoryCanMove(undefined), false);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node --experimental-strip-types --test frontend/__tests__/agentS3Repository.test.ts
```

Expected: FAIL, `ERR_MODULE_NOT_FOUND` for `frontend/src/utils/agentRepository.ts`.

- [ ] **Step 3: Write the implementation**

In `frontend/src/@types/devices.ts`, replace:

```ts
      sourceAccessModesVersion?: 1;
      commandTypes?: string[];
   };
```

with:

```ts
      sourceAccessModesVersion?: 1;
      commandTypes?: string[];
      repositoryBackends?: ('sftp' | 's3')[];
      backupPayloadVersion?: 5;
   };
```

Create `frontend/src/utils/agentRepository.ts`:

```ts
import type { AgentInfo } from '../@types/devices';
import type { PlanReplicationSettings } from '../@types/plans';

/** UI gating for an S3 primary on Managed Agent plans (docs/S3_AGENT_REPOSITORY_DESIGN.md 6.4).
 * The server enforces the same rules; the UI only explains them early. */
export const AGENT_S3_STORAGE_TYPES = ['s3', 's3compatible'];

export const AGENT_S3_HIDDEN_NOTICE =
   'S3 storages are not offered for this machine because its Agent does not report S3 repository support. Update the Agent to 0.8.0 or later to back up directly to S3.';

export const AGENT_S3_REPLICATION_NOTICE =
   'Replication is not available for an S3 primary repository yet. S3-to-SFTP replication is the next stage.';

type AgentCapabilitiesView = Pick<AgentInfo, 'capabilities'> | null | undefined;

/** Section 10.1: both fields are required; an Agent that omits them is SFTP-only. */
export function agentSupportsS3Repository(agent: AgentCapabilitiesView): boolean {
   const backends = agent?.capabilities?.repositoryBackends;
   return Array.isArray(backends) && backends.includes('s3') && agent?.capabilities?.backupPayloadVersion === 5;
}

export function agentRepositoryStorageTypes(agent: AgentCapabilitiesView): string[] {
   return agentSupportsS3Repository(agent) ? ['sftp', ...AGENT_S3_STORAGE_TYPES] : ['sftp'];
}

export function agentS3HiddenNotice(agent: AgentCapabilitiesView): string | undefined {
   return agentSupportsS3Repository(agent) ? undefined : AGENT_S3_HIDDEN_NOTICE;
}

export function isAgentS3Primary(managedAgent: boolean, storageType: string | undefined): boolean {
   return managedAgent && AGENT_S3_STORAGE_TYPES.includes(storageType || '');
}

/** Stage 1 refuses replication settings for an S3 primary, so choosing one clears them. */
export function replicationForAgentPrimary(
   replication: PlanReplicationSettings | undefined,
   s3Primary: boolean,
): PlanReplicationSettings | undefined {
   if (!s3Primary || !replication || (!replication.enabled && !replication.storages.length)) return replication;
   return { ...replication, enabled: false, storages: [], recoveryPolicy: 'primary-only' };
}

export function managedDestinationNotice(s3Primary: boolean): string {
   return s3Primary
      ? "The Agent writes this plan directly to S3. For each backup it receives this storage's S3 key in sealed form, and never any replica key. Use a dedicated prefix inside the bucket: the Agent refuses a prefix that already contains data. Database dumps and constrained hooks can be configured under Advanced → Database & Hooks. Agent prune and arbitrary scripts remain unavailable."
      : 'Remote managed backups write to an SFTP or S3 primary repository; S3 needs an Agent that reports S3 support. Database dumps and constrained hooks can be configured under Advanced → Database & Hooks. Optional replicas of an SFTP primary are copied by the Pluton server after snapshot verification, and replica credentials stay on the server. Native database recovery continues to use the trusted primary repository. Agent prune and arbitrary scripts remain unavailable.';
}

/** Move Repository copies SFTP to SFTP only; the server refuses other primaries. */
export function agentRepositoryCanMove(storageType: string | undefined): boolean {
   return storageType === 'sftp';
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
node --experimental-strip-types --test frontend/__tests__/agentS3Repository.test.ts
```

Expected: `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.

- [ ] **Step 5: Type-check**

```bash
pnpm --filter @plutonhq/core-frontend exec tsc -b
```

Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/utils/agentRepository.ts frontend/src/@types/devices.ts frontend/__tests__/agentS3Repository.test.ts
git diff --cached --check
git commit -m "feat(agent-s3): add frontend helpers for S3 primary gating"
```

---

### Task 11: Replication unavailable for an S3 primary, and general primary wording

**Files:**
- Modify: `frontend/src/components/Plan/PlanSettings/PlanReplicationSettings.tsx:20-31` (props), `:39-50` (destructure), `:186-195` (toggle), `:227-230` (wording)
- Modify: `frontend/src/utils/assistedRecovery.ts:154`
- Modify: `frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.tsx:257`
- Test: `frontend/__tests__/managedReplication.test.ts` (append), `frontend/__tests__/assistedRecovery.test.ts` (append)

**Interfaces:**
- Consumes: `AGENT_S3_REPLICATION_NOTICE` (Task 10) in tests only.
- Produces: `PlanReplicationSettings` prop `unavailableReason?: string`; when set, the toggle is unchecked and disabled, the reason is shown, and no destination controls render.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/__tests__/managedReplication.test.ts`:

```ts
test('an S3 primary Agent plan shows replication as unavailable and cannot turn it on', async () => {
   const updates: PlanReplicationSettings[] = [];
   const view = await fixture(Settings, {
      replication: settings(1),
      primaryStorageId: primary.storageId,
      primaryStoragePath: primary.storagePath,
      managedAgent: true,
      deviceId: 'main',
      unavailableReason: 'Replication is not available for an S3 primary repository yet. S3-to-SFTP replication is the next stage.',
      onUpdate: (next: PlanReplicationSettings) => updates.push(next),
   });
   try {
      const toggle = view.dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Enable Replication"]')!;
      assert.equal(toggle.disabled, true);
      assert.equal(toggle.checked, false);
      assert.match(view.text(), /S3-to-SFTP replication is the next stage/);
      assert.doesNotMatch(view.text(), /Replication Destination 1/);
      assert.equal(view.button('Add Replication Destination'), undefined);
      assert.equal(updates.length, 0);
   } finally { await view.cleanup(); }
});

test('failover policy wording names the primary repository, not a storage type', async () => {
   for (const recoveryPolicy of ['primary-only', 'assisted', 'automatic'] as const) {
      const view = await fixture(Settings, { replication: { ...settings(1), recoveryPolicy }, primaryStorageId: primary.storageId, primaryStoragePath: primary.storagePath, managedAgent: true, deviceId: 'main', onUpdate() {} });
      try {
         assert.match(view.text(), /primary repository/);
         assert.doesNotMatch(view.text(), /primary SFTP/i);
      } finally { await view.cleanup(); }
   }
});
```

Append to `frontend/__tests__/assistedRecovery.test.ts`:

```ts
test('primary-ready wording names the primary repository, not a storage type', () => {
   assert.equal(
      recoveryStatus({ status: 'primary-ready' } as AssistedRecoveryJob),
      'The primary repository is available. Continue the normal restore flow.',
   );
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
node --experimental-strip-types --test frontend/__tests__/managedReplication.test.ts frontend/__tests__/assistedRecovery.test.ts
```

Expected: `ℹ fail 3`. The unavailable test fails on `toggle.disabled` (false); the wording test fails with `primary SFTP` present; the primary-ready test fails with `'Primary SFTP is available. …'`. The other 34 tests pass.

- [ ] **Step 3: Write the implementation**

In `frontend/src/components/Plan/PlanSettings/PlanReplicationSettings.tsx`, replace:

```tsx
   managedAgent?: boolean;
   onUpdate: (replication: ReplicationSettings) => void;
}
```

with:

```tsx
   managedAgent?: boolean;
   /** Set when replication cannot be used for this primary (an S3 primary in stage 1). */
   unavailableReason?: string;
   onUpdate: (replication: ReplicationSettings) => void;
}
```

Replace:

```tsx
   managedAgent = false,
   onUpdate,
}: PlanReplicationSettingsProps) => {
```

with:

```tsx
   managedAgent = false,
   unavailableReason,
   onUpdate,
}: PlanReplicationSettingsProps) => {
```

Replace:

```tsx
               fieldValue={settings.enabled}
               onUpdate={updateEnabled}
            />

            {settings.enabled && (
```

with:

```tsx
               fieldValue={unavailableReason ? false : settings.enabled}
               disabled={Boolean(unavailableReason)}
               onUpdate={updateEnabled}
            />
            {unavailableReason && <p className={classes.fieldNotice}>{unavailableReason}</p>}

            {!unavailableReason && settings.enabled && (
```

Replace:

```tsx
                              ? 'Recovery starts on the primary SFTP. If it is unreachable, Pluton continues automatically with the first replica that passes identity and integrity checks, restoring only into isolated staging. Selecting this does not prove a replica is recoverable, and nothing is restored to production or imported into a database automatically.'
                              : settings.recoveryPolicy === 'assisted'
                                ? 'Prefer primary SFTP. A verified S3 replica requires your explicit approval and restores only into isolated staging. Database import keeps its existing separate approval.'
                                : 'Recovery uses the primary SFTP only. Choose a failover policy to allow verified S3 replicas as a recovery source.'}
```

with:

```tsx
                              ? 'Recovery starts on the primary repository. If it is unreachable, Pluton continues automatically with the first replica that passes identity and integrity checks, restoring only into isolated staging. Selecting this does not prove a replica is recoverable, and nothing is restored to production or imported into a database automatically.'
                              : settings.recoveryPolicy === 'assisted'
                                ? 'Prefer the primary repository. A verified S3 replica requires your explicit approval and restores only into isolated staging. Database import keeps its existing separate approval.'
                                : 'Recovery uses the primary repository only. Choose a failover policy to allow verified S3 replicas as a recovery source.'}
```

In `frontend/src/utils/assistedRecovery.ts`, replace:

```ts
      ? 'Primary SFTP is available. Continue the normal restore flow.'
```

with:

```ts
      ? 'The primary repository is available. Continue the normal restore flow.'
```

In `frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.tsx`, replace:

```tsx
                  This plan uses Automatic Failover. Pluton checks the primary SFTP first and opens the normal restore when it is available. If
```

with:

```tsx
                  This plan uses Automatic Failover. Pluton checks the primary repository first and opens the normal restore when it is available. If
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
node --experimental-strip-types --test frontend/__tests__/managedReplication.test.ts frontend/__tests__/assistedRecovery.test.ts frontend/__tests__/themeStyles.test.ts
grep -rn "primary SFTP\|Primary SFTP" frontend/src
```

Expected: `ℹ fail 0` (managedReplication 17, assistedRecovery 20, themeStyles unchanged). `grep` prints nothing.

- [ ] **Step 5: Type-check**

```bash
pnpm --filter @plutonhq/core-frontend exec tsc -b
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Plan/PlanSettings/PlanReplicationSettings.tsx frontend/src/utils/assistedRecovery.ts frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.tsx frontend/__tests__/managedReplication.test.ts frontend/__tests__/assistedRecovery.test.ts
git diff --cached --check
git commit -m "feat(agent-s3): show replication as unavailable for an S3 primary"
```

---

### Task 12: Offer S3 in the plan form per Agent, and hide Move Repository for S3

**Files:**
- Modify: `frontend/src/components/Plan/PlanForm/PlanForm.tsx:15` (imports), after `:69` (derived state), `:265-292` (destination and notice), `:293-300` (replication props)
- Modify: `frontend/src/routes/PlanSingle/PlanSingle.tsx` imports, `:80`, `:170`
- Test: `frontend/__tests__/agentSourceAccessUi.test.ts:70`, `:77`, `:80` (mocks expose props), new test at the end

**Interfaces:**
- Consumes: `agentRepositoryStorageTypes`, `agentS3HiddenNotice`, `isAgentS3Primary`, `managedDestinationNotice`, `replicationForAgentPrimary`, `AGENT_S3_REPLICATION_NOTICE`, `agentRepositoryCanMove` (Task 10); `unavailableReason` prop (Task 11); `useGetDevices` (`services/devices.ts`), `useGetStorages` (`services/storage.ts`).
- Produces: `StoragePicker` receives `allowedStorageTypes` `['sftp']` or `['sftp', 's3', 's3compatible']` for remote plans; `PlanReplicationSettings` receives `unavailableReason` for an S3 primary.

- [ ] **Step 1: Write the failing test**

In `frontend/__tests__/agentSourceAccessUi.test.ts`, replace:

```ts
               load(/[\\/]services[\\/]storage\.ts$/, 'export const useGetStorages=()=>({data:{result:[]}});');
```

with:

```ts
               load(/[\\/]services[\\/]storage\.ts$/, 'export const useGetStorages=()=>({data:{result:globalThis.__sourceAccessUi.storages||[]}});');
```

Replace:

```ts
               load(/[\\/]PlanReplicationSettings\.tsx$/, 'export default ()=>null;');
```

with:

```ts
               load(/[\\/]PlanReplicationSettings\.tsx$/, `import React from 'react';export default p=>React.createElement('div',{'data-replication-settings':'','data-unavailable':p.unavailableReason||''});`);
```

Replace:

```ts
               load(/[\\/]StoragePicker\.tsx$/, 'export default ()=>null;');
```

with:

```ts
               load(/[\\/]StoragePicker\.tsx$/, `import React from 'react';export default p=>React.createElement('div',{'data-storage-picker':'','data-allowed':(p.allowedStorageTypes||[]).join(',')});`);
```

(The replacement mocks render empty elements with data attributes and no text, so existing text and button assertions are unaffected.)

Append to the end of the file:

```ts
test('remote destination offers S3 only when the Agent reports it, explains why otherwise, and gates replication', async () => {
   const props = { type: 'add', title: 'Add plan', planSettings: formPlan(), onSubmit() {}, isSubmitting: false, close() {} };
   const legacy = await fixture(ControlledForm, props);
   try {
      await act(async () => legacy.button('Next: Configure Source')!.click());
      assert.equal(legacy.dom.window.document.querySelector('[data-storage-picker]')!.getAttribute('data-allowed'), 'sftp');
      assert.match(legacy.text(), /S3 storages are not offered for this machine/);
      assert.match(legacy.text(), /SFTP or S3 primary repository/);
      assert.equal(legacy.dom.window.document.querySelector('[data-replication-settings]')!.getAttribute('data-unavailable'), '');
   } finally {
      await legacy.cleanup();
   }
   const device = {
      id: 'device-01',
      name: 'app-01',
      isRemote: true,
      agent: {
         status: 'online',
         resticVersion: '0.19.1',
         rcloneVersion: '1.75.1',
         capabilities: {
            filesystemRootsConfigured: true,
            commandTypes: ['BACKUP_FILESYSTEM'],
            sourceAccessVersion: 1,
            repositoryBackends: ['sftp', 's3'],
            backupPayloadVersion: 5,
         },
      },
   };
   const capable = await fixture(ControlledForm, props, { devices: [device], storages: [{ id: 'storage-01', name: 'Primary', type: 's3compatible' }] });
   try {
      await act(async () => capable.button('Next: Configure Source')!.click());
      assert.equal(capable.dom.window.document.querySelector('[data-storage-picker]')!.getAttribute('data-allowed'), 'sftp,s3,s3compatible');
      assert.doesNotMatch(capable.text(), /S3 storages are not offered/);
      assert.match(capable.text(), /The Agent writes this plan directly to S3/);
      assert.match(capable.dom.window.document.querySelector('[data-replication-settings]')!.getAttribute('data-unavailable')!, /S3-to-SFTP replication is the next stage/);
   } finally {
      await capable.cleanup();
   }
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node --experimental-strip-types --test frontend/__tests__/agentSourceAccessUi.test.ts
```

Expected: `ℹ fail 1` in the new test (`data-allowed` is `sftp` for the capable Agent and the S3 hidden notice is missing for the legacy Agent); the 29 existing tests pass with the new mocks.

- [ ] **Step 3: Write the implementation**

In `frontend/src/components/Plan/PlanForm/PlanForm.tsx`, replace:

```tsx
import { useGetDevice } from '../../../services/devices';
```

with:

```tsx
import { useGetDevice, useGetDevices } from '../../../services/devices';
import { useGetStorages } from '../../../services/storage';
import type { Device } from '../../../@types/devices';
import {
   AGENT_S3_REPLICATION_NOTICE,
   agentRepositoryStorageTypes,
   agentS3HiddenNotice,
   isAgentS3Primary,
   managedDestinationNotice,
   replicationForAgentPrimary,
} from '../../../utils/agentRepository';
```

Replace:

```tsx
   const { data: deviceData } = useGetDevice('main', true);
   const deviceInstance = deviceData?.result?.device;
```

with:

```tsx
   const { data: deviceData } = useGetDevice('main', true);
   const deviceInstance = deviceData?.result?.device;

   // The selected machine's Agent decides whether S3 can be its primary (S3_AGENT_REPOSITORY_DESIGN.md 6.4).
   const { data: devicesData } = useGetDevices();
   const { data: storagesData } = useGetStorages();
   const sourceAgent = isRemoteFilesystemSource
      ? ((devicesData?.result || []) as Device[]).find((device) => device.id === planSettings.sourceId)?.agent
      : undefined;
   const primaryStorageType = ((storagesData?.result || []) as { id: string; type: string }[]).find(
      (item) => item.id === planSettings.storage?.id,
   )?.type;
   const s3Primary = isAgentS3Primary(isRemoteFilesystemSource, primaryStorageType);
   const s3HiddenNotice = isRemoteFilesystemSource ? agentS3HiddenNotice(sourceAgent) : undefined;
```

Replace:

```tsx
                        allowedStorageTypes={isRemoteFilesystemSource ? ['sftp'] : undefined}
                        requirePath={isRemoteFilesystemSource}
                        disabled={type === 'edit' ? true : false}
                        onUpdate={(s: { storage: { name: string; id: string; type: string }; path: string }) =>
                           onPlanSettingsChange({
                              ...planSettings,
                              storagePath: s.path,
                              storage: { id: s.storage.id, name: s.storage.name },
                           })
                        }
                     />
                  </div>
                  {isRemoteFilesystemSource && (
                     <div className={classes.field}>
                        <p className={classes.fieldNotice}>
                           Remote managed backups use SFTP. Database dumps and constrained hooks can be configured under Advanced → Database & Hooks.
                           Optional replicas are copied by the Pluton server after snapshot verification. Storage credentials stay on the server.
                           Native database recovery continues to use the trusted primary repository. Agent prune and arbitrary scripts remain
                           unavailable.
                        </p>
                     </div>
                  )}
```

with:

```tsx
                        allowedStorageTypes={isRemoteFilesystemSource ? agentRepositoryStorageTypes(sourceAgent) : undefined}
                        requirePath={isRemoteFilesystemSource}
                        disabled={type === 'edit' ? true : false}
                        onUpdate={(s: { storage: { name: string; id: string; type: string }; path: string }) => {
                           const replication = replicationForAgentPrimary(
                              planSettings.settings.replication,
                              isAgentS3Primary(isRemoteFilesystemSource, s.storage.type),
                           );
                           onPlanSettingsChange({
                              ...planSettings,
                              storagePath: s.path,
                              storage: { id: s.storage.id, name: s.storage.name },
                              ...(replication !== planSettings.settings.replication
                                 ? { settings: { ...planSettings.settings, replication } }
                                 : {}),
                           });
                        }}
                     />
                  </div>
                  {isRemoteFilesystemSource && (
                     <div className={classes.field}>
                        {s3HiddenNotice && <p className={classes.fieldNotice}>{s3HiddenNotice}</p>}
                        <p className={classes.fieldNotice}>{managedDestinationNotice(s3Primary)}</p>
                     </div>
                  )}
```

Replace:

```tsx
                     managedAgent={isRemoteFilesystemSource}
                     isEditing={type === 'edit'}
```

with:

```tsx
                     managedAgent={isRemoteFilesystemSource}
                     unavailableReason={s3Primary ? AGENT_S3_REPLICATION_NOTICE : undefined}
                     isEditing={type === 'edit'}
```

In `frontend/src/routes/PlanSingle/PlanSingle.tsx`, add this import after the last existing `import` line at the top of the file:

```tsx
import { agentRepositoryCanMove } from '../../utils/agentRepository';
```

Replace:

```tsx
      const remoteManaged = method === 'backup' && plan.sourceType === 'device' && plan.sourceId !== 'main';
```

with:

```tsx
      const remoteManaged = method === 'backup' && plan.sourceType === 'device' && plan.sourceId !== 'main';
      // Move Repository copies SFTP to SFTP only; the server refuses an S3 primary as well.
      const movableRepository = remoteManaged && agentRepositoryCanMove(plan.storage?.type);
```

Replace (the line just above the Move Repository list item):

```tsx
                                 {remoteManaged && (
```

with:

```tsx
                                 {movableRepository && (
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
node --experimental-strip-types --test frontend/__tests__/agentSourceAccessUi.test.ts frontend/__tests__/formControlAccessibility.test.ts frontend/__tests__/themePreference.test.ts frontend/__tests__/agentS3Repository.test.ts
```

Expected: `ℹ fail 0`; `agentSourceAccessUi.test.ts` reports 30 tests.

- [ ] **Step 5: Type-check**

```bash
pnpm --filter @plutonhq/core-frontend exec tsc -b
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Plan/PlanForm/PlanForm.tsx frontend/src/routes/PlanSingle/PlanSingle.tsx frontend/__tests__/agentSourceAccessUi.test.ts
git diff --cached --check
git commit -m "feat(agent-s3): offer S3 primaries in the plan form for capable Agents"
```

---

### Task 13: In-app documentation

**Files:**
- Modify: `frontend/src/docs/manifest.ts:60`
- Modify: `frontend/src/docs/articles/backup-plans/managed-agent.md:1`, `:3`, and a new section before `## Salinan S3 opsional`
- Modify: `frontend/src/docs/articles/remote-agent.md:9`, `:11`, `:38`
- Modify: `frontend/src/docs/articles/getting-started.md:30`, `:39`
- Test: `frontend/__tests__/docs.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: article title `Membuat plan Managed Agent dengan SFTP atau S3 primer` (manifest and H1 must match; `docs.test.ts` asserts it).

- [ ] **Step 1: Write the failing test**

Append to `frontend/__tests__/docs.test.ts`:

```ts
test('Managed Agent guide documents the S3 primary boundary', () => {
   const guide = index.find((item) => item.slug === 'backup-plans/managed-agent')!;
   assert.equal(guide.title, 'Membuat plan Managed Agent dengan SFTP atau S3 primer');
   for (const term of ['S3 sebagai repository primer', 'Agent 0.8.0', 'Root bucket ditolak', 'tersegel', 'Enable Replication', 'Move Repository'])
      assert(guide.markdown.includes(term), term);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node --experimental-strip-types --test frontend/__tests__/docs.test.ts
```

Expected: `ℹ fail 1` (the title is still `Membuat plan Managed Agent dengan SFTP primer`); the 13 existing tests pass.

- [ ] **Step 3: Update the documentation**

In `frontend/src/docs/manifest.ts`, replace:

```ts
         page("backup-plans/managed-agent", "Membuat plan Managed Agent dengan SFTP primer", "operator-setup"),
```

with:

```ts
         page("backup-plans/managed-agent", "Membuat plan Managed Agent dengan SFTP atau S3 primer", "operator-setup"),
```

In `frontend/src/docs/articles/backup-plans/managed-agent.md`, replace line 1:

```md
# Membuat plan Managed Agent dengan SFTP primer
```

with:

```md
# Membuat plan Managed Agent dengan SFTP atau S3 primer
```

Replace line 3:

```md
Gunakan plan Managed Agent untuk mencadangkan satu folder aplikasi pada mesin Linux lain. Agent membaca source dan menulis snapshot ke SFTP primer. Setelah server memverifikasi snapshot, server dapat menyalinnya ke paling banyak dua repository S3 tambahan.
```

with:

```md
Gunakan plan Managed Agent untuk mencadangkan satu folder aplikasi pada mesin Linux lain. Agent membaca source dan menulis snapshot ke repository primer SFTP atau, dengan Agent 0.8.0, S3. Untuk primer SFTP, setelah server memverifikasi snapshot, server dapat menyalinnya ke paling banyak dua repository S3 tambahan.
```

Insert directly before the line `## Salinan S3 opsional`:

```md
## S3 sebagai repository primer (Agent 0.8.0)

Plan Managed Agent dapat memakai storage **AWS S3** atau **S3 Compatible Storage** sebagai repository primer bila Agent mesin itu versi 0.8.0 atau lebih baru dan melaporkan dukungan S3. Agent menulis snapshot langsung ke S3 dari host-nya sendiri; data tidak melewati server Pluton. Untuk Agent lama, pilihan S3 tidak muncul pada **Backup Destination*** dan formulir menjelaskan alasannya. Server juga menolak mengantrekan backup plan S3 bila Agent tidak lagi melaporkan dukungan itu.

1. Siapkan storage dengan endpoint HTTPS. Untuk S3 compatible atau endpoint non-AWS, aktifkan **HCP / pre-existing namespace mode** seperti pada [panduan HCP](/docs/storage/hcp). `env_auth` tidak didukung.
2. Isi prefix khusus plan di dalam bucket, misalnya `agents/app-01`. Root bucket ditolak. Prefix tidak boleh berada di dalam, di atas, atau sama dengan repository primer maupun replika plan lain.
3. Pada backup pertama Agent menolak inisialisasi bila prefix sudah berisi objek. Pilih prefix baru; jangan mengosongkan prefix yang mungkin milik plan lain.

Untuk setiap backup, Agent menerima kunci S3 milik storage primer plan ini dalam bentuk tersegel dan tidak pernah menerima kunci replika. Bila beberapa plan memakai kredensial S3 yang sama, host Agent yang disusupi dapat membaca dan menghapus data plan lain dalam namespace itu. Replikasi dari primer S3 belum tersedia pada tahap ini, sehingga **Enable Replication** dinonaktifkan dan **Move Repository** tidak ditampilkan. Browse, Download, Restore ke staging, Recovery Testing dan pemulihan artifact database membaca primer S3 melalui server.

```

In `frontend/src/docs/articles/remote-agent.md`, replace:

```md
Untuk data backup, agent mengakses SFTP primer yang dipilih plan; server juga perlu mengakses primer untuk verifikasi dan pekerjaan lanjutan.
```

with:

```md
Untuk data backup, agent mengakses repository primer (SFTP, atau S3 untuk Agent 0.8.0) yang dipilih plan; server juga perlu mengakses primer untuk verifikasi dan pekerjaan lanjutan.
```

Replace:

```md
Salinan opsional ke S3/HCP dikerjakan oleh server sesudah snapshot diverifikasi, dan kredensial S3 tidak dikirim ke agent.
```

with:

```md
Salinan opsional ke S3/HCP dikerjakan oleh server sesudah snapshot diverifikasi, dan kredensial replika tidak pernah dikirim ke agent. Agent hanya menerima kunci S3 milik plan yang primernya S3, dalam bentuk tersegel per backup.
```

Replace:

```md
Primer Managed Agent hanya SFTP dengan konfigurasi yang dibatasi.
```

with:

```md
Primer Managed Agent adalah SFTP dengan konfigurasi yang dibatasi, atau S3 untuk Agent 0.8.0 yang melaporkan dukungan S3.
```

In `frontend/src/docs/articles/getting-started.md`, replace:

```md
Untuk Managed Agent, tujuan primer wajib SFTP; layanan SFTP boleh berada pada VM Pluton bila administrator menyiapkannya.
```

with:

```md
Untuk Managed Agent, tujuan primer adalah SFTP, atau S3 bila Agent 0.8.0 melaporkan dukungan S3; layanan SFTP boleh berada pada VM Pluton bila administrator menyiapkannya.
```

Replace:

```md
Managed Agent mendukung source filesystem yang dibatasi administrator, SFTP primer, serta 0–2 replika S3 opsional yang dikerjakan server.
```

with:

```md
Managed Agent mendukung source filesystem yang dibatasi administrator, SFTP primer (atau S3 primer dengan Agent 0.8.0, tanpa replikasi pada tahap ini), serta 0–2 replika S3 opsional yang dikerjakan server untuk primer SFTP.
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
node --experimental-strip-types --test frontend/__tests__/docs.test.ts
```

Expected: `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0` (titles match headings, every internal link resolves, no credential-like values).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/docs/manifest.ts frontend/src/docs/articles/backup-plans/managed-agent.md frontend/src/docs/articles/remote-agent.md frontend/src/docs/articles/getting-started.md frontend/__tests__/docs.test.ts
git diff --cached --check
git commit -m "docs(agent-s3): document S3 as a Managed Agent primary repository"
```

---

### Task 14: Accept Agent 0.8.0 for new installations (section 6.7)

Spec 6.7 installs the ERP and research hosts directly with Agent 0.8.0, after `AGENT_INSTALL_COMMIT` and `AGENT_INSTALL_VERSION` in the server `.env` point at the reviewed 0.8.0 commit. Today the server and the browser accept only `0.7.0` and `0.7.1`, so `AGENT_INSTALL_VERSION=0.8.0` would make token creation fail with 503. This task adds `0.8.0` to both allowlists. The generated install command is unchanged apart from the version argument: it still verifies on the host, before sudo, that `agent/package.json` and the runtime `AGENT_VERSION` at the pinned commit equal `0.8.0`, so the pin only works once the reviewed 0.8.0 commit exists. Setting the `.env` values stays an operator step after the Agent pull request merges.

**Files:**
- Modify: `backend/src/utils/agentDistribution.ts:20`
- Modify: `frontend/src/utils/agentEnrollment.ts:14`
- Modify: `.env.template:14`, `deploy/.env.example:29`
- Modify: `frontend/src/docs/articles/deployment/configuration.md:18`, `frontend/src/docs/articles/reference/configuration.md:13`, `frontend/src/docs/articles/remote-agent/enrollment.md:26`, `:48`, `frontend/src/docs/articles/getting-started/complete-backup-setup.md:92`
- Modify: `docs/AGENT_ENROLLMENT_DISTRIBUTION.md:19`, `docs/ARCHITECTURE.md:126`
- Test: `backend/__tests__/utils/agentDistribution.test.ts:25`, `:27`, `:40`, `:51`; `frontend/__tests__/agentEnrollment.test.ts:37`, `:55`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SUPPORTED_AGENT_INSTALL_VERSIONS = ['0.7.0', '0.7.1', '0.8.0']` in `backend/src/utils/agentDistribution.ts` and `frontend/src/utils/agentEnrollment.ts`; the 503 message becomes `... supported Agent version (0.7.0 or 0.7.1 or 0.8.0).`

- [ ] **Step 1: Change the test expectations**

In `backend/__tests__/utils/agentDistribution.test.ts`, replace:

```ts
		expect(SUPPORTED_AGENT_INSTALL_VERSIONS).toEqual(['0.7.0', '0.7.1']);
	});
	it.each(['0.7.0', '0.7.1'])(
```

with:

```ts
		expect(SUPPORTED_AGENT_INSTALL_VERSIONS).toEqual(['0.7.0', '0.7.1', '0.8.0']);
	});
	it.each(['0.7.0', '0.7.1', '0.8.0'])(
```

Replace:

```ts
			'supported Agent version (0.7.0 or 0.7.1)'
```

with:

```ts
			'supported Agent version (0.7.0 or 0.7.1 or 0.8.0)'
```

In the list of refused `AGENT_INSTALL_VERSION` values in the same file, replace:

```ts
			'',
			'0.8.0',
			'0.7.2',
```

with:

```ts
			'',
			'0.8.1',
			'0.7.2',
```

In `frontend/__tests__/agentEnrollment.test.ts`, replace:

```ts
   assert.deepEqual(SUPPORTED_AGENT_INSTALL_VERSIONS, ['0.7.0', '0.7.1']);
```

with:

```ts
   assert.deepEqual(SUPPORTED_AGENT_INSTALL_VERSIONS, ['0.7.0', '0.7.1', '0.8.0']);
```

Replace:

```ts
      ...['', '0.8.0', '0.7.2', '0.6.9', '0.7', '0.7.1-dev', 'v0.7.1', ' 0.7.1', "0.7.1'", 'latest'].map((version) => ({ version })),
```

with:

```ts
      ...['', '0.8.1', '0.7.2', '0.6.9', '0.7', '0.7.1-dev', 'v0.7.1', ' 0.7.1', "0.7.1'", 'latest'].map((version) => ({ version })),
```

The two list assertions now include `0.8.0`. The two refused-version lists swap `0.8.0`, which becomes accepted by design, for `0.8.1`, an unreviewed next version, so they still prove that anything outside the allowlist fails closed. Nothing else changes in these files.

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/utils/agentDistribution.test.ts
```

Expected: FAIL in three tests: `allows exactly the reviewed standalone releases` (received `['0.7.0', '0.7.1']`), the `0.8.0` case of `passes reviewed standalone version %s through unchanged for the host-side check` (503 thrown), and `names every supported version in the sanitized refusal` (message ends `(0.7.0 or 0.7.1).`). The other 30 tests pass.

```bash
node --experimental-strip-types --test frontend/__tests__/agentEnrollment.test.ts
```

Expected: `ℹ fail 1`: `the reviewed version allowlist matches the server and is the exact value verified on the host` (deepEqual difference); the other 3 tests pass.

- [ ] **Step 3: Change the allowlists**

In `backend/src/utils/agentDistribution.ts`, replace:

```ts
export const SUPPORTED_AGENT_INSTALL_VERSIONS: readonly string[] = ['0.7.0', '0.7.1'];
```

with:

```ts
export const SUPPORTED_AGENT_INSTALL_VERSIONS: readonly string[] = ['0.7.0', '0.7.1', '0.8.0'];
```

In `frontend/src/utils/agentEnrollment.ts`, replace:

```ts
export const SUPPORTED_AGENT_INSTALL_VERSIONS: readonly string[] = ['0.7.0', '0.7.1'];
```

with:

```ts
export const SUPPORTED_AGENT_INSTALL_VERSIONS: readonly string[] = ['0.7.0', '0.7.1', '0.8.0'];
```

- [ ] **Step 4: Update the configuration comments and guides**

In both `.env.template` and `deploy/.env.example`, replace:

```text
# Reviewed standalone version: 0.7.0 or 0.7.1, equal to agent/package.json at that commit.
```

with:

```text
# Reviewed standalone version: 0.7.0, 0.7.1 or 0.8.0, equal to agent/package.json at that commit.
```

In `frontend/src/docs/articles/deployment/configuration.md`, `frontend/src/docs/articles/reference/configuration.md` and `frontend/src/docs/articles/getting-started/complete-backup-setup.md`, replace the text `versi 0.7.0 atau 0.7.1 yang` with `versi 0.7.0, 0.7.1 atau 0.8.0 yang` (one occurrence per file).

In `frontend/src/docs/articles/remote-agent/enrollment.md`, replace `` `AGENT_INSTALL_VERSION` (0.7.0 atau 0.7.1) `` with `` `AGENT_INSTALL_VERSION` (0.7.0, 0.7.1 atau 0.8.0) ``, and replace `` (`0.7.0` atau `0.7.1`, harus `` with `` (`0.7.0`, `0.7.1` atau `0.8.0`, harus ``.

In `docs/AGENT_ENROLLMENT_DISTRIBUTION.md`, replace `` | `0.7.0` or `0.7.1`, the reviewed standalone releases. `` with `` | `0.7.0`, `0.7.1` or `0.8.0`, the reviewed standalone releases. ``

In `docs/ARCHITECTURE.md`, replace `SHA + Agent 0.7.0 or 0.7.1) is described in` with `SHA + Agent 0.7.0, 0.7.1 or 0.8.0) is described in`.

Then confirm nothing listing only the old pair is left in these files:

```bash
grep -n "0\.7\.0 or 0\.7\.1\b\|0\.7\.0 atau 0\.7\.1\b\|\`0\.7\.0\` or \`0\.7\.1\`\|\`0\.7\.0\` atau \`0\.7\.1\`" .env.template deploy/.env.example frontend/src/docs/articles/deployment/configuration.md frontend/src/docs/articles/reference/configuration.md frontend/src/docs/articles/remote-agent/enrollment.md frontend/src/docs/articles/getting-started/complete-backup-setup.md docs/AGENT_ENROLLMENT_DISTRIBUTION.md docs/ARCHITECTURE.md
```

Expected: no output. (Historical reports such as `docs/AGENT_DISTRIBUTION_0_7_1.md`, `docs/MCP.md`, `docs/REMOTE_AGENT_FOUNDATION.md` and `docs/AGENT_SOURCE_ACCESS.md` describe what was true when they were written and stay unchanged.)

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/utils/agentDistribution.test.ts __tests__/services/AgentService.test.ts
```

Expected: PASS; `agentDistribution.test.ts` reports 33 tests and `AgentService.test.ts` 47, 0 failed.

```bash
node --experimental-strip-types --test frontend/__tests__/agentEnrollment.test.ts frontend/__tests__/docs.test.ts frontend/__tests__/agentSourceAccessUi.test.ts
```

Expected: `ℹ fail 0` (agentEnrollment 4, docs 14, agentSourceAccessUi 30).

- [ ] **Step 6: Type-check**

```bash
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-frontend exec tsc -b
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add backend/src/utils/agentDistribution.ts frontend/src/utils/agentEnrollment.ts backend/__tests__/utils/agentDistribution.test.ts frontend/__tests__/agentEnrollment.test.ts .env.template deploy/.env.example frontend/src/docs/articles/deployment/configuration.md frontend/src/docs/articles/reference/configuration.md frontend/src/docs/articles/remote-agent/enrollment.md frontend/src/docs/articles/getting-started/complete-backup-setup.md docs/AGENT_ENROLLMENT_DISTRIBUTION.md docs/ARCHITECTURE.md
git diff --cached --check
git commit -m "feat(agent-distribution): accept Agent 0.8.0 for new installations"
```

---

### Task 15: Full verification and the report

**Files:**
- Create: `docs/S3_AGENT_REPOSITORY_SERVER.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the report the user reads before pushing.

- [ ] **Step 1: Run the full backend suite**

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest --runInBand 2>&1 | tail -8
```

Expected: `Tests:` line with 0 failed. Known flaky case: the `PlanService` suite can time out in Pino teardown during a full run; if exactly that suite fails, run it alone and record both results:

```bash
cd backend && TEMP='C:\laragon\www\pluton\tmp\t' TMP='C:\laragon\www\pluton\tmp\t' npx jest __tests__/services/PlanService.test.ts
```

Expected: PASS when run alone. Any other failure is a defect to fix before continuing.

- [ ] **Step 2: Backend type-check, lint and build**

```bash
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-backend lint
```

Expected: both exit 0.

- [ ] **Step 3: Frontend tests and type-check**

```bash
node --experimental-strip-types --test frontend/__tests__/*.test.ts 2>&1 | tail -8
pnpm --filter @plutonhq/core-frontend exec tsc -b
```

Expected: `ℹ fail 0`; `tsc -b` exits 0.

- [ ] **Step 4: Build and whitespace check**

```bash
pnpm build
git diff --check origin/main...HEAD
```

Expected: `pnpm build` ends with all Turbo tasks successful; `git diff --check` prints nothing.

- [ ] **Step 5: Write the report**

Create `docs/S3_AGENT_REPOSITORY_SERVER.md` with the content below. In the Tests table, replace each text in square brackets in the Result column with the exact summary line printed by the step named in that row (for example `Tests: 5,021 passed, 4 skipped`); do not round, and write `BLOCKED: <reason>` for a step that could not run.

```md
# S3 as a Managed Agent repository: server and frontend (stage 1)

Design: [S3_AGENT_REPOSITORY_DESIGN.md](S3_AGENT_REPOSITORY_DESIGN.md), sections 6.1, 6.3, 6.4,
6.5, the server half of 6.6 and 6.7, section 7 and the section 10 wire contract.

## Goal

Managed Agent plans could only use an SFTP repository: `RemoteBackupService` refused every
other storage with "Remote filesystem backups currently require an SFTP destination.". This
change lets a new Agent plan use an `s3` or `s3compatible` storage as its primary, written
directly by an Agent that reports S3 support, and makes every server read of that primary work
(browse, download, export, preview, restore, comparison, recovery tests, database restore
artifacts). Nothing was broken before; this adds a capability. No installed Agent reports S3
support yet, so after deployment the UI and API behave exactly as before until an Agent 0.8.0
is installed (separate pull request).

## What changed

| Area | Change |
| --- | --- |
| Capabilities | The strict inventory schema accepts optional `repositoryBackends` (`'sftp'`/`'s3'`, 1 to 2, no duplicates, must contain `'sftp'`) and `backupPayloadVersion: 5`. An Agent that omits them is SFTP-only with payload version 4. |
| Eligibility | At plan create, update, queue and poll: an S3 primary needs an Agent with `s3` and version 5 (otherwise HTTP 409 "Remote agent does not support S3 repositories. Update the agent first."), the replication-destination HCP rules, a prefix inside the bucket (bucket root refused), and no overlap with another plan's primary or replica (HTTP 409). Replication settings are refused for an S3 primary (HTTP 400). Unsupported storage settings with a meaningful value are refused by name, never silently dropped. |
| Payload version 5 | Sent to every Agent that reports version 5, for SFTP and S3. Plain options are exactly the section 10.2 allowlist; the repository password, `pass` and the S3 keys are sealed. `sourceDiagnosticsVersion: 1` is sent exactly as today. The payload carries no trust or CA setting; the Agent uses its own `PLUTON_AGENT_STORAGE_CA_FILE`. Agents without version 5 keep versions 1 to 4 byte for byte. |
| Sealing | HKDF-SHA256 over the per-Agent secret with info `pluton-agent-command-secrets-v1`, AES-256-GCM, random 12-byte nonce, additional data bound to the command ID and lease token. `AgentService.poll` passes the secret and lease token; the HMAC signature covers the payload including `sealed`. The section 10.4 vector is a unit test. |
| Read path | `RemoteRepositoryRecoveryService.context()` asks `RemoteBackupService.getRepositoryAccessOptions()` for the access of the repository's storage type, and a session router builds `ManagedSftpRepositorySession` or `ManagedS3RecoverySession` per call (operator trust from `PLUTON_STORAGE_CA_FILE`). Reads never consult the Agent. |
| Move Repository | Refused for a primary that is not SFTP (server) and hidden in the plan menu (UI). |
| Frontend | S3 storages are offered for a remote plan only when the machine's Agent reports S3; otherwise the form says why. Replication is disabled with a note for an S3 primary. "Primary SFTP" wording is generalised to "primary repository". |
| In-app documentation | The Managed Agent guide gains an S3 primary section; Remote Agent and Getting Started wording is generalised. |
| Agent distribution | `SUPPORTED_AGENT_INSTALL_VERSIONS` (server and browser) accepts `0.7.0`, `0.7.1` and `0.8.0`. The generated install command still verifies the package and runtime version on the host before sudo. `.env.template`, `deploy/.env.example` and the configuration and enrollment guides list the three versions. |

Unchanged: existing SFTP plans and their replication, completion handling (snapshot ID,
summary, database artifacts, `initialized_at`), Agent failure stages and codes, enrollment
tokens and the other `AGENT_INSTALL_*` checks (HTTPS repository, full reviewed SHA).

## Data model

No migration. Agent capabilities are stored as JSON in `agent_identities.capabilities` and
written verbatim on heartbeat; `remote_managed_repositories` already stores a generic
`storage_id`/`storage_path`.

## Files changed

- `backend/src/utils/agentCommandSealing.ts` (new)
- `backend/src/utils/agentS3Repository.ts` (new)
- `backend/src/utils/restic/ManagedRepositorySessionRouter.ts` (new)
- `backend/src/utils/storageSecurity.ts`
- `backend/src/types/agents.ts`
- `backend/src/services/AgentService.ts`
- `backend/src/services/remoteCommandPreparation.ts`
- `backend/src/services/RemoteBackupService.ts`
- `backend/src/services/RemoteRepositoryRecoveryService.ts`
- `backend/src/services/PlanRepositoryRelocationService.ts`
- `backend/__tests__/utils/agentCommandSealing.test.ts` (new)
- `backend/__tests__/utils/agentS3Repository.test.ts` (new)
- `backend/__tests__/utils/restic/ManagedRepositorySessionRouter.test.ts` (new)
- `backend/__tests__/utils/storageSecurity.test.ts`
- `backend/__tests__/services/AgentService.test.ts`
- `backend/__tests__/services/RemoteBackupService.test.ts`
- `backend/__tests__/services/RemoteRepositoryRecoveryService.test.ts`
- `backend/__tests__/services/PlanRepositoryRelocationService.test.ts`
- `backend/__tests__/integration/replicaRecovery.lab.ts`
- `frontend/src/utils/agentRepository.ts` (new)
- `frontend/src/@types/devices.ts`
- `frontend/src/components/Plan/PlanForm/PlanForm.tsx`
- `frontend/src/components/Plan/PlanSettings/PlanReplicationSettings.tsx`
- `frontend/src/utils/assistedRecovery.ts`
- `frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.tsx`
- `frontend/src/routes/PlanSingle/PlanSingle.tsx`
- `frontend/__tests__/agentS3Repository.test.ts` (new)
- `frontend/__tests__/managedReplication.test.ts`
- `frontend/__tests__/assistedRecovery.test.ts`
- `frontend/__tests__/agentSourceAccessUi.test.ts`
- `frontend/__tests__/docs.test.ts`
- `frontend/src/docs/manifest.ts`
- `frontend/src/docs/articles/backup-plans/managed-agent.md`
- `frontend/src/docs/articles/remote-agent.md`
- `frontend/src/docs/articles/getting-started.md`
- `backend/src/utils/agentDistribution.ts`
- `frontend/src/utils/agentEnrollment.ts`
- `backend/__tests__/utils/agentDistribution.test.ts`
- `frontend/__tests__/agentEnrollment.test.ts`
- `.env.template`
- `deploy/.env.example`
- `frontend/src/docs/articles/deployment/configuration.md`
- `frontend/src/docs/articles/reference/configuration.md`
- `frontend/src/docs/articles/remote-agent/enrollment.md`
- `frontend/src/docs/articles/getting-started/complete-backup-setup.md`
- `docs/AGENT_ENROLLMENT_DISTRIBUTION.md`
- `docs/ARCHITECTURE.md`
- `docs/S3_AGENT_REPOSITORY_SERVER.md` (this report)

Existing test assertions that changed:

- `AgentService.test.ts` ("materializes BACKUP_FILESYSTEM credentials only for the signed
  leased response") now also expects the third `materializeCommand` argument
  `{ agentSecret, leaseToken }`. Nothing was removed.
- `agentDistribution.test.ts` and `agentEnrollment.test.ts`: the allowlist expectations include
  `0.8.0` (and the pass-through cases gain `0.8.0`). In the refused-version lists, `0.8.0`,
  now accepted by design, was replaced with `0.8.1`, so an unreviewed version is still proven
  to fail closed.
- `agentSourceAccessUi.test.ts`: three bundler stubs now render empty elements with data
  attributes instead of `null`.

## Tests

| Check | Result |
| --- | --- |
| Backend suite `npx jest --runInBand` (Task 15 Step 1) | [Tests line from Step 1] |
| `PlanService` alone, only if it failed in the full run | [result or "not needed"] |
| Backend `tsc --noEmit` and ESLint (Step 2) | [result] |
| Frontend tests `node --experimental-strip-types --test frontend/__tests__/*.test.ts` (Step 3) | [tests/pass/fail line] |
| Frontend `tsc -b` (Step 3) | [result] |
| `pnpm build` (Step 4) | [result] |
| Replica lab with the S3 primary scenario (Task 9 Step 3) | [PASS line and exit code, or BLOCKED with reason] |
| Hosted CI | Not run yet; runs on the pull request. |

## Deployment, Agent and UAT

- Migration: none. Server `.env`: no change for this pull request.
- Agents: no update or re-enrollment needed. Existing Agents keep payload versions 1 to 4 and see
  no difference.
- Order: deploy this server first (by reviewed image digest), then install Agent 0.8.0 from the
  Agent pull request. Rollback: Agent first, then server.
- Installing 0.8.0: this server accepts `AGENT_INSTALL_VERSION=0.8.0`. Pinning it is an operator
  step after the Agent pull request merges: set `AGENT_INSTALL_COMMIT` to the reviewed 0.8.0
  commit and `AGENT_INSTALL_VERSION=0.8.0` in the server `.env`, then redeploy through the
  normal procedure. Until then keep the current values; nothing changes for existing Agents.

UAT after deploying this server, before any 0.8.0 Agent exists:

1. The footer shows the new revision.
2. Run **Backup Now** on one existing SFTP Agent plan. It completes; **Browse** opens the snapshot.
3. **Backup Plans → + New**, pick an existing Agent machine. On **Backup Destination** only SFTP
   storages are listed and the form says "S3 storages are not offered for this machine because
   its Agent does not report S3 repository support."
4. Open an existing SFTP Agent plan: **Move Repository** is still in the menu; replication
   settings look as before.
5. **Sources → Add Remote Machine** with the current `.env` still creates a token and shows the
   installation command for the currently pinned version. Revoke the token afterwards.

UAT after the Agent pull request merges, the operator pins 0.8.0 in `.env`, and an Agent 0.8.0
is installed:

6. **+ New** for that machine: S3 storages are listed. Pick the HCP storage, enter a new prefix
   such as `agents/<host>`. **Enable Replication** is disabled with the note. Create the plan and
   run **Backup Now**; it completes.
7. **Browse**, download one file, restore to staging, and run a Recovery Test (including the
   database artifact if the plan dumps a database).
8. The plan menu has no **Move Repository**.

If a step fails, record only: plan ID, backup ID, the backup error text shown in the UI, and from
the server log either the `remote_backup_command_preparation_failed` fields `failureStage`,
`rejectedField`, `ruleCategory`, or the `command_failed` fields `failureStage`, `failureCode`.
Do not copy payloads, storage settings or `.env`.

## Rollback

- Agent first: reinstall the previous Agent. The server then refuses to queue backups for S3
  plans with HTTP 409 "Remote agent does not support S3 repositories. Update the agent first."
  instead of sending a payload the Agent cannot read. Snapshots already in S3 stay readable.
- Server: redeploy the previous image by digest. No schema change, so no downgrade step. With the
  older server, S3-primary plans fail to back up and their snapshots are not reachable from the
  UI until this version is deployed again; their data in S3 is untouched.

## Decisions from the design

1. `sourceDiagnosticsVersion: 1` is sent in payload version 5 exactly as today (design 10.2), so
   Agent 0.8.0 keeps path-level source diagnostics.
2. The payload carries no trust or CA setting (design 6.1 point 2); the server applies
   `PLUTON_STORAGE_CA_FILE` only on its own read path.
3. `AGENT_INSTALL_VERSION=0.8.0` is accepted by this server; the `.env` pin is an operator step
   after the Agent pull request merges.

## Limitations

- The overlap check runs in the service, not inside the plan write transaction. Two S3 plans
  created at the same moment with overlapping prefixes could both pass; the Agent's refusal to
  initialize a non-empty prefix is the backstop, and `PlanStore` keeps refusing overlap with
  registered replica destinations transactionally.
- One shared HCP user means a compromised Agent host can read and delete other plans' S3 data in
  the namespace (accepted by the operator on 15 November 2026).
- No replication, failover or Move Repository for S3 primaries (design stages 2 to 4).
- Not tested against a real HCP tenant; the lab uses `rclone serve s3` with a private CA.
- Storage settings outside the Agent allowlist with a non-default value refuse the plan with the
  field name; adjust the storage or use another one.
```

- [ ] **Step 6: Commit**

```bash
git add docs/S3_AGENT_REPOSITORY_SERVER.md
git diff --cached --check
git commit -m "docs(agent-s3): report the S3 Agent repository server change"
git log --oneline origin/main..HEAD
```

Expected: 15 commits listed, newest first, from `docs(agent-s3): report the S3 Agent repository server change` down to `feat(agent-s3): seal command secrets for payload version 5`. Do not push; tell the user the branch name and the list.

---

## Self-review against the spec

**Coverage**

| Spec item | Task |
| --- | --- |
| 6.1.1 capability gating at create, update, queue (and poll) | 2, 4, 5 |
| 6.1.1 HCP validation (`hcp_mode`, HTTPS, no `env_auth`) | 3, 4 |
| 6.1.1 prefix inside the bucket, no bucket root | 4 (`canonicalS3RepositoryIdentity`) |
| 6.1.1 no overlap with other primaries and replication destinations | 3, 4 (service check); `PlanStore` transactional check unchanged |
| 6.1.1 replication refused for an S3 primary | 4 (server), 10 to 12 (UI) |
| 6.1.2 payload version 5, S3 options plus `force_path_style`/`use_accept_encoding_gzip`, version 4 unchanged | 3, 5 |
| 6.1.2 no trust or CA setting in the payload; server trust only on its read path | 5 (no trust field in `common` or `rclone`), 7 (`trustEnvironment()` in the router) |
| 6.1.3 `context()` by storage type, session factory keyed by access type | 7 |
| 6.1.4 no migration, confirmed before code | Verified findings |
| 6.1.5 completion unchanged, no replication for S3 | 5 (regression test) |
| 6.3 sealing: HKDF label, AES-256-GCM, AAD, HMAC over `sealed`, SFTP sealed too | 1, 5, 6 |
| 6.4 S3 offered per Agent with explanation, replication disabled with note, wording generalised | 10, 11, 12, 13 |
| 6.5 data flow (queue reference unchanged, seal at lease time) | 4 (queue test), 6 |
| 6.6 server unit tests and S3 primary lab | 1 to 8, 9 |
| 6.7 server first, refusal with old Agent, S3 snapshots readable after Agent rollback | 4, 5, 7, report |
| 6.7 `AGENT_INSTALL_VERSION` 0.8.0 accepted; `.env` pin is an operator step after the Agent PR | 14, report (Task 15) |
| 7 Agent without S3 support | 4, 5, 10, 12 |
| 7 other rows (wrong key, unreachable, non-empty prefix, sealed invalid) | Agent-side; server messages already storage-neutral (Verified findings) |
| 10.1, 10.2 (including `sourceDiagnosticsVersion: 1` sent unchanged), 10.3, 10.4 | 1, 2, 3, 5, 6 |
| Final report | 15 |

Not mapped, by design: the stage 0 probe and all Agent changes (other plans).

**Placeholder scan.** No "TBD", "TODO", "similar to Task N" or undescribed steps. The only
bracketed text is in the report's Tests table, where Task 15 Step 5 tells the engineer to
paste the real command output; it cannot be known before the run.

**Signature consistency.**
- `materializeCommand(agentId: string, command: AgentCommand, sealing?: AgentCommandSealingContext)` (Task 5) matches the call in Task 6 and the tests in Tasks 4 to 6.
- `AgentCommandSealingContext = { agentSecret: string; leaseToken: string }` (Task 1) is the object built in Task 6 and the `sealing` constant in Task 5 tests.
- `agentS3RepositoryOptions(storage, credentials)` returns `{ options, secrets }` (Task 3) and is used that way in Tasks 4, 5 and 7.
- `AgentS3OptionError.field` / `.rule` (Task 3) feed `rejectedField` / `ruleCategory` (Tasks 4 and 5); the rule literals equal `RemoteCommandPreparationRuleCategory`.
- Stages `'storage-lookup'`, `'repository-backend'`, `'s3-storage-validation'` (Task 4) and `'payload-sealing'` (Task 5) are added before their first use.
- `getRepositoryAccessOptions(storageId)` (Task 7) is what `context()` calls and what the lab invokes; it relies on `materializeRepositoryStorage` from Task 5.
- `decryptStorageCredentials(storage, secret?)` (Task 3) is called with `this.encryptionSecret` in Tasks 4 and 5.
- Frontend `unavailableReason` (Task 11) is the prop PlanForm passes (Task 12) and the stub reads (Task 12 test); helper names in Task 12 imports match Task 10 exports.
- `SUPPORTED_AGENT_INSTALL_VERSIONS` keeps its name and type (`readonly string[]`) in both files (Task 14); the 503 message still joins the list with `' or '`, which is the string the updated backend test expects.
- Task 5's S3 payload test expects `sourceDiagnosticsVersion: 1` for Agent 0.8.0, matching section 10.2.
- Test counts: RemoteBackupService 35 → 43 (Task 4) → 49 (Task 5) → 50 (Task 7); AgentService 45 → 46 (Task 2) → 47 (Task 6); RemoteRepositoryRecoveryService 131 → 132; PlanRepositoryRelocationService 23 → 24; storageSecurity 25 → 26; agentDistribution 32 → 33 (Task 14); frontend managedReplication 15 → 17, assistedRecovery 19 → 20, agentSourceAccessUi 29 → 30, docs 13 → 14, agentEnrollment 4 → 4.
- Commits: 15, one per task.
