# Stage 3: backup failover to a verified replica

Status: implemented on branch `claude/backup-failover`. Stage 3 of [S3_AGENT_REPOSITORY_DESIGN.md](S3_AGENT_REPOSITORY_DESIGN.md)
section 3. Builds on stage 2 ([S3_PRIMARY_REPLICATION.md](S3_PRIMARY_REPLICATION.md)).

## 1. Goal

Today a Managed Agent backup fails when its primary repository is unreachable, and no backup is
written until the primary returns. Stage 3 keeps backups going:

1. The backup to the primary fails before upload because the primary is unreachable.
2. The server confirms the primary is down and queues a **failover backup** that the Agent writes
   into the plan's verified replica repository.
3. When the primary is reachable again, the server **copies the failover snapshot back** to the
   primary and verifies it.

It works in both stage 2 directions: SFTP primary to S3 replica, and S3 primary to SFTP replica.
Switching the primary permanently is stage 4 and is out of scope.

## 2. Facts this design relies on (verified in code, main 18e546e / Agent 614fddb)

| Fact | Where |
| --- | --- |
| A replica repository uses the primary's Restic password and chunker parameters (`init --from-repo --copy-chunker-params`) | `ManagedReplicationExecutor.environment`, `copy` |
| The Agent keeps no repository identity per plan; each payload names its repository, Rclone options and sealed secrets | `agent/src/backupFilesystem.ts` `parseBackupFilesystemPayload` |
| Agents from 0.8.0 accept version 5 payloads for SFTP and S3 (`repositoryBackends`, `backupPayloadVersion: 5`) | `agent/src/inventory.ts` |
| Before upload, the Agent probes the repository with 30 s deadlines (S3 `rclone lsf`, replay `restic snapshots --tag`, `restic cat config`) | `backupFilesystem.ts` |
| An unreachable S3 repository fails in about 35 s as `target-check-transport-failed`; an unreachable SFTP repository fails in about 35 s as `repository-check-failed`, or within seconds as a transport failure when the connection is refused | `backupFilesystem.ts` `repositoryDiagnostic` |
| A repository lost during `restic backup` has no deadline other than Restic's own retries | `backupFilesystem.ts` |
| A failed remote backup is not retried automatically | `RemoteBackupService.completeCommand` |

Consequence: **a failover backup is an ordinary version 5 backup command whose repository is the
replica.** No Agent change is needed. Agents 0.8.0 and later can run it; 0.7.x Agents cannot.

## 3. Decisions

| Topic | Decision | Reason |
| --- | --- | --- |
| Where the failover backup goes | Into the existing verified replica repository (same password and chunker parameters) | Only changed data is uploaded; a separate repository would need a full upload (350 GB filestore: days) |
| Plan setting | New `Backup failover: Off / Automatic`, default Off. Requires enabled replication with a replica that holds at least one verified copy | Opt-in per plan |
| Trigger | Two witnesses: the Agent reports an eligible pre-upload failure, **and** the server's own probe of the primary fails | A storage problem seen only by the Agent, or a repository error that is not an outage, does not move backups |
| Eligible Agent failures | Stage `repository-check` or `repository-target-check` with `target-check-transport-failed`, `repository-check-failed` or `repository-target-check-failed` | Authentication, access, non-empty target, initialization, database, source and upload failures never fail over |
| Failover record | A new backup row linked to the failed one (`failed_backup_id` in its failover record), written into the replica | The failed attempt stays truthful in history; the new backup has a fresh replay tag, so no snapshot can be written twice |
| Replica choice | First replica in configured order whose repository is bound and has a completed verified copy, and that the server can reach | Same priority as recovery |
| Credentials | The replica's credentials reach the Agent only inside the sealed field of a failover command | Normal runs keep "no replica credentials on the Agent" |
| After a failover backup | The server verifies the snapshot in the replica (tags, tree, SQL artifact SHA-256) and records a failover receipt | Same proof as a replica copy; makes the backup restorable from the replica before copy-back |
| Copy-back | A server tick probes the primary; once reachable and its repository config ID is the one recorded for the plan, it copies pending failover snapshots replica to primary, oldest first, with the stage 2 executor and verification | No Agent involvement; a replaced or re-initialized primary is refused |
| While the primary stays down | Every scheduled run tries the primary first, then fails over | Self-healing; costs about 35 s of detection per run |

## 4. Server changes

