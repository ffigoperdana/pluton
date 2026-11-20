# Restore to an Agent host (design)

Status: design for review by the Pluton maintainers and the senior host
administrator who holds sudo on the Agent hosts. Server release with Agent
**0.9.0**. Everything here is implemented in the same branch; the rollout order
in section 10 is binding.

References: `backend/…` and `frontend/…` are in this repository; `agent/…`,
`installers/…`, `scripts/…` and `docs/COMPATIBILITY.md` are in the standalone
Agent repository (`pluton-agent`), the Agent runtime authority. Line numbers are
those of the base commits of this branch.

## 1. Problem

A Managed Agent backup is read back today only through the Pluton server:

- **Staged restore** runs `restic restore` on the server into a private
  workspace (`backend/src/services/RemoteRepositoryRecoveryService.ts:1129`
  `restore`). A granular selection is capped at 1,024 regular files and 8,192
  entries (`select`, same file, lines 1502-1597) and needs the server's snapshot
  index.
- **Full-snapshot downloads** stream a TAR through the browser.
- **Restore Database Internal** imports at most a 128 MiB SQL budget.

A 350 GB / 400k-file Odoo filestore or a multi-GB PostgreSQL dump at
`/pluton/database/<dumpFilename>` therefore cannot realistically be restored on
the 2 vCPU / 4 GB Pluton VM, and should not cross a browser at all.

**Goal.** Pluton asks the enrolled Agent that made the backup to run
`restic restore` on its own host, reading the plan's repository (SFTP or S3)
itself, into a new, empty folder inside a host-approved restore root. No restored
byte passes through the Pluton server or a browser.

**Non-goals (this phase).** In-place restore over live data; restore to another
Agent or host; restore from an S3 replica; overwrite, merge or delete; automatic
chown/move into the application; database import on the Agent host.

## 2. Overview

```text
Admin (UI) --POST /api/restores/action/agent-host--> Pluton server
   restores row (sourceId = Agent device) + agent_commands row
   RESTORE_FILESYSTEM {restoreId, planId, backupId, repositoryId}  (references only)
                                    |
Agent poll  <--signed command, payload materialized at poll, secrets sealed--
   validate payload + restore policy (/etc/pluton-agent/restore-roots.json)
   mkdir <root>/<name>.partial (0700, exclusive)
   restic snapshots <id> (tags must name this plan and backup)
   restic ls --json --recursive (selection exists; bytes + entries for the space check)
   statfs: free bytes and inodes
   restic restore <id> --target <root>/<name>.partial --overwrite never --verify --json
   [database artifact: sha256 of the restored dump equals the backup receipt]
   rename <name>.partial -> <name>
   complete {targetPath, files, bytes, verified}
```

## 3. Command and payload

### 3.1 Command type

A new closed command type `RESTORE_FILESYSTEM` is added to both allowlists:
server `backend/src/types/agents.ts:5-12` (`AGENT_COMMAND_TYPES`, checked by
`AgentStore.enqueueCommand`, `backend/src/stores/AgentStore.ts:245-257`) and
Agent `agent/src/runtime.ts:55` (`SAFE_COMMANDS`). An Agent older than 0.9.0
throws `server returned an unsupported command type`
(`agent/src/runtime.ts:120`) **before** acknowledging, so the command would be
re-leased forever and block that Agent's serial queue. The server therefore
never queues it without the capability (section 4), and re-checks the capability
at poll time: if the Agent no longer advertises it (for example after an Agent
rollback), the command and the restore fail at poll and are never delivered.

The command row stores **references only**, like `BACKUP_FILESYSTEM`
(`RemoteBackupService.queuePlanBackup`, `RemoteBackupService.ts:387-396`):

```json
{ "restoreId": "<24 hex>", "planId": "...", "backupId": "...", "repositoryId": "..." }
```

Credentials and the target are materialized in `AgentService.poll`
(`backend/src/services/AgentService.ts:455-530`) and never persisted in
`agent_commands`.

