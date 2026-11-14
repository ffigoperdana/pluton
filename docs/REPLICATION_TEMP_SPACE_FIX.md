# Replication temporary space and failure diagnostics

Managed replication of a larger plan failed on every backup with the opaque code
`execution-failed`. The cause is proven: `restic copy` ran out of space in the container's `/tmp`.
This change gives every copy a private temporary directory on the data volume and records where and
why a replication job failed, without exposing provider text.

## 1. Symptom (15 Nov 2026, production, sanitized)

- A remote Agent plan with a MariaDB artifact (about 1.23 GB logical, 27 backups) got replication
  enabled. All 24 replica jobs failed with `execution-failed`, attempt 1, each after about 17 to
  30 seconds. The same S3 replica Storage had 53 completed jobs for smaller plans.
- The destination repository was initialized (`init_state=ready`), so admission, source inspection
  and the source SQL artifact check all passed.

## 2. Root cause

**Proven in production.** `deploy/compose.yml` runs the container `read_only` with
`/tmp` as a 64 MiB tmpfs, and nothing sets `TMPDIR`. While one failed job was retried, `/tmp` usage
went 0 → 816 → 7,996 → 34,076 → 63,100 KiB in four seconds and back to 0 the next second; the job's
`updated_at` is exactly that second.

**Mechanism (Restic source, `internal/repository/packer_manager.go`).** Every pack Restic uploads is
first written to `TempFile("", "restic-temp-pack-")` until it reaches the pack size (16 MiB). Tree and
data blobs have separate packer managers and the uploader runs one worker per backend connection
(5 for the Rclone backend). When reading the source is faster than writing the replica, several full
packs wait on disk at the same time, which exceeds 64 MiB. Small plans never hold that much data in
flight, which is why they succeeded.

**Reproduced locally** with the Restic 0.19.1 binary of the production image, a 64 MiB `/tmp`
tmpfs, a 200 MB random repository, 5 connections and an 8 MiB/s upload limit:
`Fatal: Write: write /tmp/restic-temp-pack-…: no space left on device` with `/tmp` at 65,536 KiB.
The identical copy with `TMPDIR` on the data disk completed, `/tmp` stayed at 0, and `restic check`
found no errors. Without the upload limit (fast local destination) the 64 MiB copy succeeds, which
matches the production pattern: the replica is slower than the source.

Restic deletes the name of each temporary file right after creating it, so `ls /tmp` shows nothing;
only `df` shows the usage.

## 3. Change

### Temporary space (`ManagedReplicationExecutor.copy`)

- Each copy creates `<app temp>/replication/job-XXXXXX` (`appPaths.getTempDir()`, on Linux
  `/data/pluton`, the data volume; mode 0700 parent), sets `TMPDIR` for every Restic/Rclone call of
  that copy, and removes the directory afterwards, also after a failure or cancellation.
- If the directory cannot be created the job fails with `workspace-unavailable` before any command.
- The copy reuses one environment for its source checks instead of building a second one; the
  commands, arguments and credentials are unchanged.
- Expected extra disk use on `/data` during a copy: roughly 5 to 10 packs of 16 MiB, at most a few
  hundred MiB, released when Restic exits.

### Failure diagnostics

- `ManagedReplicationError` carries a closed `detail`: the fixed step (`workspace`, `credentials`,
  `source-config`, `source-snapshot`, `source-artifact`, `destination-config`, `destination-list`,
  `destination-init`, `copy`, `destination-snapshot`, `destination-artifact`), the exit code, the
  signal, and backend retry counts with closed error classes (reusing `archiveBackendRetries`).
- Failures that the existing credential/TLS/permission checks did not recognise now map to closed
  codes instead of `execution-failed` when Restic's text matches a known pattern:

  | Code | Meaning |
  | --- | --- |
  | `no-space-left` | A local or remote write ran out of space |
  | `memory-exhausted` | Out of memory reported |
  | `process-killed` | Restic or Rclone ended by a signal Pluton did not send |
  | `snapshot-path-missing` | `restic dump` could not find the artifact path |
  | `snapshot-unavailable` | Snapshot ID not found |
  | `repository-locked` | Lock could not be created (also exit 11) |
  | `lock-refresh-failed` | Restic could not refresh its lock |
  | `repository-data-damaged` | Decryption or pack/blob damage reported |
  | `restic-arguments-rejected` | Restic rejected a flag or argument |
  | `storage-dns-failed`, `storage-unreachable`, `storage-timeout`, `storage-connection-interrupted`, `storage-partial-read`, `storage-object-missing` | Transport classes |
  | `storage-server-error` / `storage-request-rejected` | HTTP 5xx / other 4xx |
  | `storage-authentication-failed`, `storage-permission-denied` | SSH authentication or permission |
  | `execution-failed` | Nothing recognised (unchanged fallback) |

  Earlier codes keep their precedence (`wrong-password`, `storage-tls-failed`,
  `storage-authentication-failed`, `retention-denied`, `storage-access-denied`, exit 10/11).
  All codes match the MCP `safeCode` pattern.
- The service writes one application log line per job outcome:
  `managed_replication_job_failed` (job, plan, backup and replication IDs, attempt, code, step, exit
  code, signal, backend counts/classes, duration, and only the class name for unexpected errors) and
  `managed_replication_job_completed` (IDs, attempt, duration). No storage names, endpoints, bucket,
  paths, credentials or provider text.

No database migration, no API change, no Agent or `.env`/Compose change.

## 4. Files

