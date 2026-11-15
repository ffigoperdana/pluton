# S3 Agent Repository, Agent 0.8.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the standalone Linux Managed Agent (`C:\laragon\www\pluton-agent`) back up a Managed Agent plan directly to an S3-compatible repository (HCP) as stage 1 of `docs/S3_AGENT_REPOSITORY_DESIGN.md` (Pluton server repository): `BACKUP_FILESYSTEM` payload version 5 with sealed secrets, an S3 option allowlist, an operator-installed storage CA, S3 empty-target and failure classification, capabilities `repositoryBackends`/`backupPayloadVersion`, Agent version 0.8.0, a new contract vector, an installer key and a Docker lab with an HTTPS S3 fixture behind a private CA.

**Architecture:** A new module `agent/src/sealedSecrets.ts` opens the version 5 `sealed` field with HKDF-SHA256 and AES-256-GCM, bound to the command ID and lease token. `parseBackupFilesystemPayload` gains version 5 and receives the leased-command context from `runtime.ts` (`identity.secret`, `command.id`, `command.leaseToken`, the same values `client.poll()` already used to verify the command HMAC), so secrets are opened during `payload-validation`, before any file is written. `executeFilesystemBackup` writes `[pluton] type = s3` without `rclone obscure`, passes `PLUTON_AGENT_STORAGE_CA_FILE` as `SSL_CERT_FILE`, checks S3 access with Rclone directly (Restic's Rclone bridge hides provider errors), treats an empty S3 listing as an empty target and maps S3/HTTP failures onto the existing closed failure codes. Versions 1 to 4 stay byte-for-byte SFTP-only.

**Tech Stack:** TypeScript 5.9.3 (NodeNext, strict), Node 22.23.4 private runtime (`node:crypto`, `node:test`), pnpm 10.20.0 with the frozen lockfile and no new dependencies, Restic 0.19.1 and Rclone 1.75.1 (pinned, unchanged), Bash installer, Docker Desktop for the Ubuntu 22.04/24.04 validation images and the MySQL post-dump lab, PowerShell runner `scripts/validate-post-dump.ps1`.

## Global Constraints

- Repository and branch: `C:\laragon\www\pluton-agent`, branch `claude/agent-s3-repository` created with `git switch -c claude/agent-s3-repository --no-track origin/main` after `git fetch origin` (`origin/main` was `4c2c3f3`, merge of PR #9, when this plan was written). Line numbers below refer to `4c2c3f3`; locate code by the quoted text when an earlier task moved it.
- Deployment order: the Pluton server stage 1 PR is deployed first, because its inventory `capabilities` schema in `AgentService.ts` is `.strict()` and refuses an Agent that reports `repositoryBackends` or `backupPayloadVersion` (this applies to both enrollment and heartbeat, so an older server would stop a 0.8.0 Agent entirely). Rollback is Agent first, then server.
- The server must also accept `AGENT_INSTALL_VERSION=0.8.0` (its install gate accepted only 0.7.0/0.7.1 after PR #81); that change belongs to the server plan.
- Agent version is exactly `0.8.0` in `agent/src/inventory.ts` (`AGENT_VERSION`), `package.json`, `agent/package.json` and `contracts/standalone-source-v1.json` (`agentVersion`); the release manifest contract name is `pluton-agent-0.8.0`.
- Capabilities (spec 10.1), added to `AgentCapabilities` in `agent/src/types.ts`: `repositoryBackends: ["sftp", "s3"]` (array of `'sftp'`/`'s3'`, 1 to 2 entries, no duplicates, must contain `'sftp'`) and `backupPayloadVersion: 5` (literal). An Agent that omits them is treated as `['sftp']` and payload version 4.
- Payload version 5 (spec 10.2): `version: 5`, optional `lifecycle` (unchanged), `backupId`, `planId`, `sourcePath`, `excludes`, `sourceDiagnosticsVersion: 1` (sent exactly as today and must be accepted in version 5), `repository: { remoteName: "pluton", path, initialize }` (path is the SFTP directory, or `bucket/prefix` for S3), `rclone: { type: "sftp" | "s3", options }`, `sealed: { alg: "A256GCM", kid: "pluton-agent-command-secrets-v1", nonce: <base64, 12 bytes>, ciphertext: <base64>, tag: <base64, 16 bytes> }`. `repositoryPassword` is not a top-level field in version 5. The payload carries no trust or CA setting (spec 6.1 point 2); the Agent uses only its own `PLUTON_AGENT_STORAGE_CA_FILE`, and any trust-like key or field is refused as unknown.
- Allowed plain options (spec 10.2): SFTP `host`, `port`, `user`; S3 `provider`, `endpoint`, `region`, `location_constraint`, `acl`, `force_path_style` (must be `"true"`), `use_accept_encoding_gzip` (must be `"false"`), `no_check_bucket`. The S3 `endpoint` must be an `https://` origin. Plain options never contain `pass`, `access_key_id`, `secret_access_key` or a repository password; such a payload is refused. Unknown keys are refused.
- Sealed plaintext (spec 10.3): UTF-8 JSON `{"repositoryPassword": string, "rclone": {"pass"?: string, "access_key_id"?: string, "secret_access_key"?: string}}`; SFTP carries `pass`, S3 carries both keys.
- Sealing key: `HKDF-SHA256(ikm = UTF-8 bytes of the per-Agent secret, salt = empty, info = "pluton-agent-command-secrets-v1", length = 32)`. Cipher: AES-256-GCM, 12-byte nonce, 16-byte tag. Additional data: UTF-8 of `"pluton-agent-command-secrets-v1\n" + commandId + "\n" + leaseToken`. The command HMAC still covers the whole payload including `sealed` (unchanged `verifyCommandDetailed`).
- Test vector (spec 10.4), used verbatim by the unit tests and `contracts/v0.8.0.json`: secret `synthetic-agent-secret-0123456789abcdef`, commandId `cmd-synthetic-01`, leaseToken `0123456789abcdef0123456789abcdef0123456789abcdef`, derived key `1f35dc3e9cf013165a2353883369bbfa7edd62b56072b3413c8074e2ffb93fac`, nonce `AAECAwQFBgcICQoL`, plaintext `{"repositoryPassword":"synthetic-repository-password-01","rclone":{"access_key_id":"SYNTHETICKEY01","secret_access_key":"synthetic-secret-key-01"}}`, ciphertext `jh0qetVE17GJz08s3DXhomumBqDIVOhzX3A4LgVFJeiH9JSKr4qR7OowvN0duifn639ReyzbjXGWiSEWAaymlLJKNnxwbrP+vLmuRdk9vI+wuUG8cJhENnxGV0LXHElNyPLQME0jaSjTfM7T0n9LTBr7V76enQuphACHq53aFDwiyFLa5p/2ML2748FcdivP43U+`, tag `pUKJ+stiEzlyVi8BFN6biQ==`. Changing any byte of ciphertext, tag, nonce, command ID or lease token must make opening fail. (Verified with Node crypto while writing this plan.)
- Payload versions 1 to 4 are unchanged and remain SFTP-only.
- `PLUTON_AGENT_STORAGE_CA_FILE` is optional, lives in the root-owned `/etc/pluton-agent.env`, names a root-owned PEM file, and is passed to Restic and Rclone as `SSL_CERT_FILE` for S3 backups only. The server never sends CA files.
- S3 keys are never passed through `rclone obscure`. The temporary `rclone.conf` keeps directory mode 0700, file mode 0600 and removal in `finally`.
- Failure reports use only the server's closed `backupFailureStageSchema`/`backupFailureCodeSchema` values (`AgentService.ts:84-157`). No new stage or code name reaches the server; S3 maps to `target-check-auth-failed`, `target-check-access-failed`, `target-check-transport-failed`, `repository-check-failed`, `repository-target-check-failed`, `repository-target-not-empty` and `invalid-payload`.
- Pins unchanged: Node 22.23.4, pnpm 10.20.0, Restic 0.19.1, Rclone 1.75.1, TypeScript 5.9.3, `@types/node` 22.18.13. No new dependency and no CI workflow change.
- Synthetic data only: `app-01`, `192.0.2.10`, `example.internal`, `s3.example.internal`, `bucket-01`, keys such as `SYNTHETICKEY01`. No real hostnames, endpoints, credentials or production identities in code, tests, labs or docs.
- Never weaken or skip existing tests. On Windows (Node 24.16.0) `pnpm test` at `4c2c3f3` already has 4 platform failures (`CLI enrollment creates one private identity...`, `enrollment locking and exclusive persistence...`, `a disappearing scan entry retains ENOENT...`, `an expired trusted certificate is rejected...`) and skips Linux-only tests; the Linux gate (`tmp/linux-run.sh` and the Ubuntu validation image) is authoritative.
- Every change under `agent/src/` is recorded in `contracts/standalone-source-v1.json` (enforced by `scripts/validate-standalone.mjs`, run inside `pnpm test:contracts`) with `node tmp/update-source-delta.mjs <files>`.
- Commits: explicit `git add <paths>` (never `git add .`), then `git diff --cached --check`, Conventional Commit messages, no `Co-Authored-By` or AI attribution lines; the local `.git/hooks/commit-msg` hook strips such lines and is never bypassed (no `--no-verify`). Never push, tag, release or deploy; the user pushes.

---

## File structure

| Path | Change | Responsibility |
| --- | --- | --- |
| `agent/src/sealedSecrets.ts` | Create | HKDF key, additional data, strict sealed-field opener, closed `SealedSecretsError` |
| `agent/src/sealedSecrets.test.ts` | Create | Spec 10.4 vector, exhaustive single-byte/character mutations, envelope and plaintext shape |
| `agent/src/backupFilesystem.ts` | Modify | Payload v5 parsing, version 3/4 source rules in v5, S3 config, storage CA, S3 access check, S3 empty target, S3 failure classification |
| `agent/src/backupFilesystem.test.ts` | Modify | v5 parsing, v5 source rules, S3 execution, CA, empty target, classification |
| `agent/src/backupLifecycle.test.ts` | Modify | v5 with lifecycle version 2 keeps version 3 binding and receipt recovery |
| `agent/src/sealedCommandRuntime.test.ts` | Create | `runOnce` passes the per-Agent secret, command ID and lease token; misbound seals refused before any file |
| `agent/src/runtime.ts` | Modify | Pass `commandSeal` to `executeFilesystemBackup` |
| `agent/src/types.ts` | Modify | `AgentCapabilities.repositoryBackends`, `backupPayloadVersion`; `AgentConfig.storageCaFile` |
| `agent/src/config.ts`, `agent/src/config.test.ts`, `agent/src/index.ts` | Modify | Read and validate `PLUTON_AGENT_STORAGE_CA_FILE` |
| `agent/src/inventory.ts`, `agent/src/inventory.test.ts` | Modify | `AGENT_VERSION = "0.8.0"`, new capabilities |
| `package.json`, `agent/package.json` | Modify | Version 0.8.0 |
| `contracts/v0.8.0.json` | Create | Heartbeat request, signed v5 S3 command, sealing vector |
| `contracts/standalone-source-v1.json` | Modify (generated) | Reviewed source hashes, `agentVersion` 0.8.0 |
| `scripts/tests/contracts.test.mjs`, `scripts/tests/runtime-pins.test.mjs`, `scripts/tests/release.test.mjs`, `scripts/package-release.mjs`, `scripts/verify-release.mjs` | Modify | 0.8.0 identity and new vectors |
| `installers/install-agent.sh`, `installers/tests/install-agent.test.sh`, `agent/examples/pluton-agent.env.example` | Modify | `--storage-ca-file` writes `PLUTON_AGENT_STORAGE_CA_FILE` |
| `tests/post-dump/Dockerfile`, `tests/post-dump/native.lab.ts` | Modify | Private CA stage, HTTPS `rclone serve s3` fixture, five S3 lab cases with a real MySQL dump |
| `README.md`, `docs/OPERATIONS.md`, `docs/COMPATIBILITY.md`, `docs/S3_REPOSITORY.md` | Modify / Create | Spec 6.2 point 8 wording, operator steps, report |
| `tmp/update-source-delta.mjs`, `tmp/linux-run.sh` | Create, git-ignored (`tmp/` is in `.gitignore` and `.dockerignore`) | Local helpers only, never committed |

Where the sealing inputs come from (verified at `4c2c3f3`): `runtime.ts:89` loads `identity` (`StoredAgentIdentity`, field `secret`) from `identity.json`; `runtime.ts:111` gets `command` from `client.poll()`, which at `client.ts:88-94` verified `command.signature` with `verifyCommandDetailed(this.identity.secret, command)` (`protocol.ts:29-55`, HMAC keyed by the raw secret string); `command.id` and `command.leaseToken` (`AgentCommandEnvelope`, `types.ts:99-108`) are the values the server seals to. `runtime.ts:158-190` is the only call of `executeFilesystemBackup` for a leased command.

---

### Task 1: Branch, local helpers and the sealed-secrets opener

**Files:**
- Create: `agent/src/sealedSecrets.ts`
- Create: `agent/src/sealedSecrets.test.ts`
- Modify (generated): `contracts/standalone-source-v1.json` (two new entries)
- Create, git-ignored: `tmp/update-source-delta.mjs`, `tmp/linux-run.sh`

**Interfaces:**
- Consumes: `node:crypto` (`hkdfSync`, `createDecipheriv`), `node:util` (`TextDecoder`).
- Produces (exported from `agent/src/sealedSecrets.ts`):
  - `export const COMMAND_SECRETS_LABEL = "pluton-agent-command-secrets-v1"`
  - `export type CommandSealContext = { secret: string; commandId: string; leaseToken: string }`
  - `export type SealedCommandSecrets = { repositoryPassword: string; rclone: Partial<Record<"pass" | "access_key_id" | "secret_access_key", string>> }`
  - `export class SealedSecretsError extends Error` (message `The sealed command secrets are invalid.`)
  - `export function deriveCommandSecretsKey(secret: string): Buffer`
  - `export function commandSecretsAdditionalData(commandId: string, leaseToken: string): Buffer`
  - `export function openSealedCommandSecrets(sealed: unknown, context: CommandSealContext): SealedCommandSecrets`
  - Shell: `node tmp/update-source-delta.mjs agent/src/<name>.ts ...` and `bash tmp/linux-run.sh "<command>"`

- [ ] **Step 1: Create the branch**

Run in Git Bash:

```sh
cd /c/laragon/www/pluton-agent
git status --porcelain
git fetch origin
git switch -c claude/agent-s3-repository --no-track origin/main
git log -1 --format='%H %s'
```

Expected: `git status --porcelain` prints nothing (if it prints anything, stop and ask the user; do not stash or discard). Then `Switched to a new branch 'claude/agent-s3-repository'`. The log line starts with `4c2c3f3` (`Merge pull request #9 ...`) or a newer `origin/main` merge; record the SHA for the report in Task 11.

- [ ] **Step 2: Create the source-delta helper**

Create `tmp/update-source-delta.mjs`:

```js
// Local helper (tmp/ is git-ignored and never committed). Records reviewed
// Agent source changes in contracts/standalone-source-v1.json, which
// scripts/validate-standalone.mjs (run by pnpm test:contracts) requires.
import fs from 'node:fs';
import crypto from 'node:crypto';

const REASON =
  'S3 repository stage 1 (Agent 0.8.0): BACKUP_FILESYSTEM payload version 5 with sealed secrets (HKDF-SHA256 and AES-256-GCM bound to the command ID and lease token), S3 option allowlist, operator storage CA, S3 access and empty-target checks and closed S3 failure classification; payload versions 1 to 4 unchanged.';
const files = process.argv.slice(2);
if (!files.length || files.some((file) => !/^agent\/src\/[A-Za-z0-9]+(?:\.test)?\.ts$/.test(file)))
  throw new Error('Usage: node tmp/update-source-delta.mjs agent/src/<name>.ts ...');
const deltaPath = 'contracts/standalone-source-v1.json';
const delta = JSON.parse(fs.readFileSync(deltaPath, 'utf8'));
const extracted = new Map(
  JSON.parse(fs.readFileSync('contracts/extraction-source.json', 'utf8')).agentSource.map(
    ({ file, sha256 }) => [file, sha256],
  ),
);
for (const file of files) {
  const sha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');
  let item = delta.changes.find((change) => change.file === file);
  if (!item) {
    item = { file, extractedSha256: extracted.get(file) ?? null, sha256, reason: REASON };
    delta.changes.push(item);
  }
  item.sha256 = sha256;
  if (!item.reason.includes(REASON)) item.reason = `${item.reason} ${REASON}`;
  console.log(`${file} ${sha256}`);
}
delta.changes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
fs.writeFileSync(deltaPath, JSON.stringify(delta, null, 2) + '\n');
```

- [ ] **Step 3: Create the Linux test helper**

Create `tmp/linux-run.sh`:

```bash
#!/usr/bin/env bash
# Local helper (tmp/ is git-ignored and never committed). Runs one command as the
# unprivileged `tester` account inside the Ubuntu validation image, after
# overlaying this working tree's Agent sources, contracts, installers, scripts,
# tests and docs on the image's installed workspace. No network, no host writes.
set -Eeuo pipefail
[[ $# -eq 1 ]] || { printf 'Usage: bash tmp/linux-run.sh "<command>"\n' >&2; exit 2; }
image="${PLUTON_AGENT_LINUX_IMAGE:-pluton-agent-validation:s3-base}"
repository="$(cygpath -w "$(git rev-parse --show-toplevel)")"
MSYS_NO_PATHCONV=1 docker run --rm --network none --volume "${repository}:/src:ro" --entrypoint bash "$image" -c '
set -Eeuo pipefail
rm -rf /tmp/w && mkdir /tmp/w && cp -a /workspace/. /tmp/w/
for item in agent/src contracts installers scripts tests docs; do
  rm -rf "/tmp/w/$item" && cp -r "/src/$item" "/tmp/w/$item"
done
for item in package.json agent/package.json README.md install-agent.sh upgrade-agent.sh recover-agent-install.sh; do
  cp "/src/$item" "/tmp/w/$item"
done
find /tmp/w -name "*.sh" -type f -exec chmod 0755 {} +
cd /tmp/w/agent && rm -rf dist && node node_modules/typescript/bin/tsc -p tsconfig.json
cd /tmp/w && eval "$0"
' "$1"
```

- [ ] **Step 4: Build the baseline Linux image and prove the helper**

Docker Desktop must be running (ask the user to start it if `docker version` fails). The build downloads the pinned Ubuntu packages, Node, Restic and Rclone on first use and runs the complete existing suite as `tester`; it takes several minutes.

```sh
docker build --platform linux/amd64 --progress=plain --target validation --build-arg UBUNTU_VERSION=22.04 --file tests/ubuntu/Dockerfile --tag pluton-agent-validation:s3-base .
bash tmp/linux-run.sh 'cd agent && node --test --test-reporter=spec dist/*.test.js 2>&1 | tail -n 8'
```

Expected: the build ends with `naming to docker.io/library/pluton-agent-validation:s3-base` and exit 0. The second command prints the spec summary ending in `ℹ fail 0` (no Linux test is skipped as `tester`). If either fails, stop: the baseline is broken and must be reported, not worked around.

- [ ] **Step 5: Write the failing test**

Create `agent/src/sealedSecrets.test.ts`:

```ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  COMMAND_SECRETS_LABEL,
  SealedSecretsError,
  commandSecretsAdditionalData,
  deriveCommandSecretsKey,
  openSealedCommandSecrets,
} from "./sealedSecrets.js";

/** S3 design section 10.4 test vector, verbatim. */
const vector = {
  secret: "synthetic-agent-secret-0123456789abcdef",
  commandId: "cmd-synthetic-01",
  leaseToken: "0123456789abcdef0123456789abcdef0123456789abcdef",
  derivedKeyHex:
    "1f35dc3e9cf013165a2353883369bbfa7edd62b56072b3413c8074e2ffb93fac",
  nonce: "AAECAwQFBgcICQoL",
  plaintext:
    '{"repositoryPassword":"synthetic-repository-password-01","rclone":{"access_key_id":"SYNTHETICKEY01","secret_access_key":"synthetic-secret-key-01"}}',
  ciphertext:
    "jh0qetVE17GJz08s3DXhomumBqDIVOhzX3A4LgVFJeiH9JSKr4qR7OowvN0duifn639ReyzbjXGWiSEWAaymlLJKNnxwbrP+vLmuRdk9vI+wuUG8cJhENnxGV0LXHElNyPLQME0jaSjTfM7T0n9LTBr7V76enQuphACHq53aFDwiyFLa5p/2ML2748FcdivP43U+",
  tag: "pUKJ+stiEzlyVi8BFN6biQ==",
};
const context = {
  secret: vector.secret,
  commandId: vector.commandId,
  leaseToken: vector.leaseToken,
};
const sealed = {
  alg: "A256GCM",
  kid: "pluton-agent-command-secrets-v1",
  nonce: vector.nonce,
  ciphertext: vector.ciphertext,
  tag: vector.tag,
};

function flipByte(value: string, index: number): string {
  const bytes = Buffer.from(value, "base64");
  bytes[index] ^= 0x01;
  return bytes.toString("base64");
}

function changeCharacter(value: string, index: number): string {
  return (
    value.slice(0, index) +
    (value[index] === "0" ? "1" : "0") +
    value.slice(index + 1)
  );
}

/** Independent sealer built only from node:crypto; the Agent itself only opens. */
function sealForTest(
  plaintext: string | Buffer,
  nonce: Buffer = Buffer.from(vector.nonce, "base64"),
) {
  const key = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(vector.secret, "utf8"),
      Buffer.alloc(0),
      Buffer.from("pluton-agent-command-secrets-v1", "utf8"),
      32,
    ),
  );
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(
    Buffer.from(
      `pluton-agent-command-secrets-v1\n${vector.commandId}\n${vector.leaseToken}`,
      "utf8",
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(
      typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext,
    ),
    cipher.final(),
  ]);
  return {
    alg: "A256GCM",
    kid: "pluton-agent-command-secrets-v1",
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

test("sealed: derives the 10.4 key with HKDF-SHA256 and the command-secrets label", () => {
  assert.equal(COMMAND_SECRETS_LABEL, "pluton-agent-command-secrets-v1");
  assert.equal(
    deriveCommandSecretsKey(vector.secret).toString("hex"),
    vector.derivedKeyHex,
  );
  assert.equal(
    commandSecretsAdditionalData(vector.commandId, vector.leaseToken).toString(
      "utf8",
    ),
    `pluton-agent-command-secrets-v1\n${vector.commandId}\n${vector.leaseToken}`,
  );
  // The command HMAC is keyed by the raw secret; the sealing key never equals it.
  assert.notEqual(
    deriveCommandSecretsKey(vector.secret).toString("hex"),
    Buffer.from(vector.secret, "utf8").toString("hex"),
  );
});

test("sealed: opens the 10.4 vector to the exact plaintext", () => {
  assert.deepEqual(
    openSealedCommandSecrets(sealed, context),
    JSON.parse(vector.plaintext),
  );
});

test("sealed: an independent sealer with the 10.4 inputs reproduces the vector ciphertext and tag", () => {
  const result = sealForTest(vector.plaintext);
  assert.equal(result.ciphertext, vector.ciphertext);
  assert.equal(result.tag, vector.tag);
});

test("sealed: changing any byte of ciphertext, tag or nonce, or any character of the command ID or lease token, refuses", () => {
  for (const field of ["ciphertext", "tag", "nonce"] as const) {
    const length = Buffer.from(sealed[field], "base64").length;
    for (let index = 0; index < length; index++)
      assert.throws(
        () =>
          openSealedCommandSecrets(
            { ...sealed, [field]: flipByte(sealed[field], index) },
            context,
          ),
        SealedSecretsError,
        `${field} byte ${index}`,
      );
  }
  for (const field of ["commandId", "leaseToken"] as const)
    for (let index = 0; index < context[field].length; index++)
      assert.throws(
        () =>
          openSealedCommandSecrets(sealed, {
            ...context,
            [field]: changeCharacter(context[field], index),
          }),
        SealedSecretsError,
        `${field} character ${index}`,
      );
  assert.throws(
    () =>
      openSealedCommandSecrets(sealed, {
        ...context,
        secret: "synthetic-agent-secret-0123456789abcdeF",
      }),
    SealedSecretsError,
  );
});

test("sealed: refuses envelope fields, algorithms, key IDs and non-canonical encodings outside the contract", () => {
  for (const candidate of [
    undefined,
    null,
    [],
    "sealed",
    { ...sealed, alg: "A128GCM" },
    { ...sealed, kid: "pluton-agent-command-secrets-v2" },
    { ...sealed, extra: true },
    {
      alg: sealed.alg,
      kid: sealed.kid,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
    },
    { ...sealed, nonce: "AAECAwQFBgcICQo=" },
    { ...sealed, tag: "pUKJ+stiEzlyVi8BFN6b" },
    { ...sealed, nonce: "AAECAwQFBgcICQoL\n" },
    { ...sealed, ciphertext: sealed.ciphertext.replace(/\+/g, "-") },
    { ...sealed, ciphertext: "" },
  ])
    assert.throws(
      () => openSealedCommandSecrets(candidate, context),
      SealedSecretsError,
    );
  for (const bad of [
    { ...context, commandId: "" },
    { ...context, leaseToken: "lease\ninjected" },
    { ...context, secret: "" },
  ])
    assert.throws(
      () => openSealedCommandSecrets(sealed, bad),
      SealedSecretsError,
    );
});

test("sealed: refuses plaintext outside the closed secret shape", () => {
  for (const plaintext of [
    "not json",
    "[]",
    '{"repositoryPassword":"synthetic-repository-password-01"}',
    '{"repositoryPassword":"synthetic-repository-password-01","rclone":{},"extra":true}',
    '{"repositoryPassword":"synthetic-repository-password-01","rclone":{"session_token":"x"}}',
    '{"repositoryPassword":"synthetic-repository-password-01","rclone":{"pass":""}}',
    '{"repositoryPassword":"bad\\nvalue","rclone":{"pass":"synthetic"}}',
    '{"repositoryPassword":7,"rclone":{"pass":"synthetic"}}',
  ])
    assert.throws(
      () =>
        openSealedCommandSecrets(
          sealForTest(plaintext, crypto.randomBytes(12)),
          context,
        ),
      SealedSecretsError,
      plaintext,
    );
  assert.throws(
    () =>
      openSealedCommandSecrets(
        sealForTest(Buffer.from([0xff, 0xfe]), crypto.randomBytes(12)),
        context,
      ),
    SealedSecretsError,
  );
  assert.deepEqual(
    openSealedCommandSecrets(
      sealForTest(
        '{"repositoryPassword":"synthetic-repository-password-01","rclone":{"pass":"synthetic-sftp-password-01"}}',
        crypto.randomBytes(12),
      ),
      context,
    ),
    {
      repositoryPassword: "synthetic-repository-password-01",
      rclone: { pass: "synthetic-sftp-password-01" },
    },
  );
});
```

- [ ] **Step 6: Run the test to verify it fails**

```sh
pnpm build
```

Expected: FAIL with `src/sealedSecrets.test.ts(...): error TS2307: Cannot find module './sealedSecrets.js' or its corresponding type declarations.`

- [ ] **Step 7: Write the minimal implementation**

Create `agent/src/sealedSecrets.ts`:

```ts
import crypto from "node:crypto";
import { TextDecoder } from "node:util";

/**
 * Sealed secrets for BACKUP_FILESYSTEM payload version 5 (S3 design section
 * 10.3). The label is the HKDF info, the sealed-field key ID and the prefix of
 * the additional data, so the sealing key never equals the command HMAC key and
 * a sealed blob cannot be replayed into another command or lease.
 */
export const COMMAND_SECRETS_LABEL = "pluton-agent-command-secrets-v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const MAX_SECRET_LENGTH = 16_384;
const SEALED_RCLONE_KEYS = ["pass", "access_key_id", "secret_access_key"] as const;
type SealedRcloneKey = (typeof SEALED_RCLONE_KEYS)[number];

/** The leased command the secrets are sealed to. Never logged or persisted. */
export type CommandSealContext = {
  /** The per-Agent secret from identity.json that also verifies the command HMAC. */
  secret: string;
  commandId: string;
  leaseToken: string;
};

export type SealedCommandSecrets = {
  repositoryPassword: string;
  rclone: Partial<Record<SealedRcloneKey, string>>;
};

/** One closed refusal for every malformed, tampered, misbound or wrong-key field. */
export class SealedSecretsError extends Error {
  constructor() {
    super("The sealed command secrets are invalid.");
    this.name = "SealedSecretsError";
  }
}

export function deriveCommandSecretsKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.alloc(0),
      Buffer.from(COMMAND_SECRETS_LABEL, "utf8"),
      32,
    ),
  );
}

export function commandSecretsAdditionalData(
  commandId: string,
  leaseToken: string,
): Buffer {
  return Buffer.from(
    `${COMMAND_SECRETS_LABEL}\n${commandId}\n${leaseToken}`,
    "utf8",
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

/** Standard padded base64 only, re-encoded byte for byte (no base64url, whitespace or slack bits). */
function canonicalBase64(value: unknown, exactBytes?: number): Buffer {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new SealedSecretsError();
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value ||
    (exactBytes !== undefined && bytes.length !== exactBytes)
  )
    throw new SealedSecretsError();
  return bytes;
}

function secretValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_SECRET_LENGTH ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new SealedSecretsError();
  return value;
}

function sealedRcloneKey(name: string): name is SealedRcloneKey {
  return (SEALED_RCLONE_KEYS as readonly string[]).includes(name);
}

function decrypt(
  context: CommandSealContext,
  nonce: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
): Buffer {
  const key = deriveCommandSecretsKey(context.secret);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(
      commandSecretsAdditionalData(context.commandId, context.leaseToken),
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SealedSecretsError();
  } finally {
    key.fill(0);
  }
}

/**
 * Open the version 5 `sealed` field before any file is written. Any change to
 * the nonce, ciphertext, tag, command ID, lease token or per-Agent secret fails
 * authentication; the plaintext must be exactly the section 10.3 shape.
 */
export function openSealedCommandSecrets(
  sealed: unknown,
  context: CommandSealContext,
): SealedCommandSecrets {
  if (
    !plainObject(sealed) ||
    !exactKeys(sealed, ["alg", "kid", "nonce", "ciphertext", "tag"]) ||
    sealed.alg !== "A256GCM" ||
    sealed.kid !== COMMAND_SECRETS_LABEL ||
    typeof context.secret !== "string" ||
    !context.secret ||
    typeof context.commandId !== "string" ||
    !context.commandId ||
    context.commandId.includes("\n") ||
    typeof context.leaseToken !== "string" ||
    !context.leaseToken ||
    context.leaseToken.includes("\n")
  )
    throw new SealedSecretsError();
  const plaintext = decrypt(
    context,
    canonicalBase64(sealed.nonce, NONCE_BYTES),
    canonicalBase64(sealed.ciphertext),
    canonicalBase64(sealed.tag, TAG_BYTES),
  );
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
    if (
      !plainObject(value) ||
      !exactKeys(value, ["repositoryPassword", "rclone"]) ||
      !plainObject(value.rclone)
    )
      throw new SealedSecretsError();
    const rclone: SealedCommandSecrets["rclone"] = {};
    for (const [name, entry] of Object.entries(value.rclone)) {
      if (!sealedRcloneKey(name)) throw new SealedSecretsError();
      rclone[name] = secretValue(entry);
    }
    return { repositoryPassword: secretValue(value.repositoryPassword), rclone };
  } catch {
    throw new SealedSecretsError();
  } finally {
    plaintext.fill(0);
  }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

```sh
pnpm build && node --test --test-reporter=spec agent/dist/sealedSecrets.test.js
bash tmp/linux-run.sh 'cd agent && node --test --test-reporter=spec dist/sealedSecrets.test.js'
```

Expected (both, Windows and Linux): six `✔ sealed: ...` lines, `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.

- [ ] **Step 9: Record the source change and commit**

```sh
node tmp/update-source-delta.mjs agent/src/sealedSecrets.ts agent/src/sealedSecrets.test.ts
pnpm build && pnpm test:contracts
git add agent/src/sealedSecrets.ts agent/src/sealedSecrets.test.ts contracts/standalone-source-v1.json
git diff --cached --check
git commit -m "feat(agent): open sealed command secrets"
```

Expected: the helper prints two lines `agent/src/sealedSecrets...ts <64 hex>`; `pnpm test:contracts` prints `PASS standalone layout and 47 versioned Agent source files (29 explicit independent changes); no server imports` and `ℹ fail 0`; `git diff --cached --check` prints nothing; the commit succeeds.

---

### Task 2: Parse payload version 5 (S3 allowlist and sealed secrets)

**Files:**
- Modify: `agent/src/backupFilesystem.ts` (imports after `:52`; `SFTP_OPTION_KEYS` `:57-63`; `BackupFilesystemPayload` `:65-83`; new helpers after `validateRcloneOptions` `:445-458`; `parseBackupFilesystemPayload` `:460-537`)
- Modify: `agent/src/backupFilesystem.test.ts` (imports `:1-20`; helpers after `validPayload` `:25-46`; new tests after `:104`)
- Modify (generated): `contracts/standalone-source-v1.json`

**Interfaces:**
- Consumes: `openSealedCommandSecrets`, `SealedSecretsError`, `CommandSealContext` (Task 1); existing `asRecord`, `requiredString`, `validateId`, `validateRepositoryPath`, `validateExcludes`, `validateRcloneOptions`, `parseBackupExclusions`, `parseBackupLifecycle`.
- Produces:
  - `export function parseBackupFilesystemPayload(value: Record<string, unknown>, commandSeal?: CommandSealContext): BackupFilesystemPayload`
  - `BackupFilesystemPayload.version: 1 | 2 | 3 | 4 | 5`, `BackupFilesystemPayload.rclone.type: "sftp" | "s3"`
  - Internal: `validateSftpPlainOptions(value: unknown): Record<string, string>`, `validateS3PlainOptions(value: unknown): Record<string, string>`, `validateS3RepositoryPath(value: unknown): string`, `openVersion5Secrets(type: "sftp" | "s3", optionsValue: unknown, sealedValue: unknown, commandSeal: CommandSealContext | undefined): { repositoryPassword: string; options: Record<string, string> }`

- [ ] **Step 1: Write the failing tests**

In `agent/src/backupFilesystem.test.ts`, replace the import block (lines 1-20) with:

```ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BackupFilesystemError,
  executeFilesystemBackup,
  parseBackupFilesystemPayload,
  writeTemporaryRcloneConfig,
} from "./backupFilesystem.js";
import { SealedSecretsError } from "./sealedSecrets.js";
```

Directly after the `validPayload` constant (after line 46), insert:

```ts
/** Leased-command context of the S3 design section 10.4 vector. */
const sealContext = {
  secret: "synthetic-agent-secret-0123456789abcdef",
  commandId: "cmd-synthetic-01",
  leaseToken: "0123456789abcdef0123456789abcdef0123456789abcdef",
};
const SEAL_LABEL = "pluton-agent-command-secrets-v1";

/** Independent test sealer (node:crypto only); the Agent itself only opens. */
function sealForTest(
  plaintext: unknown,
  context = sealContext,
  nonce = crypto.randomBytes(12),
) {
  const key = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(context.secret, "utf8"),
      Buffer.alloc(0),
      Buffer.from(SEAL_LABEL, "utf8"),
      32,
    ),
  );
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(
    Buffer.from(
      `${SEAL_LABEL}\n${context.commandId}\n${context.leaseToken}`,
      "utf8",
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), "utf8"),
    cipher.final(),
  ]);
  return {
    alg: "A256GCM",
    kid: SEAL_LABEL,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** S3 design section 10.4 sealed field, verbatim. */
const vectorSealed = {
  alg: "A256GCM",
  kid: "pluton-agent-command-secrets-v1",
  nonce: "AAECAwQFBgcICQoL",
  ciphertext:
    "jh0qetVE17GJz08s3DXhomumBqDIVOhzX3A4LgVFJeiH9JSKr4qR7OowvN0duifn639ReyzbjXGWiSEWAaymlLJKNnxwbrP+vLmuRdk9vI+wuUG8cJhENnxGV0LXHElNyPLQME0jaSjTfM7T0n9LTBr7V76enQuphACHq53aFDwiyFLa5p/2ML2748FcdivP43U+",
  tag: "pUKJ+stiEzlyVi8BFN6biQ==",
};

/** S3 design section 10.2 example with the 10.4 sealed field. */
const s3Version5Payload = {
  version: 5,
  backupId: "backup-01",
  planId: "plan-01",
  sourcePath: "/srv/example-app",
  excludes: [] as string[],
  repository: {
    remoteName: "pluton",
    path: "bucket-01/pluton/app-01",
    initialize: true,
  },
  rclone: {
    type: "s3",
    options: {
      provider: "Other",
      endpoint: "https://s3.example.internal",
      force_path_style: "true",
      use_accept_encoding_gzip: "false",
      no_check_bucket: "true",
    } as Record<string, string>,
  },
  sealed: vectorSealed,
};

function sftpVersion5Payload(
  sourcePath = "/srv/example-app",
  excludes: string[] = [],
) {
  return {
    version: 5,
    backupId: "backup-01",
    planId: "plan-01",
    sourcePath,
    excludes,
    repository: {
      remoteName: "pluton",
      path: "managed-repositories/example",
      initialize: true,
    },
    rclone: {
      type: "sftp",
      options: {
        host: "sftp.example.internal",
        port: "22",
        user: "backup-user",
      } as Record<string, string>,
    },
    sealed: sealForTest({
      repositoryPassword: validPayload.repositoryPassword,
      rclone: { pass: validPayload.rclone.options.pass },
    }),
  };
}
```

After the test `refuses traversal, control characters, and unexpected command fields` (after line 104), insert:

```ts
test("payload v5: opens the sealed S3 vector and merges the keys into the allowlisted options", () => {
  const parsed = parseBackupFilesystemPayload(s3Version5Payload, sealContext);
  assert.equal(parsed.version, 5);
  assert.equal(parsed.rclone.type, "s3");
  assert.deepEqual(parsed.rclone.options, {
    provider: "Other",
    endpoint: "https://s3.example.internal",
    force_path_style: "true",
    use_accept_encoding_gzip: "false",
    no_check_bucket: "true",
    access_key_id: "SYNTHETICKEY01",
    secret_access_key: "synthetic-secret-key-01",
  });
  assert.equal(parsed.repositoryPassword, "synthetic-repository-password-01");
  assert.equal(parsed.repository.path, "bucket-01/pluton/app-01");
});

test("payload v5: the SFTP password travels sealed and is merged before obscuring", () => {
  const parsed = parseBackupFilesystemPayload(
    sftpVersion5Payload(),
    sealContext,
  );
  assert.equal(parsed.rclone.type, "sftp");
  assert.deepEqual(parsed.rclone.options, {
    host: "sftp.example.internal",
    port: "22",
    user: "backup-user",
    pass: validPayload.rclone.options.pass,
  });
  assert.equal(parsed.repositoryPassword, validPayload.repositoryPassword);
});

test("payload v5: tampered, misbound or unkeyed sealed fields refuse the command", () => {
  for (const context of [
    { ...sealContext, commandId: "cmd-synthetic-02" },
    { ...sealContext, leaseToken: "f".repeat(48) },
    { ...sealContext, secret: "synthetic-other-agent-secret" },
  ])
    assert.throws(
      () => parseBackupFilesystemPayload(s3Version5Payload, context),
      SealedSecretsError,
    );
  const ciphertext = Buffer.from(vectorSealed.ciphertext, "base64");
  ciphertext[10] ^= 1;
  assert.throws(
    () =>
      parseBackupFilesystemPayload(
        {
          ...s3Version5Payload,
          sealed: { ...vectorSealed, ciphertext: ciphertext.toString("base64") },
        },
        sealContext,
      ),
    SealedSecretsError,
  );
  assert.throws(
    () => parseBackupFilesystemPayload(s3Version5Payload),
    /leased command context/,
  );
  const { sealed: _sealed, ...unsealed } = s3Version5Payload;
  assert.throws(
    () => parseBackupFilesystemPayload(unsealed, sealContext),
    SealedSecretsError,
  );
});

test("payload v5: plaintext credentials and a top-level repository password are refused", () => {
  assert.throws(
    () =>
      parseBackupFilesystemPayload(
        {
          ...s3Version5Payload,
          repositoryPassword: "synthetic-repository-password-01",
        },
        sealContext,
      ),
    /must be sealed/,
  );
  for (const key of ["access_key_id", "secret_access_key", "pass"])
    assert.throws(
      () =>
        parseBackupFilesystemPayload(
          {
            ...s3Version5Payload,
            rclone: {
              type: "s3",
              options: {
                ...s3Version5Payload.rclone.options,
                [key]: "synthetic-plaintext",
              },
            },
          },
          sealContext,
        ),
      /must be sealed/,
    );
  assert.throws(
    () =>
      parseBackupFilesystemPayload(
        {
          ...sftpVersion5Payload(),
          rclone: {
            type: "sftp",
            options: {
              host: "sftp.example.internal",
              user: "backup-user",
              pass: "synthetic-plaintext",
            },
          },
        },
        sealContext,
      ),
    /must be sealed/,
  );
  assert.throws(
    () =>
      parseBackupFilesystemPayload(
        {
          ...s3Version5Payload,
          sealed: sealForTest({
            repositoryPassword: "synthetic-repository-password-01",
            rclone: { access_key_id: "SYNTHETICKEY01" },
          }),
        },
        sealContext,
      ),
    SealedSecretsError,
  );
  assert.throws(
    () =>
      parseBackupFilesystemPayload(
        {
          ...sftpVersion5Payload(),
          sealed: sealForTest({
            repositoryPassword: validPayload.repositoryPassword,
            rclone: {
              pass: validPayload.rclone.options.pass,
              access_key_id: "SYNTHETICKEY01",
            },
          }),
        },
        sealContext,
      ),
    SealedSecretsError,
  );
});

test("payload v5: S3 options are allowlisted and HTTPS-only with path style and no transfer compression", () => {
  const base = s3Version5Payload.rclone.options;
  const withOptions = (options: Record<string, string>) => ({
    ...s3Version5Payload,
    rclone: { type: "s3", options },
  });
  assert.equal(
    parseBackupFilesystemPayload(
      withOptions({
        ...base,
        region: "us-east-1",
        location_constraint: "us-east-1",
        acl: "private",
      }),
      sealContext,
    ).rclone.options.region,
    "us-east-1",
  );
  const cases: [Record<string, string>, RegExp][] = [
    [{ ...base, env_auth: "true" }, /unsupported option/],
    [{ ...base, shared_credentials_file: "/root/.aws/credentials" }, /unsupported option/],
    [{ ...base, endpoint: "http://s3.example.internal" }, /HTTPS origin/],
    [{ ...base, endpoint: "https://s3.example.internal/bucket-01" }, /HTTPS origin/],
    [{ ...base, endpoint: "https://user:secret@s3.example.internal" }, /HTTPS origin/],
    [{ ...base, endpoint: "https://s3.example.internal:443" }, /HTTPS origin/],
    [{ provider: "Other", endpoint: base.endpoint, use_accept_encoding_gzip: "false" }, /path-style/],
    [{ ...base, force_path_style: "false" }, /path-style/],
    [{ ...base, use_accept_encoding_gzip: "true" }, /transfer compression/],
    [{ provider: "Other", endpoint: base.endpoint, force_path_style: "true" }, /transfer compression/],
    [{ ...base, no_check_bucket: "yes" }, /bucket check/],
    [{ ...base, region: "us-east-1\nexec" }, /invalid/],
    [{ ...base, acl: "private;x" }, /invalid/],
  ];
  for (const [options, message] of cases)
    assert.throws(
      () => parseBackupFilesystemPayload(withOptions(options), sealContext),
      message,
      JSON.stringify(options),
    );
});

test("payload v5: S3 repositories must be a prefix inside a bucket", () => {
  for (const repositoryPath of [
    "bucket-01",
    "/bucket-01/app-01",
    "bucket-01//app-01",
    "bucket-01/./app-01",
    "bucket-01/app-01/",
    "bucket-01\\app-01",
    "bucket-01/../app-01",
  ])
    assert.throws(
      () =>
        parseBackupFilesystemPayload(
          {
            ...s3Version5Payload,
            repository: { ...s3Version5Payload.repository, path: repositoryPath },
          },
          sealContext,
        ),
      /prefix inside a bucket|traversal/,
      repositoryPath,
    );
});

test("payload v5: versions 1 to 4 stay SFTP-only and newer versions are refused", () => {
  assert.throws(
    () =>
      parseBackupFilesystemPayload({
        ...validPayload,
        version: 4,
        rclone: { type: "s3", options: s3Version5Payload.rclone.options },
      }),
    /Only SFTP storage/,
  );
  assert.throws(
    () =>
      parseBackupFilesystemPayload(
        { ...s3Version5Payload, version: 6 },
        sealContext,
      ),
    /unsupported/,
  );
  assert.throws(
    () =>
      parseBackupFilesystemPayload(
        { ...s3Version5Payload, rclone: { type: "b2", options: {} } },
        sealContext,
      ),
    /Storage type is unsupported/,
  );
});

test("payload v5: accepts sourceDiagnosticsVersion as today and refuses any trust setting in the payload", () => {
  assert.equal(
    parseBackupFilesystemPayload(
      { ...s3Version5Payload, sourceDiagnosticsVersion: 1 },
      sealContext,
    ).sourceDiagnosticsVersion,
    1,
  );
  assert.equal(
    parseBackupFilesystemPayload(
      { ...sftpVersion5Payload(), sourceDiagnosticsVersion: 1 },
      sealContext,
    ).sourceDiagnosticsVersion,
    1,
  );
  assert.equal(
    parseBackupFilesystemPayload(s3Version5Payload, sealContext)
      .sourceDiagnosticsVersion,
    undefined,
  );
  assert.throws(
    () =>
      parseBackupFilesystemPayload(
        { ...s3Version5Payload, sourceDiagnosticsVersion: 2 },
        sealContext,
      ),
    /Source diagnostics version is unsupported/,
  );
  // Trust comes only from the Agent's own PLUTON_AGENT_STORAGE_CA_FILE (spec 6.1 point 2).
  for (const key of ["ca_cert", "no_check_certificate", "SSL_CERT_FILE"])
    assert.throws(
      () =>
        parseBackupFilesystemPayload(
          {
            ...s3Version5Payload,
            rclone: {
              type: "s3",
              options: {
                ...s3Version5Payload.rclone.options,
                [key]: "/etc/ssl/certs/synthetic.pem",
              },
            },
          },
          sealContext,
        ),
      /unsupported option/,
      key,
    );
  for (const field of ["trust", "storageCaFile", "caFile"])
    assert.throws(
      () =>
        parseBackupFilesystemPayload(
          { ...s3Version5Payload, [field]: "/etc/ssl/certs/synthetic.pem" },
          sealContext,
        ),
      /unsupported fields/,
      field,
    );
});

test("payload v5: keeps the version 4 exclusion grammar and the optional lifecycle", () => {
  assert.deepEqual(
    parseBackupFilesystemPayload(
      { ...s3Version5Payload, excludes: [" .cache/ ", "node_modules"] },
      sealContext,
    ).excludes,
    [".cache", "node_modules"],
  );
  assert.throws(() =>
    parseBackupFilesystemPayload(
      { ...s3Version5Payload, excludes: ["../escape"] },
      sealContext,
    ),
  );
  assert.equal(
    parseBackupFilesystemPayload(s3Version5Payload, sealContext).lifecycle,
    undefined,
  );
  assert.equal(
    parseBackupFilesystemPayload(
      {
        ...sftpVersion5Payload(),
        lifecycle: {
          version: 1,
          preHook: { id: "prepare", args: [], timeoutSeconds: 5 },
        },
      },
      sealContext,
    ).lifecycle?.version,
    1,
  );
  assert.equal(
    parseBackupFilesystemPayload(
      {
        ...s3Version5Payload,
        lifecycle: {
          version: 2,
          databases: [
            {
              databaseId: "db_one",
              engine: "mysql",
              host: "127.0.0.1",
              port: 3306,
              tls: "local",
              database: "example_db",
              username: "backup_reader",
              password: "synthetic-db-password-01",
              dumpFilename: "app.sql",
              timeoutSeconds: 60,
              maxDumpBytes: 4 * 1024 * 1024,
              includeRoutines: false,
              includeEvents: false,
            },
          ],
        },
      },
      sealContext,
    ).lifecycle?.version,
    2,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```sh
pnpm build
```

Expected: FAIL with `src/backupFilesystem.test.ts(...): error TS2554: Expected 1 arguments, but got 2.` (the new second argument of `parseBackupFilesystemPayload`).

- [ ] **Step 3: Implement version 5 parsing**

In `agent/src/backupFilesystem.ts`, after the import block that ends with `} from "./lifecyclePolicy.js";` (line 52), add:

```ts
import {
  openSealedCommandSecrets,
  SealedSecretsError,
  type CommandSealContext,
} from "./sealedSecrets.js";
```

After the line `const SFTP_OPTION_KEYS = new Set(["host", "port", "user", "pass"]);` (line 63), add:

```ts

/** Payload version 5 plain options (S3 design 10.2). Credentials only travel in `sealed`. */
const SFTP_PLAIN_OPTION_KEYS = new Set(["host", "port", "user"]);
const S3_PLAIN_OPTION_KEYS = new Set([
  "provider",
  "endpoint",
  "region",
  "location_constraint",
  "acl",
  "force_path_style",
  "use_accept_encoding_gzip",
  "no_check_bucket",
]);
const SEALED_ONLY_KEYS = new Set([
  "pass",
  "access_key_id",
  "secret_access_key",
  "repositoryPassword",
]);
```

Replace the type `BackupFilesystemPayload` (lines 65-83) with:

```ts
export type BackupFilesystemPayload = {
  sourceDiagnosticsVersion?: 1;
  version: 1 | 2 | 3 | 4 | 5;
  lifecycle?: BackupLifecycle;
  backupId: string;
  planId: string;
  sourcePath: string;
  excludes: string[];
  repository: {
    remoteName: "pluton";
    /** SFTP directory, or `bucket/prefix` for S3 (version 5 only). */
    path: string;
    initialize: boolean;
  };
  rclone: {
    /** Versions 1 to 4 are SFTP-only; version 5 may name S3. */
    type: "sftp" | "s3";
    /** Plain options plus, in version 5, the opened sealed credentials. Never logged. */
    options: Record<string, string>;
  };
  /** Plain in versions 1 to 4, opened from `sealed` in version 5. Never logged. */
  repositoryPassword: string;
};
```

After the function `validateRcloneOptions` (ends at line 458), add:

```ts

function validateSftpPlainOptions(value: unknown): Record<string, string> {
  const input = asRecord(value, "SFTP configuration");
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (SEALED_ONLY_KEYS.has(key))
      throw new Error("SFTP credentials must be sealed.");
    if (!SFTP_PLAIN_OPTION_KEYS.has(key))
      throw new Error("SFTP configuration contains an unsupported option.");
    result[key] = requiredString(entry, `SFTP option ${key}`, 16_384);
  }
  if (!result.host || !result.user)
    throw new Error("SFTP host and user are required.");
  return result;
}

function validateS3PlainOptions(value: unknown): Record<string, string> {
  const input = asRecord(value, "S3 configuration");
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (SEALED_ONLY_KEYS.has(key))
      throw new Error("S3 credentials must be sealed.");
    if (!S3_PLAIN_OPTION_KEYS.has(key))
      throw new Error("S3 configuration contains an unsupported option.");
    result[key] = requiredString(entry, `S3 option ${key}`, 1_024);
  }
  let endpoint: URL | undefined;
  try {
    endpoint = new URL(result.endpoint || "");
  } catch {
    endpoint = undefined;
  }
  if (
    !endpoint ||
    endpoint.protocol !== "https:" ||
    endpoint.origin !== result.endpoint
  )
    throw new Error("S3 endpoint must be an HTTPS origin.");
  if (result.force_path_style !== "true")
    throw new Error("S3 path-style addressing is required.");
  if (result.use_accept_encoding_gzip !== "false")
    throw new Error("S3 transfer compression must be disabled.");
  if (
    result.no_check_bucket !== undefined &&
    result.no_check_bucket !== "true" &&
    result.no_check_bucket !== "false"
  )
    throw new Error("S3 bucket check option is invalid.");
  for (const key of ["provider", "region", "location_constraint", "acl"]) {
    if (
      result[key] !== undefined &&
      !/^[A-Za-z0-9._-]{1,128}$/.test(result[key])
    )
      throw new Error(`S3 option ${key} is invalid.`);
  }
  return result;
}

