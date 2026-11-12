# Plan repository relocation

Moves the primary SFTP Restic repository of **one** managed Remote Agent backup plan to another
SFTP Storage, without recreating the plan and without losing snapshot history. Pluton copies the
repository on the server, proves the copy, and switches the plan only after an explicit operator
action. The previous copy is kept until the operator deletes it explicitly. No Agent change is
needed.

Status: implemented and validated locally (unit, integration and a Docker lab with two real SFTP
servers). Not yet deployed or exercised against a production SFTP server.

## 1. Why this is needed

All managed plans of a deployment can share one SFTP Storage. When that Storage runs out of space,
moving the **whole** Storage already works without code: copy every repository to the new server
and edit the Storage host. Moving **one** plan did not work, because Pluton deliberately refuses to
change a plan's `storageId`/`storagePath` after creation (`PlanService.updatePlan`).

Changing that binding in only one place is not enough. The repository location of a managed plan is
recorded in four places, and recovery features compare them:

| Where | Checked by | Effect if only the plan changed |
| --- | --- | --- |
| `plans.storage_id/storage_path` | everything | – |
| `remote_managed_repositories` (holds the Restic password) | backup command preparation, browse, restore, download, export, replication, replica recovery | `repository-binding-changed`, `source-binding-invalid` |
| every `backups` row of the plan | `RemoteRepositoryRecoveryService.context`, `VerifiedReplicaRecoveryService`, recovery-test insert trigger (migration 0009), replication enqueue | old backups can no longer be browsed, restored, downloaded, recovery-tested or replicated |
| `managed_replication_jobs.source_storage_id/path` (mirror receipts) | `VerifiedReplicaRecoveryService` (`replica-unverified`), `ManagedReplicationStore.enqueue` (`Replication immutable binding changed`, used by `rescanCompleted`) | Assisted/Automatic recovery from mirrors and the replication rescan fail for old backups |

### Audit of other references (unchanged on purpose)

| Feature / table | Binding | Decision |
| --- | --- | --- |
| Reliable Download exports (`temporary-exports` journal) | `repositoryId`, `backupId`, `snapshotId` | Ready exports stay valid; an export that is still preparing blocks start and switch |
| Recovery tests, persistent database restores, automatic recovery lifecycle | `repository_id` (unchanged) | Active ones block start/switch; history stays valid |
| Assisted Recovery jobs | `plan_id`, `backup_id`, live repository context | Active/cleanup-pending jobs block start/switch |
| `restores` history | `storage_id/storage_path` at the time of the restore | Kept as a historical record (where data was read from) |
| `managed_replication_destinations` | `source_repository_id` (unchanged) | Replication continues to the same HCP mirror |
| Managed snapshot index cache | hash of the full access context | Changes with the location, so it is rebuilt automatically |
| Agent parent-snapshot selection | snapshot tags + local receipts | Location-independent; the copy holds the same snapshots |
| Agent command credentials | materialized per poll from `remote_managed_repositories.storage_id` | The next backup uses the new SFTP server automatically |

Remote plans never run `forget`, `prune` or `unlock` on the server, and only the Agent writes to the
repository (backups). A paused, idle plan therefore has no writer.

## 2. Operator decisions (12 Nov 2026)

1. Pluton copies the repository (server side), not the operator.
2. Switching is a separate, confirmed button after verification.
3. The plan resumes automatically after the switch if it was active before.
4. Pluton offers an explicit **Delete previous copy** button, available only after one successful
   backup at the new location.

## 3. Behaviour

### States

| Status | Meaning | Plan |
| --- | --- | --- |
| `copying` | Listing and `rclone copy` | Paused by Pluton at start; whether it was active is recorded |
| `verifying` | Listing, SHA-256 readback, repository ID, snapshots, `restic check` | Paused |
| `ready` | Every check passed, waiting for **Switch** | Paused (scheduled backups are skipped) |
| `switched` | Binding moved | Resumed if it was active |
| `failed` / `cancelled` | Nothing changed on the plan | Given back its previous state (resumed if it was active) |
| `reverted` | Moved back to the previous location | Unchanged |
| `source-deleted` | Previous copy deleted | Unchanged |

Failures record a closed code and the phase where they happened (`audit[].phase`), never provider
text. The closed code list is `RelocationFailureCode` in `backend/src/utils/relocation/repositoryInventory.ts`.


### Start conditions

- Managed Remote Agent backup plan (`sourceType=device`, `sourceId≠main`, `method=backup`) with an
  initialized repository whose record matches the plan.
