# Automatic Failover recovery policy

Automatic Failover is a third, opt-in recovery source policy for managed remote filesystem plans
with verified S3 replicas. After an operator explicitly starts a recovery, Pluton prefers the primary
SFTP repository. If the primary is unreachable for an eligible transport reason, Pluton evaluates the
configured replicas in priority order and continues automatically with the first one that passes
every identity and integrity preflight, restoring only into isolated staging with mandatory integrity
verification. It selects a recovery source; it never selects a backup destination, never writes to a
production target and never imports a database.

## 1. Existing architecture findings (reused, not replaced)

| Component | What it already guarantees | Reuse |
| --- | --- | --- |
| `AssistedRecoveryService` | Job state machine `checking` → `primary-ready` / `awaiting-approval` → `running` → `completed` / `failed` / `cancelled`; restart turns `checking` and `running` into `uncertain` and never replays | Same service and job; automatic selection is one new transition |
| `AssistedRecoveryStore` (migration 0022) | Durable SQLite CAS: idempotent request key, one active job per plan, at most two checks/runs, one execution globally, approval bound to owner, intent and a ten-minute expiry | Same table and rules; new `autoApprove` and `advanceAutomatic` transitions use the same CAS |
| `RemoteRepositoryRecoveryService.primaryAvailability` | Bounded Rclone transport probe plus exact snapshot verification; only `network-unavailable` and `timeout` count as an outage | Unchanged; same eligible failure classes |
| `VerifiedReplicaRecoveryService` | Preflight checks receipt, source/destination snapshot mapping, repository config ID, tree, owner tags, canonical bucket/prefix and a fresh transport probe; `withReplica` revalidates the binding | Unchanged; every automatic candidate passes the same preflight |
| `replicaStage` and `RecoveryWorkspace` | Full TAR readback proof, per-file SHA-256, Restic restore into an exclusive per-job workspace, owned-workspace cleanup | Unchanged; a failed automatic attempt removes the workspace before any other source |
| `AssistedRecovery` panel | Restore Wizard, snapshot file restore and Mirror Details entry points, polling, rediscovery, cancellation | Same panel; policy-aware copy, explicit start, progression and decision summary |

## 2. Exact behavior

Policies (Edit Plan → Source & Destination → Recovery & Failover): `Primary Only (default)`,
`Assisted Failover`, `Automatic Failover`. Both failover policies need a managed remote filesystem
backup with enabled S3 replicas; the server validates this on save. Existing plans keep their stored
policy; a missing policy still means Primary Only.

Automatic Failover recovery, started explicitly by the operator:

1. Restore Wizard: the panel shows **Start recovery** and does nothing until it is clicked (opening
   the dialog is not consent to a replica restore). Snapshot file/directory restore starts from its
   existing explicit **Restore to staging** action.
2. Primary check (read-only). Healthy and holding the exact snapshot → `primary-ready`; the normal
   restore wizard continues as before. No replica is contacted.
3. Primary failure classified `network-unavailable` or `timeout` → each configured replica, in order,
   runs the full preflight (3-minute deadline each). Failures are recorded per candidate.
4. The first passing replica is selected by an atomic `autoApprove` (only from `checking`, only while
   the plan is still Automatic, only before the request's ten-minute expiry, only when no other
   recovery holds the execution slot). Audit: `automatic-source-selected` with the primary reason.
5. The existing staged recovery runs: binding revalidation, TAR proof, Restic restore, per-file
   SHA-256, final verification. `completed` only after verified staging and replica session cleanup.
6. If the selected replica fails during staging with `network-unavailable` or `timeout`, and its
   partial staging and session were removed successfully, `advanceAutomatic` selects the next
   untried verified replica (at most two attempts in total) and the recovery restarts from an empty
   workspace. Audit: `automatic-failover-next-replica` with the failure code.

| Situation | Result |
| --- | --- |
| Primary healthy | `primary-ready`, normal restore, no replica access |
| Primary unreachable, replica 1 verified | Automatic recovery from replica 1 |
| Replica 1 rejected (receipt, mapping, identity, access) | Replica 2 evaluated and used if it passes |
| No replica passes | `failed`, `no-eligible-replica`, nothing restored |
| Primary authentication, TLS, wrong password, repository, invalid output, unknown error | `failed`, no replica evaluated |
| Primary no longer holds the requested snapshot | `failed`, no fallback |
| Replica integrity, identity or authentication failure during staging | `failed`, no source switch, no success |
| Transport failure during staging, cleanup succeeded, untried verified replica exists | Next replica from an empty workspace |
| Transport failure during staging, cleanup failed | `failed`, `cleanupPending`, no source switch |
| Another recovery running, or request expired before selection | `failed`, `automatic-failover-blocked`, nothing restored |
| Plan changed from Automatic to Assisted during the check | `awaiting-approval` (operator approval required) |
| Manual replica check from Mirror Details | Unchanged: always requires operator approval |
| Restart during check or recovery | `uncertain`, never resumed or switched; explicit cleanup required |