- Migration `0024_backup_failover.sql`: table `managed_backup_failovers` (one row per failover
  backup: failed run, replica binding, primary and replica repository config IDs, state, snapshot
  IDs). States: `queued` → `verify-pending` → `verifying` → `verified` → `copying` →
  `copied-back`, or `backup-failed` / `failed`. Triggers refuse deleting the plan or backup,
  changing the plan's storage or source, and starting a repository relocation while a failover is
  open.
- `BackupFailoverStore`: compare-and-set transitions guarded by an owner token. Verification
  inserts the failover receipt as a completed `managed_replication_jobs` row (source and
  destination snapshot are the same original). Copy-back moves the backup row, the receipt and the
  plan statistics to the primary snapshot ID in one transaction.
- `BackupFailoverService`: eligibility table, the two-witness decision (server probe with
  read-only `restic cat config`, 60 s), replica choice, verification, copy-back, and a 30 s
  reconciliation tick that also re-evaluates failed runs it has no decision for (24 h window).
- `RemoteBackupService`: `completeCommand` hands failures and cancellations to the decision and a
  successful failover run to verification only (no `markInitialized`, no replication enqueue).
  `queueFailoverBackup` creates the backup row, its command and the failover record in one
  transaction. `materializeCommand` writes a failover backup into the replica (path, Rclone
  options, sealed credentials, `initialize: false`) and refuses Agents without version 5 or,
  for S3, without S3 support.
- `ManagedReplicationService`: admission skips a failover backup until it is copied back (then
  other replicas copy it from the primary), replication and copy-back never run at the same time,
  `validatePlan` refuses removing or redirecting a replica that holds a pending copy-back, and the
  mirror projection carries the failover state.
- `VerifiedReplicaRecoveryService`: after copy-back the replica holds the original and the primary
  holds the copy; replica recovery accepts that pair only when the failover record names both IDs.

## 5. UI changes

- Plan form, Recovery & Failover: `Backup failover` setting with the requirements above.
- Backup row: `Failover → <replica>` badge and copy-back state (Pending, Copied back, Failed with
  Retry).

## 6. Security

- During a failover run the Agent host holds write access to the replica storage. For an SFTP
  primary with an S3 replica this is the HCP key, which covers the whole namespace (see the stage 1
  design, section 6.3). Hosts that already run S3-primary plans already hold it. A dedicated HCP
  user limited to replica prefixes reduces this and is recommended before enabling failover on
  other hosts.
- The Agent already knows the repository password, so it gains no new read access to replica
  contents.
- Failover never initializes, unlocks, prunes or deletes anything in the replica.

## 7. Limits

- An outage during `restic backup` is not detected; that run fails after Restic's retries and the
  next run fails over.
- Before copy-back, Browse and restore from the primary do not find the failover snapshot; use
  Manual Verified Replica Recovery (or Assisted Failover) from the replica.
- A failover backup is never itself failed over again, and a failed failover run is final.
- Failover upload speed is the Agent host's link to the replica (HCP from the ERP hosts:
  0.6 to 4.6 MiB/s measured).
- Replica retention and prune remain unavailable (unchanged).
- Agents older than 0.8.0 cannot fail over; their plans keep today's behaviour.

## 8. Tests

| Area | Coverage |
| --- | --- |
| Decision, verification, copy-back | `backend/__tests__/services/BackupFailover.test.ts` (real SQLite schema and stores): eligibility table, queue with backup, command and record in one transaction, primary still reachable, ineligible code, disabled plan, newer run, unverified or unreachable replica, verification receipt, waiting while the primary is down, copy-back with backup, receipt and statistics moved, refusal of a replaced primary and of a foreign snapshot, no chained failover, triggers |
| Command path | `backend/__tests__/services/RemoteBackupService.test.ts`: failover payload into an S3 replica with every secret sealed and `initialize: false`, refusal without version 5, failure and success routing |
| UI | `frontend/__tests__/managedReplication.test.ts`: setting validation, Backup failover select, failover badge text |
| Real Restic | `backend/__tests__/integration/replicaRecovery.lab.ts` (Docker, network none): Restic backup into the SFTP replica as the Agent writes it, verification with SQL artifact SHA-256, copy-back into the S3 primary (one copy, idempotent repeat, `restic check` on both), refusal of the replica original without the failover record, staged restore after copy-back with SHA-256 checks |