/** S3 repositories are a prefix inside a bucket; the bucket root is never a repository. */
function validateS3RepositoryPath(value: unknown): string {
  const repositoryPath = validateRepositoryPath(value);
  const segments = repositoryPath.split("/");
  if (
    repositoryPath.includes("\\") ||
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error("S3 repository path must be a prefix inside a bucket.");
  return repositoryPath;
}

/** Open version 5 secrets and merge them into the validated plain options. */
function openVersion5Secrets(
  type: "sftp" | "s3",
  optionsValue: unknown,
  sealedValue: unknown,
  commandSeal: CommandSealContext | undefined,
): { repositoryPassword: string; options: Record<string, string> } {
  const plain =
    type === "s3"
      ? validateS3PlainOptions(optionsValue)
      : validateSftpPlainOptions(optionsValue);
  if (!commandSeal)
    throw new Error(
      "Sealed command secrets require the leased command context.",
    );
  const secrets = openSealedCommandSecrets(sealedValue, commandSeal);
  const { pass, access_key_id, secret_access_key } = secrets.rclone;
  if (type === "sftp") {
    if (!pass || access_key_id !== undefined || secret_access_key !== undefined)
      throw new SealedSecretsError();
    return {
      repositoryPassword: secrets.repositoryPassword,
      options: { ...plain, pass },
    };
  }
  if (!access_key_id || !secret_access_key || pass !== undefined)
    throw new SealedSecretsError();
  return {
    repositoryPassword: secrets.repositoryPassword,
    options: { ...plain, access_key_id, secret_access_key },
  };
}
```

Replace the whole function `parseBackupFilesystemPayload` together with its doc comment (lines 460-537, from `/**` before `export function parseBackupFilesystemPayload(` through its closing `}`) with:

```ts
/**
 * Parse the short, server-signed workflow envelope. Unknown fields are refused
 * so this cannot gradually turn into a generic remote execution protocol.
 * Version 5 (S3 design 10.2) adds S3 and carries every secret in `sealed`,
 * opened with the leased command context before any file is written.
 */
export function parseBackupFilesystemPayload(
  value: Record<string, unknown>,
  commandSeal?: CommandSealContext,
): BackupFilesystemPayload {
  const sealedVersion = value.version === 5;
  if (sealedVersion && Object.hasOwn(value, "repositoryPassword"))
    throw new Error("Version 5 secrets must be sealed.");
  const allowed = new Set([
    "version",
    "backupId",
    "planId",
    "sourcePath",
    "excludes",
    "repository",
    "rclone",
    sealedVersion ? "sealed" : "repositoryPassword",
    "sourceDiagnosticsVersion",
    ...([2, 3, 4, 5].includes(value.version as number) ? ["lifecycle"] : []),
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Backup command contains unsupported fields.");
  }
  if (![1, 2, 3, 4, 5].includes(value.version as number))
    throw new Error("Backup command version is unsupported.");
  if (
    value.sourceDiagnosticsVersion !== undefined &&
    value.sourceDiagnosticsVersion !== 1
  )
    throw new Error("Source diagnostics version is unsupported.");
  const repository = asRecord(value.repository, "Repository configuration");
  const rclone = asRecord(value.rclone, "Rclone configuration");
  if (
    repository.remoteName !== "pluton" ||
    typeof repository.initialize !== "boolean"
  ) {
    throw new Error("Repository configuration is invalid.");
  }
  if (!sealedVersion && rclone.type !== "sftp")
    throw new Error("Only SFTP storage is supported by this agent.");
  if (sealedVersion && rclone.type !== "sftp" && rclone.type !== "s3")
    throw new Error("Storage type is unsupported by this agent.");
  const storageType = rclone.type as "sftp" | "s3";
  const opened = sealedVersion
    ? openVersion5Secrets(storageType, rclone.options, value.sealed, commandSeal)
    : undefined;
  const password = requiredString(
    opened ? opened.repositoryPassword : value.repositoryPassword,
    "Repository password",
    512,
  );
  if (password.length < 20) throw new Error("Repository password is invalid.");
  const lifecycle =
    value.version === 1 ||
    ((value.version === 4 || value.version === 5) &&
      value.lifecycle === undefined)
      ? undefined
      : parseBackupLifecycle(value.lifecycle);
  if (
    lifecycle &&
    (value.version === 2 || value.version === 3) &&
    lifecycle.version !== (value.version === 3 ? 2 : 1)
  )
    throw new Error("Incompatible lifecycle envelope.");
  return {
    version: value.version as BackupFilesystemPayload["version"],
    ...(value.sourceDiagnosticsVersion === 1
      ? { sourceDiagnosticsVersion: 1 as const }
      : {}),
    ...(lifecycle ? { lifecycle } : {}),
    backupId: validateId(value.backupId, "Backup ID"),
    planId: validateId(value.planId, "Plan ID"),
    sourcePath: requiredString(value.sourcePath, "Source path", 4_096),
    excludes:
      value.version === 4 || value.version === 5
        ? parseBackupExclusions(value.excludes)
        : validateExcludes(value.excludes),
    repository: {
      remoteName: "pluton",
      path:
        storageType === "s3"
          ? validateS3RepositoryPath(repository.path)
          : validateRepositoryPath(repository.path),
      initialize: repository.initialize,
    },
    rclone: {
      type: storageType,
      options: opened ? opened.options : validateRcloneOptions(rclone.options),
    },
    repositoryPassword: password,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```sh
pnpm build && node --test --test-reporter=spec --test-name-pattern="^payload v5:" agent/dist/backupFilesystem.test.js
bash tmp/linux-run.sh 'cd agent && node --test --test-reporter=spec dist/backupFilesystem.test.js 2>&1 | tail -n 8'
```

Expected: Windows shows nine `✔ payload v5: ...` lines and `ℹ fail 0`. Linux runs the whole file (existing SFTP tests unchanged) and ends with `ℹ fail 0`.

- [ ] **Step 5: Record and commit**

```sh
node tmp/update-source-delta.mjs agent/src/backupFilesystem.ts agent/src/backupFilesystem.test.ts
pnpm build && pnpm test:contracts
git add agent/src/backupFilesystem.ts agent/src/backupFilesystem.test.ts contracts/standalone-source-v1.json
git diff --cached --check
git commit -m "feat(agent): parse backup payload version 5 with S3 and sealed secrets"
```

Expected: `PASS standalone layout and 47 versioned Agent source files (29 explicit independent changes); no server imports`; `ℹ fail 0` (the existing contract assertion that `{ ...v, version: 5 }` throws still passes, now with `Version 5 secrets must be sealed.`); no `--check` output.

---

### Task 3: Bind sealed secrets to the leased command in the runtime

**Files:**
- Modify: `agent/src/backupFilesystem.ts` (`executeFilesystemBackup` input `:1383-1395`, parse call `:1438`)
- Modify: `agent/src/runtime.ts` (`:158-160`)
- Create: `agent/src/sealedCommandRuntime.test.ts`
- Modify (generated): `contracts/standalone-source-v1.json`

**Interfaces:**
- Consumes: `CommandSealContext` (Task 1), `parseBackupFilesystemPayload(value, commandSeal)` (Task 2), `StoredAgentIdentity.secret`, `AgentCommandEnvelope.id`, `AgentCommandEnvelope.leaseToken`.
- Produces: `executeFilesystemBackup(input: { payload: Record<string, unknown>; commandSeal?: CommandSealContext; config: AgentConfig; allowedRoots: string[]; serverManagedSource?: boolean; shouldCancel: () => Promise<boolean>; onEvent: (event: Record<string, unknown>) => Promise<void>; onStage?: (event: BackupFilesystemStageEvent) => void; successfulSnapshotIds?: string[]; parentLookupTimeoutMs?: number }): Promise<BackupFilesystemResult>`; `runOnceWork` passes `{ secret: identity.secret, commandId: command.id, leaseToken: command.leaseToken }`.

- [ ] **Step 1: Write the failing test**

Create `agent/src/sealedCommandRuntime.test.ts`:

```ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runOnce } from "./runtime.js";
import { saveIdentity } from "./identity.js";
import type { AgentCommandEnvelope, StoredAgentIdentity } from "./types.js";

const tools = process.env.PLUTON_PHASE5_TEST_TOOLS;
/** Same boundary as lifecycleTransport.test.ts: unprivileged Linux with root-owned private tools. */
const executionTest =
  process.platform === "linux" && tools && process.getuid?.() !== 0
    ? test
    : test.skip;
const LABEL = "pluton-agent-command-secrets-v1";
const identity: StoredAgentIdentity = {
  deviceId: "device-01",
  agentId: "agent-01",
  secret: "synthetic-agent-secret-0123456789abcdef",
  pollIntervalSeconds: 1,
  completedCommands: [],
};
const repositoryPassword = "synthetic-repository-password-01";
const sftpPassword = "synthetic-sftp-password-01";

/** Independent test sealer; the Agent itself only opens. */
function seal(commandId: string, leaseToken: string, plaintext: unknown) {
  const key = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(identity.secret, "utf8"),
      Buffer.alloc(0),
      Buffer.from(LABEL, "utf8"),
      32,
    ),
  );
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(`${LABEL}\n${commandId}\n${leaseToken}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), "utf8"),
    cipher.final(),
  ]);
  return {
    alg: "A256GCM",
    kid: LABEL,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function leasedCommand(
  id: string,
  payloadFor: (leaseToken: string) => Record<string, unknown>,
): AgentCommandEnvelope {
  const leaseToken = crypto.randomBytes(24).toString("hex");
  const command: AgentCommandEnvelope = {
    id,
    type: "BACKUP_FILESYSTEM",
    idempotencyKey: `backup:${id}`,
    leaseToken,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    signatureTimestamp: String(Date.now()),
    signature: "",
    payload: payloadFor(leaseToken),
  };
  command.signature = crypto
    .createHmac("sha256", identity.secret)
    .update(
      [
        "command",
        command.signatureTimestamp,
        command.id,
        command.type,
        JSON.stringify(command.payload),
        command.idempotencyKey,
        command.leaseToken,
        Date.parse(command.leaseExpiresAt!).toString(),
      ].join("\n"),
    )
    .digest("base64");
  return command;
}

function sftpPayload(source: string, sealed: unknown): Record<string, unknown> {
  return {
    version: 5,
    planId: "plan-01",
    backupId: "backup-01",
    sourcePath: source,
    excludes: [],
    repository: {
      remoteName: "pluton",
      path: "managed/app-01",
      initialize: true,
    },
    rclone: {
      type: "sftp",
      options: { host: "sftp.example.internal", user: "backup_reader" },
    },
    sealed,
  };
}

async function runLeasedBackup(
  commandFor: (source: string) => AgentCommandEnvelope,
) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "pluton-sealed-runtime-"));
  const source = path.join(scratch, "source");
  const dataDir = path.join(scratch, "state");
  await mkdir(source);
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(path.join(source, "app.txt"), "synthetic app");
  await saveIdentity(dataDir, { ...identity, completedCommands: [] });
  const command = commandFor(source);
  const completions: Record<string, unknown>[] = [];
  const output: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    const body = JSON.parse(raw);
    let result: unknown = {};
    if (request.url === "/api/agent/poll") result = { command };
    else if (request.url?.endsWith("/status")) result = { cancelled: false };
    else if (request.url?.endsWith("/complete")) completions.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        request.url === "/api/agent/heartbeat" ||
          request.url === "/api/agent/poll" ||
          request.url?.endsWith("/status")
          ? { success: true, result }
          : { success: true },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previousInfo = console.info,
    previousError = console.error;
  console.info = (...args) => {
    output.push(args);
  };
  console.error = (...args) => {
    output.push(args);
  };
  try {
    await runOnce({
      serverUrl: new URL(
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      ),
      dataDir,
      allowedRoots: [source],
      allowInsecureHttp: true,
      binDir: path.join(tools!, "bin"),
      databaseBinDirs: [path.join(tools!, "bin")],
    });
  } finally {
    console.info = previousInfo;
    console.error = previousError;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return { scratch, dataDir, completions, output };
}

