# S3 as a Managed Agent repository: design

Status: design approved in conversation on 15 November 2026, written for review. No code yet.

## 1. Goal

Managed Agent ("remote device") plans can only use an SFTP repository today. The operator has an
S3-compatible object store (Hitachi Content Platform, 10 TB quota) and wants it to be a first-class
repository for Agent plans:

1. a plan's **primary** repository, written directly by the Agent from its own host;
2. a **failover** target when the SFTP primary is unreachable;
3. a primary that can be **switched** between SFTP and S3 in either direction, for example when
   the SFTP host runs out of space.

A second SFTP repository on the Pluton VM was rejected as a failover target: it fails together with
the control plane and adds no reliability.

## 2. Decisions

| Topic | Decision | Reason |
| --- | --- | --- |
| Order | Stage 1 is S3 as primary for **new** Agent plans | Two large plans (an ERP filestore of about 300 GB and a research application) are about to be onboarded; their Agents are not installed yet |
| Data path | The Agent writes directly to S3 | A proxy through the Pluton server puts every byte on the Pluton VM and its slow uplink, and makes the VM a single point of failure |
| Credentials | One shared HCP user (the existing shared S3 storage) for all plans | Operator's choice; risk accepted, see section 6.3 |
| Second copy | S3 primary to SFTP replication is stage 2, not stage 1 | Stage 1 ships sooner; the source data still exists on the Agent host |

## 3. Stages

| Stage | Delivers | Main dependency |
| --- | --- | --- |
| 0 | Operator probe from an Agent host to HCP: DNS, TLS, write/read/delete, throughput | none |
| **1** | **S3 as primary for new Agent plans** (this document) | stage 0 results |
| 2 | Replication from an S3 primary to an SFTP secondary | generalise the replication executor's source and destination |
| 3 | Failover backup: when the primary is unreachable, the Agent writes to the plan's secondary repository; the server copies back after recovery | backups with more than one location (repository and snapshot ID) |
| 4 | Switch an existing plan's primary between SFTP and S3 using the secondary copy | stage 2 or the existing replica, relocation state machine |

Stages 2 to 4 get their own design documents. Section 9 records what stage 1 must not block.

## 4. Current state (verified from code)

Server (`backend/src`):

- `RemoteBackupService` rejects non-SFTP storage for remote plans (`:801`, `:865`,
  "Remote filesystem backups currently require an SFTP destination."). `materializeCommand`
  (`:359-499`) builds the Agent payload `{version, backupId, planId, sourcePath, excludes,
  repository {remoteName: 'pluton', path, initialize}, rclone {type: 'sftp', options},
  repositoryPassword}` at poll time. Only `{backupId, planId, repositoryId}` is stored with the
  command. `AgentService` signs the leased command with HMAC (`signAgentCommand`, keyed by the
  per-Agent secret); the payload is signed, not encrypted.
- `remote_managed_repositories` (migration 0006) holds `plan_id`, `agent_id`, `storage_id`,
  `storage_path`, `encrypted_password`, `initialized_at`. Nothing in it is SFTP-specific.
- Every read of an Agent repository goes through `RemoteRepositoryRecoveryService` (browse,
  download, export, preview, restore, comparison, recovery tests, database restore artifacts,
  primary availability). Its `context()` (`:1292-1349`) always builds SFTP access through
  `getSftpRecoveryOptions`, and the session provider is fixed per service instance (`:125`).
- `ManagedS3RecoverySession` already extends `ManagedSftpRepositorySession` for replica recovery and
  inherits every read operation (probe, diff, dump, archive, identity, snapshot, ls, restore). It
  allowlists S3 options, requires HTTPS, `force_path_style=true`, `use_accept_encoding_gzip=false`
  and `env_auth` off, and accepts `SSL_CERT_FILE`/`RCLONE_CA_CERT` trust paths.
- HCP handling exists: `storageRcloneOptions`, `isHcpMode`, `validateHcpConfiguration`,
  `trustEnvironment` (`PLUTON_STORAGE_CA_FILE`), `canonicalS3RepositoryIdentity` (authority is the
  endpoint origin plus bucket; bucket roots are refused).
- Relocation ("Move Repository") is SFTP-to-SFTP only and rewrites storage columns without changing
  snapshot IDs.