### 3.2 Signed payload (version 1)

```json
{
  "version": 1,
  "restoreId": "0123456789abcdef01234567",
  "planId": "plan-01",
  "backupId": "backup-01",
  "snapshotId": "<64 lowercase hex>",
  "target": { "root": "/srv/pluton-restore", "name": "app-01-20261120-0123abcd" },
  "selection": { "includes": ["/srv/example-app/filestore"], "excludes": [] },
  "artifact": { "path": "/pluton/database/odoo.sql", "bytes": 1234, "sha256": "<64 hex>" },
  "repository": { "remoteName": "pluton", "path": "managed/app-01" },
  "rclone": { "type": "sftp", "options": { "host": "sftp.example.internal", "port": "22", "user": "backup" } },
  "sealed": { "alg": "A256GCM", "kid": "pluton-agent-command-secrets-v1", "nonce": "...", "ciphertext": "...", "tag": "..." }
}
```

- The whole payload is covered by the command HMAC
  (`agent/src/protocol.ts` `verifyCommandDetailed`), which also binds the type.
- **Secrets are sealed only.** There is no plain variant. The server reuses the
  version 5 sealing of `BACKUP_FILESYSTEM`: the S3/SFTP split of plain options and
  secrets (`RemoteBackupService.ts:602-619`) and `sealAgentCommandSecrets`
  (`backend/src/utils/agentCommandSealing.ts:82`), HKDF-SHA256 over the per-Agent
  secret with info `pluton-agent-command-secrets-v1`, AES-256-GCM, additional data
  = label, command ID and lease token. The sealed plaintext is exactly
  `{repositoryPassword, rclone}`; there is no `lifecycle`. The Agent opens it with
  the unchanged `openSealedCommandSecrets` (`agent/src/sealedSecrets.ts:182`) and
  the same plain-option allowlists as version 5 (`validateSftpPlainOptions`,
  `validateS3PlainOptions`, `agent/src/backupFilesystem.ts:556-611`). Reusing the
  key is safe: the AAD binds a command ID that is unique per restore
  (`agent-restore-<restoreId>`) and the lease token, and the HMAC binds the type.
- `target.root` must be one of the Agent's host-approved restore roots;
  `target.name` is one path segment matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`
  that does not end in `.partial`. The server proposes
  `<hostname>-<yyyymmdd>-<restoreId prefix>`; the administrator may edit it.
- `selection` holds exact absolute snapshot paths (at most 1,024 includes and
  1,024 excludes, each at most 4,096 characters), normalized, no `.`/`..`
  segment, no control character and no glob metacharacter `* ? [ ] \`
  (Restic treats `--include` values as patterns). Empty includes means the whole
  snapshot. A selection has includes **or** excludes, never both, so the Agent's
  exact-path size accounting and Restic's filters always describe the same set;
  the UI asks to select only the items to restore instead of deselecting inside
  a selected folder.
- `artifact` (optional) is set only for a database dump restore. Then the
  selection is exactly `{includes: [artifact.path], excludes: []}`, the path
  matches `^/pluton/database/[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}\.sql$` and
  `bytes`/`sha256` come from the backup's completion receipt
  (`completionStats.lifecycle.databases`, validated at backup completion,
  `RemoteBackupService.ts:760-786`).
- Unknown fields, versions or option keys are refused, as in
  `parseBackupFilesystemPayload` (`agent/src/backupFilesystem.ts:716-823`).

### 3.3 Completion result

```json
{ "restoreId": "...", "restoredSnapshotId": "<64 hex>", "targetPath": "/srv/pluton-restore/<name>",
  "totalFiles": 400000, "filesRestored": 400000, "totalBytes": 375809638400,
  "bytesRestored": 375809638400, "verified": true, "artifactSha256": "<64 hex, artifact only>" }