## 3. Safeguards

- Explicit operator start; the automatic authorization is consumed once, atomically, and cannot be
  replayed as an operator approval.
- Same eligible outage classes as Assisted Failover; security, identity and unknown failures never
  trigger a switch.
- Every candidate passes the existing preflight; `replication completed` alone is never accepted.
- Source switches are bounded by the verified candidates (two at most), happen only after a
  transport failure with a verified clean workspace, and never after integrity or identity failures.
- Staging only: no production target, overwrite, delete, database import or cutover path exists.
- TLS verification, credential isolation, the gzip fix, `--no-lock`/`--no-cache` reads and the
  Restic retry diagnostics are unchanged.
- No new endpoint and no new permission. Responses add optional, closed `policy` and
  `sourceSelection` fields.

## 4. Data, migrations and configuration

- Database migration: none. The policy lives in the existing plan settings JSON; the job payload JSON
  gains optional `policy` and `selection` fields. Older rows remain readable.
- `.env` or Docker Compose changes: none required.
- Agent update or re-enrollment: none. Deploy order: server only.

## 5. Audit and observability

Job audit (authenticated job GET, panel "Safe audit history"): `recovery-requested`,
`primary-unavailable` (with the classified code), `replica-eligibility-checked` per candidate,
`automatic-source-selected` (reason), `recovery-source-approved`, `automatic-failover-next-replica`
(failure code), `staged-recovery-verified` or `staged-recovery-failed`, `operator-cancelled`,
`restart-reconciliation`. `sourceSelection.attempts` records every selected replica, its position,
outcome, failure code and time. Candidates keep their rejection codes and bounded diagnostics.

Application log (`restore` module, existing logger): `assisted_recovery_automatic_source_selected`,
`assisted_recovery_automatic_failover_next_replica` and `assisted_recovery_automatic_failover_blocked`
with job ID, plan, backup, replica position and code only. Native archive failures keep
`managed_native_archive` with `backendRetries`. No credentials, URLs, paths or provider text.

The panel shows a server-derived progression (checking primary, primary available or unavailable,
failover initiated, replica verified or rejected, recovering from replica N, verifying restored
files, integrity verified or recovery failed), a spinner and elapsed time while active, a policy row,
and a decision line such as "Recovery source: S3 Replica 2, chosen automatically after the primary was
network unavailable · S3 Replica 1 failed: timeout." No percentage is shown.

## 6. Automated tests

| Prompt scenario | Coverage |
| --- | --- |
| 1 Primary healthy | Service test; real lab (healthy primary with Automatic policy) |
| 2 Primary unavailable → replica 1 | Service test; real lab (killed SFTP, HTTPS S3 replica, 4,366 files and SQL artifact verified by hash) |
| 3 Replica 1 unavailable → replica 2 | Service tests (preflight rejection; transport failure during staging with workspace cleanup) |
| 4 All sources unavailable | Service tests (incomplete receipt, identity mismatch, unreachable replicas) |
| 5 Receipt incomplete | Service test |
| 6 Snapshot identity mismatch | Service tests (preflight mapping; staging binding change stops without switching) |
| 7 Invalid credentials or TLS | Service tests (primary `authentication-denied`, `tls-invalid`, `wrong-password`, `repository-unavailable`); existing lab (untrusted CA, wrong password) |
| 8 Missing requested snapshot | Service test |
| 9 Replica integrity failure | Service test (no switch, no success, workspace removed) |
| 10 Interrupted midway | Service test (restart → `uncertain`, old instance cannot switch or complete) |
| 11 Duplicate requests | Service test (same intent across tabs, one execution) |
| 12 Cancellation | Service test (aborts, cleans, no switch) |
| 13 Assisted unchanged | All existing Assisted tests pass unchanged |
| 14 Primary Only unchanged | Existing policy tests pass |
| 15 Automatic from verified S3 | Real lab |
| 16 No production writes | Service tests assert only the job workspace is written; lab asserts the replica is unchanged and staging is removed |

Streaming behavior (stall, backpressure, timeouts, cancellation, gzip Range responses, retry loops)
is covered by the existing lab fixture with scaled timers. Also tested: cleanup failure blocks a
switch, policy change during the check, busy execution slot, expired request, manual replica checks.

Results:

| Check | Result |
| --- | --- |
| Assisted recovery service suite | 63/63 passed (22 new Automatic Failover tests) |
| Policy validation suite | 19/19 passed |
| Full backend suite (`--runInBand`, Windows, Node 24.16.0) | 230/230 suites; 4,866 passed, 4 skipped by default |
| Frontend tests (all) | 478/478 passed |
| Backend type check, backend lint, frontend `tsc -b` | passed |
| `pnpm build` | 3/3 tasks successful |
| Replica recovery lab (Docker, network none, real Restic 0.19.1 and Rclone 1.75.1) | all scenarios passed, including both Automatic Failover scenarios |

The existing policy test that asserted `automatic` was rejected was updated for the new contract;
unknown values (`auto`, `unsafe`, `Automatic`, `true`, `null`) are still rejected and both failover
policies share the scope and replica requirements.

## 7. Limitations

- The real lab has one replica; failover to a second replica is covered by service tests with
  controlled failures, not by a two-replica native lab.
- The lab snapshot is 4,366 files (4.7 MB) plus an SQL artifact. Production-scale snapshots keep the
  existing timeouts and capacity limits.
- `repository-unavailable` (Restic reports no repository) is not treated as an outage, as in
  Assisted Failover, so a missing primary repository does not fail over.
- A staged SQL artifact is not an imported or application-tested database.
- Hosted CI and production UAT are pending.

## 8. Production UAT checklist

Do not stop, reconfigure or block the production SFTP server or touch production HCP objects.

1. Deployment: confirm the image revision label matches the merge commit before `install.sh`, then
   `status.sh` and the health endpoint.
2. Policy persistence: on the plan, choose Automatic Failover, save, reload the page and restart the
   container (`status.sh` after redeploy is enough); the setting must remain.
3. Primary-first (real plan, healthy primary): Restore → **Start recovery**. Expect a quick primary
   check and the normal restore wizard; close it without restoring. The job audit must show no
   replica checks.
4. Automatic selection, using only disposable resources: a test plan whose primary SFTP storage is a
   disposable test server or account you control, replicated to a dedicated HCP prefix. Run one
   backup and confirm the replica receipt is verified. Make only that disposable SFTP unreachable
   (stop the test server or remove its test firewall rule). Restore → **Start recovery**. Expect
   "Automatic failover succeeded", the progression, the decision line, files and bytes verified,
   and audit events `primary-unavailable`, `automatic-source-selected`, `recovery-source-approved`,
   `staged-recovery-verified`. If no disposable SFTP is available, rely on the lab evidence for this
   path and keep step 3.
5. Eligibility: in the disposable setup, a replica whose preflight fails must be listed as rejected
   with its code; with no passing replica the job must end `no-eligible-replica`.
6. Logs: `/data/logs/app.log` inside the container shows `assisted_recovery_automatic_source_selected`
   for the job ID, with no credentials or URLs.
7. Cleanup: **Discard staged result**; `cleanupPending` must become false. Restore the disposable SFTP.
8. Return the real plan to the policy you want to operate with.

## 9. Rollback

1. Set every plan using Automatic Failover back to Assisted Failover or Primary Only first. Older
   images do not know `automatic`; they would treat such a plan as Primary Only for assisted recovery
   and reject saving it unchanged.
2. Finish or cancel active recovery jobs and confirm cleanup is clear.
3. Redeploy the previous image digest. No schema or data change needs reverting; extra job JSON
   fields are ignored by older images.

## 10. `.env` and Docker Compose

Not required. No new variables, mounts, ports or services.

## Changed files

| Area | Files |
| --- | --- |
| Backend | `backend/src/services/AssistedRecoveryService.ts`, `backend/src/stores/AssistedRecoveryStore.ts`, `backend/src/utils/managedReplicationPolicy.ts`, `backend/src/services/ManagedReplicationService.ts`, `backend/src/types/plans.ts` |
| Frontend | `frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.tsx`, `frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.module.scss`, `frontend/src/utils/assistedRecovery.ts`, `frontend/src/components/Restore/RestoreWizard/RestoreWizard.tsx`, `frontend/src/components/Plan/Backups/Backups.tsx`, `frontend/src/components/Plan/SnapshotViewer/SnapshotViewer.tsx`, `frontend/src/components/Plan/SnapshotViewer/ManagedSnapshotViewer.tsx`, `frontend/src/components/Plan/Mirrors/MirrorDetails.tsx`, `frontend/src/components/Plan/PlanSettings/PlanReplicationSettings.tsx`, `frontend/src/utils/replication.ts`, `frontend/src/@types/plans.ts` |
| Tests | `backend/__tests__/services/AssistedRecoveryService.test.ts`, `backend/__tests__/utils/AssistedRecoveryPolicy.test.ts`, `backend/__tests__/integration/replicaRecovery.lab.ts`, `frontend/__tests__/assistedRecovery.test.ts`, `frontend/__tests__/managedReplication.test.ts` |
| Reports | `docs/AUTOMATIC_FAILOVER.md` (new), `docs/ASSISTED_REPLICA_RECOVERY.md` |
