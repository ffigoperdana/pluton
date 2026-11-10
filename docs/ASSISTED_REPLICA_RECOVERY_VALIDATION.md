# Assisted replica recovery delivery and validation

Date: 2026-11-10. Branch: `codex/assisted-replica-recovery`.
Base: local main `b4aa7488694ec1f63c69590095a13d0a4f6cc3d1` (PR #69).
No linked worktree was created. No production/HCP access, push, merge, deployment,
Agent upgrade, secret/configuration change or repository cleanup was performed.
Docker deployments below were disposable local acceptance fixtures only.

## Findings and delivered scope

The original recovery context/session was SFTP-only; a completed replica badge
could not select a verified S3 source. Existing durable replication records already
carry the source config/tree/binding hash and actual destination snapshot mapping.
The implementation reuses these records and existing bounded index, TAR, safe-link,
SQL SHA-256 and staging validators rather than adopting an arbitrary repository.

Stages A and B are implemented for file/directory/full-snapshot/recorded SQL-artifact
staging and an owner-authorized staged integrity recovery test. The new opt-in policy
preserves Primary Only for existing plans. Native database import, automatic
RecoveryTestService source switching, generic mirror browse/download and recovery
from deleted/detached/unowned/Legacy scopes are not implemented. Existing primary
paths remain in use for those workflows. Assisted progress/history lives in its own
owner-bound journal/panel; ordinary RestoreStore and backup history are not rewritten.

Approval is durable, owner/source/destination/operation/selection/target bound,
ten-minute and one-time. SQLite immediate transactions, a per-plan active unique
index, a global execution slot and idempotent active-intent admission prevent
replay/duplicates. Restart preserves pending approval but marks interrupted work
uncertain and never executes it again automatically. Job-owned temporary credentials,
indexes and staging have explicit private cleanup; historical stats/audit survive
staging discard. GET rediscovery never creates work, including uncertain or cleanup-
pending jobs. Browser close/navigation does not cancel admitted work.

A native negative test independently found that Restic can conceal Rclone TLS
failures behind internal retries until a deadline. A fixed bounded read-only Rclone
root-list probe now distinguishes TLS/auth failures before Restic metadata checks;
returned names are discarded and never count as identity/ownership proof. A later
metadata deadline after successful connection is not sufficient to authorize an
automatic fallback. No TLS, credential, identity, crypto or readiness check was disabled.

## Final verification

Windows: Node v24.16.0; Linux/production: pinned Node v24.22.1. pnpm 10.20.0,
existing lockfile and dependencies unchanged.

| Check | Result |
| --- | --- |
| Final isolated Linux `pnpm --filter @plutonhq/core-backend test --runInBand`, CI=true, 2 CPUs / 4 GiB | 229 suites passed; 4,785 tests passed; 7 existing skips; 368.538 s; normal exit |
| Final Windows focused recovery/replication/security suites (9 files) | 339 tests passed; 0 skips; 150.904 s |
| Earlier full Windows serial sweep before final transport-probe additions | 229 suites passed; 4,778 passed; 4 existing skips; 444.801 s |
| Full frontend `node --experimental-strip-types --test frontend/__tests__/*.test.ts` | 443 passed; 0 skipped; includes 11 actual UI/helper regressions for this feature |
| Backend lint; backend and frontend TypeScript checks | Passed |
| `pnpm build` (frontend/backend/Agent) | All 3 tasks passed; 42.699 s |
| Final `docker build -f Dockerfile.source -t pluton-assisted-recovery:local .` | Passed |
| Actual disposable SFTP → authenticated HTTPS S3 Restic copy/restore | Passed; copied destination ID differs from source; primary stopped only inside isolated fixture |
| Real assisted workflow | Healthy primary, offline detection, owner-isolated pending approval, coordinator restart, approval replay refusal, verified recovery and explicit staging cleanup passed |
| Native integrity/permissions negatives | Wrong Restic password and untrusted CA explicitly refused with the corresponding closed categories; replica bytes unchanged after reads/restores |
| Native resource profile | UID 1000, network none, 2 CPUs, 4 GiB cap, 128 PIDs + init; peak cgroup 605,962,240 bytes (about 578 MiB); PID limit events max=0 |
| Actual Linux Docker deployment acceptance | 19 passed, including host-bundle upgrade, same-digest reapply, failed-reapply rollback, image rollback, mount/SQLite/export metadata preservation; disposable resources removed |
| Compiled HTTPS/LAN session compatibility | Passed at UID 10001, including real login/logout, restore/recovery preparation and cross-origin rejection |
| Read-only production artifact verification | Passed at UID/GID 10001; Node v24.22.1; 1,878 entries checked; no fixtures/host operators/local credentials shipped |
| API inventory, deployment/export Compose/release Node contracts | 25 passed; 203 contracts inventoried |
| Linux POSIX deployment/CA/keyring/bundle contracts | 29 + 6 + 7 + 4 passed (46 total) |
| Pinned MySQL worker package/import/readiness boundaries | 19 passed; no worker or Agent changes |
| `git diff --check` | Passed |

The native fixture is a small synthetic source containing a 4 MiB random file,
ordinary files/directories, a safe symlink and a recorded SQL artifact. It is real
Restic/Rclone/SigV4/TLS and byte/hash recovery evidence, not a large-snapshot
throughput benchmark or proof of actual HCP compatibility. No real HCP probe ran.

New backend coverage includes missing/incomplete receipts, differing destination
IDs/original mapping, tree/config/owner mismatch, revoked sources, unsafe paths,
wrong credentials, TLS/deadline classification, metadata deadlines, index-signal
cancellation, same-size corruption, durable on-disk restart, owner isolation,
idempotency collisions, approval expiry/replay, cancellation, cleanup retry,
invalid first/valid second replica, and refusal to switch after restore begins.
The real fixture verifies full, directory, single-file and SQL-artifact recovery.
Frontend tests cover reload, old primary-ready state, StrictMode/parent rerenders,
GET-only uncertain/cleanup rediscovery, stale sessions, selection mismatch,
explicit approval/cancel, API/WAF failures and secure UUIDs on supported LAN HTTP.

## Baseline and environment limitations

Targeted frontend ESLint cannot load the unchanged existing config: its
`tseslint.config()` extends array contains the string `eslint-config-prettier`
instead of a configuration object. No rules/config were disabled or bypassed.
Frontend type checks, complete interaction tests and production builds pass.

One exploratory Linux run with overlapping validation hit the unchanged
`closeLoggers` afterAll hook's five-second deadline. Main's PlanService mounted
without a checkout/worktree change passed all 80 focused tests. Subsequent isolated
full Linux runs passed (the final run is reported above). The exact reason for that
exploratory hook delay is unproven; no logger behavior, test assertion or timeout
was modified to obtain a pass. Windows attempts to run POSIX Python tests fail on
missing `os.geteuid`/permission semantics; the same contracts passed on Linux.

The API inventory also catches main's already existing snapshot-item download
route alongside the five new assisted routes; no unrelated runtime endpoint was
added. The new routes remain session-only and outside the legacy key/MCP write
allowlists. Agent payload construction remains the explicit primary-repository
projection, without replication/recovery policy or S3 credentials.

Hosted GitHub Actions has not run on this unpublished local commit. The Container
Image workflow now includes the real native replica fixture with a six-minute
step limit. The operator must publish and verify hosted CI; no CI PASS is claimed.

## Operation, cleanup and rollback

Follow [the full operator runbook](ASSISTED_REPLICA_RECOVERY.md). Enable only on a
controlled plan, first perform manual read-only replica checks without stopping
production SFTP, then explicitly approve private staging and verify results.
Inject outages only in disposable infrastructure. Inspect CPU/RAM/free capacity,
network and retained staging; full TAR readback can read the entire snapshot even
for a granular selection. Unreadable/unsafe entries fail closed. Native SQL import
and any live target write require their existing separate authorization and are
not provided by this replica feature.

Use one controller per application data directory. Supported restart must stop the
old server/container and native children; interrupted work is not resumed. Cancel
or discard jobs explicitly, verify cleanupPending=false, and reset the policy to
Primary Only before reverting to the previous approved image. Retain additive
migration 0022, journal/audit and existing export metadata; do not run a down
migration or restore an old app DB over newer backup history. No replica object
removal, unlock, retention or namespace-setting change is part of rollback.

## Exact changed files

- `.github/workflows/container.yml`
- `backend/__tests__/fixtures/replica-recovery/Dockerfile`
- `backend/__tests__/fixtures/replicaRecovery.fixture.ts`
- `backend/__tests__/integration/replicaRecovery.lab.ts`
- `backend/__tests__/routes/assistedRecovery.test.ts`
- `backend/__tests__/services/AssistedRecoveryService.test.ts`
- `backend/__tests__/services/RemoteRepositoryRecoveryService.test.ts`
- `backend/__tests__/services/VerifiedReplicaRecoveryService.test.ts`
- `backend/__tests__/utils/AssistedRecoveryPolicy.test.ts`
- `backend/__tests__/utils/restic/ManagedS3RecoverySession.test.ts`
- `backend/__tests__/utils/restic/ManagedSftpRepositorySession.test.ts`
- `backend/drizzle/0022_assisted_recovery.sql`
- `backend/drizzle/meta/_journal.json`
- `backend/src/controllers/AssistedRecoveryController.ts`
- `backend/src/createApp.ts`
- `backend/src/routes/assistedRecovery.ts`
- `backend/src/services/AssistedRecoveryService.ts`
- `backend/src/services/ManagedReplicationService.ts`
- `backend/src/services/PlanService.ts`
- `backend/src/services/RemoteRepositoryRecoveryService.ts`
- `backend/src/services/VerifiedReplicaRecoveryService.ts`
- `backend/src/stores/AssistedRecoveryStore.ts`
- `backend/src/types/plans.ts`
- `backend/src/utils/managedReplicationPolicy.ts`
- `backend/src/utils/replicaSourceBinding.ts`
- `backend/src/utils/restic/ManagedS3RecoverySession.ts`
- `backend/src/utils/restic/ManagedSftpRepositorySession.ts`
- `docs/API_COVERAGE_MATRIX.md`
- `docs/API_SECURITY_AUDIT.md`
- `docs/ARCHITECTURE.md`
- `docs/ASSISTED_REPLICA_RECOVERY.md`
- `docs/ASSISTED_REPLICA_RECOVERY_VALIDATION.md`
- `docs/api-inventory.json`
- `frontend/__tests__/assistedRecovery.test.ts`
- `frontend/__tests__/managedReplication.test.ts`
- `frontend/src/@types/plans.ts`
- `frontend/src/components/Plan/Backups/Backups.tsx`
- `frontend/src/components/Plan/Mirrors/MirrorDetails.tsx`
- `frontend/src/components/Plan/PlanSettings/PlanReplicationSettings.tsx`
- `frontend/src/components/Plan/SnapshotViewer/ManagedSnapshotViewer.tsx`
- `frontend/src/components/Plan/SnapshotViewer/SnapshotViewer.tsx`
- `frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.tsx`
- `frontend/src/components/Restore/RestoreWizard/RestoreWizard.tsx`
- `frontend/src/docs/articles/replication/managed-agent.md`
- `frontend/src/docs/articles/replication/retention-restore.md`
- `frontend/src/utils/assistedRecovery.ts`
- `frontend/src/utils/replication.ts`
- `scripts/validate-replica-recovery.ps1`
- `scripts/validate-replica-recovery.py`