- Frontend: `PlanForm.tsx:269` limits remote plans to `['sftp']`; SFTP wording in `PlanForm.tsx:284`,
  `PlanRelocationModal.tsx`, `PlanReplicationSettings.tsx:227-230`, `AssistedRecovery.tsx:257`,
  `utils/assistedRecovery.ts:154`, `docs/manifest.ts:60`.

Agent (`pluton-agent`, `agent/src`, version 0.7.1):

- `backupFilesystem.ts` accepts payload versions 1 to 4 with `rclone.type === 'sftp'` and the
  options `host/port/user/pass` only (`:57-83`, `:445-537`). It writes a temporary `rclone.conf`
  (directory 0700, file 0600, `type = sftp`) and removes it in `finally`. Restic gets only `PATH`,
  `RESTIC_PASSWORD`, `RESTIC_CACHE_DIR` and `RCLONE_CONFIG`; `HTTPS_PROXY` and `SSL_CERT_FILE` are
  not passed to child processes.
- The empty-target check relies on `rclone lsf` exit code 3 ("directory not found").
- Capabilities (`inventory.ts:107-139`) have no field that names a storage backend.
- Failure classification recognises transport errors only around the repository and target checks;
  any failure during `restic backup` becomes `restic-backup-failed`.
- Pinned: Node 22.23.4, Restic 0.19.1, Rclone 1.75.1, all with SHA-256 checks.

## 5. Stage 0: operator probe

Before stage 1 code is merged, the operator runs a probe on one Agent host (the ERP host first).
A script in `scripts/diagnostics/` reads the endpoint, bucket and keys from environment variables
the operator sets in their own shell, writes nothing else to disk, and prints only closed facts:

- DNS: resolves or not, with the time taken.
- TLS: verifies with the system trust store or not (decides whether `PLUTON_AGENT_STORAGE_CA_FILE`
  is needed).
- Write, read back, compare and delete one 64 MiB test object under a dedicated `probe/` prefix;
  report MiB/s for upload and download.
- Rclone version used (the Agent's private binary when present).

The upload rate decides how long the first full backup of the 300 GB plan takes. The rate seen so
far (replication from the Pluton VM, below about 0.6 MiB/s) is an upper bound with an unknown cause,
not a measurement of an Agent host.

## 6. Stage 1 design

### 6.1 Server

1. **Eligibility.** A remote plan may use an `s3` or `s3compatible` storage as its primary when all
   of these hold, at plan create and update and again when a backup is queued:
   - the plan's Agent advertises `repositoryBackends` containing `s3` (section 6.2);
   - the storage passes the same HCP validation as replication destinations (`hcp_mode` required for
     `s3compatible` and non-AWS endpoints, HTTPS endpoint, no `env_auth`);
   - the path is a prefix inside the bucket, never the bucket root;
   - its canonical identity does not overlap any other plan's primary or any replication
     destination (the existing overlap check in `ManagedReplicationService.validatePlan`, extended
     to primaries).
   Replication settings are refused for an S3-primary Agent plan in stage 1.
2. **Command payload version 5.** For an S3 primary, `materializeCommand` sends
   `rclone {type: 's3', options}` built from `storageRcloneOptions(storage)` plus
   `force_path_style: 'true'` and `use_accept_encoding_gzip: 'false'`. The payload carries no trust
   or CA setting; the Agent uses its own `PLUTON_AGENT_STORAGE_CA_FILE` (6.2 point 4), and the
   server applies `trustEnvironment` only on its own read path.
   Secrets (`repositoryPassword`, `secret_access_key`, `access_key_id`, and for SFTP `pass`) move into
   a sealed field (section 6.3). Agents that do not advertise version 5 keep receiving version 4,
   which stays SFTP-only.
3. **Read path.** `RemoteRepositoryRecoveryService.context()` chooses the access by the storage
   type of the repository: SFTP builds the existing SFTP access; S3 builds the same access shape the
   replica resolver builds today (`storageRcloneOptions`, `force_path_style`, `trustEnvironment`).
   The session provider becomes a factory keyed by access type instead of one provider per
   instance. Browse, download, export, preview, restore, comparison, recovery tests and database
   restore artifacts then work unchanged, because the other modules only use the session
   interface.
4. **Data model.** No migration is expected: `remote_managed_repositories` already stores a generic
   `storage_id`/`storage_path`, and Agent capabilities are part of the stored inventory. The
   implementation plan confirms this before any code.
5. **Completion.** Unchanged: the snapshot ID, summary and database artifacts are checked as today,
   `initialized_at` is set on the first success, and replication is not queued for S3 primaries.

### 6.2 Agent (`pluton-agent` 0.8.0)

1. **Payload version 5.** `rclone.type` may be `s3`, with an allowlist that mirrors
   `ManagedS3RecoverySession`: `provider`, `endpoint`, `access_key_id`, `secret_access_key`, `region`,
   `location_constraint`, `acl`, `force_path_style`, `use_accept_encoding_gzip`, `no_check_bucket`.
   The endpoint must be HTTPS, `force_path_style` must be `true` and `use_accept_encoding_gzip` must
   be `false`. Unknown keys are refused, as for SFTP.
2. **Sealed secrets.** The Agent opens the sealed field (section 6.3) before writing any file;
   tampering or a wrong key refuses the command. The opened values (`access_key_id`,
   `secret_access_key`, the repository password, and `pass` for SFTP) are merged into the options;
   a version 5 payload that carries any of them in plain text is refused.
3. **Configuration.** The temporary `rclone.conf` holds `[pluton] type = s3` and the options, with
   the same 0700/0600 permissions and removal in `finally`. S3 keys are not passed through
   `rclone obscure`.
4. **Trust.** An optional `PLUTON_AGENT_STORAGE_CA_FILE` in the Agent's environment file (root-owned,
   installed by the operator) is passed to Restic and Rclone as `SSL_CERT_FILE`. The server never
   sends CA files. It is only needed if stage 0 shows the HCP certificate does not verify with the
   system trust store.