```

The field is `restoredSnapshotId`, not `snapshotId`: the Agent derives backup
parent candidates from `result.snapshotId` of its stored receipts
(`agent/src/resticParent.ts` `successfulSnapshotIds`), and a restore receipt must
never become one. Failures use closed `failureStage`/`failureCode` values only
(section 6.9); Restic, Rclone and provider text never leave the host, as for
backups. The server validates the completion with its own strict schema
(`agentHostRestoreCompletionSchema`) and accepts a success only when the restore
ID, snapshot ID, target path and, for a dump, the SHA-256 equal the request.

## 4. Capability and version negotiation

Agent 0.9.0 adds to its inventory (`agent/src/inventory.ts:107-143`):

- `capabilities.restoreFilesystemVersion: 1`;
- `RESTORE_FILESYSTEM` in `capabilities.commandTypes`;
- a top-level, non-secret `restoreAccess` report:
  `{ version: 1, roots: [{ path, status: "writable" | "unavailable" | "rejected", code?, availableBytes?, availableInodes? }], policyError? }`.

Both are advertised only on Linux, as a non-root service account, with the
root-owned private Restic and Rclone that `backupLifecycleVersion: 2` already
requires (`inventory.ts`, `immutableBackupTools`).

The server validates inventory with a **strict** zod schema
(`backend/src/services/AgentService.ts:29-83`; `commandTypes` is `.max(6)` at
line 60). An older server therefore **refuses the 0.9.0 enrollment and
heartbeat**. Deploy the server first, exactly as for the S3 capability fields
(Agent `docs/COMPATIBILITY.md`, "S3 repositories"). The new server:

- accepts `restoreFilesystemVersion: 1`, `RESTORE_FILESYSTEM`, up to 7 command
  types and `restoreAccess` (at most 8 roots);
- decides with `supportsAgentHostRestore(agent)` in
  `backend/src/utils/agentHostRestore.ts`: the capability **and**
  `RESTORE_FILESYSTEM` in `commandTypes` **and** Agent version `>= 0.9.0`
  (the same belt-and-braces version gate as `supportsVanishedSourceEntries`,
  `backend/src/utils/sourceDiagnostics.ts:61-66`);
- offers a root only if the latest heartbeat reported it `writable`. The report is
  stored beside the capabilities (`capabilities.restoreAccess` in
  `agent_identities`), so no migration is needed and the UI reads it with the
  device;
- requires `restoreAccess` exactly when `RESTORE_FILESYSTEM` is advertised.

An Agent 0.8.x never sees the command. A server rollback with 0.9.0 Agents is
**not** safe (the old strict schema refuses their heartbeat): roll back the Agent
first, then the server.

## 5. Host-approved restore roots

### 5.1 Policy file

Root-owned JSON at `/etc/pluton-agent/restore-roots.json` (an administrator may
point `PLUTON_AGENT_RESTORE_POLICY_FILE` in the root-owned `/etc/pluton-agent.env`
elsewhere; a command never can):

```json
{ "version": 1, "agentId": "agent-…", "hostVersion": 3, "roots": ["/srv/pluton-restore"] }
```

It follows the source access host policy (`agent/src/sourceAccessPolicy.ts`):

- the file and every ancestor are root-owned, not group/other-writable, not a
  symbolic link, a single hard link (`rootOwned`, `sourceAccessPolicy.ts:450-466`,
  `readJSON` 496-535); read with `O_NOFOLLOW` and an identity check before and after;
- `agentId` must equal the enrolled identity, so a copied policy does nothing;
- at most 8 roots, lexically valid (`validateSourcePaths`, same file 81-105),
  non-overlapping (`assertNonoverlappingRoots`, 114-119);
- the Agent account cannot change it: it is root-owned, and the unit's
  `ProtectSystem=full` makes `/etc` read-only for the service anyway.

### 5.2 Root rules (checked at every heartbeat and again at execution)

A root is `writable` only if all of these hold, else it is reported `rejected`
or `unavailable` with a closed code and never offered:

1. Not in `DENIED_ROOTS` and not within `DENIED_TREES`
   (`sourceAccessPolicy.ts:30-66`: `/`, `/srv`, `/var`, `/home`, `/opt`, `/etc`,
   `/proc`, `/sys`, `/dev`, `/boot`, `/root`, the Agent state, install and upgrade
   directories, …) and additionally not within `/usr`, `/bin`, `/sbin`, `/lib`,
   `/lib64`, `/run`, `/tmp`, `/var/tmp` (read-only under `ProtectSystem=full`, or
   shared/world-writable).
2. No overlap, in either direction, with the Agent state directory or any source
   root: static `PLUTON_AGENT_ALLOWED_ROOTS`, host-approved and delegated Source
   Access roots and the effective selection (`SourceAccessPolicy.report()`). A
   restore never lands inside live data, and a later backup never re-reads a
   restore.
3. Canonical: `realpath(root) === root`, a real directory, not a symbolic link.
4. Owned by the Agent account, mode `0700` (no group/other bits): restored
   database dumps are confidential.
5. Every ancestor root-owned and not group/other-writable (no sticky exception),
   so no other local account can swap a path component.
6. Writable for the service (`access(W_OK)`; catches a read-only mount).

The repository is remote (SFTP/S3 through Rclone) and invisible to the Agent as
a local path. **Operator rule:** never approve a root that is, or lies inside, a
directory an SFTP server on the same host exports as a Pluton repository.

### 5.3 Local CLI for the host administrator

```sh
sudo install -d -o pluton-agent -g pluton-agent -m 0700 /srv/pluton-restore
sudo /opt/pluton-agent/runtime/bin/node /opt/pluton-agent/app/dist/index.js \
  restore-roots approve --config-file /etc/pluton-agent.env \
  --agent-id <agent id> --root /srv/pluton-restore
