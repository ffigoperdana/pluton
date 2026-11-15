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
| Database passwords | Lifecycle database passwords are sealed in payload version 5 as well (user decision of 15 November 2026; design section 10.3 amended in `3d241ea`), so no secret travels in plain `options` or lifecycle fields for a version 5 Agent. |

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
- `frontend/src/docs/articles/architecture.md`, `backup-plans/delete.md`, `getting-started/quick-start.md`, `getting-started/requirements.md`, `storage.md`, `storage/local.md`, `remote-agent/permissions.md` (wording no longer claims Agent plans are SFTP-only; 0.8.0 listed)
- `scripts/validate-agent-enrollment.ps1` (`-AgentVersion` accepts `0.8.0`)
- `docs/S3_AGENT_REPOSITORY_DESIGN.md` (section 10.3 amendment), `docs/superpowers/plans/2026-11-15-s3-agent-agent.md` (Agent plan amended for database password sealing)
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
| Backend suite `npx jest --runInBand` (Task 15 Step 1) | `Test Suites: 1 failed, 239 passed, 240 total` / `Tests: 6 skipped, 5036 passed, 5042 total`; the one failed suite is `PlanService` (afterAll hook timeout in the Pino teardown, see next row) |
| `PlanService` alone, only if it failed in the full run | The full run and three solo runs by the implementer hit the known flaky Pino `afterAll` teardown timeout in `__tests__/setup.ts` ("Exceeded timeout of 5000 ms for a hook"); all 80 tests passed each time. A later solo rerun by the controller passed (80/80, suite passed), and so did the final review rerun. This branch does not touch `PlanService`, its test or the setup file. Hosted CI (Linux) must show the Backend Test job green before merge |
| Backend `tsc --noEmit` and ESLint (Step 2) | `tsc --noEmit` exit 0; `pnpm lint` exit 0 (no output) |
| Frontend tests `node --experimental-strip-types --test frontend/__tests__/*.test.ts` (Step 3) | `tests 501`, `pass 501`, `fail 0` |
| Frontend `tsc -b` (Step 3) | `tsc -b` exit 0 |
| `pnpm build` (Step 4) | `Tasks: 3 successful, 3 total` (no cache); `git diff --check origin/main...HEAD` prints nothing |
| Replica lab with the S3 primary scenario (Task 9 Step 3) | Not rerun in Task 15 (needs Docker). Task 9 recorded 19/19 passed, including the S3 primary scenario (per the task ledger) |
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

Note: if the Agent of an S3 plan is older than 0.8.0, the server refuses to queue its backups and this appears only as a `remote_backup_not_queued` log warning, not in the UI. Check the log if a scheduled S3 backup does not start.

If a step fails, record only: plan ID, backup ID, the backup error text shown in the UI, and from
the server log either the `remote_backup_command_preparation_failed` fields `failureStage`,
`rejectedField`, `ruleCategory`, or the `command_failed` fields `failureStage`, `failureCode`.
Do not copy payloads, storage settings or `.env`.

## Rollback

- Agent first, then server. The order matters because an older server's strict capability schema refuses 0.8.0 heartbeats, so those Agents would go offline for all their plans. Reinstall the previous Agent. The server then refuses to queue backups for S3
  plans with HTTP 409 "Remote agent does not support S3 repositories. Update the agent first."
  instead of sending a payload the Agent cannot read. While the Agent is older than 0.8.0 this refusal shows only as a `remote_backup_not_queued` log warning, not in the UI. Snapshots already in S3 stay readable.
- Server: redeploy the previous image by digest. No schema change, so no downgrade step. With the
  older server, S3-primary plans fail to back up and their snapshots are not reachable from the
  UI until this version is deployed again; their data in S3 is untouched.

## Decisions from the design

1. Two additions beyond the original task list: database passwords are sealed in version 5 too (commit `ab73e45`), and sibling in-app articles were aligned (`55f2d93`).
2. `sourceDiagnosticsVersion: 1` is sent in payload version 5 exactly as today (design 10.2), so
   Agent 0.8.0 keeps path-level source diagnostics.
3. The payload carries no trust or CA setting (design 6.1 point 2); the server applies
   `PLUTON_STORAGE_CA_FILE` only on its own read path.
4. `AGENT_INSTALL_VERSION=0.8.0` is accepted by this server; the `.env` pin is an operator step
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
- Review follow-ups recorded in the task ledger, none blocking: `seal()` has no runtime shape check and accepts empty secret, command ID or lease token (poll guarantees them); the overlap scan decrypts all plans' storages on every S3 queue (performance, fail-closed: one unverifiable plan scope blocks all S3 plans); a missing-password or missing-`databaseId` path in database sealing is untested; the replica lab uses fake stores and has no negative control; the `PlanService` suite can hit the known flaky Pino teardown timeout (see the Tests table; solo rerun passed 80/80), unrelated to this change, and hosted CI must show the Backend Test job green before merge.
- Sealing is only as confidential as the Agent enrollment exchange: the per-Agent secret (HKDF input) is returned in plain form in the enrollment response (`AgentService.ts`), and production may allow Agent HTTP on the LAN (`ALLOW_INSECURE_AGENT_HTTP`). A passive observer of an enrollment over HTTP could derive the sealing key. Enroll Agents that will use an S3 primary over HTTPS; otherwise the residual risk is accepted. Documentation only, no code change.
- Agents older than 0.8.0 on an S3 plan: the queue refusal is visible only as the `remote_backup_not_queued` log warning, not in the UI (follow-up).
- A local (device Main) plan created later inside an S3 primary's prefix is not refused and makes that S3 plan's backups stop queueing (follow-up).
- Hostname aliases of the same HCP namespace are not detected (a single shared storage record today).
- Switching between two remote machines in the plan form keeps an S3 selection; the server refuses it with HTTP 409 (follow-up).
