# Stage 4: promote a verified replica to primary

Status: implemented on branch `claude/switch-primary`. Stage 4 of
[S3_AGENT_REPOSITORY_DESIGN.md](S3_AGENT_REPOSITORY_DESIGN.md) section 3. Builds on stage 2
([S3_PRIMARY_REPLICATION.md](S3_PRIMARY_REPLICATION.md)) and stage 3 ([BACKUP_FAILOVER.md](BACKUP_FAILOVER.md)).

## 1. Goal

Before stage 4 a Managed Agent plan kept its primary repository type for life. Move Repository
copies SFTP to SFTP only, and changing between SFTP and S3 meant a new plan, a full upload and a
split history. Stage 4 promotes a plan's verified replica to primary:

1. The server makes sure the replica holds every backup it can receive (catch-up).
2. In one transaction the replica becomes the primary and the previous primary becomes the
   replica (roles swap). Nothing is deleted.
3. The Agent writes the next backup into the new primary and uploads only changed data.

It works with any SFTP storage and any S3 or S3-compatible storage that the plan uses as a
replica, in both directions. To move to a storage that is not a replica yet, add it as a replica
first, wait for its copies, then promote it. SFTP to SFTP without a replica stays Move Repository.

## 2. Facts this design relies on (verified in code, main 460e0ef / Agent 614fddb)

