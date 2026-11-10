# Assisted managed replica recovery

## Scope and default

This independently implemented community feature reads an existing, managed S3
replica of an encrypted remote SFTP Restic repository. Existing plans remain
**Primary Only**. Enable **Assisted Failover** explicitly under Edit → Replication
→ Recovery & Failover, with one or two compatible replicas. No schedule, source
Agent, replication destination, retention or Reliable Download setting changes.

Supported and exercised: isolated full-snapshot, directory, single-file and
recorded SQL-artifact staging; Restic decryption, per-file SHA-256 readback,
structure and safe-link verification; an owner-authorized staged recovery test.
**Native database import from replicas and automatic RecoveryTestService jobs
from replicas are not implemented.** They retain their existing primary-only
paths and separate target approvals. A staged SQL artifact is not a restored or
application-tested database. Comparison, browser downloads and Reliable Download
retain their existing source paths. There is no automatic production-target write.

## Verified architecture

The previous path was RemoteRepositoryRecoveryService.context → protected SFTP
session → exact snapshot/index → staging restore. A completed replica badge did
not make that path capable of reading S3. ManagedReplicationStore already records
source config/tree/binding hashes and the actual destination snapshot mapping.
Restic copy can change a snapshot ID; no short-ID or equal-ID assumption is used.

Stage A adds ManagedS3RecoverySession, a read/staging-only specialization of the
fixed managed session. It exposes config identity, snapshots, streaming metadata,
diff, TAR/raw read and fixed restore. All reads and restores use no-lock/no-cache;
there is no init, copy, backup, tag, unlock, repair, prune, forget or repository
DELETE interface. Recovery never uses a general command builder. S3 uses explicit
protected credentials, HTTPS, path-style addressing and the operator storage CA.
Unsupported remote options fail closed rather than enabling alternate endpoints,
external credential files, signing logs, historical versions or insecure TLS.

VerifiedReplicaRecoveryService checks current managed source/plan/Agent scope,
revocation, completed successful encrypted backup, configured replica order,
unique verified receipt, ready owned destination, exact canonical bucket/prefix,
repository config ID, full destination ID, tree, original source-ID mapping and
unique owner tags. SQL metadata comes from the immutable completion receipt.
It never contacts primary SFTP to resolve replica credentials. No mirror flag is
accepted as proof. Credential/config ciphertext and CA contents are included in a
server HMAC binding. Inputs are rechecked at every repository boundary; unchanged
inputs reuse decrypted credentials only within that operation, avoiding redundant
password KDF work. No credential, endpoint, private repository path or proof is
returned through the API.

RemoteRepositoryRecoveryService.replicaStage reuses bounded selection, metadata
index, strict TAR proof, safe links, exclusive staging and restored-file validation.
It authenticates a full TAR readback before restoring, then checks each selected
file SHA-256 and each selected recorded SQL SHA-256. A granular restore therefore
can read the entire snapshot; it is not a fast single-object range download.

Stage B adds a separate durable SQLite CAS coordinator and narrow authenticated
API. Primary availability uses a fixed, bounded Rclone root-list transport probe
(names are discarded), then exact read-only snapshot verification. Replica
validation probes transport once per operation before checking config/snapshot.
This exposes TLS/auth failures that Restic can otherwise hide until its retries
expire. A later metadata timeout after transport connected is not treated as
proof of a primary connection failure. Only explicit
network-unavailable or request timeout categories offer fallback. Authentication,
TLS/SSH host-key failure, wrong password, missing config, identity mismatch,
metadata errors and unknown failures refuse fallback. A normal informational SSH
warning does not count as a failed host-key verification. Authentication/TLS
categories outrank availability on deadline races. Classification retains at most
16 KiB privately; truncated diagnostics cannot authorize fallback. Raw process
output never crosses the boundary.

## Approval, persistence and cleanup