5. **Empty-target check.** For S3, an empty listing under the prefix counts as empty (Rclone exits
   0 for a missing prefix); any object present refuses initialization, as for SFTP.
6. **Failure classification.** S3 and HTTP failures map to the existing stages and codes:
   authentication (`SignatureDoesNotMatch`, `InvalidAccessKeyId`), access (403), transport (DNS,
   connection, timeout, 5xx). This keeps failure reports meaningful and is the base for the
   failover decision in stage 3.
7. **Capabilities.** The heartbeat reports `repositoryBackends: ['sftp', 's3']` and the highest
   payload version it accepts. `AGENT_VERSION` becomes 0.8.0, with a new contract test vector.
8. **Documentation.** README, OPERATIONS and COMPATIBILITY change from "the Agent receives no S3
   key" to "the Agent receives the S3 key of its own S3-primary plans only; never replica keys".

### 6.3 Security

- **Sealing.** The Agent payload is signed but not encrypted, and Agent traffic on the LAN may use
  HTTP. Because the shared HCP key covers the whole namespace, version 5 seals every secret:
  - key: HKDF-SHA256 over the per-Agent secret that already signs commands, with its own `info`
    label (`pluton-agent-command-secrets-v1`), so the sealing key differs from the HMAC key;
  - cipher: AES-256-GCM with a random 96-bit nonce;
  - additional data: the command ID and the lease token, so a sealed blob cannot be replayed into
    another command;
  - the HMAC signature still covers the whole payload, including the sealed blob.
  SFTP secrets are sealed the same way for Agents that accept version 5.
- **Enrollment limitation.** Sealing is only as confidential as the enrollment exchange: the per-Agent
  secret (the HKDF input) is returned in plain form in the enrollment response, and production may
  allow Agent HTTP on the LAN (`ALLOW_INSECURE_AGENT_HTTP`). A passive observer of an enrollment over
  HTTP can derive the sealing key. Agents that will use an S3 primary should be enrolled over HTTPS;
  otherwise the residual risk is accepted. No code change in stage 1.
- **Exposure on the host.** The S3 key exists only in the Agent process memory and the temporary
  0600 configuration during one backup, as the SFTP password does today. It is never logged; the
  server never stores the materialised payload.
- **Accepted risk.** With one shared HCP user, a compromised Agent host can read and delete the S3
  data of every plan in the namespace, including other plans' replicas. Restic needs delete
  permission for its lock files, so the key cannot be write-only. The operator accepted this on
  15 November 2026. A per-plan HCP user remains possible later without changing this design,
  because each plan already points at a storage record.
- **Isolation between plans.** Overlap checks keep every plan's prefix separate, and an Agent never
  initializes a non-empty prefix.

### 6.4 Frontend

- `PlanForm` offers S3 storages for a remote plan when the selected device's Agent advertises S3,
  and explains why S3 is hidden otherwise.
- Replication settings are disabled for S3-primary Agent plans with a note that S3-to-SFTP
  replication is the next stage.