- Destination is an SFTP Storage. The path is a concrete folder: not empty, not `/` or `.`, no `..`,
  no backslash or control characters, not starting with `-`.
- Destination does not overlap the current location (same Storage), any plan/mirror/legacy/retained
  repository, or any copy kept by another relocation.
- Destination folder is empty, **or** it holds an earlier failed/cancelled/reverted attempt of the
  same repository whose files are a subset of the source (retry). Rclone `.partial` temporaries are
  removed in that case only.
- Plan idle: no running backup or restore; no pending/running/uncertain replication; no queued or
  running recovery test, unreleased internal recovery session or import lease; no active or
  cleanup-pending Assisted Recovery; no queued/importing/deleting database restore or import lease;
  no Reliable Download export still preparing.
- One relocation per plan, and only one copy/verification at a time on the whole server.

### Copy and verification

1. `rclone lsjson` of the source: only `config`, `keys/`, `snapshots/`, `index/`, `data/xx/` files
   are accepted (`locks/` are ignored and never copied); anything else fails closed with
   `unexpected-repository-file`.
2. `rclone copy --exclude /locks/** --size-only --immutable` (Restic files are content addressed and
   never modified). Progress shows Rclone's real byte and file counters.
3. Source listed again: must be identical (`source-changed` otherwise).
4. Destination listing must equal the source listing (names and sizes).
5. `rclone hashsum sha256 --download` of the destination: every file except `config` must hash to its
   own name (Restic names files by the SHA-256 of their content); `config` must equal the source
   digest. Every byte of the copy is read back.
6. `restic cat config` on both sides: same repository ID. `restic snapshots`: same snapshot set, and
   every successful backup record of the plan is present.
7. `restic check` (structure) on the copy. Data integrity is already proven by step 5, so
   `--read-data` is not used.

A stall watchdog stops `rclone copy` and the hash readback when Rclone reports no forward progress
for 10 minutes (code `timeout`); a hung SFTP request can otherwise block without I/O.

### Switch

Runs in the background (the API answers 202; listings of a large repository can exceed proxy
timeouts). Pluton lists both locations again and compares them to the verified listing digest and
repository ID. Then one immediate SQLite transaction rechecks the idle conditions and rewrites the
plan, the repository record, every backup row at the previous location and their mirror receipts.
The IDs of the moved backup rows are recorded (`plan_repository_relocation_backups`). The plan is
then resumed if it was active.

### Move back (revert)

Allowed while no successful backup exists at the new location that the switch did not move (a
failed backup does not block, so moving back stays possible if the Agent cannot reach the new
server). Pluton first proves the previous copy is unchanged (listing digest and repository ID), then
moves back exactly the rows and receipts the switch moved.

### Delete previous copy

Allowed only after at least one successful backup at the new location, with the plan name typed
exactly. Pluton refuses when the previous location overlaps any live or retained repository, holds
any file that is not a Restic repository file, holds any file the live repository does not have
(the live repository never forgets or prunes, so it contains every previous file), or reports a
different repository ID. Then `rclone purge` removes that folder. A partial failure can be retried.

### Database guards (migration 0023)

Triggers reject, while a relocation is `copying`, `verifying` or `ready`: inserting a backup row for
the plan, resuming the plan, editing or deleting either Storage, and deleting the plan. The services
return friendly 409 messages first (`PlanService` resume/backup/edit/remove,
`StorageStore.assertManagedReplicationStorageEditable`). Copies kept by relocations are added to
`PlanStore.getStorageRemovalReferences`, so plan/mirror purges and new relocations cannot target them.

### Restart

A copy or verification interrupted by a server restart is marked `failed` (`server-restarted`) at
startup and the plan gets its state back; starting again reuses the files already copied. A `ready`
relocation stays ready. An interrupted delete is recorded as failed and can be retried.

## 4. Files

New:

- `backend/drizzle/0023_plan_repository_relocation.sql` (+ `backend/drizzle/meta/_journal.json`)
- `backend/src/stores/PlanRepositoryRelocationStore.ts`
- `backend/src/services/PlanRepositoryRelocationService.ts`
- `backend/src/utils/relocation/repositoryInventory.ts`
- `backend/src/utils/relocation/SftpRepositoryTransfer.ts`
- `backend/src/controllers/PlanRepositoryRelocationController.ts`
- `backend/src/routes/planRelocations.ts`
- `frontend/src/components/Plan/PlanRelocation/PlanRelocationModal.tsx`, `PlanRelocation.module.scss`
- `frontend/src/services/planRelocations.ts`, `frontend/src/utils/planRelocation.ts`,
  `frontend/src/@types/planRelocations.ts`