Migration 0022 adds assisted_recovery_jobs, with no changes to backup history or
existing repository data. Optional recoveryPolicy is stored in existing plan JSON;
missing means primary-only. Approval binds the signed session owner, plan, source
snapshot, replica, destination snapshot/config/tree, selection, operation, server
allocated private target/job ID and ten-minute expiry. The durable state changes
before any staging side effect. A consumed, expired, cancelled or changed approval
cannot be replayed. Concurrent tabs requesting the same active intent share a job;
changed intent/idempotency collisions and other owners do not acquire it. One
staged execution is admitted globally; two availability checks and two fixed
repository sessions are the maximum. No timed lease or automatic takeover is used.

GET-only rediscovery restores already admitted state after navigation, refresh and
re-login. There is no POST to find an old job. The UI uses no persistent credentials,
proofs or job-state cache; per-mount/session query scopes, abort fencing and session
change notifications prevent stale owner results. Closing is not approval or
cancellation. Explicit cancellation aborts active native processes before cleaning
the exact owned local workspaces. It never issues a repository cleanup command.

An interrupted running/checking job becomes uncertain on restart and never
executes automatically. Pending approval survives restart, but still expires and
must pass fresh identity/config checks when approved. Staging, credential files
and indexes belong to the journal job ID. Interrupted cleanup remains pending and
blocks execution until an explicit cancellation/cleanup retry succeeds. Unknown
local directories are not adopted. Completed staging is retained for operator
inspection until explicitly discarded; verification/audit metadata remains after
discard. The job expiry is an approval deadline, not permission to erase results.

API (all require the authenticated browser session; no API-key bypass):

- GET /api/assisted-recovery?planId=...&backupId=...: owner-scoped history, max 20.
- GET /api/assisted-recovery/:id: owner-scoped safe state.
- POST /api/assisted-recovery: explicit intent; strict planId, backupId, UUID
  requestKey, mode prefer-primary/manual-replica and exact includes/excludes only.
- POST /api/assisted-recovery/:id/approve: selected replicationId only.
- POST /api/assisted-recovery/:id/cancel: explicit cancellation/local cleanup only.

No endpoint accepts an owner, credential, endpoint, password, repository path,
custom restore target, overwrite/delete flag, snapshot substitution or native SQL
import override. Responses are private/no-store. Global web-origin/CSRF and session
middleware remain in effect. Audit records are bounded to 50 safe events per job.

## Operator UAT

1. Publish and review hosted CI separately; local tests do not establish hosted CI
   or actual HCP compatibility. Deploy only through the existing approved release
   procedure after the operator authorizes it. Back up application DB/config using
   the normal private procedure; retain the previous immutable image digest.
2. Use a disposable plan/source and dedicated replica prefix for outage injection.
   Keep real production SFTP and scheduled backups running throughout UAT. Check
   existing replication receipt, source/destination mapping and storage CA first.
   Do not repurpose the Reliable Download temporary export namespace.
3. Confirm an unchanged plan still shows Primary Only. Its normal restore must use
   primary. With compatible replication explicitly enable Assisted Failover.
4. With primary healthy, click Restore. After the read-only primary check the normal
   wizard opens without a failover confirmation. Existing target safeguards remain.
5. For a real approved replica without an outage, open the selected backup's replica
   details and choose Check replica recovery. This only reads authorized metadata.
   Verify exact requested snapshot, candidate order, destination snapshot and
   preflight status. Replication completed, replica verified, recovery preflight
   passed and staged recovery tested are separate evidence.
6. Leave the path empty for the full snapshot, or specify an exact snapshot file or
   directory path before checking. For SQL use the recorded /pluton/database/\*.sql
   path. Review the fixed isolated-staging target and operation. Click Continue with
   S3 Replica only when ready to authorize that specific request.
7. Browser file/directory restore actions also bind the exact selected path to the
   source check and approval. An existing request for another selection must be
   cancelled/rechecked; it cannot authorize the new selection.
   Refresh/navigate/re-login while awaiting approval. Reopen Restore or replica
   details for the same backup. Its server job must reappear without a new restore.
   Close it without approval: no restore starts. Test expiry/cancel/replay only on
   disposable requests. Two tabs must show the same admitted intent and one execution.
8. Only on the disposable fixture, stop its SFTP server. Restore should classify the
   network failure, check replica 1 then replica 2, and require explicit selection/
   approval. An invalid receipt, foreign owner, auth/TLS failure, wrong repository,
   missing snapshot or unknown failure must refuse recovery rather than relax checks.