- Wording that says "primary SFTP" is generalised where it describes Agent plans in general.

### 6.5 Data flow of one backup

1. The scheduler queues a command with `{backupId, planId, repositoryId}`.
2. The Agent polls; the server leases the command and materialises payload version 5, sealing the
   secrets with the command ID and lease token.
3. The Agent verifies the signature, opens the sealed field and writes the temporary configuration.
4. If the repository is not initialized and the prefix is empty, `restic init`.
5. `restic backup` to `rclone:pluton:<bucket>/<prefix>` with the usual tags and parent selection.
6. The Agent reports the snapshot; the server records it as for SFTP.

### 6.6 Testing

- **Server unit tests:** eligibility (capability gating, HCP validation, bucket root, overlap with
  primaries and replicas), payload version 5 (options, no plaintext secrets, version 4 unchanged for
  old Agents), `context()` choosing the S3 session, and read operations against an S3 primary.
- **Agent unit tests:** version 5 parsing and allowlist, sealing (tampered blob, wrong command ID,
  wrong key all refused), `type = s3` configuration, CA variable, S3 empty-target check, S3 failure
  classification.
- **Labs (Docker, synthetic data):**
  - the Agent post-dump lab gains an HTTPS S3 fixture with a private CA and runs a full backup with
    a database dump into it;
  - the server replica lab is reused to browse, restore and read a database artifact from an S3
    primary.
- **Probe:** the stage 0 script runs against the lab fixture in CI-like conditions before the
  operator runs it.

### 6.7 Rollout and rollback

- **Order:** server first. S3 appears only for Agents that advertise it, so existing plans are not
  affected. The ERP and research hosts have no Agent installed yet, so they are installed directly
  with 0.8.0 after `AGENT_INSTALL_COMMIT` and `AGENT_INSTALL_VERSION` in the server `.env` point at
  the reviewed 0.8.0 commit.
- **Pull requests:** (1) stage 0 probe script; (2) server and frontend; (3) Agent.
- **Rollback:** Agent first, then server. With an older Agent the server refuses to queue a backup
  for an S3-primary plan instead of sending a payload it cannot read. Snapshots already in S3 stay
  readable by the server version that introduced the S3 read path; rolling the server back further
  makes them unreachable from the UI until it is upgraded again.

## 7. Error handling

| Situation | Behaviour |
| --- | --- |
| Agent without S3 support | S3 not offered for the plan; queueing an S3 plan for such an Agent is refused with a clear message |
| Wrong or revoked HCP key | Backup fails as authentication failure; no retry loop |
| HCP unreachable (DNS, TLS, timeout) | Backup fails as transport failure; in stage 3 this becomes the failover trigger |
| Prefix not empty at first backup | Initialization refused; the operator chooses a new prefix |
| Sealed field invalid | Command refused before any file is written |

## 8. Non-goals of stage 1

- No change to existing SFTP plans or their replication.
- No per-plan HCP users (possible later, see 6.3).
- No S3-to-SFTP replication, failover or primary switching (stages 2 to 4).
- No automatic prune or unlock on S3 repositories.

## 9. What later stages need from stage 1

- Repository access built per storage type, not per service instance (stage 2 reads an S3 source;
  stage 3 writes to a secondary).
- Agent failure classification that separates transport failures from the rest (stage 3 trigger).
- Sealed secrets, so a later payload can carry the credentials of two repositories (stage 3).
- No assumption that a plan's primary storage type never changes (stage 4).

## 10. Stage 1 wire contract

Server and Agent implement this exactly. Both test suites use the vector in 10.4.

### 10.1 Capabilities

Two optional fields are added to the inventory `capabilities` object (server schema in
`AgentService.ts`, `.strict()`; Agent type `AgentCapabilities` in `agent/src/types.ts`):

| Field | Type | Meaning |
| --- | --- | --- |
| `repositoryBackends` | array of `'sftp'` and `'s3'`, 1 to 2 entries, no duplicates, must contain `'sftp'` | Repository types the Agent can back up to |
| `backupPayloadVersion` | literal `5` | Highest `BACKUP_FILESYSTEM` payload version the Agent accepts |

Because the server schema is strict, the server must be deployed before any 0.8.0 Agent reports
these fields. An Agent that omits them is treated as `repositoryBackends: ['sftp']` and payload
version 4.

### 10.2 Payload version 5