- Tests: `backend/__tests__/stores/PlanRepositoryRelocationStore.test.ts`,
  `backend/__tests__/services/PlanRepositoryRelocationService.test.ts`,
  `backend/__tests__/routes/planRelocations.test.ts`,
  `backend/__tests__/utils/relocationInventory.test.ts`,
  `backend/__tests__/utils/relocationTransferRunner.test.ts`, `frontend/__tests__/planRelocation.test.ts`
- Lab: `backend/__tests__/integration/planRelocation.lab.ts`, `scripts/validate-plan-relocation.py`
- This report

Changed:

- `backend/src/createApp.ts` (wiring, startup recovery, shutdown, route `/api/plan-relocations`)
- `backend/src/services/PlanService.ts` (409 while a relocation is active: resume, backup, edit, remove)
- `backend/src/stores/PlanStore.ts`, `backend/src/utils/storageRemovalScope.ts` (relocation copies are retained references)
- `backend/src/stores/StorageStore.ts` (Storage edit/delete guard)
- `backend/src/services/ManagedExportService.ts` (`hasActiveForPlan`)
- `frontend/src/routes/PlanSingle/PlanSingle.tsx` (Move button in the Storage box, Remote Agent plans only)
- `docs/api-inventory.json`, `docs/API_COVERAGE_MATRIX.md` (regenerated: 7 new routes)