- `backend/src/utils/restic/ManagedReplicationExecutor.ts`
- `backend/src/services/ManagedReplicationService.ts`
- `backend/__tests__/utils/ManagedReplicationExecutor.test.ts`
- `backend/__tests__/utils/ManagedReplicationProcess.test.ts`
- `backend/__tests__/services/ManagedReplicationService.test.ts`
- `frontend/src/utils/replication.ts`
- `frontend/src/components/Plan/PlanSettings/PlanReplicationSettings.tsx`
- `frontend/src/components/Plan/PlanSettings/PlanReplicationSettings.module.scss`
- `frontend/__tests__/managedReplication.test.ts`
- `docs/REPLICATION_TEMP_SPACE_FIX.md`

## 5. Validation (15 Nov 2026, Windows, Node 24.16.0)

| Check | Result |
| --- | --- |
| Replication suites (executor, process, service) | 80 passed, 1 skipped (signal test is Linux-only) |
| Full backend suite `--runInBand` | 233/236 suites, 4,939 passed, 5 skipped; the 3 failing suites are environmental, see 5.1 |
| Backend `tsc --noEmit`, ESLint on changed files | pass |
| Docker reproduction (Restic 0.19.1, 64 MiB `/tmp`, throttled upload) | old behaviour fails with ENOSPC; `TMPDIR` on disk succeeds, `check` clean |
| Replica recovery lab `scripts/validate-replica-recovery.py` (new source mounted) | 18/18 PASS |
| Frontend tests `node --experimental-strip-types --test frontend/__tests__/*.test.ts` | 490/490 |
| Frontend `tsc -b` | pass (full frontend ESLint still fails to load its config, the known `eslint-config-prettier` baseline) |

New tests: the copy's private `TMPDIR` is used by every call and removed after success and failure;
`workspace-unavailable` stops before any command; the failing step is recorded for every command;
sanitized classification of each new code from real child stderr; backend retry summary; the job
log has the step and closed facts and no secrets or provider text.

### 5.1 Results

- Replica recovery lab (Docker, network none, read-only, real Restic 0.19.1 and Rclone, current
  source mounted into `pluton-s3-readback-verified:local`): all 18 scenarios PASS, including
  "real SFTP-to-HTTPS-S3 Restic copy, private CA, destination mapping and recovery preflight", which
  now runs the copy with the private temporary directory.
- Full backend suite with `TEMP` inside the worktree (a `.claude/worktrees/.../tmp` folder): 3 suites failed,
  none touching replication. Rerun alone with a short `TEMP` outside `.claude`:
  `VerifiedReplicaRecoveryService` 52/52 and `spaFallback` 17/17 pass (the long path breaks the
  index builder's SQLite file, and `send` treats the `.claude` segment as a dotfile and answers 404);
  `PlanService` passes alone (the known Pino teardown timeout in a full run).

## 6. Deploy and operator UAT

1. Deploy the server image by digest as usual (server only).
2. Open Mirror Details of one failed backup of the affected plan and click **Retry**.
3. Expected: the mirror becomes Completed. The first copy of a larger plan takes longer; later ones
   copy only new data. Optional, in the VM: `df -h /tmp` inside the container stays near 0.
4. If it still fails, read the decision code in Mirror Details and the job log:
   `docker exec <pluton-container> sh -c 'grep managed_replication_job /data/logs/app.log | tail -3'`
   Bring back only `code`, `step`, `exitCode` and `backend`.
5. Retry the remaining failed backups (Retry is per backup; jobs run one at a time).

Turning replication off and on again does not reset failed jobs (each backup keeps its job); use
Retry. Removing a replica row and adding the same folder again is refused
(`Replica repository ownership changed`) because the folder belongs to the old row.

## 7. Rollback

Image rollback only. The old image writes temporary packs to `/tmp` again, so larger replications
fail again with `execution-failed`. Nothing is stored that the old image cannot read; an interrupted
copy leaves at most an empty `job-*` directory under `/data/pluton/replication`.

## 8. Limitations

- The pack temporary space now comes from the data volume; a nearly full `/data` would fail with
  `no-space-left` (step `copy`) instead of filling `/tmp`.
- Classification uses the last 32 KiB of stderr and fixed patterns; an unknown message stays
  `execution-failed`, now with its step, exit code and backend counts in the log.
- Other server-side Restic writers (self-backup of the Pluton host, plans on device `main`) were not
  changed in this fix.

## 9. Confirmation when replication is turned off

Operator question after the incident: turning replication off showed no warning, although it changes
more than the toggle suggests. Edit Plan now asks first when a saved plan that has replica
destinations is switched off (`needsReplicationOffConfirmation`). A new plan, or one without
destinations, toggles directly as before. The dialog lists (`replicationOffNotice`):

- new backups are no longer copied to the replica storages;
- copies already in the replicas stay where they are, nothing is deleted;
- managed plans only: Recovery & Failover returns to Primary Only and is not restored by turning
  replication on again; turning replication off and on does not retry failed copies (use Retry in
  Mirror Details); saving is refused while a copy is pending or running
  (`managed_replication_plan_binding` trigger);
- the change takes effect when the plan is saved.

**Keep Replication On** leaves everything unchanged; **Turn Off Replication** applies exactly the
previous toggle behaviour (`enabled: false`, policy `primary-only`, destination rows and their
replication IDs kept, so turning it on again continues in the same replica folders).

No replica deletion was added. Deleting a managed replica stays unavailable on purpose (offsite copy,
irreversible, HCP retention can make it partial); if needed it should be a separate, explicit action
on detaching a destination, with a typed confirmation and owned-prefix checks.

Tests: the helper's cases; a rendered managed plan in edit mode does not change on the first toggle,
shows the notice, keeps everything on **Keep Replication On**, and on **Turn Off Replication** sends
one update with `enabled: false`, `primary-only` and the same destination rows (fails on the previous
component); a new plan toggles off immediately without a dialog.