executionTest(
  "sealed runtime: a v5 command sealed to another command or lease is refused before any backup file is written",
  async () => {
    for (const misbinding of ["command", "lease"] as const) {
      const run = await runLeasedBackup((source) =>
        leasedCommand("command-sealed-01", (leaseToken) =>
          sftpPayload(
            source,
            seal(
              misbinding === "command" ? "command-sealed-other" : "command-sealed-01",
              misbinding === "lease"
                ? crypto.randomBytes(24).toString("hex")
                : leaseToken,
              { repositoryPassword, rclone: { pass: sftpPassword } },
            ),
          ),
        ),
      );
      try {
        assert.equal(run.completions.length, 1, misbinding);
        assert.equal(run.completions[0].success, false);
        assert.equal(run.completions[0].failureStage, "payload-validation");
        assert.equal(run.completions[0].failureCode, "invalid-payload");
        const files = await readdir(run.dataDir);
        assert.ok(
          !files.some(
            (name) =>
              name.startsWith("rclone-") ||
              name === "jobs" ||
              name === "restic-cache" ||
              name === "restic-calls",
          ),
          files.join(","),
        );
        for (const forbidden of [repositoryPassword, sftpPassword, identity.secret])
          assert.ok(
            !JSON.stringify([run.completions, run.output]).includes(forbidden),
          );
      } finally {
        await rm(run.scratch, { recursive: true, force: true });
      }
    }
  },
);

