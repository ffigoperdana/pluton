# HCP Range gzip fix

Assisted Replica Recovery from an HCP replica stopped after roughly two MiB of TAR output and was
cut off by the ten-minute inactivity watchdog (`archive-output-idle`). The cause is proven: HCP
answered one Range read with a gzip-encoded body because Rclone asked for gzip, Rclone passed the
compressed bytes on as the requested range, and Restic retried the load until the watchdog stopped
it. Pluton now never asks for transfer compression on the Rclone S3 sessions it builds for managed
S3/HCP storage.

## Root cause (proven in production, read-only)

Evidence and the diagnostic tools are in [REPLICA_READBACK_PROBE.md](REPLICA_READBACK_PROBE.md).

- Every replica object is intact: all 29 objects matched their SHA-256 names, in full and by Range.
- During a real stall, Restic made 12 attempts with exponential backoff capped near one minute. HCP
  answered every attempt over healthy connections; DNS had no failures.
- Through the same pinned Rclone 1.75.1 `serve restic` path Restic uses, one range of the 2.6 MB data
  pack (`bytes=2605056-2619015`) failed 3 of 3 times with gzip requested. HCP replied `206` with
  `Content-Encoding: gzip` and `Content-Length: 13983`. The same range passed 3 of 3 times with
  `use_accept_encoding_gzip = false`.
- Rclone 1.75.1 sends `Accept-Encoding: gzip` on downloads for provider `Other` and does not decode
  the body (`--s3-decompress` is off)
  ([s3 backend](https://github.com/rclone/rclone/blob/v1.75.1/backend/s3/s3.go)). Restic 0.19.1
  retries a load with backoff when the transfer is wrong or short
  ([REST backend](https://github.com/restic/restic/blob/v0.19.1/internal/backend/rest/rest.go)).

Not determined: why HCP compresses this range and not the others. The fix does not depend on it.

## Change

`use_accept_encoding_gzip = false` only changes the `Accept-Encoding` header Rclone sends when it
opens an object for download (`Object.Open` in the Rclone S3 backend). Restic data is already
compressed and encrypted, so transfer compression gains nothing; HCP's gzip body was 23 bytes larger
than the range it encoded.

| Path | Change |
| --- | --- |
| `storageRcloneOptions` (all managed S3/HCP Rclone options) | Always returns `use_accept_encoding_gzip = false`; a stored setting cannot re-enable it. Covers replica recovery, managed replication destinations, HCP storage create/update (written to `rclone.conf` and the verification environment) and the protected HCP environment that `restic.ts` and `rclone.ts` inject into every command for an HCP-mode storage. That environment overrides existing `rclone.conf` entries at runtime, so storages saved before this change do not need to be edited. |
| `ManagedS3RecoverySession` | Accepts the key only with the value `false`, rejects any other value before spawning, and always writes `false` into the private session config. |
| `ManagedReplicationExecutor` | Always sets `RCLONE_CONFIG_DESTINATION_USE_ACCEPT_ENCODING_GZIP=false`, so copy and Range-based SQL artifact verification never receive gzip bodies. |

## What does not change

- No object is written, re-uploaded, renamed or modified. Uploads are unaffected.
- Repository format, existing snapshots and existing replicas are unchanged. Replica identity is
  derived from endpoint, bucket, prefix and database rows, not from Rclone options, so existing
  replica bindings remain valid.
- S3 storages without HCP mode (configured in `rclone.conf`), SFTP storages, Reliable Download
  exports (AWS SDK in Node, which does not request gzip) and the Agent.
- Migration: none. Agent update or re-enrollment: none. Deploy order: server only.

## Validation

| Check | Result |
| --- | --- |
| Focused Jest suites (`storageSecurity`, `ManagedS3RecoverySession`, `ManagedReplicationExecutor`, `HcpStorageManager`) | 60/60 passed |
| Replica recovery lab before the change (`scripts/validate-replica-recovery.py`, Docker, network none) | all scenarios passed, exit 0 |
| Same lab with the change and the new gzip scenarios | all scenarios passed, exit 0 |
| Backend type check (`tsc --noEmit -p tsconfig.json`) | passed |
| Backend lint | passed |
| Full backend suite (`--runInBand`, Windows, Node 24.16.0) | 229/229 suites; 4,805 passed, 4 skipped by default |
| `pnpm build` | 3/3 tasks successful |
| `git diff --check` | clean |

New lab scenarios, real Restic 0.19.1 and Rclone 1.75.1 against a loopback HTTPS S3 fixture whose
proxy gzip-encodes data-pack Range responses when the request accepts gzip, like HCP:

- A session that re-enables gzip (Pluton before this change) received gzip Range bodies, stopped
  making TAR progress with Restic still running, and was stopped by the watchdog.
- The managed session read the same snapshot completely (6,960,128 bytes, identical to a plain read)
  and the proxy saw no gzip-accepting Range request.

`tsconfig.test.json` reports type errors in test files; every error in the changed test files is on a
line that already existed on `origin/main` (that configuration is not part of the standard checks).
No frontend file changed. Hosted CI and production UAT are pending.

## Operator UAT

1. Deploy the new image by digest as usual. No migration and no Agent action.
2. Confirm the earlier recovery job for the plan is terminal and its cleanup is clear.
3. For the plan that stalled, run one replica check and approve one staged recovery of the same
   snapshot (isolated staging, no database import). Expected: the job completes with staged-integrity
   success within a couple of minutes instead of stopping after ten minutes with
   `archive-output-idle`.
4. Optional evidence: keep `scripts/diagnostics/archive-stall-watch.mjs` running in the container
   during step 3; Restic should write TAR output continuously with no repeated one-minute bursts.
5. Discard the staged result with the existing control and confirm cleanup is clear.
6. After the next scheduled backup, confirm the replica copy and its SQL artifact verification still
   report success.

If the job still fails, collect the job diagnostic and phase timings with the console snippet in
[ASSISTED_RECOVERY_TIMEOUT_PROGRESS.md](ASSISTED_RECOVERY_TIMEOUT_PROGRESS.md) and run the range sweep
again.

## Rollback

Redeploy the previous image digest. There is no data, schema or replica change to revert. With the
previous image, recovery of the affected snapshot from the HCP replica will stall again.

## Limitations and separate findings

- An HCP endpoint configured as a plain S3 storage without HCP mode keeps Rclone's default and could
  show the same behavior for plans that read it. Use HCP mode for HCP endpoints.
- Separate, not changed here: the production host resolver lists one internal DNS server and two
  public resolvers on the same interface. One public resolver answers NXDOMAIN for the HCP tenant
  host and the other is unreachable; the container briefly failed to resolve the host while the probe
  ran. This can make replication or exports fail intermittently and should be fixed in the host DNS
  configuration.

## Changed files

| Area | Files |
| --- | --- |
| Fix | `backend/src/utils/storageSecurity.ts`, `backend/src/utils/restic/ManagedS3RecoverySession.ts`, `backend/src/utils/restic/ManagedReplicationExecutor.ts` |
| Tests | `backend/__tests__/utils/storageSecurity.test.ts`, `backend/__tests__/utils/restic/ManagedS3RecoverySession.test.ts`, `backend/__tests__/utils/ManagedReplicationExecutor.test.ts`, `backend/__tests__/managers/HcpStorageManager.test.ts`, `backend/__tests__/integration/replicaArchiveFaults.fixture.ts` |
| Reports | `docs/HCP_RANGE_GZIP_FIX.md`, `docs/REPLICA_READBACK_PROBE.md` |