sudo /opt/pluton-agent/runtime/bin/node /opt/pluton-agent/app/dist/index.js \
  restore-roots list --config-file /etc/pluton-agent.env --agent-id <agent id>
sudo ... restore-roots revoke --config-file /etc/pluton-agent.env --agent-id <agent id> --root /srv/pluton-restore
```

`approve` requires root, checks the identity like `source-access`
(`agent/src/index.ts`), validates the root with section 5.2 rules 1, 3, 4 and 5
and overlap with the static allowed roots and the state directory, then writes the
file durably (temporary file, `fsync`, `rename`, directory `fsync`, mode `0644`).
It never creates, chowns or chmods the root itself. No service restart is needed:
the Agent re-reads the policy at every heartbeat and at execution.

## 6. Execution on the Agent

### 6.1 systemd hardening

`write_systemd_unit` (Agent `installers/install-agent.sh:776-805`) sets
`ProtectSystem=full`, `ReadWritePaths=$STATE_DIR`, `NoNewPrivileges=yes`,
`PrivateTmp=yes`, `CapabilityBoundingSet=` (empty) and `UMask=0077`.
`ProtectSystem=full` makes only `/usr`, `/boot`, `/efi` and `/etc` read-only;
`ReadWritePaths` adds an exception and does not restrict other paths;
`ProtectHome` is not set. A root such as `/srv/pluton-restore` or
`/var/backups/pluton-restore`, owned by `pluton-agent` with mode `0700`, is
therefore writable **without any unit change**.

Do **not** add a drop-in: the upgrader refuses any unit that differs from the
installer contract, including `DropInPaths` (`installers/lib/upgrade-agent.cjs:345-369`).
`upgrade-agent.sh` keeps the unit unchanged (`upgrade-agent.cjs:1-2`). With an
empty capability bounding set the Agent cannot `chown`, so restored files belong
to `pluton-agent` (section 7).

### 6.2 Sequence and stages

Inside the existing activity fence (`SourceAccessPolicy.withActivity`,
`sourceAccessPolicy.ts:355-406`), so an upgrade drain waits for a restore:

| Stage | Action | Failure codes |
| --- | --- | --- |
| `payload-validation` | strict parse, open sealed secrets | `invalid-payload` |
| `restore-policy` | read policy, re-check section 5.2, root ∈ policy and reported | `restore-policy-invalid`, `restore-root-not-approved`, `restore-root-unsafe`, `restore-root-overlap` |
| `target-creation` | `<name>` and `<name>.partial` absent; `mkdir <name>.partial` 0700, non-recursive (`EEXIST` refuses); verify identity, empty, owner | `restore-target-exists`, `restore-target-failed` |
| `tool-validation` | root-owned private Restic/Rclone | `tool-unavailable` |
| `temporary-storage-config` | obscure SFTP password, 0600 Rclone config in the state directory (`writeTemporaryRcloneConfig`, `backupFilesystem.ts:1456-1480`), S3 operator CA | `sftp-password-obscure-failed`, `temporary-config-failed` |
| `repository-check` | S3 access check, `restic cat config` (`verifyRepository`, `backupFilesystem.ts:1313-1368`) | `target-check-*-failed`, `repository-check-failed` |
| `snapshot-validation` | `restic snapshots --json <id>`: exactly one snapshot, full ID equal, tags contain `pluton-plan-<planId>` and `pluton-backup-<backupId>` | `restore-snapshot-mismatch` |
| `space-check` | `restic ls --json --recursive <id> [includes]`: every include exists; sum file sizes and count entries below includes and outside excludes; `statfs` | `restore-selection-missing`, `restore-insufficient-space` |
| `restic-restore` | `restic restore <id> --target <partial> --overwrite never --verify --json [--include …] [--exclude …]` | `restic-restore-failed`, `target-check-*-failed`, `cancelled` |
| `artifact-verification` | artifact only: size and SHA-256 of `<partial>/pluton/database/<file>` equal the receipt | `restore-verification-failed` |
| `finalize` | `<name>` still absent, `rename(<name>.partial, <name>)`, `fsync` root | `restore-finalize-failed` |
| `cleanup` | remove the temporary Rclone config only | `cleanup-failed` |

### 6.3 Safety rules (AGENTS.md "Restic operation boundaries")

- **New, empty, validated target only.** The Agent creates the directory itself
  with an exclusive `mkdir`; an existing `<name>` or `<name>.partial` refuses.
- **No overwrite, no delete.** `--overwrite never`, never `--delete`. The Agent
  never removes anything it restored, including a partial tree; the
  administrator decides.
- **No overlap** with any source root, the state directory, system trees or each
  other (5.2). The repository is remote (5.2, operator rule).
- **Path escape.** One-segment names, canonical roots, root-owned ancestors, a
  0700 root owned by the Agent account; Restic writes only below `--target`, and
  the Agent re-checks the target's identity (device/inode) before `rename`.
- **Snapshot binding.** The full ID and plan/backup tags must match before any
  byte is written (6.2 `snapshot-validation`).
- **Repository locks.** `restic restore` takes a non-exclusive lock (no
  `--no-lock`) so a future prune cannot remove packs mid-restore. These are
  managed plan repositories, not imported legacy ones; nothing runs `unlock`.

### 6.4 Disk-space precheck

`restic ls --json --recursive <id> [include…]` streams one node per line; the
Agent keeps only running totals (no listing is stored or sent). It requires, on
the filesystem of the root:

- free bytes `>= required + max(1 GiB, 5 % of required)`;
- free inodes `>= entries + 1,000` (400k small files can exhaust inodes first);
- and 512 MiB free in the state directory for the Restic cache.

A filesystem that reports no inode accounting (`files == 0`) skips the inode
rule. The check is advisory against concurrent writers; Restic still fails
cleanly on `ENOSPC`.

### 6.5 Progress and lease

The command uses the backup lease model: the first lease is 60 s
(`AGENT_COMMAND_LEASE_MS`), every status check and progress event renews it for
**10 minutes** (`agentCommandRenewalMs`, `backend/src/types/agents.ts:25-27`,
extended to `RESTORE_FILESYSTEM`). Restic `--json` status lines become paced
events (`ProgressDelivery`, at most one per 5 s):
`{ phase: "running", restoreStage, progress: { bytesProcessed, filesProcessed, totalBytesProcessed, totalFilesProcessed } }`.
While Restic runs, the cancellation poll is `leaseBoundCancellationCheck`
(`agent/src/commandStatus.ts:36-74`): a short control-plane outage does not
stop a long restore before the granted lease ends; every stage boundary stays
strict. An Agent executing a restore is shown busy, not offline
(`AgentStore.hasLiveCommand`). Restic has a 72-hour deadline.

### 6.6 Cancellation

`POST /api/restores/:id/action/cancel` marks the command cancelled
(`AgentStore.cancelCommand`, `AgentStore.ts:482-500`) and the restore row
cancelled. A queued command is never delivered; a running one sees
`cancelled: true` at its next status check (at most 10 s) and the Agent
terminates the Restic process group (`terminateProcessTree`). The partial folder
stays as `<name>.partial`.

### 6.7 Verification

`restic restore --verify` re-reads every restored file and compares it with the
snapshot's content hashes; any mismatch fails the restore
(`restic-restore-failed`) and leaves `<name>.partial`. For a database artifact
the Agent additionally hashes the restored dump and compares size and SHA-256
with the backup receipt. Only a verified restore is renamed to `<name>`, so a
folder without `.partial` is complete and verified. `--verify` roughly doubles
local disk reads; it adds no repository traffic.

### 6.8 Idempotency and crashes

The Agent persists its completion receipt before acknowledging it
(`agent/src/runtime.ts:319-320`). A lost completion ACK replays the stored
completion without restoring again. If the Agent dies mid-restore, the server
requeues the command when the lease ends; the second attempt finds
`<name>.partial` and fails `restore-target-exists`. Start a new restore (new
folder name) after reviewing or removing the partial folder.

### 6.9 Closed failure vocabulary

Stages: `payload-validation`, `restore-policy`, `target-creation`,
`tool-validation`, `sftp-password-obscure`, `temporary-storage-config`,
`repository-check`, `snapshot-validation`, `space-check`, `restic-restore`,
`artifact-verification`, `finalize`, `cleanup`, `command-status-check`.
Codes: those in the table of 6.2 plus the command-status codes
(`agent/src/commandStatus.ts:2-10`), `cancelled` and `unexpected`.

## 7. Restored ownership: what the operator does next

The Agent runs as the unprivileged `pluton-agent` user with no capabilities. As
a non-root process Restic cannot restore the original owner or group; it restores
modes, timestamps and content. **Every restored file is owned by
`pluton-agent:pluton-agent`** inside a `0700` root. Original numeric owners are
visible in Pluton's snapshot browser.

Typical steps (as the host administrator, application stopped where relevant):

```sh
# 1. Review
sudo ls -la /srv/pluton-restore/<name>/srv/example-app/
# 2a. Move a filestore into place (same filesystem: rename; otherwise copy)
sudo rsync -aH --chown=odoo:odoo /srv/pluton-restore/<name>/srv/example-app/filestore/ /srv/example-app/filestore/
# 2b. Load a PostgreSQL dump into a NEW database (never over the live one first)
sudo -u postgres createdb odoo_restore
sudo cat /srv/pluton-restore/<name>/pluton/database/odoo.sql | sudo -u postgres psql --dbname=odoo_restore
# 3. Remove the restored copy when done (Pluton never deletes it)
sudo rm -rf --one-file-system /srv/pluton-restore/<name>
```

Pluton never runs these steps.

## 8. Server, API and UI

### 8.1 Data model

No migration. An Agent host restore is a `restores` row
(`backend/src/db/schema/restores.ts`) with `sourceId` = the Agent's device ID,
`method: 'backup'`, `status` `queued | started | completed | failed | cancelled`,
`taskStats` for totals and progress, `progressStats.backupStage` for the last
closed restore stage, and `config`:

```json
{ "target": "/srv/pluton-restore/<name>", "overwrite": "never", "delete": false,
  "includes": [...], "excludes": [...], "snapshotId": "<64 hex>",
  "agentHost": { "version": 1, "root": "/srv/pluton-restore", "name": "<name>",
                 "commandId": "agent-restore-<restoreId>", "agentId": "...",
                 "databaseId": "db_…", "artifact": { "path": "...", "bytes": 1, "sha256": "..." } } }