executionTest(
  "sealed runtime: a v5 SFTP command opens its secrets with the per-Agent secret, command ID and lease token",
  async () => {
    const run = await runLeasedBackup((source) =>
      leasedCommand("command-sealed-02", (leaseToken) =>
        sftpPayload(
          source,
          seal("command-sealed-02", leaseToken, {
            repositoryPassword,
            rclone: { pass: sftpPassword },
          }),
        ),
      ),
    );
    try {
      assert.equal(run.completions.length, 1);
      assert.equal(
        run.completions[0].success,
        true,
        JSON.stringify({
          stage: run.completions[0].failureStage,
          code: run.completions[0].failureCode,
        }),
      );
      const calls = (await readFile(path.join(run.dataDir, "restic-calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.ok(
        calls.some(
          (args) =>
            args.includes("backup") && args[1] === "rclone:pluton:managed/app-01",
        ),
      );
      for (const forbidden of [repositoryPassword, sftpPassword, identity.secret])
        assert.ok(
          !JSON.stringify([run.completions, run.output]).includes(forbidden),
        );
    } finally {
      await rm(run.scratch, { recursive: true, force: true });
    }
  },
);
```

- [ ] **Step 2: Run the test to verify it fails**

```sh
bash tmp/linux-run.sh 'cd agent && node --test --test-reporter=spec dist/sealedCommandRuntime.test.js'
```

Expected: `✔ sealed runtime: a v5 command sealed to another command or lease is refused ...` (version 5 is already refused without a context) and `✖ sealed runtime: a v5 SFTP command opens its secrets ...` with an assertion message `{"stage":"payload-validation","code":"invalid-payload"}`; `ℹ fail 1`.

- [ ] **Step 3: Wire the leased command context**

In `agent/src/backupFilesystem.ts`, in the input type of `executeFilesystemBackup`, find:

```ts
export async function executeFilesystemBackup(input: {
  payload: Record<string, unknown>;
  config: AgentConfig;
```

Replace with:

```ts
export async function executeFilesystemBackup(input: {
  payload: Record<string, unknown>;
  /** Leased-command context that opens version 5 sealed secrets. Never logged. */
  commandSeal?: CommandSealContext;
  config: AgentConfig;
```

Find:

```ts
    const payload = parseBackupFilesystemPayload(input.payload);
```

Replace with:

```ts
    const payload = parseBackupFilesystemPayload(
      input.payload,
      input.commandSeal,
    );
```

In `agent/src/runtime.ts`, find:

```ts
      const result = await executeFilesystemBackup({
        payload: command.payload,
        config,
```

Replace with:

```ts
      const result = await executeFilesystemBackup({
        payload: command.payload,
        // client.poll() verified this command's HMAC with identity.secret; version 5
        // secrets are sealed to the same secret, this command ID and this lease token.
        commandSeal: {
          secret: identity.secret,
          commandId: command.id,
          leaseToken: command.leaseToken,
        },
        config,
```

- [ ] **Step 4: Run the tests to verify they pass**

```sh
bash tmp/linux-run.sh 'cd agent && node --test --test-reporter=spec dist/sealedCommandRuntime.test.js dist/lifecycleTransport.test.js dist/sourceAccessRuntime.test.js 2>&1 | tail -n 8'
pnpm typecheck
```

Expected: both `sealed runtime:` tests pass, the existing runtime tests still pass, summary `ℹ fail 0`; `pnpm typecheck` exits 0.

- [ ] **Step 5: Record and commit**

```sh
node tmp/update-source-delta.mjs agent/src/backupFilesystem.ts agent/src/runtime.ts agent/src/sealedCommandRuntime.test.ts
pnpm build && pnpm test:contracts
git add agent/src/backupFilesystem.ts agent/src/runtime.ts agent/src/sealedCommandRuntime.test.ts contracts/standalone-source-v1.json
git diff --cached --check
git commit -m "feat(agent): bind sealed secrets to the leased command"
```

Expected: `PASS standalone layout and 48 versioned Agent source files (30 explicit independent changes); no server imports`; `ℹ fail 0`; no `--check` output.

---

### Task 4: Keep the version 3 and version 4 source rules in payload version 5

The server sends version 4 only when a plan has exclusions and version 3 for a version 2 database lifecycle (`RemoteBackupService.materializeCommand`). An Agent that accepts version 5 receives version 5 for every backup, so version 5 must keep each set of rules; otherwise existing SFTP plans silently lose version 3 snapshot binding (spec section 8: no change to existing SFTP plans).

**Files:**
- Modify: `agent/src/backupFilesystem.ts` (new helpers after `parseBackupFilesystemPayload`; `confirmLifecycleSnapshot` `:1255`, `:1320`; `executeFilesystemBackup` `:1452-1455`, `:1463`, `:1543`, `:1742`, `:1786`)
- Modify: `agent/src/backupFilesystem.test.ts` (append one test)
- Modify: `agent/src/backupLifecycle.test.ts` (imports `:1-28`; helper and test appended at the end, after `:877`)
- Modify (generated): `contracts/standalone-source-v1.json`

**Interfaces:**
- Consumes: `BackupFilesystemPayload` (Task 2), `executeFilesystemBackup({ commandSeal })` (Task 3).
- Produces (internal, `agent/src/backupFilesystem.ts`): `function usesVersion4SourceRules(payload: BackupFilesystemPayload): boolean` (version 4, or version 5 with exclusions: anchored exclusions, pre-backup scan, excluded-path source diagnostics); `function bindsApplicationSource(payload: BackupFilesystemPayload): boolean` (version 3, or version 5 with a version 2 lifecycle: source binding and receipt recovery).

- [ ] **Step 1: Write the failing tests**

Append to `agent/src/backupFilesystem.test.ts`:

```ts
linuxExecutionTest(
  "payload v5: follows version 3 source rules without exclusions and version 4 rules with them",
  async () => {
    const fixture = await createExecutionFixture("");
    const unreadable = path.join(fixture.source, "included.txt");
    await writeFile(unreadable, "synthetic included");
    await chmod(unreadable, 0);
    try {
      const base = executionInput(fixture);
      // Without exclusions the server would have sent version 1 to 3: no pre-backup scan.
      await executeFilesystemBackup({
        ...base,
        payload: sftpVersion5Payload(fixture.source),
        commandSeal: sealContext,
      });
      // With exclusions the server would have sent version 4: scan and anchored filters.
      await assert.rejects(
        executeFilesystemBackup({
          ...base,
          payload: sftpVersion5Payload(fixture.source, ["node_modules/"]),
          commandSeal: sealContext,
        }),
        (error: unknown) =>
          error instanceof BackupFilesystemError &&
          error.stage === "source-validation" &&
          error.code === "source-entry-inaccessible",
      );
      await chmod(unreadable, 0o600);
      await executeFilesystemBackup({
        ...base,
        payload: sftpVersion5Payload(fixture.source, ["*.sql"]),
        commandSeal: sealContext,
      });
      const backups = (
        await readCalls(path.join(fixture.dataDir, "restic-calls"))
      ).filter((args) => args.includes("backup"));
      assert.equal(backups.length, 2);
      assert.ok(!backups[0].some((arg) => arg.includes("**/")));
      assert.ok(backups[1].includes(`${fixture.source}/**/*.sql`));
    } finally {
      await chmod(unreadable, 0o600);
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);
```

In `agent/src/backupLifecycle.test.ts`, replace the line `import assert from "node:assert/strict";` (line 1) with:

```ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
```

Append to the end of `agent/src/backupLifecycle.test.ts`:

```ts
const sealContext = {
  secret: "synthetic-agent-secret-0123456789abcdef",
  commandId: "cmd-synthetic-01",
  leaseToken: "0123456789abcdef0123456789abcdef0123456789abcdef",
};

/** Turn a version 2/3 SFTP payload into the equivalent sealed version 5 payload. */
function sealedVersion5(payload: Record<string, unknown>): Record<string, unknown> {
  const { repositoryPassword, rclone, ...rest } = payload;
  const { type, options } = rclone as {
    type: string;
    options: Record<string, string>;
  };
  const { pass, ...plain } = options;
  const label = "pluton-agent-command-secrets-v1";
  const key = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(sealContext.secret, "utf8"),
      Buffer.alloc(0),
      Buffer.from(label, "utf8"),
      32,
    ),
  );
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(
    Buffer.from(
      `${label}\n${sealContext.commandId}\n${sealContext.leaseToken}`,
      "utf8",
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ repositoryPassword, rclone: { pass } }), "utf8"),
    cipher.final(),
  ]);
  return {
    ...rest,
    version: 5,
    rclone: { type, options: plain },
    sealed: {
      alg: "A256GCM",
      kid: label,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
  };
}

executionTest(
  "payload v5 with a version 2 lifecycle binds the application source and recovers receipts on replay like version 3",
  async () => {
    const f = await multiFixture(multiEntries(["mariadb", "postgresql"]));
    try {
      const input = {
        ...f.input,
        payload: sealedVersion5(f.input.payload),
        commandSeal: sealContext,
      };
      const result = await executeFilesystemBackup(input);
      const replay = await executeFilesystemBackup(input);
      assert.equal(replay.snapshotId, result.snapshotId);
      assert.equal(result.lifecycle?.databases?.length, 2);
      assert.deepEqual(
        replay.lifecycle?.databases,
        result.lifecycle?.databases,
        "Replay must recover every artifact's safe metadata, as version 3 does",
      );
      const resticCalls = await calls(path.join(f.dataDir, "restic-calls"));
      assert.ok(
        resticCalls.some(
          (args: string[]) => args.includes("ls") && args.at(-1) === f.source,
        ),
        "The application source must be bound to the snapshot",
      );
      assert.equal(
        resticCalls.filter((args: string[]) => args.includes("backup")).length,
        1,
      );
      assert.equal((await calls(path.join(f.dataDir, "dump-calls"))).length, 2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
```

- [ ] **Step 2: Run the tests to verify they fail**

```sh
bash tmp/linux-run.sh 'cd agent && node --test --test-reporter=spec --test-name-pattern="^payload v5" dist/backupFilesystem.test.js dist/backupLifecycle.test.js'
```

Expected: the nine Task 2 `payload v5:` parse tests pass; `✖ payload v5: follows version 3 source rules ...` (the excluded run does not reject because no scan runs) and `✖ payload v5 with a version 2 lifecycle binds ...` (replay `lifecycle.databases` is `undefined`); `ℹ fail 2`.

- [ ] **Step 3: Implement the version mapping**

In `agent/src/backupFilesystem.ts`, directly after the closing `}` of `parseBackupFilesystemPayload`, add:

```ts

/**
 * Version 5 replaces 1 to 4 for Agents that accept it, so it keeps the source
 * rules of the version the server would otherwise send. With exclusions that is
 * version 4: anchored exclusions, the pre-backup scan and excluded-path source
 * diagnostics. Without exclusions the source rules of versions 1 to 3 apply.
 */
function usesVersion4SourceRules(payload: BackupFilesystemPayload): boolean {
  return (
    payload.version === 4 ||
    (payload.version === 5 && payload.excludes.length > 0)
  );
}

/** Version 3, and version 5 with a version 2 lifecycle, bind the source and recover receipts. */
function bindsApplicationSource(payload: BackupFilesystemPayload): boolean {
  return (
    payload.version === 3 ||
    (payload.version === 5 && payload.lifecycle?.version === 2)
  );
}
```

In `confirmLifecycleSnapshot`, find `    if (payload.version === 3) {` and replace it with:

```ts
    if (bindsApplicationSource(payload)) {
```

Find `      if (payload.version === 3 && expectedReport && !expected) {` and replace it with:

```ts
      if (bindsApplicationSource(payload) && expectedReport && !expected) {
```

In `executeFilesystemBackup`, find:

```ts
    const userExcludes =
      payload.version === 4
        ? sourceResticExclusions(source, payload.excludes)
        : payload.excludes;
```

Replace with:

```ts
    const userExcludes = usesVersion4SourceRules(payload)
      ? sourceResticExclusions(source, payload.excludes)
      : payload.excludes;
```

Find `    if (payload.version === 4) {` and replace it with:

```ts
    if (usesVersion4SourceRules(payload)) {
```

Find `          ...(payload.version === 3 ? { databases: [] } : {}),` and replace it with:

```ts
          ...(bindsApplicationSource(payload) ? { databases: [] } : {}),
```

Find:

```ts
          input.allowedRoots,
          payload.version === 4
            ? {
```

Replace with:

```ts
          input.allowedRoots,
          usesVersion4SourceRules(payload)
            ? {
```

Find:

```ts
      ...(payload.version === 4
        ? {
            sourceExcluded: compileBackupExclusions([
```

Replace with:

```ts
      ...(usesVersion4SourceRules(payload)
        ? {
            sourceExcluded: compileBackupExclusions([
```

Then confirm no other version 3/4 source check remains:

```sh
grep -n "payload.version === [34]" agent/src/backupFilesystem.ts
```

Expected: no output.

- [ ] **Step 4: Run the tests to verify they pass**

```sh
bash tmp/linux-run.sh 'cd agent && node --test --test-reporter=spec dist/backupFilesystem.test.js dist/backupLifecycle.test.js 2>&1 | tail -n 8'
```

Expected: all tests in both files pass (existing versions 1 to 4 behaviour unchanged), `ℹ fail 0`.

- [ ] **Step 5: Record and commit**

```sh
node tmp/update-source-delta.mjs agent/src/backupFilesystem.ts agent/src/backupFilesystem.test.ts agent/src/backupLifecycle.test.ts
pnpm build && pnpm test:contracts
git add agent/src/backupFilesystem.ts agent/src/backupFilesystem.test.ts agent/src/backupLifecycle.test.ts contracts/standalone-source-v1.json
git diff --cached --check
git commit -m "fix(agent): keep version 3 and 4 source rules in payload version 5"
```

Expected: `PASS standalone layout and 48 versioned Agent source files (31 explicit independent changes); no server imports`; `ℹ fail 0`.

---

### Task 5: Write the S3 repository configuration

**Files:**
- Modify: `agent/src/backupFilesystem.ts` (`writeTemporaryRcloneConfig` `:898-915`; obscure and config calls `:1501-1513`)
- Modify: `agent/src/backupFilesystem.test.ts` (imports; S3 fixture and tests appended)
- Modify (generated): `contracts/standalone-source-v1.json`

**Interfaces:**
- Consumes: `payload.rclone.type` (Task 2).
- Produces: `export async function writeTemporaryRcloneConfig(dataDir: string, options: Record<string, string>, type: "sftp" | "s3" = "sftp"): Promise<{ directory: string; configPath: string }>`; test helpers `createS3ExecutionFixture(options?)`, `s3ExecutionInput(fixture, payload?, config?)`, `readJsonLines<T>(file)`.

- [ ] **Step 1: Write the failing tests**

In `agent/src/backupFilesystem.test.ts`, replace the line `import crypto from "node:crypto";` with:

```ts
import crypto from "node:crypto";
import { existsSync } from "node:fs";
```

and replace the line `import { SealedSecretsError } from "./sealedSecrets.js";` with:

```ts
import { SealedSecretsError } from "./sealedSecrets.js";
import type { AgentConfig } from "./types.js";
```

Append to the end of `agent/src/backupFilesystem.test.ts`:

```ts
/**
 * Fake Rclone/Restic for S3 version 5 runs. The first `lsf` is the S3 access
 * check (Task 7), any later `lsf` the empty-target check. Each call records its
 * arguments and SSL_CERT_FILE; the config is copied for inspection.
 */
async function createS3ExecutionFixture(
  options: {
    accessExit?: number;
    targetListing?: string;
    targetExit?: number;
    lsfDiagnostics?: string;
    backupExit?: number;
    backupDiagnostics?: string;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pluton-agent-s3-"));
  const source = path.join(root, "source");
  const dataDir = path.join(root, "state");
  const binDir = path.join(root, "bin");
  await Promise.all([mkdir(source), mkdir(dataDir), mkdir(binDir)]);
  await writeFile(path.join(source, "app.txt"), "synthetic source\n");
  await writeFile(
    path.join(binDir, "rclone"),
    `#!/usr/bin/env node
import { appendFileSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const config = process.env.RCLONE_CONFIG || "";
if (!config) {
  process.exitCode = 97;
} else {
  const state = path.dirname(path.dirname(config));
  appendFileSync(path.join(state, "rclone.calls"), JSON.stringify(args) + "\\n");
  appendFileSync(path.join(state, "rclone.env"), JSON.stringify({ SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? null }) + "\\n");
  if (args[0] === "lsf") {
    copyFileSync(config, path.join(state, "rclone.config-copy"));
    const access = !existsSync(path.join(state, "access-checked"));
    writeFileSync(path.join(state, "access-checked"), "1");
    process.stderr.write(${JSON.stringify(options.lsfDiagnostics ?? "")});
    if (access) process.exitCode = ${options.accessExit ?? 0};
    else {
      process.stdout.write(${JSON.stringify(options.targetListing ?? "")});
      process.exitCode = ${options.targetExit ?? 0};
    }
  }
}
`,
  );
  await writeFile(
    path.join(binDir, "restic"),
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const state = path.dirname(path.dirname(process.env.RCLONE_CONFIG || ""));
appendFileSync(path.join(state, "restic-calls"), JSON.stringify(args) + "\\n");
appendFileSync(path.join(state, "restic.env"), JSON.stringify({ SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? null, passwordOpened: process.env.RESTIC_PASSWORD === "synthetic-repository-password-01" }) + "\\n");
if (args.includes("cat") && args.includes("config")) console.log(JSON.stringify({ version: 2, id: "c".repeat(64) }));
else if (args.includes("snapshots")) process.exitCode = 10;
else if (args.includes("backup")) {
  process.stderr.write(${JSON.stringify(options.backupDiagnostics ?? "")});
  if (${options.backupExit ?? 0} !== 0) process.exitCode = ${options.backupExit ?? 0};
  else process.stdout.write(JSON.stringify({ message_type: "summary", snapshot_id: "abcdef0123456789", files_new: 0, files_changed: 0, files_unmodified: 0, dirs_new: 0, dirs_changed: 0, dirs_unmodified: 0, data_blobs: 0, tree_blobs: 0, data_added: 0, data_added_packed: 0, total_files_processed: 0, total_bytes_processed: 0, total_duration: 0 }) + "\\n");
}
`,
  );
  await Promise.all([
    chmod(path.join(binDir, "rclone"), 0o755),
    chmod(path.join(binDir, "restic"), 0o755),
  ]);
  return { root, source, dataDir, binDir };
}

function s3ExecutionInput(
  fixture: Awaited<ReturnType<typeof createS3ExecutionFixture>>,
  payload: Record<string, unknown> = {
    ...s3Version5Payload,
    sourcePath: fixture.source,
  },
  config: Partial<AgentConfig> = {},
) {
  return {
    payload,
    commandSeal: sealContext,
    config: {
      serverUrl: new URL("https://example.invalid"),
      dataDir: fixture.dataDir,
      allowedRoots: [fixture.source],
      binDir: fixture.binDir,
      allowInsecureHttp: false,
      ...config,
    },
    allowedRoots: [fixture.source],
    shouldCancel: async () => false,
    onEvent: async () => undefined,
  };
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

linuxExecutionTest(
  "S3: writes a private type = s3 config with the plain sealed keys, never obscures, and backs up to the bucket prefix",
  async () => {
    const fixture = await createS3ExecutionFixture();
    const stages: string[] = [];
    try {
      const result = await executeFilesystemBackup({
        ...s3ExecutionInput(fixture),
        onStage: (event) => stages.push(`${event.stage}:${event.message}`),
      });
      assert.equal(result.snapshotId, "abcdef0123456789");
      const rcloneCalls = await readCalls(
        path.join(fixture.dataDir, "rclone.calls"),
      );
      assert.ok(!rcloneCalls.some((args) => args[0] === "obscure"));
      assert.ok(
        rcloneCalls.some(
          (args) =>
            args[0] === "lsf" && args[1] === "pluton:bucket-01/pluton/app-01",
        ),
      );
      assert.ok(
        !stages.some((stage) => stage.startsWith("sftp-password-obscure:")),
      );
      assert.ok(
        stages.includes(
          "temporary-storage-config:temporary storage config created",
        ),
      );
      const config = (
        await readFile(path.join(fixture.dataDir, "rclone.config-copy"), "utf8")
      ).split("\n");
      assert.deepEqual(config.slice(0, 3), [
        "[pluton]",
        "type = s3",
        "env_auth = false",
      ]);
      for (const line of [
        "access_key_id = SYNTHETICKEY01",
        "secret_access_key = synthetic-secret-key-01",
        "endpoint = https://s3.example.internal",
        "provider = Other",
        "force_path_style = true",
        "use_accept_encoding_gzip = false",
        "no_check_bucket = true",
      ])
        assert.ok(config.includes(line), line);
      const resticCalls = await readCalls(
        path.join(fixture.dataDir, "restic-calls"),
      );
      for (const command of ["init", "backup"])
        assert.ok(
          resticCalls.some(
            (args) =>
              args.includes(command) &&
              args[1] === "rclone:pluton:bucket-01/pluton/app-01",
          ),
          command,
        );
      assert.ok(
        (
          await readJsonLines<{ passwordOpened: boolean }>(
            path.join(fixture.dataDir, "restic.env"),
          )
        ).every((entry) => entry.passwordOpened),
      );
      assert.ok(!JSON.stringify(stages).includes("synthetic-secret-key-01"));
      assert.deepEqual(
        (await readdir(fixture.dataDir)).filter((name) =>
          name.startsWith("rclone-"),
        ),
        [],
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

permissionTest(
  "S3: the temporary Rclone config is private and pins env_auth off",
  async () => {
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "pluton-agent-s3-config-"),
    );
    try {
      const temporary = await writeTemporaryRcloneConfig(
        dataDir,
        {
          endpoint: "https://s3.example.internal",
          access_key_id: "SYNTHETICKEY01",
          secret_access_key: "synthetic-secret-key-01",
          force_path_style: "true",
          use_accept_encoding_gzip: "false",
        },
        "s3",
      );
      assert.equal((await stat(temporary.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(temporary.configPath)).mode & 0o777, 0o600);
      assert.equal(
        await readFile(temporary.configPath, "utf8"),
        "[pluton]\ntype = s3\nenv_auth = false\naccess_key_id = SYNTHETICKEY01\nendpoint = https://s3.example.internal\nforce_path_style = true\nsecret_access_key = synthetic-secret-key-01\nuse_accept_encoding_gzip = false\n",
      );
      await assert.rejects(
        writeTemporaryRcloneConfig(
          dataDir,
          { endpoint: "https://s3.example.internal\n[other]" },
          "s3",
        ),
        /unsafe value/,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
```

- [ ] **Step 2: Run the tests to verify they fail**

```sh
pnpm build
```

Expected: FAIL with `src/backupFilesystem.test.ts(...): error TS2554: Expected 2 arguments, but got 3.` (the new `type` argument of `writeTemporaryRcloneConfig`).

- [ ] **Step 3: Implement the S3 configuration**

In `agent/src/backupFilesystem.ts`, replace the whole function `writeTemporaryRcloneConfig` (lines 898-915) with:

```ts
export async function writeTemporaryRcloneConfig(
  dataDir: string,
  options: Record<string, string>,
  type: "sftp" | "s3" = "sftp",
): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(path.join(dataDir, "rclone-"));
  await chmod(directory, 0o700);
  const configPath = path.join(directory, "rclone.conf");
  // S3 keys stay plain in this 0600 file (rclone obscure is SFTP-only) and an S3
  // remote never falls back to ambient AWS credentials of the Agent host.
  const lines = [
    "[pluton]",
    `type = ${type}`,
    ...(type === "s3" ? ["env_auth = false"] : []),
  ];
  for (const key of Object.keys(options).sort()) {
    lines.push(`${key} = ${rcloneConfigValue(options[key])}`);
  }
  await writeFile(configPath, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(configPath, 0o600);
  return { directory, configPath };
}
```

In `executeFilesystemBackup`, find:

```ts
    const rcloneEnv: NodeJS.ProcessEnv = { PATH: env.PATH };
    setStage("sftp-password-obscure");
    const rcloneOptions = await obscureSensitiveSftpOptions(
      rclone,
      payload.rclone.options,
      rcloneEnv,
      input.shouldCancel,
    );
    setStage("temporary-storage-config");
    temporary = await writeTemporaryRcloneConfig(
      input.config.dataDir,
      rcloneOptions,
    );
```

Replace with:

```ts
    const rcloneEnv: NodeJS.ProcessEnv = { PATH: env.PATH };
    let rcloneOptions = payload.rclone.options;
    if (payload.rclone.type === "sftp") {
      setStage("sftp-password-obscure");
      rcloneOptions = await obscureSensitiveSftpOptions(
        rclone,
        payload.rclone.options,
        rcloneEnv,
        input.shouldCancel,
      );
    }
    setStage("temporary-storage-config");
    temporary = await writeTemporaryRcloneConfig(
      input.config.dataDir,
      rcloneOptions,
      payload.rclone.type,
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

```sh
bash tmp/linux-run.sh 'cd agent && node --test --test-reporter=spec dist/backupFilesystem.test.js 2>&1 | tail -n 8'
```

Expected: both new `S3:` tests and all existing tests pass (the SFTP test `creates a private temporary Rclone config` still sees `type = sftp`), `ℹ fail 0`.

- [ ] **Step 5: Record and commit**

```sh
node tmp/update-source-delta.mjs agent/src/backupFilesystem.ts agent/src/backupFilesystem.test.ts
pnpm build && pnpm test:contracts
git add agent/src/backupFilesystem.ts agent/src/backupFilesystem.test.ts contracts/standalone-source-v1.json
git diff --cached --check
git commit -m "feat(agent): write the S3 repository configuration"
```

Expected: `PASS standalone layout and 48 versioned Agent source files (31 explicit independent changes); no server imports`; `ℹ fail 0`.

---

### Task 6: Pass the operator storage CA to Restic and Rclone

**Files:**
- Modify: `agent/src/types.ts` (`AgentConfig` `:82-97`)
- Modify: `agent/src/config.ts` (`createAgentConfig` `:22-84`, `configFromEnvironment` `:86-104`)
- Modify: `agent/src/config.test.ts` (whole file, 14 lines)
- Modify: `agent/src/index.ts` (`configFromArgs` `:33-54`)
- Modify: `agent/src/backupFilesystem.ts` (after `setStage("temporary-storage-config");` in `executeFilesystemBackup`)
- Modify: `agent/src/backupFilesystem.test.ts` (append tests)
- Modify (generated): `contracts/standalone-source-v1.json`

**Interfaces:**
- Consumes: `assertRootOwnedPath(candidate: string, directory = false, readableFile = false): string` (`lifecyclePolicy.ts:276-313`, already imported in `backupFilesystem.ts`).
- Produces: `AgentConfig.storageCaFile?: string`; `createAgentConfig(input: { ...; storageCaFile?: string }): AgentConfig`; environment key `PLUTON_AGENT_STORAGE_CA_FILE` read by `configFromEnvironment` and `configFromArgs`; S3 child environments gain `SSL_CERT_FILE`.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `agent/src/config.test.ts` with:

```ts
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { configFromEnvironment, createAgentConfig, parseAllowedRoots } from './config.js';

test('rejects insecure HTTP unless explicitly enabled', () => {
	assert.throws(() => createAgentConfig({ serverUrl: 'http://192.0.2.10:5173', allowInsecureHttp: false }), /HTTP is disabled/);
	assert.equal(createAgentConfig({ serverUrl: 'http://192.0.2.10:5173', allowInsecureHttp: true }).serverUrl.protocol, 'http:');
});

test('accepts HTTPS and parses generic allowed roots', () => {
	const config = createAgentConfig({ serverUrl: 'https://pluton.example.internal', allowedRoots: '/srv/example-app,\n/var/lib/example' });
	assert.equal(config.serverUrl.protocol, 'https:');
	assert.deepEqual(parseAllowedRoots('/srv/example-app,\n/var/lib/example'), ['/srv/example-app', '/var/lib/example']);
});

test('reads an absolute storage CA file and refuses relative or control-character paths', () => {
	const expected = path.resolve('/etc/pluton-agent/storage-ca.pem');
	assert.equal(createAgentConfig({ serverUrl: 'https://pluton.example.internal', storageCaFile: '/etc/pluton-agent/storage-ca.pem' }).storageCaFile, expected);
	assert.equal(createAgentConfig({ serverUrl: 'https://pluton.example.internal' }).storageCaFile, undefined);
	assert.equal(createAgentConfig({ serverUrl: 'https://pluton.example.internal', storageCaFile: '' }).storageCaFile, undefined);
	assert.throws(() => createAgentConfig({ serverUrl: 'https://pluton.example.internal', storageCaFile: 'storage-ca.pem' }), /PLUTON_AGENT_STORAGE_CA_FILE/);
	assert.throws(() => createAgentConfig({ serverUrl: 'https://pluton.example.internal', storageCaFile: '/etc/pluton-agent/ca\n.pem' }), /PLUTON_AGENT_STORAGE_CA_FILE/);
	assert.equal(configFromEnvironment({ PLUTON_SERVER_URL: 'https://pluton.example.internal', PLUTON_AGENT_STORAGE_CA_FILE: '/etc/pluton-agent/storage-ca.pem' }).storageCaFile, expected);
});
```

Append to `agent/src/backupFilesystem.test.ts`:

```ts
/** Root-owned, readable PEM bundle present in the Ubuntu validation image (ca-certificates). */
const rootOwnedCaBundle = "/etc/ssl/certs/ca-certificates.crt";

linuxExecutionTest(
  "S3: PLUTON_AGENT_STORAGE_CA_FILE reaches Restic and Rclone as SSL_CERT_FILE",
  async () => {
    assert.ok(
      existsSync(rootOwnedCaBundle),
      "The Ubuntu validation image provides a root-owned CA bundle.",
    );
    for (const storageCaFile of [rootOwnedCaBundle, undefined]) {
      const fixture = await createS3ExecutionFixture();
      try {
        await executeFilesystemBackup(
          s3ExecutionInput(
            fixture,
            undefined,
            storageCaFile ? { storageCaFile } : {},
          ),
        );
        for (const file of ["rclone.env", "restic.env"])
          assert.ok(
            (
              await readJsonLines<{ SSL_CERT_FILE: string | null }>(
                path.join(fixture.dataDir, file),
              )
            ).every(
              (entry) => entry.SSL_CERT_FILE === (storageCaFile ?? null),
            ),
            `${file} ${storageCaFile ?? "without CA"}`,
          );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  },
);

linuxExecutionTest(
  "S3: a storage CA that is not root-owned refuses the backup before any storage tool runs",
  async () => {
    const fixture = await createS3ExecutionFixture();
    const unowned = path.join(fixture.root, "storage-ca.pem");
    await writeFile(unowned, "synthetic CA\n", { mode: 0o644 });
    try {
      await assert.rejects(
        executeFilesystemBackup(
          s3ExecutionInput(fixture, undefined, { storageCaFile: unowned }),
        ),
        (error: unknown) => {
          assert.ok(error instanceof BackupFilesystemError);
          assert.equal(error.stage, "temporary-storage-config");
          assert.equal(error.code, "temporary-config-failed");
          return true;
        },
      );
      assert.ok(!existsSync(path.join(fixture.dataDir, "rclone.calls")));
      assert.ok(!existsSync(path.join(fixture.dataDir, "restic-calls")));
      assert.deepEqual(
        (await readdir(fixture.dataDir)).filter((name) =>
          name.startsWith("rclone-"),
        ),
        [],
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

linuxExecutionTest("S3: an SFTP backup ignores the storage CA setting", async () => {
  const fixture = await createExecutionFixture("");
  try {
    const input = executionInput(fixture);
    const result = await executeFilesystemBackup({
      ...input,
      config: {
        ...input.config,
        storageCaFile: path.join(fixture.root, "absent-storage-ca.pem"),
      },
    });
    assert.equal(result.snapshotId, "abcdef0123456789");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```sh
pnpm build
```

Expected: FAIL with errors such as `src/config.test.ts(...): error TS2353: Object literal may only specify known properties, and 'storageCaFile' does not exist in type ...` and `Property 'storageCaFile' does not exist on type 'AgentConfig'`.

- [ ] **Step 3: Implement the configuration and environment**

In `agent/src/types.ts`, find:

```ts
  allowInsecureHttp: boolean;
  caFile?: string;
```

Replace with:

```ts
  allowInsecureHttp: boolean;
  caFile?: string;
  /**
   * Operator-installed CA bundle for S3 repositories (PLUTON_AGENT_STORAGE_CA_FILE),
   * passed to Restic and Rclone as SSL_CERT_FILE. Never supplied by a command.
   */
  storageCaFile?: string;
```

In `agent/src/config.ts`, find:

```ts
  sourcePolicyFile?: string;
}): AgentConfig {
```

Replace with:

```ts
  sourcePolicyFile?: string;
  storageCaFile?: string;
}): AgentConfig {
  if (
    input.storageCaFile &&
    (!path.isAbsolute(input.storageCaFile) ||
      /[\x00-\x1f\x7f]/.test(input.storageCaFile))
  )
    throw new Error(
      "PLUTON_AGENT_STORAGE_CA_FILE must be an absolute file path.",
    );
```

In the same file, find:

```ts
    sourcePolicyFile: input.sourcePolicyFile
      ? path.resolve(input.sourcePolicyFile)
      : undefined,
  };
}
```

Replace with:

```ts
    sourcePolicyFile: input.sourcePolicyFile
      ? path.resolve(input.sourcePolicyFile)
      : undefined,
    storageCaFile: input.storageCaFile
      ? path.resolve(input.storageCaFile)
      : undefined,
  };
}
```

Find:

```ts
    sourcePolicyFile: overrides.PLUTON_AGENT_SOURCE_POLICY_FILE,
  });
```

Replace with:

```ts
    sourcePolicyFile: overrides.PLUTON_AGENT_SOURCE_POLICY_FILE,
    storageCaFile: overrides.PLUTON_AGENT_STORAGE_CA_FILE,
  });
```

In `agent/src/index.ts`, find:

```ts
    sourcePolicyFile: envConfig.PLUTON_AGENT_SOURCE_POLICY_FILE,
  });
```

Replace with:

```ts
    sourcePolicyFile: envConfig.PLUTON_AGENT_SOURCE_POLICY_FILE,
    storageCaFile: envConfig.PLUTON_AGENT_STORAGE_CA_FILE,
  });
```

In `agent/src/backupFilesystem.ts`, in `executeFilesystemBackup`, find:

```ts
    setStage("temporary-storage-config");
    temporary = await writeTemporaryRcloneConfig(
```

Replace with:

```ts
    setStage("temporary-storage-config");
    if (payload.rclone.type === "s3" && input.config.storageCaFile) {
      // Operator-installed trust only; the server never sends CA files.
      const storageCa = assertRootOwnedPath(
        input.config.storageCaFile,
        false,
        true,
      );
      env.SSL_CERT_FILE = storageCa;
      rcloneEnv.SSL_CERT_FILE = storageCa;
    }
    temporary = await writeTemporaryRcloneConfig(
```

- [ ] **Step 4: Run the tests to verify they pass**

```sh
pnpm build && node --test --test-reporter=spec agent/dist/config.test.js
bash tmp/linux-run.sh 'cd agent && node --test --test-reporter=spec dist/config.test.js dist/backupFilesystem.test.js 2>&1 | tail -n 8'
```

Expected: Windows `ℹ tests 3`, `ℹ pass 3`, `ℹ fail 0`. Linux: all tests in both files pass, `ℹ fail 0`.

- [ ] **Step 5: Record and commit**

```sh
node tmp/update-source-delta.mjs agent/src/types.ts agent/src/config.ts agent/src/config.test.ts agent/src/index.ts agent/src/backupFilesystem.ts agent/src/backupFilesystem.test.ts
pnpm build && pnpm test:contracts
git add agent/src/types.ts agent/src/config.ts agent/src/config.test.ts agent/src/index.ts agent/src/backupFilesystem.ts agent/src/backupFilesystem.test.ts contracts/standalone-source-v1.json
git diff --cached --check
git commit -m "feat(agent): pass the operator storage CA to Restic and Rclone"
```

Expected: `PASS standalone layout and 48 versioned Agent source files (33 explicit independent changes); no server imports`; `ℹ fail 0`.

---

### Task 7: S3 access check, empty-target rule and failure classification

Restic reaches S3 only through `rclone serve restic`, which turns provider errors into plain HTTP 404/500 for Restic and does not print them at the default log level, so a wrong key on an initialized repository would surface as `repository-check-failed`. The Agent therefore lists the prefix with Rclone directly before Restic runs (one LIST request per backup) and classifies Rclone's own error text.

**Files:**
- Modify: `agent/src/backupFilesystem.ts` (stage messages `:168-192`; `toBackupFilesystemError` `:252-329`; `ProgramTimeoutError` `:347-351`; `ProcessOptions` `:358-371`; `repositoryDiagnostic` `:373-399`; `classifyTargetFailure` `:571-597`; `runProgram` stderr `:756-768` and close `:787-813`; new `checkS3RepositoryAccess` after `verifyRepository` `:835-890`; `ensureManagedRepository` `:1040-1043`; repository check `:1522-1530`; restic backup call `:1783-1797`)
- Modify: `agent/src/backupFilesystem.test.ts` (append tests)
- Modify (generated): `contracts/standalone-source-v1.json`

**Interfaces:**
- Consumes: `runProgram`, `RepositoryDiagnostic`, `RepositoryTargetFailureCode`, `ProgramTimeoutError`, `BackupCancelledError`, `CommandStatusError`.
- Produces (internal): constants `S3_AUTHENTICATION_FAILURE`, `S3_ACCESS_FAILURE`, `STORAGE_TRANSPORT_FAILURE`; `function classifyBackupStorageFailure(diagnostics: string): RepositoryTargetFailureCode | undefined`; `class ProgramExitError extends Error { readonly storageFailure?: RepositoryTargetFailureCode }`; `ProcessOptions.classifyBackupStorageFailure?: boolean`; `async function checkS3RepositoryAccess(rclone: string, target: string, env: NodeJS.ProcessEnv, shouldCancel: () => Promise<boolean>, diagnostic: (reason: RepositoryDiagnostic) => void): Promise<void>`; stage messages `"storage access check started"` and `"storage access verified"` (journal only).

- [ ] **Step 1: Write the failing tests**

Append to `agent/src/backupFilesystem.test.ts`:

```ts
for (const scenario of [
  {
    name: "an unknown access key",
    diagnostics:
      "operation error S3: ListObjectsV2, https response error StatusCode: 403, RequestID: 1, HostID: 2, api error InvalidAccessKeyId: The access key ID you provided does not exist in our records.",
    code: "target-check-auth-failed",
  },
  {
    name: "a wrong secret key",
    diagnostics:
      "operation error S3: ListObjectsV2, https response error StatusCode: 403, RequestID: 1, HostID: 2, api error SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.",
    code: "target-check-auth-failed",
  },
  {
    name: "a refused bucket",
    diagnostics:
      "operation error S3: ListObjectsV2, https response error StatusCode: 403, RequestID: 1, HostID: 2, api error AccessDenied: Access Denied",
    code: "target-check-access-failed",
  },
  {
    name: "an untrusted certificate",
    diagnostics:
      'Get "https://s3.example.internal/bucket-01?delimiter=%2F": tls: failed to verify certificate: x509: certificate signed by unknown authority',
    code: "target-check-transport-failed",
  },
  {
    name: "a DNS server failure",
    diagnostics: "lookup s3.example.internal on 192.0.2.53:53: server misbehaving",
    code: "target-check-transport-failed",
  },
  {
    name: "a throttled endpoint",
    diagnostics:
      "operation error S3: ListObjectsV2, https response error StatusCode: 503, RequestID: 1, HostID: 2, api error SlowDown: Please reduce your request rate.",
    code: "target-check-transport-failed",
  },
  {
    name: "an unrecognised provider failure",
    diagnostics: "synthetic unrecognised provider failure",
    code: "repository-check-failed",
  },
])
  linuxExecutionTest(
    `S3: the access check maps ${scenario.name} to ${scenario.code} before Restic runs`,
    async () => {
      const providerSecret = "synthetic-provider-secret-marker";
      const fixture = await createS3ExecutionFixture({
        accessExit: 1,
        lsfDiagnostics: `${scenario.diagnostics} ${providerSecret}\n`,
      });
      const stages: import("./backupFilesystem.js").BackupFilesystemStageEvent[] =
        [];
      try {
        await assert.rejects(
          executeFilesystemBackup({
            ...s3ExecutionInput(fixture),
            onStage: (event) => stages.push(event),
          }),
          (error: unknown) => {
            assert.ok(error instanceof BackupFilesystemError);
            assert.equal(error.stage, "repository-check");
            assert.equal(error.code, scenario.code);
            assert.ok(!JSON.stringify(error).includes(providerSecret));
            return true;
          },
        );
        assert.equal(
          (await readCalls(path.join(fixture.dataDir, "rclone.calls"))).filter(
            (args) => args[0] === "lsf",
          ).length,
          1,
          "One access check, no retry loop",
        );
        assert.ok(
          !existsSync(path.join(fixture.dataDir, "restic-calls")),
          "Restic must not run after a failed S3 access check.",
        );
        assert.ok(
          stages.some((event) => event.message === "real repository failure"),
        );
        for (const forbidden of [providerSecret, "synthetic-secret-key-01"])
          assert.ok(!JSON.stringify(stages).includes(forbidden));
        assert.deepEqual(
          (await readdir(fixture.dataDir)).filter((name) =>
            name.startsWith("rclone-"),
          ),
          [],
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

linuxExecutionTest(
  "S3: a missing bucket (rclone exit 3) is a repository failure, never an empty target",
  async () => {
    const fixture = await createS3ExecutionFixture({
      accessExit: 3,
      lsfDiagnostics: "directory not found\n",
    });
    try {
      await assert.rejects(
        executeFilesystemBackup(s3ExecutionInput(fixture)),
        (error: unknown) =>
          error instanceof BackupFilesystemError &&
          error.stage === "repository-check" &&
          error.code === "repository-check-failed",
      );
      assert.ok(!existsSync(path.join(fixture.dataDir, "restic-calls")));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

linuxExecutionTest(
  "S3: objects under the prefix refuse initialization; an empty listing initializes",
  async () => {
    const occupied = await createS3ExecutionFixture({ targetListing: "config\n" });
    try {
      await assert.rejects(
        executeFilesystemBackup(s3ExecutionInput(occupied)),
        (error: unknown) =>
          error instanceof BackupFilesystemError &&
          error.stage === "repository-target-check" &&
          error.code === "repository-target-not-empty",
      );
      assert.ok(
        !(await readCalls(path.join(occupied.dataDir, "restic-calls"))).some(
          (args) => args.includes("init") || args.includes("backup"),
        ),
      );
    } finally {
      await rm(occupied.root, { recursive: true, force: true });
    }
    const missingBucket = await createS3ExecutionFixture({ targetExit: 3 });
    try {
      await assert.rejects(
        executeFilesystemBackup(s3ExecutionInput(missingBucket)),
        (error: unknown) =>
          error instanceof BackupFilesystemError &&
          error.stage === "repository-target-check" &&
          error.code === "repository-target-check-failed",
      );
      assert.ok(
        !(await readCalls(path.join(missingBucket.dataDir, "restic-calls"))).some(
          (args) => args.includes("init"),
        ),
      );
    } finally {
      await rm(missingBucket.root, { recursive: true, force: true });
    }
    const empty = await createS3ExecutionFixture();
    const stages: string[] = [];
    try {
      await executeFilesystemBackup({
        ...s3ExecutionInput(empty),
        onStage: (event) => stages.push(`${event.stage}:${event.message}`),
      });
      assert.ok(stages.includes("repository-check:storage access check started"));
      assert.ok(stages.includes("repository-check:storage access verified"));
      assert.ok(stages.includes("repository-target-check:target-empty"));
      assert.ok(!stages.includes("repository-target-check:target-not-found"));
      assert.equal(
        (await readCalls(path.join(empty.dataDir, "rclone.calls"))).filter(
          (args) => args[0] === "lsf",
        ).length,
        2,
      );
    } finally {
      await rm(empty.root, { recursive: true, force: true });
    }
  },
);

for (const scenario of [
  {
    name: "a refused upload",
    diagnostics:
      "rclone: operation error S3: PutObject, https response error StatusCode: 403, RequestID: 1, HostID: 2, api error AccessDenied: Access Denied\nFatal: unable to save snapshot: synthetic\n",
    code: "target-check-access-failed",
  },
  {
    name: "a rejected key",
    diagnostics:
      "rclone: operation error S3: PutObject, https response error StatusCode: 403, RequestID: 1, HostID: 2, api error SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.\n",
    code: "target-check-auth-failed",
  },
  {
    name: "a provider error",
    diagnostics:
      "rclone: operation error S3: PutObject, https response error StatusCode: 500, RequestID: 1, HostID: 2, api error InternalError: We encountered an internal error.\n",
    code: "target-check-transport-failed",
  },
  {
    name: "an unclassified failure",
    diagnostics: "Fatal: unable to save snapshot: synthetic\n",
    code: "restic-backup-failed",
  },
])
  linuxExecutionTest(
    `S3: a Restic backup failure from ${scenario.name} becomes ${scenario.code}`,
    async () => {
      const fixture = await createS3ExecutionFixture({
        backupExit: 1,
        backupDiagnostics: scenario.diagnostics,
      });
      try {
        await assert.rejects(
          executeFilesystemBackup(s3ExecutionInput(fixture)),
          (error: unknown) => {
            assert.ok(error instanceof BackupFilesystemError);
            assert.equal(error.stage, "restic-backup");
            assert.equal(error.code, scenario.code);
            assert.ok(!JSON.stringify(error).includes("RequestID"));
            return true;
          },
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

linuxExecutionTest(
  "S3: SFTP Restic backup failures keep restic-backup-failed",
  async () => {
    const fixture = await createExecutionFixture("");
    await writeFile(
      path.join(fixture.binDir, "restic"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("cat") && args.includes("config")) console.log(JSON.stringify({ version: 2, id: "c".repeat(64) }));
else if (args.includes("snapshots")) process.exitCode = 1;
else if (args.includes("backup")) { process.stderr.write("api error AccessDenied: Access Denied StatusCode: 403\\n"); process.exitCode = 1; }
`,
    );
    try {
      await assert.rejects(
        executeFilesystemBackup(executionInput(fixture)),
        (error: unknown) =>
          error instanceof BackupFilesystemError &&
          error.stage === "restic-backup" &&
          error.code === "restic-backup-failed",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);
```

- [ ] **Step 2: Run the tests to verify they fail**

```sh
bash tmp/linux-run.sh 'cd agent && node --test --test-reporter=spec --test-name-pattern="^S3:" dist/backupFilesystem.test.js'
```

Expected: the Task 5 and Task 6 `S3:` tests pass; the seven access-check tests, the missing-bucket test, the empty-target test and three Restic-backup classification tests fail (for example `the access check maps an unknown access key ...` rejects at `repository-target-check` with `repository-target-check-failed`, and `objects under the prefix ...` initializes because the first listing is empty); `a Restic backup failure from an unclassified failure becomes restic-backup-failed` and `S3: SFTP Restic backup failures keep restic-backup-failed` already pass; the summary shows `ℹ fail 12`.

- [ ] **Step 3: Implement the S3 classification and checks**

In `agent/src/backupFilesystem.ts`, in the `BackupFilesystemStageEvent` message union, find:

```ts
    | "repository check started"
```

Replace with:

```ts
    | "repository check started"
    | "storage access check started"
    | "storage access verified"
```

In `toBackupFilesystemError`, find:

```ts
  const code: BackupFilesystemFailureCode =
    stage === "payload-validation"
```

Replace with:

```ts
  if (
    stage === "restic-backup" &&
    error instanceof ProgramExitError &&
    error.storageFailure
  )
    return new BackupFilesystemError(stage, error.storageFailure);
  const code: BackupFilesystemFailureCode =
    stage === "payload-validation"
```

Find:

```ts
class ProgramTimeoutError extends Error {
  constructor(readonly diagnostic?: RepositoryDiagnostic) {
    super("Backup process timed out.");
  }
}
```

Replace with:

```ts
class ProgramTimeoutError extends Error {
  constructor(readonly diagnostic?: RepositoryDiagnostic) {
    super("Backup process timed out.");
  }
}

/** A classified S3 Restic failure; provider text never leaves runProgram. */
class ProgramExitError extends Error {
  constructor(readonly storageFailure?: RepositoryTargetFailureCode) {
    super("Backup process failed.");
  }
}
```

In `ProcessOptions`, find:

```ts
  classifyRepositoryFailure?: boolean;
  stdin?: string;
```

Replace with:

```ts
  classifyRepositoryFailure?: boolean;
  /** S3 `restic backup` only: map storage-specific provider text to closed codes. */
  classifyBackupStorageFailure?: boolean;
  stdin?: string;
```

Replace the whole function `repositoryDiagnostic` (lines 373-399) with:

```ts
/** S3 SDK codes for a wrong or revoked key. Checked before 403 access, which they also carry. */
const S3_AUTHENTICATION_FAILURE = /SignatureDoesNotMatch|InvalidAccessKeyId/;
/** S3 refusals (AWS SDK v2 "StatusCode: 403", SDK v1 "status code: 403"). */
const S3_ACCESS_FAILURE = /\bAccessDenied\b|status ?code: 403\b/i;
/** Text only a storage transport produces: TCP/SSH, DNS, TLS, HTTP client timeouts and S3 5xx. */
const STORAGE_TRANSPORT_FAILURE =
  /dial tcp|connection refused|connection reset|connection closed|i\/o timeout|connection timed out|broken pipe|no route to host|network is unreachable|no such host|server misbehaving|x509: |tls: |TLS handshake timeout|Client\.Timeout exceeded|status ?code: 5\d\d\b|api error (?:InternalError|ServiceUnavailable|SlowDown)\b|(?:^|[\s:])(?:unexpected )?EOF(?:\s|$)/i;

function repositoryDiagnostic(
  code: number | null,
  diagnostics: string,
): RepositoryDiagnostic | undefined {
  if (
    code === 12 ||
    /wrong password|no key found|unable to authenticate|authentication failed|failed to authenticate|ssh: handshake failed.*authenticate/i.test(
      diagnostics,
    ) ||
    S3_AUTHENTICATION_FAILURE.test(diagnostics)
  )
    return "authentication-failed";
  if (
    /permission denied|access denied|operation not permitted/i.test(
      diagnostics,
    ) ||
    S3_ACCESS_FAILURE.test(diagnostics)
  )
    return "access-failed";
  if (classifyTargetFailure(diagnostics) === "target-check-transport-failed")
    return "transport-failed";
  if (code === 10) return "repository-unavailable";
  if (
    /ciphertext verification failed|invalid data returned|invalid repository|unsupported repository version|config.*(?:invalid|corrupt)|load.*snapshot.*(?:corrupt|invalid)/i.test(
      diagnostics,
    )
  )
    return "invalid-repository";
  if (code !== 0) return "process-failed";
  return undefined;
}
```

Replace the whole function `classifyTargetFailure` with its doc comment (lines 571-597) with:

```ts
/** Provider text is used only to categorize failures, never to permit init or log it. */
function classifyTargetFailure(
  diagnostics: string,
): RepositoryTargetFailureCode | undefined {
  if (
    /unable to authenticate|authentication failed|no supported methods remain|permission denied \((?:publickey|password|keyboard-interactive)/i.test(
      diagnostics,
    ) ||
    S3_AUTHENTICATION_FAILURE.test(diagnostics)
  ) {
    return "target-check-auth-failed";
  }
  if (
    /permission denied|access denied|SSH_FX_PERMISSION_DENIED|operation not permitted/i.test(
      diagnostics,
    ) ||
    S3_ACCESS_FAILURE.test(diagnostics)
  ) {
    return "target-check-access-failed";
  }
  if (STORAGE_TRANSPORT_FAILURE.test(diagnostics)) {
    return "target-check-transport-failed";
  }
  return undefined;
}

/** Restic backup stderr also carries source errors, so only storage-specific provider text is classified. */
function classifyBackupStorageFailure(
  diagnostics: string,
): RepositoryTargetFailureCode | undefined {
  if (S3_AUTHENTICATION_FAILURE.test(diagnostics))
    return "target-check-auth-failed";
  if (S3_ACCESS_FAILURE.test(diagnostics)) return "target-check-access-failed";
  if (STORAGE_TRANSPORT_FAILURE.test(diagnostics))
    return "target-check-transport-failed";
  return undefined;
}
```

In `runProgram`, find:

```ts
      if (options.classifyTargetFailure || options.classifyRepositoryFailure) {
        diagnostics = appendBounded(diagnostics, String(chunk));
      }
```

Replace with:

```ts
      if (
        options.classifyTargetFailure ||
        options.classifyRepositoryFailure ||
        options.classifyBackupStorageFailure
      ) {
        diagnostics = appendBounded(diagnostics, String(chunk));
      }
```

Find:

```ts
          if (timedOut) {
            const reason = options.classifyRepositoryFailure
```

Replace with:

```ts
          if (timedOut) {
            if (options.classifyBackupStorageFailure)
              return reject(
                new ProgramExitError(classifyBackupStorageFailure(diagnostics)),
              );
            const reason = options.classifyRepositoryFailure
```

Find:

```ts
            return reject(
              new Error(
                `Backup process exited with status ${code ?? "unknown"}.`,
              ),
            );
```

Replace with:

```ts
            return reject(
              options.classifyBackupStorageFailure
                ? new ProgramExitError(classifyBackupStorageFailure(diagnostics))
                : new Error(
                    `Backup process exited with status ${code ?? "unknown"}.`,
                  ),
            );
```

After the closing `}` of `verifyRepository` (line 890), add:

```ts

/**
 * S3 credentials and reachability, checked by Rclone directly before Restic:
 * Restic's Rclone bridge (`rclone serve restic`) turns provider errors into
 * plain HTTP statuses. A missing prefix lists as empty with exit 0; any other
 * exit, including 3 (missing bucket), fails without a retry loop.
 */
async function checkS3RepositoryAccess(
  rclone: string,
  target: string,
  env: NodeJS.ProcessEnv,
  shouldCancel: () => Promise<boolean>,
  diagnostic: (reason: RepositoryDiagnostic) => void,
): Promise<void> {
  let reason: RepositoryDiagnostic | undefined;
  try {
    const result = await runProgram(rclone, ["lsf", target], {
      env,
      shouldCancel,
      timeoutMs: 30_000,
      allowFailure: true,
      classifyRepositoryFailure: true,
    });
    if (result.code === 0) return;
    reason = result.repositoryFailure;
  } catch (error) {
    if (error instanceof BackupCancelledError || error instanceof CommandStatusError)
      throw error;
    reason =
      error instanceof ProgramTimeoutError
        ? error.diagnostic || "timeout"
        : "process-failed";
  }
  diagnostic(reason || "process-failed");
  throw new BackupFilesystemError(
    "repository-check",
    reason === "authentication-failed"
      ? "target-check-auth-failed"
      : reason === "access-failed"
        ? "target-check-access-failed"
        : reason === "transport-failed" || reason === "timeout"
          ? "target-check-transport-failed"
          : "repository-check-failed",
  );
}
```

In `ensureManagedRepository`, find:

```ts
  const missingTarget = listing.code === 3 && !listing.targetFailureCode;
```

Replace with:

```ts
  // S3 has no directories: a missing prefix lists as empty with exit 0, and
  // exit 3 means the bucket itself is missing, which never permits init.
  const missingTarget =
    payload.rclone.type === "sftp" &&
    listing.code === 3 &&
    !listing.targetFailureCode;
```

In `executeFilesystemBackup`, find:

```ts
    emitStage({
      stage: "repository-check",
      message: "repository check started",
    });
```

Replace with:

```ts
    emitStage({
      stage: "repository-check",
      message: "repository check started",
    });
    if (payload.rclone.type === "s3") {
      emitStage({
        stage: "repository-check",
        message: "storage access check started",
      });
      await checkS3RepositoryAccess(
        rclone,
        `${payload.repository.remoteName}:${payload.repository.path}`,
        rcloneEnv,
        input.shouldCancel,
        (diagnostic) =>
          emitStage({
            stage: "repository-check",
            message: "real repository failure",
            diagnostic,
          }),
      );
      emitStage({
        stage: "repository-check",
        message: "storage access verified",
      });
    }
```

In the `restic backup` call, find:

```ts
    await runProgram(restic, args, {
      env,
      source,
```

Replace with:

```ts
    await runProgram(restic, args, {
      env,
      source,
      classifyBackupStorageFailure: payload.rclone.type === "s3",
```

- [ ] **Step 4: Run the tests to verify they pass**

```sh
bash tmp/linux-run.sh 'cd agent && node --test --test-reporter=spec dist/*.test.js 2>&1 | tail -n 8'
```

Expected: every test passes, including the existing SFTP target-check and parent-discovery classification tests, `ℹ fail 0`.

- [ ] **Step 5: Record and commit**

```sh
node tmp/update-source-delta.mjs agent/src/backupFilesystem.ts agent/src/backupFilesystem.test.ts
pnpm build && pnpm test:contracts
git add agent/src/backupFilesystem.ts agent/src/backupFilesystem.test.ts contracts/standalone-source-v1.json
git diff --cached --check
git commit -m "feat(agent): classify S3 access, empty-target and backup failures"
```

Expected: `PASS standalone layout and 48 versioned Agent source files (33 explicit independent changes); no server imports`; `ℹ fail 0`.

---

### Task 8: Advertise S3 as Agent 0.8.0 with the new contract vector

**Files:**
- Modify: `agent/src/types.ts` (`AgentCapabilities` `:35-44`)
- Modify: `agent/src/inventory.ts` (`AGENT_VERSION` `:15`, capabilities `:107-139`)
- Modify: `agent/src/inventory.test.ts` (imports `:1-3`, append one test)
- Modify: `package.json` (`:3`), `agent/package.json` (`:3`)
- Modify: `contracts/standalone-source-v1.json` (`agentVersion` `:3`, generated entries)
- Create: `contracts/v0.8.0.json`
- Modify: `scripts/tests/contracts.test.mjs` (whole file), `scripts/tests/runtime-pins.test.mjs` (`:22`), `scripts/tests/release.test.mjs` (append), `scripts/package-release.mjs` (`:27`, `:145`), `scripts/verify-release.mjs` (`:10`)

**Interfaces:**
- Consumes: `signRequest`, `verifyCommand` (`protocol.ts`), `deriveCommandSecretsKey`, `openSealedCommandSecrets` (Task 1), `parseBackupFilesystemPayload` (Task 2), `verifyRelease`.
- Produces: `export const AGENT_VERSION = "0.8.0"`; `AgentCapabilities.repositoryBackends?: ("sftp" | "s3")[]`; `AgentCapabilities.backupPayloadVersion?: 5`; `contracts/v0.8.0.json` with keys `format`, `contract`, `description`, `request`, `command`, `sealing`.

- [ ] **Step 1: Write the failing tests**

In `agent/src/inventory.test.ts`, replace lines 1-3 with:

```ts
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_VERSION,
  collectInventory,
  commandTypesForInventory,
} from "./inventory.js";
```

Append to `agent/src/inventory.test.ts`:

```ts
test("advertises S3 repositories and backup payload version 5 as Agent 0.8.0", () => {
  const inventory = collectInventory({
    filesystemRootsConfigured: false,
    binDir: path.join(os.tmpdir(), "pluton-agent-absent-private-tools"),
  });
  assert.equal(AGENT_VERSION, "0.8.0");
  assert.equal(inventory.agentVersion, "0.8.0");
  assert.deepEqual(inventory.capabilities.repositoryBackends, ["sftp", "s3"]);
  assert.equal(inventory.capabilities.backupPayloadVersion, 5);
});
```

Create `contracts/v0.8.0.json` (the `sealing` values are spec 10.4 verbatim; `request.signature` and `command.signature` were computed with the unchanged 0.7.0 canonical forms and cross-checked against `agent/dist/protocol.js` while writing this plan):

```json
{
  "format": 1,
  "contract": "pluton-agent-0.8.0",
  "description": "Synthetic stage 1 S3 repository vectors from the approved wire contract (Pluton server repository, docs/S3_AGENT_REPOSITORY_DESIGN.md section 10). Sealing values are section 10.4 verbatim; request and command signatures use the unchanged 0.7.0 HMAC canonical forms. The 0.7.0 vectors remain valid.",
  "request": {
    "secret": "synthetic-agent-secret-0123456789abcdef",
    "timestamp": "4102444800000",
    "nonce": "synthetic-nonce-01",
    "method": "POST",
    "path": "/api/agent/heartbeat",
    "body": "{\"agentVersion\":\"0.8.0\",\"capabilities\":{\"backupExclusionsVersion\":1,\"repositoryBackends\":[\"sftp\",\"s3\"],\"backupPayloadVersion\":5}}",
    "signature": "beaDgqLpYlabcqnG4x3vdfq44ICD3+U+unhFyHi0/gc="
  },
  "command": {
    "secret": "synthetic-agent-secret-0123456789abcdef",
    "id": "cmd-synthetic-01",
    "type": "BACKUP_FILESYSTEM",
    "payload": {
      "version": 5,
      "backupId": "backup-01",
      "planId": "plan-01",
      "sourcePath": "/srv/example-app",
      "excludes": [".git"],
      "sourceDiagnosticsVersion": 1,
      "repository": {
        "remoteName": "pluton",
        "path": "bucket-01/pluton/app-01",
        "initialize": true
      },
      "rclone": {
        "type": "s3",
        "options": {
          "provider": "Other",
          "endpoint": "https://s3.example.internal",
          "force_path_style": "true",
          "use_accept_encoding_gzip": "false",
          "no_check_bucket": "true"
        }
      },
      "sealed": {
        "alg": "A256GCM",
        "kid": "pluton-agent-command-secrets-v1",
        "nonce": "AAECAwQFBgcICQoL",
        "ciphertext": "jh0qetVE17GJz08s3DXhomumBqDIVOhzX3A4LgVFJeiH9JSKr4qR7OowvN0duifn639ReyzbjXGWiSEWAaymlLJKNnxwbrP+vLmuRdk9vI+wuUG8cJhENnxGV0LXHElNyPLQME0jaSjTfM7T0n9LTBr7V76enQuphACHq53aFDwiyFLa5p/2ML2748FcdivP43U+",
        "tag": "pUKJ+stiEzlyVi8BFN6biQ=="
      }
    },
    "idempotencyKey": "idempotency-01",
    "leaseExpiresAt": "2099-01-01T00:00:00.000Z",
    "leaseToken": "0123456789abcdef0123456789abcdef0123456789abcdef",
    "signatureTimestamp": "4102444800000",
    "signature": "He24m4tnFkK87pwp6d06g8nP0hv8xh7l+1igrmqkWRw="
  },
  "sealing": {
    "secret": "synthetic-agent-secret-0123456789abcdef",
    "commandId": "cmd-synthetic-01",
    "leaseToken": "0123456789abcdef0123456789abcdef0123456789abcdef",
    "info": "pluton-agent-command-secrets-v1",
    "derivedKeyHex": "1f35dc3e9cf013165a2353883369bbfa7edd62b56072b3413c8074e2ffb93fac",
    "nonce": "AAECAwQFBgcICQoL",
    "plaintext": "{\"repositoryPassword\":\"synthetic-repository-password-01\",\"rclone\":{\"access_key_id\":\"SYNTHETICKEY01\",\"secret_access_key\":\"synthetic-secret-key-01\"}}",
    "ciphertext": "jh0qetVE17GJz08s3DXhomumBqDIVOhzX3A4LgVFJeiH9JSKr4qR7OowvN0duifn639ReyzbjXGWiSEWAaymlLJKNnxwbrP+vLmuRdk9vI+wuUG8cJhENnxGV0LXHElNyPLQME0jaSjTfM7T0n9LTBr7V76enQuphACHq53aFDwiyFLa5p/2ML2748FcdivP43U+",
    "tag": "pUKJ+stiEzlyVi8BFN6biQ=="
  }
}
```

Replace the whole of `scripts/tests/contracts.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { signRequest, verifyCommand } from '../../agent/dist/protocol.js';
import {
  parseBackupExclusions,
  sourceResticExclusions,
} from '../../agent/dist/backupExclusions.js';
import { parseBackupFilesystemPayload } from '../../agent/dist/backupFilesystem.js';
import { AGENT_VERSION } from '../../agent/dist/inventory.js';
import {
  deriveCommandSecretsKey,
  openSealedCommandSecrets,
} from '../../agent/dist/sealedSecrets.js';
import { validate } from '../validate-standalone.mjs';
const contract = JSON.parse(
  fs.readFileSync(new URL('../../contracts/v0.7.0.json', import.meta.url)),
);
const s3Contract = JSON.parse(
  fs.readFileSync(new URL('../../contracts/v0.8.0.json', import.meta.url)),
);
test(
  'standalone extraction has no runtime imports or build paths into the monorepo',
  validate,
);
test('Agent 0.8.0 retains the original 0.7.0 server request and command HMAC vectors', () => {
  assert.equal(AGENT_VERSION, '0.8.0');
  const r = contract.request;
  assert.equal(
    signRequest(r.secret, r.timestamp, r.nonce, r.method, r.path, r.body),
    r.signature,
  );
  const { secret, ...command } = contract.command;
  assert.equal(verifyCommand(secret, command), true);
  for (const mutation of [
    { payload: { changed: true } },
    { leaseToken: 'replaced' },
    { id: 'other' },
    { leaseExpiresAt: '2000-01-01T00:00:00Z' },
  ])
    assert.equal(verifyCommand(secret, { ...command, ...mutation }), false);
});
test('server-generated exclusion corpus matches acceptance, normalization and exact Restic anchoring', () => {
  for (const v of contract.exclusions) {
    if (!v.accepted) {
      assert.throws(() => parseBackupExclusions(v.input));
      continue;
    }
    assert.deepEqual(parseBackupExclusions(v.input), v.parsed);
    assert.deepEqual(
      sourceResticExclusions('/srv/example-app', v.parsed),
      v.restic,
    );
  }
});
test('versioned backup v4 retains exclusions and refuses newer versions and shell options', () => {
  const v = {
    version: 4,
    backupId: 'backup-01',
    planId: 'plan-01',
    sourcePath: '/srv/example-app',
    excludes: ['.git'],
    repository: {
      remoteName: 'pluton',
      path: 'repositories/app-01',
      initialize: false,
    },
    rclone: {
      type: 'sftp',
      options: {
        host: 'sftp.example.internal',
        user: 'backup_reader',
        pass: 'synthetic-only',
      },
    },
    repositoryPassword: 'synthetic-only-repository-password',
  };
  assert.equal(parseBackupFilesystemPayload(v).version, 4);
  assert.equal(parseBackupFilesystemPayload({ ...v, sourceDiagnosticsVersion: 1 }).sourceDiagnosticsVersion, 1);
  assert.throws(() => parseBackupFilesystemPayload({ ...v, sourceDiagnosticsVersion: 2 }));
  assert.throws(() => parseBackupFilesystemPayload({ ...v, version: 5 }));
  assert.throws(() => parseBackupFilesystemPayload({ ...v, command: 'sh' }));
  assert.throws(() =>
    parseBackupFilesystemPayload({
      ...v,
      rclone: {
        ...v.rclone,
        options: { ...v.rclone.options, ssh: 'unapproved' },
      },
    }),
  );
});
test('Agent 0.8.0 S3 stage 1 vectors: capabilities request, version 5 command HMAC and sealed secrets', () => {
  const r = s3Contract.request;
  assert.equal(
    signRequest(r.secret, r.timestamp, r.nonce, r.method, r.path, r.body),
    r.signature,
  );
  assert.deepEqual(JSON.parse(r.body).capabilities, {
    backupExclusionsVersion: 1,
    repositoryBackends: ['sftp', 's3'],
    backupPayloadVersion: 5,
  });
  const { secret, ...command } = s3Contract.command;
  assert.equal(verifyCommand(secret, command), true);
  const sealedField = command.payload.sealed;
  const tampered = Buffer.from(sealedField.ciphertext, 'base64');
  tampered[0] ^= 1;
  assert.equal(
    verifyCommand(secret, {
      ...command,
      payload: {
        ...command.payload,
        sealed: { ...sealedField, ciphertext: tampered.toString('base64') },
      },
    }),
    false,
  );
  const s = s3Contract.sealing;
  assert.equal(deriveCommandSecretsKey(s.secret).toString('hex'), s.derivedKeyHex);
  const context = { secret: s.secret, commandId: s.commandId, leaseToken: s.leaseToken };
  assert.deepEqual(sealedField, {
    alg: 'A256GCM',
    kid: s.info,
    nonce: s.nonce,
    ciphertext: s.ciphertext,
    tag: s.tag,
  });
  assert.deepEqual(openSealedCommandSecrets(sealedField, context), JSON.parse(s.plaintext));
  assert.equal(command.id, s.commandId);
  assert.equal(command.leaseToken, s.leaseToken);
  assert.equal(secret, s.secret);
  const parsed = parseBackupFilesystemPayload(command.payload, context);
  assert.equal(parsed.version, 5);
  assert.equal(parsed.rclone.type, 's3');
  assert.equal(parsed.rclone.options.access_key_id, 'SYNTHETICKEY01');
  assert.equal(parsed.rclone.options.secret_access_key, 'synthetic-secret-key-01');
  assert.equal(parsed.repositoryPassword, 'synthetic-repository-password-01');
  assert.deepEqual(parsed.excludes, ['.git']);
  assert.equal(parsed.sourceDiagnosticsVersion, 1);
  assert.throws(() =>
    parseBackupFilesystemPayload(command.payload, { ...context, leaseToken: 'f'.repeat(48) }),
  );
  assert.throws(() =>
    parseBackupFilesystemPayload(command.payload, { ...context, commandId: 'cmd-synthetic-02' }),
  );
});
```

In `scripts/tests/runtime-pins.test.mjs`, find:

```js
  assert.equal(JSON.parse(read('agent/package.json')).version, '0.7.1');
```

Replace with:

```js
  assert.equal(JSON.parse(read('agent/package.json')).version, '0.8.0');
```

Append to `scripts/tests/release.test.mjs`:

```js
test('release identity accepts the 0.8 series and refuses unsupported versions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-release-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = ['example-source.tar.gz', 'example-app.tar.gz'];
  for (const f of files) fs.writeFileSync(path.join(root, f), 'synthetic archive');
  const sha256 = crypto.createHash('sha256').update('synthetic archive').digest('hex');
  const manifest = (version) => ({
    format: 1,
    version,
    sourceCommit: 'a'.repeat(40),
    platform: 'linux-x64',
    artifacts: files.map((file) => ({ file, sha256 })),
  });
  fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify(manifest('v0.8.0')));
  assert.equal(verifyRelease(root).version, 'v0.8.0');
  for (const version of ['v0.9.0', 'v1.0.0', '0.8.0']) {
    fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify(manifest(version)));
    assert.throws(() => verifyRelease(root), /release identity/);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```sh
pnpm build
```

Expected: FAIL with `src/inventory.test.ts(...): error TS2339: Property 'repositoryBackends' does not exist on type 'AgentCapabilities'.` (and the same for `backupPayloadVersion`).

- [ ] **Step 3: Implement the version and capabilities**

In `agent/src/types.ts`, find:

```ts
  sourceAccessVersion?: 1;
  sourceAccessModesVersion?: 1;
};
```

Replace with:

```ts
  sourceAccessVersion?: 1;
  sourceAccessModesVersion?: 1;
  /** Repository types this Agent backs up to (S3 design 10.1); always contains "sftp". */
  repositoryBackends?: ("sftp" | "s3")[];
  /** Highest BACKUP_FILESYSTEM payload version this Agent accepts (S3 design 10.1). */
  backupPayloadVersion?: 5;
};
```

In `agent/src/inventory.ts`, replace `export const AGENT_VERSION = "0.7.1";` with:

```ts
export const AGENT_VERSION = "0.8.0";
```

and find:

```ts
    capabilities: {
      backupExclusionsVersion: 1,
```

Replace with:

```ts
    capabilities: {
      backupExclusionsVersion: 1,
      // S3 design 10.1. The server's strict inventory schema must accept these first.
      repositoryBackends: ["sftp", "s3"],
      backupPayloadVersion: 5,
```

In `package.json` and in `agent/package.json`, replace `  "version": "0.7.1",` with:

```json
  "version": "0.8.0",
```

In `contracts/standalone-source-v1.json`, replace `  "agentVersion": "0.7.1",` with:

```json
  "agentVersion": "0.8.0",
```

In `scripts/package-release.mjs`, find:

```js
if (!/^v0\.7\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(sourceCommit))
```

Replace with:

```js
if (!/^v0\.[78]\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(sourceCommit))
```

and replace `  contract: 'pluton-agent-0.7.0',` with:

```js
  contract: 'pluton-agent-0.8.0',
```

In `scripts/verify-release.mjs`, find:

```js
    !/^v0\.7\.\d+$/.test(manifest.version) ||
```

Replace with:

```js
    !/^v0\.[78]\.\d+$/.test(manifest.version) ||
```

- [ ] **Step 4: Run the tests to verify they pass**

```sh
node tmp/update-source-delta.mjs agent/src/types.ts agent/src/inventory.ts agent/src/inventory.test.ts
pnpm build && node --test --test-reporter=spec agent/dist/inventory.test.js && pnpm test:contracts
bash tmp/linux-run.sh 'node --test --test-reporter=spec scripts/tests/*.test.mjs 2>&1 | tail -n 8; cd agent && node --test --test-reporter=spec dist/*.test.js 2>&1 | tail -n 8'
```

Expected: inventory `ℹ tests 3`, `ℹ pass 3`, `ℹ fail 0`; `pnpm test:contracts` prints `PASS standalone layout and 48 versioned Agent source files (34 explicit independent changes); no server imports` and `ℹ fail 0` with the new `Agent 0.8.0 S3 stage 1 vectors` and `release identity accepts the 0.8 series` tests passing; both Linux summaries end in `ℹ fail 0`.

- [ ] **Step 5: Commit**

```sh
git add agent/src/types.ts agent/src/inventory.ts agent/src/inventory.test.ts agent/package.json package.json contracts/standalone-source-v1.json contracts/v0.8.0.json scripts/tests/contracts.test.mjs scripts/tests/runtime-pins.test.mjs scripts/tests/release.test.mjs scripts/package-release.mjs scripts/verify-release.mjs
git diff --cached --check
git commit -m "feat(agent): advertise S3 repositories as Agent 0.8.0"
```

Expected: no `--check` output; commit succeeds.

---

### Task 9: Installer key `PLUTON_AGENT_STORAGE_CA_FILE`

**Files:**
- Modify: `installers/install-agent.sh` (variables `:26-27`; usage `:78`; argument parsing `:154-158`; `compatibility_preflight` `:261-263`; `validate_agent_access_to_roots` `:371-375`; new functions after `preserve_existing_optional_config` `:377-385`; `write_config` `:727-729`; `install_agent` `:889`)
- Modify: `installers/tests/install-agent.test.sh` (new function after `:194`, call after `:496`)
- Modify: `agent/examples/pluton-agent.env.example`

**Interfaces:**
- Consumes: existing `fail`, `log`, `is_test_mode`, `escape_environment_value`, `runuser`, `CONFIG_FILE`, `AGENT_USER`.
- Produces: option `--storage-ca-file <path>`; variable `STORAGE_CA_FILE`; functions `validate_storage_ca_file()` and `preserve_existing_storage_ca_config()`; environment line `PLUTON_AGENT_STORAGE_CA_FILE="<path>"` in `/etc/pluton-agent.env`.

- [ ] **Step 1: Write the failing test**

In `installers/tests/install-agent.test.sh`, after the function `test_multiple_roots_and_private_ca_configuration` (ends at line 194), add:

```bash

test_storage_ca_configuration() {
	local root storage_ca
	root="$(make_root storage-ca)"
	storage_ca="$root/storage-ca.pem"
	printf 'synthetic-storage-ca' > "$storage_ca"
	run_installer "$root" --server https://pluton.example.internal --allowed-root "$root/source" --storage-ca-file "$storage_ca"
	grep -Fx "PLUTON_AGENT_STORAGE_CA_FILE=\"$storage_ca\"" "$root/etc/pluton-agent.env" >/dev/null || fail 'The storage CA was not written to the environment file.'
	if grep -q '^PLUTON_AGENT_CA_FILE=' "$root/etc/pluton-agent.env"; then
		fail 'The storage CA must not become the control-plane CA.'
	fi
	run_installer "$root" --server https://pluton.example.internal --allowed-root "$root/source"
	grep -Fx "PLUTON_AGENT_STORAGE_CA_FILE=\"$storage_ca\"" "$root/etc/pluton-agent.env" >/dev/null || fail 'Reinstall did not preserve the storage CA.'
	root="$(make_root storage-ca-relative)"
	if run_installer "$root" --server https://pluton.example.internal --allowed-root "$root/source" --storage-ca-file storage-ca.pem >/dev/null 2>&1; then
		fail 'A relative storage CA path was accepted.'
	fi
	root="$(make_root storage-ca-link)"
	printf 'synthetic-storage-ca' > "$root/target.pem"
	ln -s "$root/target.pem" "$root/link.pem"
	if run_installer "$root" --server https://pluton.example.internal --allowed-root "$root/source" --storage-ca-file "$root/link.pem" >/dev/null 2>&1; then
		fail 'A symbolic-link storage CA path was accepted.'
	fi
}
```

In the call list at the end of the file, find:

```bash
test_multiple_roots_and_private_ca_configuration
test_platform_rejections
```

Replace with:

```bash
test_multiple_roots_and_private_ca_configuration
test_storage_ca_configuration
test_platform_rejections
```

- [ ] **Step 2: Run the test to verify it fails**

```sh
bash tmp/linux-run.sh 'bash installers/tests/install-agent.test.sh'
```

Expected: FAIL with `[pluton-agent-installer] Error: Unknown option: --storage-ca-file` and a non-zero exit; `PASS: install-agent installer tests` is not printed.

- [ ] **Step 3: Implement the installer option**

In `installers/install-agent.sh`, find:

```bash
CA_FILE=''
ALLOW_INSECURE_HTTP='false'
```

Replace with:

```bash
CA_FILE=''
STORAGE_CA_FILE=''
ALLOW_INSECURE_HTTP='false'
```

Find:

```text
  --ca-file <path>             PEM file for a private HTTPS CA.
```

Replace with:

```text
  --ca-file <path>             PEM file for a private HTTPS CA.
  --storage-ca-file <path>     Root-owned PEM bundle for S3 repositories, passed to Restic/Rclone as SSL_CERT_FILE.
```

Find:

```bash
			--ca-file)
				[[ $# -ge 2 ]] || fail '--ca-file requires a file path.'
				CA_FILE="$2"
				shift 2
				;;
```

Replace with:

```bash
			--ca-file)
				[[ $# -ge 2 ]] || fail '--ca-file requires a file path.'
				CA_FILE="$2"
				shift 2
				;;
			--storage-ca-file)
				[[ $# -ge 2 ]] || fail '--storage-ca-file requires a file path.'
				STORAGE_CA_FILE="$2"
				shift 2
				;;
```

Find (in `compatibility_preflight`):

```bash
	if [[ -n "$CA_FILE" ]]; then
		[[ "$CA_FILE" == /* && -f "$CA_FILE" && -r "$CA_FILE" ]] || fail '--ca-file must be an existing readable absolute PEM file.'
	fi
```

Replace with:

```bash
	if [[ -n "$CA_FILE" ]]; then
		[[ "$CA_FILE" == /* && -f "$CA_FILE" && -r "$CA_FILE" ]] || fail '--ca-file must be an existing readable absolute PEM file.'
	fi
	validate_storage_ca_file
```

Find (end of `validate_agent_access_to_roots`):

```bash
		runuser -u "$AGENT_USER" -- test -r "$CA_FILE" || fail 'The pluton-agent account cannot read --ca-file.'
	fi
}
```

Replace with:

```bash
		runuser -u "$AGENT_USER" -- test -r "$CA_FILE" || fail 'The pluton-agent account cannot read --ca-file.'
	fi
	if [[ -n "$STORAGE_CA_FILE" ]]; then
		runuser -u "$AGENT_USER" -- test -r "$STORAGE_CA_FILE" || fail 'The pluton-agent account cannot read --storage-ca-file.'
	fi
}
```

Find (end of `preserve_existing_optional_config`):

```bash
	CA_FILE="${encoded//\\\\/\\}"
	log 'Preserving the existing private CA configuration.'
}
```

Replace with:

```bash
	CA_FILE="${encoded//\\\\/\\}"
	log 'Preserving the existing private CA configuration.'
}

# The Agent passes this bundle to Restic and Rclone as SSL_CERT_FILE for S3
# repositories only; it replaces the system trust store for those connections.
# The Agent itself re-checks root ownership of the whole path at backup time.
validate_storage_ca_file() {
	[[ -n "$STORAGE_CA_FILE" ]] || return 0
	[[ "$STORAGE_CA_FILE" == /* && -f "$STORAGE_CA_FILE" && ! -L "$STORAGE_CA_FILE" && -r "$STORAGE_CA_FILE" ]] || fail '--storage-ca-file must be an existing readable absolute PEM file, not a symbolic link.'
	if is_test_mode; then return 0; fi
	[[ "$(stat -c '%u' -- "$STORAGE_CA_FILE")" == 0 ]] || fail '--storage-ca-file must be owned by root.'
	(( (8#$(stat -c '%a' -- "$STORAGE_CA_FILE") & 8#022) == 0 )) || fail '--storage-ca-file must not be group- or world-writable.'
}

preserve_existing_storage_ca_config() {
	[[ -z "$STORAGE_CA_FILE" && -f "$CONFIG_FILE" ]] || return 0
	local encoded
	encoded="$(sed -n 's/^PLUTON_AGENT_STORAGE_CA_FILE="\(.*\)"$/\1/p' "$CONFIG_FILE" | head -n 1)"
	[[ -n "$encoded" ]] || return 0
	encoded="${encoded//\\\"/\"}"
	STORAGE_CA_FILE="${encoded//\\\\/\\}"
	log 'Preserving the existing storage CA configuration.'
}
```

Find (in `write_config`):

```bash
			if [[ -n "$CA_FILE" ]]; then
				printf 'PLUTON_AGENT_CA_FILE="%s"\n' "$(escape_environment_value "$CA_FILE")"
			fi
```

Replace with:

```bash
			if [[ -n "$CA_FILE" ]]; then
				printf 'PLUTON_AGENT_CA_FILE="%s"\n' "$(escape_environment_value "$CA_FILE")"
			fi
			if [[ -n "$STORAGE_CA_FILE" ]]; then
				printf 'PLUTON_AGENT_STORAGE_CA_FILE="%s"\n' "$(escape_environment_value "$STORAGE_CA_FILE")"
			fi
```

Find (in `install_agent`):

```bash
	preserve_existing_optional_config
	create_stage_root
```

Replace with:

```bash
	preserve_existing_optional_config
	preserve_existing_storage_ca_config
	validate_storage_ca_file
	create_stage_root
```

In `agent/examples/pluton-agent.env.example`, find:

```text
# PLUTON_AGENT_CLIENT_KEY_FILE=/etc/pluton-agent/client-key.pem
```

Replace with:

```text
# PLUTON_AGENT_CLIENT_KEY_FILE=/etc/pluton-agent/client-key.pem

# Optional root-owned CA bundle for S3 repositories. The Agent passes it to
# Restic and Rclone as SSL_CERT_FILE, which replaces the system trust store for
# storage connections only. The server never sends CA files.
# PLUTON_AGENT_STORAGE_CA_FILE=/etc/pluton-agent/storage-ca.pem
```

- [ ] **Step 4: Run the tests to verify they pass**

```sh
bash tmp/linux-run.sh 'bash -n installers/install-agent.sh && bash installers/tests/install-agent.test.sh && bash installers/tests/upgrade-agent.test.sh'
```

Expected: the last lines include `PASS: install-agent installer tests` and the upgrade test's PASS line; exit 0.

- [ ] **Step 5: Commit**

```sh
git add installers/install-agent.sh installers/tests/install-agent.test.sh agent/examples/pluton-agent.env.example
git diff --cached --check
git commit -m "feat(installer): accept an optional storage CA file"
```

Expected: no `--check` output; commit succeeds.

---

### Task 10: Post-dump lab with an HTTPS S3 fixture behind a private CA

**Files:**
- Modify: `tests/post-dump/native.lab.ts` (header `:1-2`; new S3 block between the end of the SFTP scenario loop `:565` and the final `agent_post_dump_native` log `:566`)
- Modify: `tests/post-dump/Dockerfile` (new `fixture-tls` stage and two `COPY` lines)

**Interfaces:**
- Consumes: the lab's existing `run`, `port`, `nativePids`, `secret`, `records`, `journal`, `current`, `completions`, `forbidden`, `serverUrl`, `source`, `root`, `agentSecret`, `repoPassword`, `dbPassword`, `runOnce`, `saveIdentity`, `fork`, `fileURLToPath`; `rclone serve s3` (`--auth-key`, `--cert`, `--key`) from the pinned Rclone 1.75.1; Agent `config.storageCaFile` (Task 6).
- Produces: image paths `/app/fixture-tls/ca.pem` (root-owned, mode 0644, for `PLUTON_AGENT_STORAGE_CA_FILE`) and `/app/fixture-tls-server/{server.pem,server-key.pem}` (owned by 10001); lab case records `s3-healthy`, `s3-untrusted-ca`, `s3-wrong-key`, `s3-non-empty`, `s3-tampered-seal`.

- [ ] **Step 1: Write the failing lab cases**

In `tests/post-dump/native.lab.ts`, replace lines 1-2:

```ts
/** Disposable real MySQL/dump + real Agent runtime + signed faulting control plane.
 * Provider output, SQL, credentials and signed bodies never leave the fixture. */
```

with:

```ts
/** Disposable real MySQL/dump + real Agent runtime + signed faulting control plane,
 * with an SFTP fixture and an HTTPS S3 fixture behind a private CA (Agent 0.8.0).
 * Provider output, SQL, credentials and signed bodies never leave the fixture. */
```

Find:

```ts
			originalInfo(JSON.stringify({ event: 'agent_post_dump_case', ...records.at(-1) }));
		}
		originalInfo(
			JSON.stringify({
				event: 'agent_post_dump_native',
```

Replace with:

```ts
			originalInfo(JSON.stringify({ event: 'agent_post_dump_case', ...records.at(-1) }));
		}
		if (!baseline) {
			// HTTPS S3 fixture with a private CA generated for this test image
			// (tests/post-dump/Dockerfile). The Agent trusts it only through
			// PLUTON_AGENT_STORAGE_CA_FILE (config.storageCaFile).
			const storageCaFile = '/app/fixture-tls/ca.pem';
			const s3Root = path.join(root, 's3');
			await fs.mkdir(path.join(s3Root, 'bucket-01', 'managed', 's3-occupied'), { recursive: true });
			await fs.writeFile(
				path.join(s3Root, 'bucket-01', 'managed', 's3-occupied', 'existing.txt'),
				'synthetic existing object\n'
			);
			const s3Port = await port();
			const s3AccessKey = 'SYNTHETICLABKEY01';
			const s3SecretKey = secret();
			const s3WrongSecretKey = secret();
			const s3 = spawn(
				'/usr/local/bin/rclone',
				[
					'serve',
					's3',
					s3Root,
					'--addr',
					`127.0.0.1:${s3Port}`,
					'--auth-key',
					`${s3AccessKey},${s3SecretKey}`,
					'--cert',
					'/app/fixture-tls-server/server.pem',
					'--key',
					'/app/fixture-tls-server/server-key.pem',
					'--cache-dir',
					path.join(root, 's3-cache'),
					'--config',
					path.join(root, 'rclone-s3.conf'),
				],
				{
					stdio: 'ignore',
					env: { ...process.env, HOME: root, XDG_CACHE_HOME: path.join(root, 'cache') },
				}
			);
			children.push(s3);
			for (let n = 0; ; n++) {
				const ready = await new Promise<boolean>(r => {
					const s = net.createConnection({ host: '127.0.0.1', port: s3Port });
					s.once('connect', () => {
						s.destroy();
						r(true);
					});
					s.once('error', () => r(false));
				});
				if (ready) break;
				assert(n < 120, 'Disposable S3 fixture did not start.');
				await new Promise(r => setTimeout(r, 25));
			}
			const listeners = (await nativePids('rclone')).length;
			const label = 'pluton-agent-command-secrets-v1';
			const sealSecrets = (commandId: string, leaseToken: string, plaintext: unknown) => {
				const key = Buffer.from(
					crypto.hkdfSync(
						'sha256',
						Buffer.from(agentSecret, 'utf8'),
						Buffer.alloc(0),
						Buffer.from(label, 'utf8'),
						32
					)
				);
				const nonce = crypto.randomBytes(12);
				const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
				cipher.setAAD(Buffer.from(`${label}\n${commandId}\n${leaseToken}`, 'utf8'));
				const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), 'utf8'), cipher.final()]);
				return {
					alg: 'A256GCM',
					kid: label,
					nonce: nonce.toString('base64'),
					ciphertext: ciphertext.toString('base64'),
					tag: cipher.getAuthTag().toString('base64'),
				};
			};
			const s3Cases = [
				{ scenario: 's3-healthy', repositoryPath: 'bucket-01/managed/s3-healthy', trusted: true, secretKey: s3SecretKey, tamper: false, expected: undefined },
				{ scenario: 's3-untrusted-ca', repositoryPath: 'bucket-01/managed/s3-untrusted', trusted: false, secretKey: s3SecretKey, tamper: false, expected: ['repository-check', 'target-check-transport-failed'] },
				{ scenario: 's3-wrong-key', repositoryPath: 'bucket-01/managed/s3-wrong-key', trusted: true, secretKey: s3WrongSecretKey, tamper: false, expected: ['repository-check', 'target-check-auth-failed'] },
				{ scenario: 's3-non-empty', repositoryPath: 'bucket-01/managed/s3-occupied', trusted: true, secretKey: s3SecretKey, tamper: false, expected: ['repository-target-check', 'repository-target-not-empty'] },
				{ scenario: 's3-tampered-seal', repositoryPath: 'bucket-01/managed/s3-tampered', trusted: true, secretKey: s3SecretKey, tamper: true, expected: ['payload-validation', 'invalid-payload'] },
			];
			for (let i = 0; i < s3Cases.length; i++) {
				const item = s3Cases[i];
				fault = item.scenario;
				remaining = 0;
				completeUncertain = false;
				postDump = false;
				dumpStarted = false;
				resticStarted = false;
				statusCalls = acknowledgements = events = applied = 0;
				completions = [];
				const dataDir = path.join(root, `state-s3-${i}`);
				activeDataDir = dataDir;
				await fs.mkdir(dataDir, { mode: 0o700 });
				await saveIdentity(dataDir, {
					deviceId: 'device-01',
					agentId: 'agent-01',
					secret: agentSecret,
					pollIntervalSeconds: 5,
					completedCommands: [],
				});
				const commandId = `command-s3-${i}`;
				const leaseToken = secret();
				const sealed = sealSecrets(commandId, leaseToken, {
					repositoryPassword: repoPassword,
					rclone: { access_key_id: s3AccessKey, secret_access_key: item.secretKey },
				});
				if (item.tamper) {
					const bytes = Buffer.from(sealed.ciphertext, 'base64');
					bytes[0] ^= 1;
					sealed.ciphertext = bytes.toString('base64');
				}
				current = {
					id: commandId,
					type: 'BACKUP_FILESYSTEM',
					idempotencyKey: `backup:s3-${i}`,
					leaseToken,
					leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
					signatureTimestamp: String(Date.now()),
					payload: {
						version: 5,
						backupId: `backup-s3-${i}`,
						planId: 'plan-01',
						sourcePath: source,
						excludes: [],
						repository: { remoteName: 'pluton', path: item.repositoryPath, initialize: true },
						rclone: {
							type: 's3',
							options: {
								provider: 'Other',
								endpoint: `https://127.0.0.1:${s3Port}`,
								region: 'us-east-1',
								force_path_style: 'true',
								use_accept_encoding_gzip: 'false',
								no_check_bucket: 'true',
							},
						},
						sealed,
						lifecycle: {
							version: 2,
							databases: [
								{
									databaseId: 'db_fixture',
									engine: 'mysql',
									host: '127.0.0.1',
									port: 3306,
									tls: 'local',
									database: 'example_db',
									username: 'backup_reader',
									password: dbPassword,
									dumpFilename: 'app.sql',
									timeoutSeconds: 60,
									maxDumpBytes: 4 * 1024 ** 2,
									includeRoutines: false,
									includeEvents: false,
								},
							],
						},
					},
				};
				current.signature = crypto
					.createHmac('sha256', agentSecret)
					.update(
						[
							'command',
							current.signatureTimestamp,
							current.id,
							current.type,
							JSON.stringify(current.payload),
							current.idempotencyKey,
							current.leaseToken,
							Date.parse(current.leaseExpiresAt).toString(),
						].join('\n')
					)
					.digest('base64');
				const config = {
					serverUrl,
					dataDir,
					allowedRoots: [source],
					allowInsecureHttp: true,
					binDir: '/usr/local/bin',
					databaseBinDirs: ['/usr/bin'],
					...(item.trusted ? { storageCaFile } : {}),
				};
				const started = performance.now();
				await runOnce(config);
				assert.deepEqual(await nativePids('mysqldump'), [], 'Owned native dump must stop before cleanup.');
				assert.deepEqual(await nativePids('restic'), [], 'Owned Restic process must stop before completion.');
				assert.equal((await nativePids('rclone')).length, listeners, 'Only the fixture listeners may remain.');
				assert.equal(completions.length, 1);
				const completion = completions[0];
				const repo = path.join(s3Root, item.repositoryPath);
				if (!item.expected) {
					assert.equal(
						completion.success,
						true,
						JSON.stringify({ stage: completion.failureStage, code: completion.failureCode })
					);
					assert(dumpStarted && postDump, 'The real MySQL dump must reach the S3 repository.');
					assert.match(completion.result.snapshotId, /^[a-f0-9]{64}$/);
					const receipt = completion.result.lifecycle.databases[0];
					assert(receipt.bytes > 0);
					const sql = await run(
						'/usr/local/bin/restic',
						['--no-cache', '-r', repo, 'dump', completion.result.snapshotId, receipt.path],
						undefined,
						{ RESTIC_PASSWORD: repoPassword }
					);
					assert.equal(Buffer.byteLength(sql), receipt.bytes);
					assert.equal(crypto.createHash('sha256').update(sql).digest('hex'), receipt.sha256);
					const snapshots = JSON.parse(
						await run('/usr/local/bin/restic', ['--no-cache', '-r', repo, 'snapshots', '--json'], undefined, {
							RESTIC_PASSWORD: repoPassword,
						})
					);
					assert.equal(snapshots.length, 1);
					assert.equal(snapshots[0].id, completion.result.snapshotId);
					// A fresh process replays the persisted receipt without a second execution.
					const previous = JSON.stringify(completion);
					const ackBefore = acknowledgements,
						eventsBefore = events;
					const child = fork(fileURLToPath(new URL('./restart.mjs', import.meta.url)), [], {
						stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
						env: { PATH: process.env.PATH },
					});
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => {
							child.kill();
							reject(new Error('Fresh-process reconciliation deadline.'));
						}, 20_000);
						child.once('message', (message: any) => {
							clearTimeout(timer);
							message.complete ? resolve() : reject(new Error('Fresh-process reconciliation refused.'));
						});
						child.once('error', () => reject(new Error('Fresh process unavailable.')));
						child.send({ ...config, serverUrl: config.serverUrl.href });
					});
					await new Promise<void>(resolve =>
						child.exitCode !== null ? resolve() : child.once('exit', () => resolve())
					);
					assert(JSON.stringify(completions[1]) === previous, 'Durable completion changed on replay.');
					assert.equal(acknowledgements, ackBefore, 'Restart replay must not ACK/execute the command again.');
					assert.equal(events, eventsBefore, 'Restart replay must not emit execution progress.');
					assert.equal(
						JSON.parse(
							await run('/usr/local/bin/restic', ['--no-cache', '-r', repo, 'snapshots', '--json'], undefined, {
								RESTIC_PASSWORD: repoPassword,
							})
						).length,
						1,
						'Completion replay must not create another snapshot.'
					);
				} else {
					assert.equal(completion.success, false);
					assert.deepEqual([completion.failureStage, completion.failureCode], item.expected);
					assert.equal(completion.result, undefined, 'A failed S3 backup cannot report a snapshot.');
					assert.equal(dumpStarted, item.scenario === 's3-non-empty', 'Only the non-empty prefix case reaches the dump.');
				}
				const files = await fs.readdir(dataDir);
				assert(!files.some(name => name.startsWith('rclone-')), 'The temporary S3 configuration must be removed.');
				if (item.scenario === 's3-tampered-seal')
					assert(!files.includes('jobs') && !files.includes('restic-cache'), 'A refused seal must not write backup state.');
				if (files.includes('jobs')) assert.equal((await fs.readdir(path.join(dataDir, 'jobs'))).length, 0);
				for (const value of [...forbidden, s3SecretKey, s3WrongSecretKey])
					assert(
						!JSON.stringify({
							journal,
							records,
							completions: completions.map(({ leaseToken, ...safe }) => safe),
						}).includes(value)
					);
				records.push({
					scenario: item.scenario,
					baseline,
					success: completion.success,
					stage: completion.failureStage,
					code: completion.failureCode,
					statusCalls,
					events,
					postDumpAttempts: applied,
					durationMs: Math.round(performance.now() - started),
				});
				originalInfo(JSON.stringify({ event: 'agent_post_dump_case', ...records.at(-1) }));
			}
		}
		originalInfo(
			JSON.stringify({
				event: 'agent_post_dump_native',
```

- [ ] **Step 2: Build the branch images and run the lab to verify it fails**

The post-dump image copies `agent/dist` from the validation image, so the validation image is rebuilt from the branch first. The first post-dump build pulls the pinned MySQL image.

```sh
docker build --platform linux/amd64 --progress=plain --target validation --build-arg UBUNTU_VERSION=22.04 --file tests/ubuntu/Dockerfile --tag pluton-agent-validation:s3-22.04 .
docker build --platform linux/amd64 --progress=plain --build-arg TOOL_IMAGE=pluton-agent-validation:s3-22.04 --file tests/post-dump/Dockerfile --tag pluton-agent-post-dump:s3-22.04 .
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate-post-dump.ps1 -RuntimeImage pluton-agent-post-dump:s3-22.04
```

Expected: the validation build succeeds (it runs every unit, contract, installer and release check of Tasks 1 to 9 as `tester` on Ubuntu 22.04, including `pnpm package:release` for `v0.8.0`). The lab prints the 24 SFTP `agent_post_dump_case` lines, then fails with `AssertionError ... Disposable S3 fixture did not start.` because `/app/fixture-tls-server/server.pem` does not exist yet; the runner ends with `Disposable native post-dump regression failed.`

- [ ] **Step 3: Add the private CA stage**

Replace the whole of `tests/post-dump/Dockerfile` with:

```dockerfile
# Native Linux test runner only; never an Agent deployment artifact.
ARG TOOL_IMAGE=pluton-agent-validation:ci-22.04
FROM ${TOOL_IMAGE} AS standalone-tools
# Disposable private CA and HTTPS S3 fixture certificate for this test image only.
# The CA key never leaves this stage. The runner receives the CA certificate
# root-owned (as the Agent requires for PLUTON_AGENT_STORAGE_CA_FILE) and the
# server pair owned by the unprivileged runner account.
FROM ${TOOL_IMAGE} AS fixture-tls
RUN set -eu; umask 022; mkdir /tmp/fixture-tls; cd /tmp/fixture-tls; \
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout ca-key.pem -out ca.pem \
      -subj '/CN=Synthetic Pluton Agent Lab CA' \
      -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign'; \
    openssl req -newkey rsa:2048 -nodes -keyout server-key.pem -out server.csr -subj '/CN=s3.example.internal'; \
    printf '%s\n' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' \
      'extendedKeyUsage=serverAuth' 'subjectAltName=DNS:s3.example.internal,IP:127.0.0.1' > server.ext; \
    openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -set_serial 1 -days 30 -sha256 \
      -extfile server.ext -out server.pem; \
    openssl verify -CAfile ca.pem server.pem; \
    chmod 0644 ca.pem server.pem; chmod 0600 server-key.pem
FROM mysql@sha256:24989179f58856db763f418010c1169fecc944e3ec1ea7e921572d83eb070f70
COPY --from=standalone-tools /opt/pluton-agent/runtime /opt/test-node
COPY --from=standalone-tools /opt/pluton-agent/bin/restic /usr/local/bin/restic
COPY --from=standalone-tools /opt/pluton-agent/bin/rclone /usr/local/bin/rclone
COPY --from=standalone-tools /workspace/agent/dist /app/agent/dist
COPY --from=standalone-tools /workspace/agent/package.json /app/agent/package.json
COPY --from=fixture-tls /tmp/fixture-tls/ca.pem /app/fixture-tls/ca.pem
COPY --from=fixture-tls --chown=10001:10001 /tmp/fixture-tls/server.pem /tmp/fixture-tls/server-key.pem /app/fixture-tls-server/
COPY tests/post-dump /app/tests/post-dump
ENV PATH=/opt/test-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER 10001:10001
ENTRYPOINT ["node", "--experimental-strip-types", "/app/tests/post-dump/native.lab.ts"]
```

- [ ] **Step 4: Rebuild the lab image and verify it passes**

```sh
docker build --platform linux/amd64 --progress=plain --build-arg TOOL_IMAGE=pluton-agent-validation:s3-22.04 --file tests/post-dump/Dockerfile --tag pluton-agent-post-dump:s3-22.04 .
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate-post-dump.ps1 -RuntimeImage pluton-agent-post-dump:s3-22.04
```

Expected: the build prints `server.pem: OK` from `openssl verify`. The lab prints the 24 SFTP cases unchanged, then five S3 lines:

```text
{"event":"agent_post_dump_case","scenario":"s3-healthy","baseline":false,"success":true,...}
{"event":"agent_post_dump_case","scenario":"s3-untrusted-ca","baseline":false,"success":false,"stage":"repository-check","code":"target-check-transport-failed",...}
{"event":"agent_post_dump_case","scenario":"s3-wrong-key","baseline":false,"success":false,"stage":"repository-check","code":"target-check-auth-failed",...}
{"event":"agent_post_dump_case","scenario":"s3-non-empty","baseline":false,"success":false,"stage":"repository-target-check","code":"repository-target-not-empty",...}
{"event":"agent_post_dump_case","scenario":"s3-tampered-seal","baseline":false,"success":false,"stage":"payload-validation","code":"invalid-payload",...}
```

followed by the final `{"event":"agent_post_dump_native","nodeVersion":"v22.23.4",...}` line and exit 0. If `s3-wrong-key` reports any code other than `target-check-auth-failed`, stop and capture the journal line `real repository failure ... reason=<value>`: do not change the expectation or the classifier until the cause (for example a different error code from `rclone serve s3`) is understood and reported.

- [ ] **Step 5: Run the CI-equivalent validation on both Ubuntu releases**

```sh
for version in 22.04 24.04; do
  docker build --platform linux/amd64 --progress=plain --target validation --build-arg UBUNTU_VERSION="$version" --file tests/ubuntu/Dockerfile --tag "pluton-agent-validation:s3-$version" . || break
  docker build --platform linux/amd64 --progress=plain --target runtime-upgrade --build-arg UBUNTU_VERSION="$version" --file tests/ubuntu/Dockerfile --tag "pluton-agent-runtime-upgrade:s3-$version" . || break
  docker build --platform linux/amd64 --progress=plain --build-arg TOOL_IMAGE="pluton-agent-validation:s3-$version" --file tests/post-dump/Dockerfile --tag "pluton-agent-post-dump:s3-$version" . || break
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate-post-dump.ps1 -RuntimeImage "pluton-agent-post-dump:s3-$version" || break
done
git diff --exit-code origin/main -- .github/workflows/ci.yml && echo "CI workflow unchanged"
```

Expected: all eight steps succeed for 22.04 and 24.04 (each lab run ends with the `agent_post_dump_native` line and exit 0), then `CI workflow unchanged`. The CI-only `network-routing` and `monorepo-migration` jobs are not affected by this change and run in hosted CI.

- [ ] **Step 6: Commit**

```sh
git add tests/post-dump/Dockerfile tests/post-dump/native.lab.ts
git diff --cached --check
git commit -m "test(lab): back up a database dump to an HTTPS S3 fixture with a private CA"
```

Expected: no `--check` output; commit succeeds.

---

### Task 11: Documentation and report

**Files:**
- Modify: `README.md` (`:4`, `:21-23`, `:26-28`)
- Modify: `docs/OPERATIONS.md` (`:78-80`, `:87`, `:125`, new section before `## Exclusions, DB and hooks` `:133`)
- Modify: `docs/COMPATIBILITY.md` (`:23-25`, table `:43`, `:48`, new section at the end after `:89`)
- Create: `docs/S3_REPOSITORY.md`

**Interfaces:**
- Consumes: results of Tasks 1 to 10; `scripts/tests/documentation.test.mjs` (every local Markdown link must resolve inside the repository).
- Produces: operator documentation of `PLUTON_AGENT_STORAGE_CA_FILE` and `--storage-ca-file`, the 0.8.0 compatibility rules, and the report `docs/S3_REPOSITORY.md`.

- [ ] **Step 1: Update README**

In `README.md`, replace `Agent capability version **0.7.0**` with:

```text
Agent version **0.8.0**
```

Find:

```text
                                +--> encrypted Restic backup --> SFTP primary
Server verifies primary, performs optional S3 replication and hosts recovery.
```

Replace with:

```text
                                +--> encrypted Restic backup --> SFTP or S3 primary
Server verifies the primary, replicates SFTP primaries to S3 when configured and
hosts recovery. The Agent receives the S3 key of its own S3-primary plans only;
never replica keys.
```

Find:

```text
[releases](docs/RELEASES.md) and the [extraction audit/migration plan](docs/EXTRACTION_AUDIT.md).
```

Replace with:

```text
[releases](docs/RELEASES.md), [S3 repositories](docs/S3_REPOSITORY.md) and the
[extraction audit/migration plan](docs/EXTRACTION_AUDIT.md).
```

- [ ] **Step 2: Update OPERATIONS**

In `docs/OPERATIONS.md`, find:

```text
The source machine needs its own connection to SFTP and any source DB. The server
also needs primary repository access; optional S3 replication belongs to the server.
```

Replace with:

```text
The source machine needs its own connection to its primary repository (SFTP, or
HTTPS S3 for an S3-primary plan) and any source DB. The server also needs primary
repository access; optional S3 replication of SFTP primaries belongs to the server.
The Agent receives the S3 key of its own S3-primary plans only; never replica keys.
```

Replace `Verify systemd status, authenticated ONLINE/Last seen, Agent version 0.7.0, private` with:

```text
Verify systemd status, authenticated ONLINE/Last seen, Agent version 0.8.0, private
```

Replace `Create a Managed Agent Backup Plan on the server using a dedicated SFTP repository.` with:

```text
Create a Managed Agent Backup Plan on the server using a dedicated SFTP repository,
or a dedicated S3 prefix for an Agent that advertises S3 (see below).
```

Directly before the line `## Exclusions, DB and hooks`, insert:

````markdown
## S3 repositories (Agent 0.8.0)

Agent 0.8.0 can back up directly to an S3-compatible repository (for example
HCP) when the compatible server offers S3 for the plan's device. The Agent
receives the S3 key of its own S3-primary plans only; never replica keys. The key
arrives sealed (AES-256-GCM bound to the command ID and lease token), exists only
in Agent memory and a temporary 0600 Rclone configuration during one backup, and
is never logged. See the [S3 repository report](S3_REPOSITORY.md).

The Agent host needs outbound HTTPS to the S3 endpoint itself (DNS and TLS must
work from this host, not only from the Pluton server) and an S3 prefix that is
empty at the first backup; a prefix that already holds objects is never
initialized.

Only if the endpoint certificate does not verify with the system trust store,
install a root-owned PEM bundle and configure it:

```sh
sudo install -o root -g root -m 0644 approved-storage-ca.pem /etc/pluton-agent/storage-ca.pem
```

A fresh installation passes `--storage-ca-file /etc/pluton-agent/storage-ca.pem`,
which writes `PLUTON_AGENT_STORAGE_CA_FILE` to `/etc/pluton-agent.env`. On an
installed Agent, drain it, add the line
`PLUTON_AGENT_STORAGE_CA_FILE="/etc/pluton-agent/storage-ca.pem"` to
`/etc/pluton-agent.env` as root and restart the service. The Agent passes the file
to Restic and Rclone as `SSL_CERT_FILE` for S3 backups only. It **replaces** the
system trust store for those connections, so the bundle must contain every CA
needed for the endpoint. It never affects the control-plane connection
(`--ca-file`) or SFTP backups, and the server never sends CA files. A CA file that
is not root-owned, is writable by group or others, or lies behind a symbolic link
fails the backup as `temporary-storage-config`/`temporary-config-failed`.

S3 failures use the existing closed codes: a wrong or revoked key is
`repository-check`/`target-check-auth-failed`; a refused bucket or prefix is
`target-check-access-failed`; DNS, TLS, timeouts and 5xx are
`target-check-transport-failed`; a missing bucket is `repository-check-failed`; a
non-empty first prefix is `repository-target-check`/`repository-target-not-empty`;
a sealed field that does not open is `payload-validation`/`invalid-payload`, with
nothing written first.

````

- [ ] **Step 3: Update COMPATIBILITY**

In `docs/COMPATIBILITY.md`, find:

```text
The current Agent advertises 0.7.1; original
0.7.0 HMAC/exclusion vectors remain authoritative. This reliability port keeps
that advertisement and uses the reviewed immutable Git SHA to identify the fix.
```

Replace with:

```text
The current Agent advertises 0.8.0; original
0.7.0 HMAC/exclusion vectors remain authoritative and the 0.8.0 S3 vectors are
additive (see the S3 section below).
```

Find the table row that starts with `| Filesystem envelopes 1–4` and replace the whole row with:

```text
| Filesystem envelopes 1–5                | 1–4 unchanged and SFTP-only; 5 adds S3 and sealed secrets for Agents that advertise `backupPayloadVersion: 5`; unknown versions/fields refuse |
```

Find the table row that starts with `| Server replication/recovery` and replace the whole row with:

```text
| Server replication/recovery             | Remains server-only; the Agent receives the S3 key of its own S3-primary plans only; never replica keys or Internal root privileges |
```

Append to the end of `docs/COMPATIBILITY.md`:

```markdown

## S3 repositories (contract `pluton-agent-0.8.0`)

Agent 0.8.0 adds two optional inventory capability fields:
`repositoryBackends: ["sftp", "s3"]` and `backupPayloadVersion: 5`. The Pluton
server validates the inventory with a strict schema, so a server without stage 1
S3 support **refuses the 0.8.0 enrollment and heartbeat**. Deploy the compatible
server first, then install or upgrade Agents; roll back in the reverse order,
Agent first, then server.

`BACKUP_FILESYSTEM` payload version 5 may name `rclone.type` `sftp` or `s3`. Every
secret (repository password, SFTP `pass`, S3 `access_key_id` and
`secret_access_key`) is inside `sealed`: HKDF-SHA256 over the per-Agent secret
with info `pluton-agent-command-secrets-v1`, AES-256-GCM with a 12-byte nonce and
16-byte tag, and additional data made of that label, the command ID and the lease
token separated by newlines. Plain options never contain those keys; such a
payload is refused. The command HMAC still covers the whole payload. Versions 1
to 4 are unchanged and SFTP-only; an Agent that does not advertise version 5 keeps
receiving them.

Version 5 keeps the source rules of the version the server would otherwise send:
the version 4 exclusion grammar, the pre-backup scan only when exclusions are
present, and version 3 source binding and receipt recovery when the lifecycle is
version 2.

`contracts/v0.8.0.json` holds the synthetic heartbeat request, a signed version 5
S3 command and the sealing vector copied verbatim from the approved design; the
server test suite uses the same sealing vector.
```

- [ ] **Step 4: Write the report**

Create `docs/S3_REPOSITORY.md`. Write it only after Tasks 1 to 10 passed exactly as their Expected lines state; if any command did not pass, stop and fix or report instead of writing PASS. Use the `origin/main` SHA recorded in Task 1 Step 1 in the `Branch` line.

````markdown
# S3 repositories for Managed Agent plans (Agent 0.8.0)

Design: Pluton server repository, `docs/S3_AGENT_REPOSITORY_DESIGN.md` (approved
15 November 2026), stage 1, Agent part: sections 6.2, 6.3, 6.6, 6.7, 7 and the
wire contract in section 10. Branch: `claude/agent-s3-repository` from
`origin/main` `4c2c3f3`.

## Goal

A Managed Agent plan can use an S3-compatible repository (HCP) as its primary.
The Agent writes directly to S3 from its own host; nothing passes through the
Pluton server. Existing SFTP plans and payload versions 1 to 4 are unchanged.

## What changed

- **Sealed secrets** (`agent/src/sealedSecrets.ts`): the version 5 `sealed` field
  is opened with HKDF-SHA256 over the per-Agent secret (info
  `pluton-agent-command-secrets-v1`) and AES-256-GCM, with the command ID and lease
  token as additional data. The runtime passes `identity.secret`, `command.id` and
  `command.leaseToken`, the same values that verified the command HMAC. Opening
  happens during `payload-validation`, before any file is written.
- **Payload version 5** (`agent/src/backupFilesystem.ts`): `rclone.type` `sftp` or
  `s3`; S3 plain options `provider`, `endpoint` (HTTPS origin), `region`,
  `location_constraint`, `acl`, `force_path_style` (`true`),
  `use_accept_encoding_gzip` (`false`), `no_check_bucket`; SFTP plain options
  `host`, `port`, `user`. Plaintext credentials or a top-level repository
  password are refused. An S3 path must be a prefix inside a bucket.
- **Version 3/4 rules inside version 5**: anchored exclusions and the pre-backup
  scan only with exclusions (as version 4); source binding and receipt recovery
  with a version 2 lifecycle (as version 3).
- **S3 configuration**: `[pluton] type = s3` with `env_auth = false`, keys not
  obscured, directory 0700 and file 0600, removed in `finally`.
- **Trust**: optional root-owned `PLUTON_AGENT_STORAGE_CA_FILE`, passed to Restic
  and Rclone as `SSL_CERT_FILE` for S3 only (`agent/src/config.ts`,
  `agent/src/index.ts`, `installers/install-agent.sh --storage-ca-file`).
- **Checks and classification**: an Rclone listing of the prefix before Restic
  (Restic's Rclone bridge hides provider errors); an empty S3 listing is an empty
  target, a missing bucket never is; S3 authentication, access and transport text
  (including TLS, DNS and 5xx) maps to the existing closed codes, also for a
  failing `restic backup` on S3.
- **Capabilities and version**: `repositoryBackends: ["sftp", "s3"]`,
  `backupPayloadVersion: 5`, Agent 0.8.0, contract `pluton-agent-0.8.0`
  (`contracts/v0.8.0.json`).

## Security

The S3 key is the shared HCP user (risk accepted by the operator on 15 November
2026): a compromised Agent host can read and delete every plan's S3 data in that
namespace. The key is sealed on the wire, so HTTP Agent traffic on the LAN does not
expose it; it exists only in Agent memory and the temporary 0600 configuration
during one backup and is never logged or persisted (completion receipts carry no
secrets). The sealing key differs from the HMAC key, and a sealed field cannot be
replayed into another command or lease. The Agent never receives replica keys.

## Tests

| Check | Command | Result |
| --- | --- | --- |
| Sealing vector and every single-byte/character mutation | `node --test agent/dist/sealedSecrets.test.js` | PASS (Windows and Ubuntu) |
| Payload v5 parsing and allowlists | `backupFilesystem.test.js`, `payload v5:` tests | PASS |
| Runtime binding to secret, command ID and lease token | `sealedCommandRuntime.test.js` | PASS (Ubuntu) |
| v5 keeps version 3/4 source rules | `backupFilesystem.test.js`, `backupLifecycle.test.js` | PASS (Ubuntu) |
| S3 config, CA, access check, empty target, classification | `backupFilesystem.test.js`, `S3:` tests | PASS (Ubuntu) |
| Contract vectors, standalone parity, release identity | `pnpm test:contracts` | PASS (Windows and Ubuntu) |
| Installer `--storage-ca-file` | `bash installers/tests/install-agent.test.sh` | PASS (Ubuntu) |
| Full Ubuntu 22.04 and 24.04 validation images | `docker build --target validation` and `--target runtime-upgrade` | PASS |

Docker post-dump lab (`scripts/validate-post-dump.ps1`, Ubuntu 22.04 and 24.04
tool images, real MySQL 8 dump, real Restic 0.19.1 and Rclone 1.75.1, HTTPS
`rclone serve s3` with a private CA generated per image build): the 24 existing
SFTP cases are unchanged, and the five S3 cases pass:

| Case | Expected outcome |
| --- | --- |
| `s3-healthy` | Success; snapshot and SQL artifact read back and hash-verified; restart replay does not execute again |
| `s3-untrusted-ca` (no `PLUTON_AGENT_STORAGE_CA_FILE`) | `repository-check` / `target-check-transport-failed`, no dump |
| `s3-wrong-key` | `repository-check` / `target-check-auth-failed`, no dump |
| `s3-non-empty` | `repository-target-check` / `repository-target-not-empty`, no init |
| `s3-tampered-seal` | `payload-validation` / `invalid-payload`, no backup state written |

Windows `pnpm test` keeps its four pre-existing platform failures from
`origin/main`; the Linux results above are authoritative.

## Operator steps

1. Deploy the server stage 1 release first. Its strict inventory schema must
   accept `repositoryBackends` and `backupPayloadVersion`, and its install gate
   must accept `AGENT_INSTALL_VERSION=0.8.0`. An older server refuses a 0.8.0
   Agent's enrollment and heartbeat.
2. After review and merge, set in the server `.env`:
   `AGENT_INSTALL_COMMIT` to the full 40-hex SHA of the reviewed 0.8.0 Agent merge
   commit and `AGENT_INSTALL_VERSION=0.8.0`.
3. Run the stage 0 probe on the Agent host. Only if TLS does not verify with the
   system trust store, install the CA bundle as root:
   `sudo install -o root -g root -m 0644 approved-storage-ca.pem /etc/pluton-agent/storage-ca.pem`.
4. Install the Agent on the new host from the reviewed commit:

   ```sh
   bash install-agent.sh --check --server https://pluton.example.internal \
     --allowed-root /srv/example-app --storage-ca-file /etc/pluton-agent/storage-ca.pem
   sudo bash install-agent.sh --server https://pluton.example.internal \
     --allowed-root /srv/example-app --storage-ca-file /etc/pluton-agent/storage-ca.pem
   ```

   Omit `--storage-ca-file` when the system trust store verifies the endpoint.
   For an Agent that is already installed, drain it, add
   `PLUTON_AGENT_STORAGE_CA_FILE="/etc/pluton-agent/storage-ca.pem"` to
   `/etc/pluton-agent.env` as root and run `sudo systemctl restart pluton-agent`.
5. Confirm in the UI that the device reports Agent 0.8.0 and that S3 storages are
   offered for its plans. Create the plan with a new, empty prefix inside the
   bucket.
6. Run one backup and check the journal privately:
   `journalctl -u pluton-agent --since '30 minutes ago' --no-pager | grep -E 'storage access verified|backup completed'`.
   Then verify the snapshot, a database artifact and a restored sample in the UI.
7. On a failure, record only `failureStage`, `failureCode` and the journal
   `reason=` value; never share the environment file, the S3 key or provider
   output.

## Rollback

Agent first, then server. Roll the Agent back with `sudo bash upgrade-agent.sh
--rollback <upgrade-id>` (see [upgrade and rollback](AGENT_UPGRADE.md)); a host that
was installed fresh with 0.8.0 has no earlier version and is stopped or
uninstalled instead. With an Agent older than 0.8.0 the server refuses to queue a
backup for an S3-primary plan; snapshots already in S3 stay readable by the
server version that introduced the S3 read path. A leftover
`PLUTON_AGENT_STORAGE_CA_FILE` line is ignored by older Agents. Roll the server
back only after every 0.8.0 Agent is rolled back, because an older server refuses
the 0.8.0 heartbeat.

## Limits and follow-ups

- `PLUTON_AGENT_STORAGE_CA_FILE` replaces the system trust store for S3
  connections; the bundle must contain every CA the endpoint needs.
- `upgrade-agent.sh` accepts the new key (it allows `PLUTON_` keys) but does not
  yet check its readability during upgrade preflight; the Agent refuses an
  unreadable or non-root-owned file at backup time.
- `scripts/verify-server-contract.mjs` still checks the pinned 0.7.0 server
  revision; the server suite checks the 0.8.0 sealing vector on its side.
- No S3-to-SFTP replication, failover, primary switching, automatic prune or
  unlock (stages 2 to 4).
- The lab endpoint is `https://127.0.0.1:<port>`; its certificate also names
  `s3.example.internal`. Real HCP behaviour is confirmed by the stage 0 probe and
  the first operator backup, not by this lab.

## Changed files

`agent/src/sealedSecrets.ts` (new), `agent/src/sealedSecrets.test.ts` (new),
`agent/src/sealedCommandRuntime.test.ts` (new), `agent/src/backupFilesystem.ts`,
`agent/src/backupFilesystem.test.ts`, `agent/src/backupLifecycle.test.ts`,
`agent/src/runtime.ts`, `agent/src/types.ts`, `agent/src/config.ts`,
`agent/src/config.test.ts`, `agent/src/index.ts`, `agent/src/inventory.ts`,
`agent/src/inventory.test.ts`, `agent/package.json`, `package.json`,
`agent/examples/pluton-agent.env.example`, `contracts/standalone-source-v1.json`,
`contracts/v0.8.0.json` (new), `scripts/tests/contracts.test.mjs`,
`scripts/tests/runtime-pins.test.mjs`, `scripts/tests/release.test.mjs`,
`scripts/package-release.mjs`, `scripts/verify-release.mjs`,
`installers/install-agent.sh`, `installers/tests/install-agent.test.sh`,
`tests/post-dump/Dockerfile`, `tests/post-dump/native.lab.ts`, `README.md`,
`docs/OPERATIONS.md`, `docs/COMPATIBILITY.md`, `docs/S3_REPOSITORY.md` (new).
````

- [ ] **Step 5: Verify the documentation and the complete file list**

```sh
pnpm build && pnpm test:contracts
git diff --name-only origin/main...HEAD | sort
git status --porcelain
```

Expected: `ℹ fail 0` (the documentation link test resolves `docs/S3_REPOSITORY.md`, `AGENT_UPGRADE.md` and the README link). The committed file list equals the `Changed files` section minus the four documentation files of this task (still uncommitted, shown by `git status --porcelain` as ` M README.md`, ` M docs/COMPATIBILITY.md`, ` M docs/OPERATIONS.md`, `?? docs/S3_REPOSITORY.md`). If the committed list differs, fix the report before committing.

- [ ] **Step 6: Commit**

```sh
git add README.md docs/OPERATIONS.md docs/COMPATIBILITY.md docs/S3_REPOSITORY.md
git diff --cached --check
git commit -m "docs: S3 repositories in Agent 0.8.0"
git log --oneline origin/main..HEAD
git status --porcelain
```

Expected: eleven commits listed (one per task), `git status --porcelain` prints nothing, no push. Tell the user the branch name, the eleven SHAs, the results and that pushing, the Draft PR and hosted CI are theirs; the server PR must be deployed before any 0.8.0 Agent.

---

## Self-review against the spec

Coverage (spec point → task):

- 6.2.1 version 5 allowlist, HTTPS endpoint, `force_path_style=true`, `use_accept_encoding_gzip=false`, unknown keys refused → Task 2 (`payload v5: S3 options are allowlisted...`).
- 10.2 `sourceDiagnosticsVersion` sent as today and accepted in version 5, and 6.1 point 2 (no trust or CA setting in the payload) → Task 2 (`payload v5: accepts sourceDiagnosticsVersion as today and refuses any trust setting in the payload`); the signed command in `contracts/v0.8.0.json` follows the updated 10.2 example including `sourceDiagnosticsVersion: 1` (Task 8).
- 6.2.2 sealed secrets opened before any file, tampering/wrong key refused, merged into options, plaintext refused → Tasks 1, 2, 3 (`sealed runtime: ... refused before any backup file is written`), lab `s3-tampered-seal`.
- 6.2.3 `[pluton] type = s3`, 0700/0600, removal in `finally`, no `rclone obscure` → Task 5.
- 6.2.4 `PLUTON_AGENT_STORAGE_CA_FILE` as `SSL_CERT_FILE` for Restic and Rclone, never sent by the server → Task 6, installer in Task 9, lab `s3-untrusted-ca` versus `s3-healthy`.
- 6.2.5 empty S3 listing is empty, any object refuses → Task 7, lab `s3-non-empty`.
- 6.2.6 authentication (`SignatureDoesNotMatch`, `InvalidAccessKeyId`), access (403), transport (DNS, connection, timeout, 5xx) on existing stages and codes → Task 7, lab `s3-wrong-key` and `s3-untrusted-ca`.
- 6.2.7 heartbeat `repositoryBackends`, highest payload version, `AGENT_VERSION` 0.8.0, new contract vector → Task 8.
- 6.2.8 README, OPERATIONS, COMPATIBILITY wording → Task 11 Steps 1 to 3.
- 6.3 (Agent side) sealing key, cipher, additional data, HMAC over the whole payload, key only in memory and the 0600 file → Tasks 1, 3, 5.
- 6.6 Agent unit tests (v5 parsing and allowlist, tampered blob, wrong command ID, wrong key, `type = s3`, CA variable, S3 empty target, S3 classification) → Tasks 1 to 7; Docker post-dump lab with an HTTPS S3 fixture and private CA, full backup with a database dump → Task 10.
- 6.7 (Agent) version 0.8.0, contract vector, installer key, server-first order, rollback Agent first → Tasks 8, 9, 11; Global Constraints.
- Section 7 rows owned by the Agent: S3 without support (0.7.1 refuses version 5; version 4 with `s3` refused, Task 2), wrong or revoked key without a retry loop (Task 7 asserts one `lsf` and no Restic), HCP unreachable as transport (Task 7, lab), non-empty prefix (Task 7, lab), invalid sealed field before any file (Tasks 1 to 3, lab).
- Section 10.1 to 10.4 field names, labels and vector verbatim → Global Constraints, Tasks 1, 2, 8 (vector re-verified with Node crypto while writing this plan; the request and command signatures in `contracts/v0.8.0.json` were cross-checked with the current `agent/dist/protocol.js`).

Placeholder scan: every code step contains complete code; each referenced function exists at `4c2c3f3` (`asRecord`, `requiredString`, `validateRepositoryPath`, `validateRcloneOptions`, `runProgram`, `verifyRepository`, `ensureManagedRepository`, `assertRootOwnedPath`, `createExecutionFixture`, `executionInput`, `readCalls`, `multiFixture`, `multiEntries`, `calls`, `nativePids`, `port`, `run`) or is defined in a task. The only operator-supplied value is the reviewed Agent commit SHA in Task 11 operator step 2.

Type consistency checked: `CommandSealContext` (Task 1) is the type of `parseBackupFilesystemPayload`'s second argument (Task 2) and of `executeFilesystemBackup`'s `commandSeal` (Task 3); `RepositoryTargetFailureCode` is reused by `ProgramExitError` and `classifyBackupStorageFailure` (Task 7); `AgentConfig.storageCaFile` (Task 6) is the field the lab sets (Task 10).

Issues found and fixed inline while reviewing:

- A version 5 payload would have lost version 3 source binding and receipt recovery for existing SFTP database plans once the server sends version 5 to 0.8.0 Agents; Task 4 now maps version 5 onto the version 3 or 4 source rules.
- Restic's Rclone bridge does not surface S3 provider errors, so the spec's authentication classification would not hold for an initialized repository; Task 7 adds the Rclone access check before Restic.
- The release scripts refused any version outside `0.7.x`, which would have failed `pnpm package:release` in the validation image; Task 8 extends both version gates and adds a test.
- `*.pem` is excluded by `.dockerignore`, so lab certificates cannot come from the build context; Task 10 generates the CA inside a dedicated build stage and keeps the CA key there.
- Windows `pnpm test` is not a clean gate at `origin/main`; Linux runs are used for every execution test.

Open questions for the server plan (not blockers for this plan):

1. The server should send version 5 for every `BACKUP_FILESYSTEM` command to an Agent advertising `backupPayloadVersion: 5` (SFTP too, spec 6.3), with the same `excludes` and `lifecycle` it would have sent in versions 1 to 4 (`sourceDiagnosticsVersion` is already settled by spec 10.2), and must drop `type` and `env_auth` from `storageRcloneOptions` output, because the Agent refuses unknown plain keys.
2. The server install gate must accept `AGENT_INSTALL_VERSION=0.8.0`.
3. The extra Rclone listing costs one LIST request per S3 backup; if this is unwanted, the alternative is reading Rclone errors through Restic with a higher Rclone log level, which floods the bounded diagnostics buffer.