```json
{
  "version": 5,
  "lifecycle": "<unchanged, optional>",
  "backupId": "<unchanged>",
  "planId": "<unchanged>",
  "sourcePath": "<unchanged>",
  "excludes": ["<unchanged>"],
  "sourceDiagnosticsVersion": 1,
  "repository": { "remoteName": "pluton", "path": "<sftp directory, or bucket/prefix for s3>", "initialize": true },
  "rclone": { "type": "s3", "options": { "provider": "Other", "endpoint": "https://s3.example.internal", "force_path_style": "true", "use_accept_encoding_gzip": "false", "no_check_bucket": "true" } },
  "sealed": { "alg": "A256GCM", "kid": "pluton-agent-command-secrets-v1", "nonce": "<base64, 12 bytes>", "ciphertext": "<base64>", "tag": "<base64, 16 bytes>" }
}
```

- `rclone.type` is `sftp` or `s3`. Plain `options` never contain `pass`, `access_key_id`,
  `secret_access_key` or a repository password; a payload that does is refused.
- Allowed plain options: SFTP `host`, `port`, `user`; S3 `provider`, `endpoint`, `region`,
  `location_constraint`, `acl`, `force_path_style` (must be `"true"`), `use_accept_encoding_gzip`
  (must be `"false"`), `no_check_bucket`. The S3 `endpoint` must be an `https://` origin.
- `repositoryPassword` is not a top-level field in version 5; it is inside `sealed`.
- `sourceDiagnosticsVersion` is sent exactly as today (Agents 0.7.1 and later already receive it) and
  must be accepted in version 5.
- Versions 1 to 4 are unchanged and remain SFTP-only.

### 10.3 Sealing

- Plaintext: UTF-8 JSON `{"repositoryPassword": string, "rclone": {"pass"?: string,
  "access_key_id"?: string, "secret_access_key"?: string}, "lifecycle"?: {"database"?: string,
  "databases"?: {"<databaseId>": string}}}`. SFTP carries `pass`; S3 carries both keys.
- Database passwords (decision of 15 November 2026): in version 5 the plain `lifecycle` carries no
  `password` field in any database entry. The password of `lifecycle.database` (lifecycle shape
  version 1) is sealed as `lifecycle.database`; the password of each `lifecycle.databases[]` entry is
  sealed under its `databaseId` in `lifecycle.databases`. The sealed `lifecycle` key is present only
  when the payload has a lifecycle with at least one database. The Agent restores each password into
  its entry before use. A version 5 payload is refused when a plain database entry carries
  `password`, when a database has no sealed password, or when a sealed password has no matching
  database.
- Key: `HKDF-SHA256(ikm = UTF-8 bytes of the per-Agent secret, salt = empty, info =
  "pluton-agent-command-secrets-v1", length = 32)`.
- Cipher: AES-256-GCM, random 12-byte nonce per command, 16-byte tag.
- Additional data: UTF-8 of `"pluton-agent-command-secrets-v1\n" + commandId + "\n" + leaseToken`.
- The HMAC command signature is computed over the payload that contains `sealed`, as today.

### 10.4 Test vector (synthetic)

| Input | Value |
| --- | --- |
| secret | `synthetic-agent-secret-0123456789abcdef` |
| commandId | `cmd-synthetic-01` |
| leaseToken | `0123456789abcdef0123456789abcdef0123456789abcdef` |
| derived key (hex) | `1f35dc3e9cf013165a2353883369bbfa7edd62b56072b3413c8074e2ffb93fac` |
| nonce (base64) | `AAECAwQFBgcICQoL` |
| plaintext | `{"repositoryPassword":"synthetic-repository-password-01","rclone":{"access_key_id":"SYNTHETICKEY01","secret_access_key":"synthetic-secret-key-01"}}` (no lifecycle; a plaintext with `lifecycle` is sealed and opened the same way) |
| ciphertext (base64) | `jh0qetVE17GJz08s3DXhomumBqDIVOhzX3A4LgVFJeiH9JSKr4qR7OowvN0duifn639ReyzbjXGWiSEWAaymlLJKNnxwbrP+vLmuRdk9vI+wuUG8cJhENnxGV0LXHElNyPLQME0jaSjTfM7T0n9LTBr7V76enQuphACHq53aFDwiyFLa5p/2ML2748FcdivP43U+` |
| tag (base64) | `pUKJ+stiEzlyVi8BFN6biQ==` |

Changing any byte of the ciphertext, tag, nonce, command ID or lease token must make opening fail.