9. Observe preparation, staged restore and integrity verification. No percentage or
   byte total establishes completion. Closing does not cancel work. Completion
   means verified staging only. Verify file/directory hashes and SQL receipt hash
   privately on the operator-controlled host; do not paste contents or secrets into
   logs or public issues. Native SQL import is a separate, unsupported replica flow.
10. Explicitly Cancel Recovery to stop active work, or Discard staged result after
    inspection. Check cleanupPending=false. If cleanup fails, retain the job and
    inspect local permissions/free space privately, then retry its cancellation.
    Do not manually delete repository objects, unlock repositories or adopt unknown
    workspaces. Restart during a disposable execution must show uncertain and require
    explicit cleanup plus a new request, without replay or a mid-write source switch.

On the 2 vCPU / 4 GiB host, start with a small fixture. Monitor CPU, RSS, available
staging/cache space, PID count and network. Indexes keep the existing 500,000-entry,
256 MiB bounds. Granular selection is limited to 1,024 regular files/8,192 selected
entries and 1,024 include selectors; full snapshots remain streamed/indexed. Logical
staging is capped at 1 TiB and requires available selected bytes plus 512 MiB before
writing. Free capacity must also cover existing retained results. S3 native child
resources use GOMAXPROCS=2, GOMEMLIMIT=256MiB, two transfers and 4 MiB buffers; they
are not a total VM quota. Inspect and discard retained staging explicitly to reclaim
space. Full readback increases network IO; do not run concurrent operator UAT or
infer provider throughput from snapshot size alone.

## Validation and reproduction

Use pinned pnpm 10.20.0 and the existing lockfile. Focused backend files are
AssistedRecoveryService, VerifiedReplicaRecoveryService, ManagedS3RecoverySession,
ManagedSftpRepositorySession and routes/assistedRecovery. Frontend actual React
regressions are frontend/**tests**/assistedRecovery.test.ts.

scripts/validate-replica-recovery.ps1 uses only a local reviewed fixture image,
network-none Docker, loopback SFTP and SigV4 HTTPS S3 served by pinned existing
Rclone/Restic binaries. It generates disposable TLS material outside Git, verifies
CA/hostname trust and constrains execution to two CPUs, 4 GiB and 128 PIDs with init.
It actually copies an encrypted Restic snapshot, exercises differing snapshot IDs,
stops only the disposable primary, restores full/directory/file/SQL with safe links,
checks unchanged replica bytes, approval/restart/replay/cancellation and untrusted
CA refusal. No simulated API response is used as proof of native restore ability.
This is protocol-compatible S3 fixture evidence; it is not an actual HCP probe.
Build the reproducible local test image with:

```sh
docker build -f Dockerfile.source -t pluton-recovery-ci:local .
docker build --target build -f Dockerfile.source -t pluton-replica-build:local .
docker build -f backend/__tests__/fixtures/replica-recovery/Dockerfile -t pluton-replica-recovery:local .
python3 scripts/validate-replica-recovery.py pluton-replica-recovery:local
```

The same portable driver runs through the PowerShell convenience wrapper on
Windows (Git OpenSSL is its default). Container Image CI adds this separate native
test gate with a six-minute step bound. No production image/test dependencies are
changed by the fixture image. No fixture server is
shipped or enabled in production.

Run the full backend/frontend tests, backend lint/types, frontend types/build,
Docker deployment acceptance and the real fixture before publishing. Report the
existing frontend ESLint configuration failure separately if it prevents targeted
lint; do not disable a rule or gate. See the validation report for actual results.

## Rollback

Cancel/finish active assisted jobs and verify local cleanup first. Change opted-in
plans back to Primary Only explicitly; do not touch replica prefixes or backups.
Reapply the previous approved immutable image using the existing rollback runbook.
Keep migration 0022/table and job metadata/results; older code does not need to
remove this additive table. Do not run a down migration or restore an old application
DB over newer backup history. Restart reconciliation never replays a destructive
operation. Pending approvals require the new version to inspect/cancel; do not
assume an older image will handle them. Existing backup, replication, download,
comparison and primary recovery paths retain their original configuration.