```

Because `sourceId` is not `main`, the startup sweep leaves it alone
(`PlanService.clearOrphanedInProgress`, `backend/src/services/PlanService.ts:1253-1255`):
the Agent keeps running across a Pluton restart. `RestoreService` dispatches
`stats`, `progress`, `cancel` and `delete` on `config.agentHost`, as it does on
`config.stagingOnly` (`backend/src/services/RestoreService.ts:49,209,229`).

### 8.2 API (authenticated)

| Method and path | Purpose |
| --- | --- |
| `GET /api/restores/agent-host/options?backupId=&planId=` | Agent hostname, version, `supported` and a closed reason, writable roots with free space, suggested name, database artifacts of the backup |
| `POST /api/restores/action/agent-host` | `{ backupId, planId, root, name, includes?, excludes?, databaseId? }` → `202 { restoreId, target }` (`databaseId` is a `db_…` ID or `legacy` for a lifecycle version 1 dump) |
| existing `GET /api/restores/:id/progress`, `/stats`, `POST /:id/action/cancel`, `DELETE /:id` | dispatched for `agentHost` rows; delete refuses while in progress |

Creation checks (all server-side; hiding UI controls is not relied on):
managed Agent plan (`RemoteBackupService.isRemoteFilesystemPlan`); completed,
successful backup with a 64-hex snapshot ID; the plan's managed repository and
its Agent equal the plan's current Agent (restore on the same host only); the
Agent is not revoked and `supportsAgentHostRestore`; S3 primaries need the S3
capability (`agentSupportsS3Repository`); root is reported `writable`; name and
selection rules of 3.2; database artifacts resolved from the receipt by
`databaseId`; no other restore of the same backup in progress
(`RestoreStore.isRestoreRunning`) and no active Agent host restore with the same
root and name. Row and command are written in one transaction.

At poll, `AgentHostRestoreService.materializeCommand` re-checks ownership,
consistency, row state and capability, then seals. Any failure completes the
command as failed and the restore as failed, without delivering it.

### 8.3 Audit

Structured `serverLogger` events, never with secrets, paths of restored content
or provider text: `agent_host_restore_requested` (restoreId, planId, backupId,
agentId, root, name, whole/partial/database-dump, include/exclude counts,
databaseId), `agent_host_restore_delivered` (attempt),
`agent_host_restore_preparation_failed` (poll-time refusal),
`agent_host_restore_completed` (files, bytes, verified),
`agent_host_restore_failed` (failureStage, failureCode),
`agent_host_restore_cancelled` and `agent_host_restore_cancel_requested`. The
Agent logs one closed line per stage. The `restores` row keeps the durable
history.

### 8.4 UI

- **Restore wizard** for Managed Agent backups (`RestoreWizard`,
  `stagingOnly` mode): step 1 offers *Pluton server staging* (unchanged) or
  *Agent host (`<hostname>`)*. The Agent host option shows the host-approved
  roots with free space, the folder name, and the ownership note; when the Agent
  cannot do it, it shows the closed reason instead of the fields. Step 2 keeps
  the existing selection viewer; an empty selection restores the whole snapshot.
  There is no server-side preview (the Agent checks space itself): the wizard
  goes from the selection straight to a review step that shows the target and
  the selection and queues the restore, then shows the operator steps and links
  to the plan's restores.
- **Database artifact** in Snapshot Details: a *Restore to Agent host* action on
  each `.sql` artifact opens a small dialog (root, name) and queues an `artifact`
  restore.
- **Restores list/progress** show Agent host restores with the target path, the
  `.partial` note and the operator steps of section 7.
- In-app documentation: `frontend/src/docs/articles/restore/agent-host.md`.

## 9. Security review summary

| Threat | Control |
| --- | --- |
| Server or admin account abuse writes anywhere on the host | Only into a new folder inside a root the host administrator approved with sudo; one-segment names; system trees and source roots refused by the Agent itself |
| Overwrite or deletion of live data | No in-place mode, `--overwrite never`, no `--delete`, no overlap with sources, Agent never deletes |
| Symlink or path swap by another local user | Canonical root, root-owned non-writable ancestors, 0700 root owned by the Agent account, `O_NOFOLLOW` policy read, identity check before rename |
| Secret disclosure | Sealed to the per-Agent secret, command ID and lease token; temporary Rclone config 0600 in the state directory, removed in `finally` and swept at start-up |
| Wrong snapshot | Full ID, plan and backup tags checked before restore |
| Silent corruption | `--verify`; artifact SHA-256; rename only after success |
| Queue poisoning on old Agents | Capability + version gate at creation and at poll |
| Disk exhaustion | Byte and inode precheck; Restic `ENOSPC` fails cleanly; partial folder kept for review |

## 10. Rollout

1. **Server first.** Deploy the server that accepts the 0.9.0 inventory and lists
   `0.9.0` in `SUPPORTED_AGENT_INSTALL_VERSIONS`
   (`backend/src/utils/agentDistribution.ts:20`,
   `frontend/src/utils/agentEnrollment.ts:14`). Existing Agents are unaffected.
2. **Agent 0.9.0** with the standalone upgrader after a drain:
   `sudo bash upgrade-agent.sh --check`, then `sudo bash upgrade-agent.sh`
   (Agent `docs/AGENT_UPGRADE.md`). No unit or config change.
3. **Host administrator** creates and approves a restore root (5.3).
4. Rollback: Agent first (`upgrade-agent.sh --rollback <id>`), then server.
   Queued Agent host restores of a rolled-back Agent fail at poll.

## 11. Test plan

Agent (`node --test`, Linux execution tests in Docker as an unprivileged user,
fake Restic/Rclone like `agent/src/backupFilesystem.test.ts:1043-1100`):

- payload parser: exact fields, sealed-only, bad names/roots/selections/artifacts,
  wrong-key and tampered seals;
- restore policy: ownership/mode/ancestor/symlink/overlap/denied-tree rules,
  agentId binding, report statuses;
- execution: whole and partial restore succeed and rename; existing target and
  existing `.partial` refuse without touching them; snapshot tag mismatch;
  missing include; insufficient space; Restic failure keeps `.partial`;
  cancellation kills Restic and keeps `.partial`; artifact SHA-256 mismatch;
  temporary config removed; secrets never in arguments or output;
- inventory: capability and `restoreAccess` advertisement; runtime routes the
  command and persists the receipt;
- CLI argument parsing; contract and version pins (`scripts/tests`).

Server (jest): inventory schema accepts the new fields and still refuses
unknown ones; command allowlist; option, creation and every refusal path
(capability, version, revoked, root not reported, name, selection, artifact,
concurrent restore, foreign repository); poll materialization seals and refuses
lost capability; event and completion schemas; cancel, progress, stats and
delete dispatch; distribution versions.

Frontend (`node --test`): request/option helpers, name rules, docs manifest
count.

**Not covered by automated tests:** a real Restic 0.19.1 restore against a real
SFTP or S3 repository from a booted Ubuntu host with systemd, real ACL/xattr
data, a 350 GB restore and its timing. These need the native acceptance run of
the Agent repository before production use.