API (session-authenticated administrator):

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/plan-relocations?planId=` | overview: supported, canStart, last 10 relocations |
| POST | `/api/plan-relocations` `{planId, storageId, storagePath}` | 202, starts copy |
| GET | `/api/plan-relocations/:id` | one relocation |
| POST | `/api/plan-relocations/:id/cancel` | cancel copying/verifying/ready |
| POST | `/api/plan-relocations/:id/switch` | 202, background switch |
| POST | `/api/plan-relocations/:id/revert` | 202, background move back |
| DELETE | `/api/plan-relocations/:id/source-copy` `{confirmTitle}` | 202, background delete of previous copy |

## 5. Deployment

- **Migration:** yes, `0023` (additive: two tables, indexes, five triggers). Runs at startup.
- **Agent:** no update or re-enrollment. The Agent host only needs network access to the new SFTP
  server.
- **`.env` / Compose:** no change.
- **Order:** server only.

## 6. Validation (12 Nov 2026, Windows, Node 24.16.0, pnpm 10.20.0)

| Check | Result |
| --- | --- |
| New backend tests (store 13, service 20, routes/guards 11, inventory 7, runner 4) | 55/55 |
| Full backend suite `pnpm --filter @plutonhq/core-backend test --runInBand` | 235/235 suites, 4,934 passed, 4 skipped (built-in), 422 s |
| Backend lint, backend `tsc --noEmit` | pass |
| Frontend `tsc -b` | pass |
| Frontend tests `node --experimental-strip-types --test frontend/__tests__/*.test.ts` | 483/483 |
| Frontend lint (changed files, temporary config with the known `eslint-config-prettier` loader fix) | only the repository-wide `object-curly-newline` baseline and one existing `react-hooks/static-components` finding at `PlanSingle.tsx:30` (unchanged code) |
| `node --test scripts/__tests__/apiInventory.test.mjs` | pass |
| `pnpm build` | 3/3 tasks |
| `git diff --check` | clean |
| Docker lab `py -3 scripts/validate-plan-relocation.py pluton-s3-readback-verified:local` | PASS, three consecutive runs |

### 6.1 Docker lab

One network-none container (`--read-only`, UID 1000, 2 CPU, 4 GiB), two `rclone serve sftp`
loopback servers, real Restic 0.19.1 and Rclone 1.75.1, the production store, service, transfer and
SFTP option materialization (`RemoteBackupService.materializeSftpStorage`). Phases:

1. Destination unreachable → `failed`/`network-unavailable`, plan resumed, binding unchanged.
2. Destination holds a same-size but corrupted pack → `destination-hash-mismatch` (proves the
   SHA-256 readback), plan resumed.
3. Retry after removing the bad pack, with an Rclone `.partial` left behind → temporary removed,
   pack copied, `ready`; stale lock not copied; file sets identical.
4. Outside writer adds a snapshot to the source after verification → switch refused with
   `source-changed`, binding unchanged, plan resumed.
5. New relocation copies only the delta (real Rclone counters asserted), switch moves plan,
   repository record and backup rows; plan resumed.
6. Production `ManagedSftpRepositorySession` reads both recorded snapshots and the repository ID from
   the new location.
7. Move back, then move again (reusing the destination).
8. Backup written at the new location → revert refused, delete offered.
9. Delete refused for a wrong plan name and for a foreign file in the previous folder
   (`unexpected-repository-file`); then deleted; a sibling folder on the same server is untouched;
   the live repository holds all four snapshots.

Lab finding: `rclone serve sftp` caches directory listings for five minutes and, with the cache
disabled, once deadlocked on renaming an upload. The lab therefore restarts both loopback servers
after every out-of-band disk edit. The deadlock led to the stall watchdog above. A real OpenSSH
server has neither behaviour, but this was not verified against OpenSSH.

### 6.2 Local browser walkthrough

A disposable local preview (image built from this branch, `127.0.0.1` only, synthetic plan and
two loopback `rclone serve sftp` servers inside the container) was driven in a browser, dark theme:
the Move button appears on the Storage box of a Remote Agent plan; copy and verification
progress; verified summary (15 files, 22.9 MiB, 3 snapshots); switch confirmation; plan page then
shows the new Storage and an old backup is browsable from it; Move back; a second move reusing the
reverted destination; after one successful backup at the new location Move back is hidden and
Delete previous copy is enabled only after typing the plan name; the previous folder is removed and
the live repository keeps all four snapshots. The walkthrough found three dialog issues, fixed in
`fix(ui): default Move destination to another SFTP Storage`: the Storage select displayed a choice
while none was set (start button disabled), the default could be the current Storage when the
Storage list loaded first, and the switch confirmation wrongly said restore history moves.

## 7. Operator UAT

Use placeholders: `NEW_SFTP_HOST`, `NEW_SFTP_PORT`, `PLAN_NAME`. Start with a small plan.

1. Create the new SFTP Storage in Pluton (host, port, user, password). Make sure the target folder is
   empty and has room for the repository plus growth.
2. From the Agent host of the plan (read-only check):
   `timeout 5 bash -c '</dev/tcp/NEW_SFTP_HOST/NEW_SFTP_PORT' && echo reachable || echo NOT reachable`
3. Deploy the new image (server only). Confirm the plan page loads.
4. Plan page → hover the Storage box → arrow button **Move repository to another Storage** → choose
   the Storage and folder → **Pause plan and copy**. Watch the copy counters, then the readback
   counter.
5. When it says *Verified, waiting for switch*, compare files/size/snapshots with expectations,
   then **Switch to new Storage** → **Switch now**. The plan resumes if it was active.
6. Open an old backup of that plan and browse it; then **Backup now** and wait for success; check its
   mirror status if replication is enabled.
7. Optional, after that successful backup: type the plan name and **Delete previous copy**.

If anything fails, bring back only: relocation status, failure code and phase (dialog → History), or
`lastOperationFailure.code` for switch/move back/delete. No logs or configuration are needed.

Expected duration: the repository is read from the old server, written to the new one and read back
once from the new one (about three times its size in traffic). For about 75 GB on a 1 Gbit/s LAN
that is an estimated 30–60 minutes; this is not measured. The plan is paused for the whole copy and
until **Switch**, so its scheduled backups in that window are skipped.

## 8. Rollback

- **Relocation level:** **Move back** (while no successful backup exists at the new location), or a
  new relocation to an empty folder afterwards.
- **Image rollback:** cancel any relocation that is `copying`, `verifying` or `ready` first. The
  database triggers stay after an image rollback and would otherwise keep that plan from creating
  backups or resuming. A switched plan keeps working on the old image, because the new location is in
  the ordinary plan/repository/backup columns. The new tables are ignored by the old image. No schema
  downgrade.

## 9. Limitations

- SFTP to SFTP only; S3/HCP mirrors are not primary locations and are not moved.
- The copy passes through the Pluton server (SFTP → server → SFTP); not a server-to-server transfer.
- Throughput and duration on production infrastructure are not measured.
- SFTP host keys are not pinned (same as all existing Pluton SFTP access); the transfer uses only
  `host`, `port`, `user`, `pass`.
- Deleting the previous copy removes the whole previous folder after the proofs in section 3; files
  added there between the proof and the purge would be removed too.
- After the plan itself is removed, its previous copy can no longer be deleted through Pluton; it
  stays protected as a retained location and must be removed manually.
- In-flight browse or download sessions started before a switch keep reading the previous copy until
  they finish (harmless: identical content).
- Not verified: a real OpenSSH SFTP server, the light theme, hosted CI.