| Fact | Where |
| --- | --- |
| A replica repository uses the primary's Restic password and chunker parameters | `ManagedReplicationExecutor` |
| The Agent keeps no repository identity per plan; each payload names its repository | `agent/src/backupFilesystem.ts` `parseBackupFilesystemPayload` |
| Agent backups into a replica repository already work (failover backups) | `BackupFailoverService`, `replicaRecovery.lab.ts` |
| Managed Agent plans never forget or prune, so the primary holds every snapshot | `RemoteBackupService.assertFailedHistoryRemovable`, `BackupServices` |
| Replication admits every completed backup, older ones too, through the 30 s rescan; an admission refusal (for example `artifact-binding-mismatch`) is recorded on the backup and not retried | `ManagedReplicationService.rescanCompleted`, `ManagedReplicationStore.completedBackupCandidates` |
| A Restic copy has a new snapshot ID whose `original` names the source snapshot (or the source's own original) | `restic copy`, `VerifiedReplicaRecoveryService` |
| The primary binding is `plans.storage_id/storage_path`, `remote_managed_repositories.storage_id/storage_path` and `backups.storage_id/storage_path` | `PlanRepositoryRelocationStore.rewrite` |
| The replica binding is the plan's `replication.storages` slot, `managed_replication_destinations` (fingerprint, `init_state`, `actual_repository_id`) and one `managed_replication_jobs` receipt per backup | `0018_managed_replication.sql` |

Consequence: **no Agent change is needed.** Promoting an S3 replica requires an Agent that reports
S3 and version 5 payloads (0.8.0 or later). Promoting an SFTP replica adds no requirement.

## 3. Decisions

| Topic | Decision | Reason |
| --- | --- | --- |
| What can be promoted | The only replica of a plan with replication enabled, whose destination is `ready` and holds at least one verified copy | The data is already there; no full upload |
| Validation at start | The plan is validated exactly as it will be after the switch, with the full managed plan validation (Agent online and capable, S3 path rules, ownership and overlap, the previous primary as a valid replica) | A promotion that cannot run afterwards never starts |
| Previous primary | Becomes the replica in the same replication slot. It is never deleted or modified | Two copies remain; switching back is promoting again |
| Catch-up | Every completed backup without a completed copy goes through the existing replication queue (one admission at a time); a failed copy or a refused admission is retried once | Same copy and proof as stage 2 |
| Plan during catch-up | Keeps running. It is paused only for the final step: copies of backups that finished meanwhile, verification and the switch | Hours of catch-up must not stop backups |
| Backups that cannot be copied | Listed in the promotion and stay in the previous primary. When the server can read them there, a receipt keeps them restorable through Verified Replica Recovery; when it cannot (the previous primary is down), their rows keep the previous location | Early backups taken before a database dump was configured are refused with `artifact-binding-mismatch`; a dead primary must not block the promotion |
| Snapshot IDs | In the switch transaction every copied backup takes the replica snapshot ID as its primary snapshot. Its receipt is inverted: source is the new primary copy, destination is the previous primary original, marked `destination_original` | Browse, restore, replication and failover keep working by ID |
| Replica recovery | Accepts a replica snapshot that is itself the original when its receipt is marked `destination_original` (generalizes stage 3 `originalInReplica`; copied-back failover receipts are marked by the migration) | The pair is inverted after a swap |
| Other replicas | Refused while the plan has more than one replica | A second replica's copies name the old primary's snapshot IDs as their original; plans use one replica today |
| Exclusivity | Never together with a relocation or an open failover (SQLite triggers in both directions); no failover is queued while a promotion runs; settings and removal are locked; Backup Now and Resume wait only during the final step | Each of them rewrites the same bindings |
| Verification before the switch | Read-only: the replica's repository config ID is the recorded one, and every snapshot the plan will point at exists with the receipt's tree, tags and `original` relation | Each copy was already verified with its SQL artifact when it was made |
| Switching back | Promote the other side again; backups written since are copied first | No separate revert path to maintain |

## 4. Server changes

- Migration `0025_primary_promotion.sql`:
  - table `managed_primary_promotions`: plan, repository, replication slot, previous and promoted
    location, both repository config IDs, state (`catching-up` → `switching` → `switched`, or
    `failed` / `cancelled`), counts, retried backups, left-behind backups;
  - column `destination_original` on `managed_replication_jobs`, set for existing copied-back
    failover receipts;
  - triggers: no plan or backup deletion, no binding or storage change, no relocation and no
    failover while a promotion is active; no new backup and no resume during the final step; no
    promotion while a relocation or a failover is open.
- `PrimaryPromotionStore`: compare-and-set transitions. The switch transaction rewrites the plan
  (primary and replication slot), the repository row, every copied backup (snapshot ID and
  storage), the plan statistics, the destination reservations (the promoted location leaves the
  replica ownership; the previous primary is reserved as `ready` with its repository config ID)
  and the receipts (inverted, or removed for a backup that only ever existed in the promoted
  repository, or added for a proven left-behind backup).
- `PrimaryPromotionService`: start, overview, cancel, a reconciliation tick (30 s) for catch-up,
  the final step and the switch; `verifyPromotion` and `repositoryReader` hold the read-only proof.
- `PlanService`, `BackupFailoverService`: the guards above. `VerifiedReplicaRecoveryService`:
  `destination_original` receipts. API: `/api/plan-promotions`.

## 5. UI changes

- Plan page, more actions: `Promote Replica` (managed Agent plans with replication). The dialog
  lists the replica with the reason when it cannot be promoted, explains each step before
  confirming, follows catch-up (`n of m backups in the replica`), the final step and the result,
  lists the backups that stay in the previous primary, and offers Cancel before the switch.

## 6. Security

- After an S3 replica is promoted, the Agent host receives S3 credentials on every run, as for an
  S3-primary plan from stage 1 (the shared HCP key covers the whole namespace; see the stage 1
  design, section 6.3).
- Promotion never initializes, unlocks, forgets, prunes or deletes anything in either repository.
  Verification opens both repositories read-only.

## 7. Limits

- Catch-up runs through the Pluton server and its links, like replication; a long history takes
  hours, and every admission still reads the backup's SQL artifact.
- One replica per plan; no same-type promotion (S3 to S3), since a replica is always the opposite
  type of its primary.
- The Agent must be online when the promotion starts.
- Backups the replica cannot receive remain only in the previous primary.

## 8. Tests

| Area | Coverage |
| --- | --- |
| Service and store | `backend/__tests__/services/PrimaryPromotion.test.ts` (real SQLite schema and stores): eligibility and refusals, validation of the plan as it will be (also with the real `RemoteBackupService` in both directions), exclusivity with failover, catch-up with one retry, the switch of every binding, inverted receipts, a proven left-behind backup, promoting back, the previous primary down, waiting for running copies, uncertain copies, identity mismatch and an unreachable replica, cancel, triggers |
| Guards | `PlanService.test.ts` (settings, removal, Backup Now, Resume), `BackupFailover.test.ts` (no failover during a promotion) |
| UI | `frontend/__tests__/primaryPromotion.test.ts`: progress, wording, confirmation steps, plan page action |
| Real Restic | `backend/__tests__/integration/replicaRecovery.lab.ts` (Docker, network none): verification on the real S3 primary and SFTP replica (copies, a copied-back original, a left-behind backup, a wrong repository refused, no write), an Agent-like backup into the promoted repository that uploads no file data, replication into the previous primary, `restic check` on both, and replica recovery of an old backup from the previous primary through a `destination_original` receipt (refused without it) with SHA-256 checks |
