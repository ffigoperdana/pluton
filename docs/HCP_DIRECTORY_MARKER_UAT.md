# HCP directory marker compatibility and controlled UAT

Production is **NO-GO until its actual destination passes the gates below**.
Local reference-provider tests do not certify HCP. Do not recreate a historical
probe whose cleanup has already been reconciled.

## Exact recognition and sanitized diagnostics

Only the configured export prefix plus one trailing slash can be structural.
LIST must establish zero Size, a bounded quoted ETag and valid LastModified.
An independent read-only HEAD with If-Match must return HTTP 200, zero
ContentLength, the same ETag and consistent modification time, no ContentRange,
delete marker or real VersionId. HTTP HEAD dates have second precision; LIST XML
can include fractional seconds. The comparison uses their common second
precision. Missing or conflicting evidence blocks admission. No body is read.

Success adds `inventory.directoryMarker:"verified-empty"`. The marker is excluded
from `objects` and never becomes a job, ownership proof or cleanup target. It is
never overwritten, renamed, adopted or deleted. All foreign descendants, nested
markers and unknown multipart uploads remain blocked. The versioned S3 contract,
export ownership, encryption, hash, authorization and cleanup rules are unchanged.
Enumeration remains limited to eight pages of 100 entries per list; incomplete,
malformed, repeated-token and cyclic pagination is refused.
See the public [S3 HEAD response contract](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html)
and [HCP multipart pagination contract](https://docs.hitachivantara.com/r/en-us/mk-95hcph002/latest/using-the-hitachi-api-for-amazon-s3/working-with-buckets/listing-the-in-progress-multipart-uploads-in-a-bucket).

Read-only inventory failures use the existing sanitized `preflightFailure` API
projection, persisted across restart. Example (no object names or provider data):

```json
{
  "stage": "read-only",
  "capability": "destination-isolation",
  "operation": "HeadObject",
  "target": "namespace",
  "category": "unexpected-response",
  "providerCategory": "invalid-response",
  "providerCode": "unrecognized",
  "detail": "directory-marker-unverified",
  "httpStatus": 200,
  "creationAcknowledged": false,
  "durableOwnershipProof": false,
  "objectCleanupPending": false,
  "multipartCleanupPending": false
}
```

| Detail/category | Action; all failures remain NO-GO |
| --- | --- |
| `directory-marker-nonzero` | The object is not inert; request independent administrator attribution. Never delete it through Pluton. |
| `directory-marker-unverified` | Ask the provider administrator to inspect LIST/conditional HEAD size, ETag, status and timestamps privately. Do not relax verification. |
| `foreign-object` / `unknown-multipart` | Independently reconcile ownership. Matching a prefix, key or metadata is never permission to delete/abort. |
| `listing-invalid` / `listing-incomplete` | Provider response, completeness, pagination or bounds are incompatible; provide sanitized diagnostics to support. |
| `provider-error` with `unsupported-api`, `access-denied`, `tls-validation` or `network-or-deadline` | Resolve the actual API, authorization, certificate or connectivity problem. Do not bypass TLS or change signing region to force acceptance. |

## Publish, approve and deploy

1. Operator publishes `codex/hcp-directory-marker`, opens/reviews the PR and checks
   hosted Backend Test and every Container Image job on the exact commit. Local
   PASS is not hosted CI PASS. Merge only after review and green hosted CI.
2. After publication, obtain and approve the immutable GHCR image digest. Record
   the previous digest, host-bundle approval, exact named data volume, ordered
   Compose overlays and rollback history privately. Retain a consistent protected
   backup of configuration and application state, including export-job metadata.
   Preserve `.env`, private CA/keyring mounts and all historical key slots.
3. Let active backups, restores and exports finish. This patch changes no host
   bundle file, environment setting or mount. Use the existing reviewed bundle;
   if an older bundle requires upgrade, first follow the separately reviewed
   [bundle upgrade procedure](DEPLOYMENT_OVERLAY_AND_HEALTHCHECK_FIX.md). Never
   copy a checkout over local configuration. Do not change endpoint, credentials,
   signing region, namespace, overwrite policy, retention, backup or replication
   settings. Do not regenerate/rotate keys or redeploy Agent.
4. Substitute the operator-approved digest and update only Pluton:

   ```sh
   sudo sh /opt/pluton/install.sh 'sha256:<approved-image-digest>'
   sudo sh /opt/pluton/status.sh
   ```

   Status must confirm health, exact image, UID/GID, complete mounts and effective
   export environment without showing values. Authenticated
   `GET /api/managed-exports/configuration` must show `configured:true`,
   `sharedNamespaceEnabled:true`, `exportMode:"application-encrypted-hcp"`,
   `keyringConfigured:true` and the unchanged private-CA status. Never print
   expanded Compose/container environment or keyring contents.

## Destination and transfer GO/NO-GO checklist

- [ ] As the authenticated operator, run Inventory Check (POST `{}` to
  `/api/managed-exports/inventory-checks`), then poll the owner-bound
  `GET /api/managed-exports/inventory-checks/<returned-id>`. Require `state:ready`,
  `cleanupPending:false`, and `{objects:0,uploads:0,exclusive:true}`. If a root
  marker exists, also require `directoryMarker:"verified-empty"`. A truly empty
  prefix has no marker field. Do not delete a marker to force Ready.
- [ ] Run a new owner-bound preflight: POST `{}` to
  `/api/managed-exports/preflights`, then poll its returned ID. Require actual
  `productionReadiness:GO`, `state:ready`, no pending cleanup, verified
  `application-encryption` and `authenticated-readback`, and every applicable
  privacy, collision/write-once, multipart, conditional-read and cleanup gate.
  Inventory Ready alone does not authorize backup contents. Unsupported mandatory
  capabilities require HCP administrator support; retain NO-GO.
- [ ] Select an existing small Backup Plan snapshot with regular files and use
  Reliable Download regular-files mode. After that passes, test a roughly 120 MB
  regular-file snapshot. Record original TAR byte count and
  `summary.archiveSha256` from its owner-authorized Ready job. Download through
  the authenticated plaintext proxy; stored ciphertext is not a TAR.
- [ ] On an isolated operator client, compare `stat -c %s sample.tar` and
  `sha256sum sample.tar` with the recorded proof. Run `tar -tf sample.tar`, then
  extract into a new empty staging directory with `--keep-old-files`,
  `--no-same-owner` and `--no-same-permissions`. Compare file sizes/hashes with
  the selected snapshot manifest. Verify Restore separately into an explicitly
  approved empty staging destination, never the live source.
- [ ] Interrupt a transfer and resume the same Ready job. Keep authenticated URL
  and session cookie in a private curl configuration (0600), without verbose
  output or tracing. Renew expired authorization without creating a new artifact.
  Test a deterministic split first, then an actual interrupted transfer:

  ```sh
  umask 077
  curl --config /private/uat-download.conf --fail --range 0-1048575 \
    --dump-header /private/first.headers --output sample.tar
  curl --config /private/uat-download.conf --fail --continue-at - \
    --header 'If-Range: "sha256-<original-tar-sha256>"' \
    --dump-header /private/resume.headers --output sample.tar
  ```

  Require HTTP 206, exact expected Content-Range, unchanged plaintext ETag and
  final byte count/SHA-256/extraction. A partial or authentication-failed output
  is never a successful archive. Keep headers/authorization private.
- [ ] Cancel/delete only the operator's export job through its owner-bound API
  (or wait for normal expiry). Require `cleanupPending:false`. Repeat Inventory
  Check: Ready, zero objects/uploads and the same verified structural marker.
  Do not clear metadata or manually delete unknown objects/uploads.
- [ ] Check scheduled backup health, Standard Download, staging Restore, Managed
  Agent and existing SFTP/S3 replication. Test medium/larger snapshots only after
  every earlier gate passes and resource evidence is approved.

## Resources and rollback

For the 2 vCPU / 4 GiB VM, record baseline/peak `docker stats --no-stream`,
`free -m`, `df -h`, Docker volume usage, network rate, provider free capacity and
cleanup latency. Run one UAT export at a time outside backup/restore windows.
No TAR should be staged on the application filesystem. Stop new admission on
memory pressure, swap/OOM, sustained saturation, backup delays, storage pressure,
integrity errors or incomplete cleanup. Never prune replicas/backups or change
shared-namespace lifecycle to create space.

Any failed security, integrity or cleanup gate is NO-GO. Pause new Reliable
Download admission through the existing reviewed configuration procedure if
needed, preserving destination settings, all keys and job metadata for safe
cleanup. Do not change historical identities/proofs or force-clear pending jobs.
For an application regression, use the recorded approved image rollback:

```sh
sudo sh /opt/pluton/rollback.sh
sudo sh /opt/pluton/status.sh
```

Require the previous immutable image to be healthy with unchanged mounts and
configuration. Do not automatically restore old SQLite: existing encrypted jobs
need their retained journal/manifest. If healthy rollback fails, use the existing
reviewed recovery process. Keep directory markers and replicas untouched.

## Local reproduction

SDK/XML tests cover empty, nonzero and ambiguous markers, foreign objects,
unknown uploads, pagination cycles/bounds and provider errors. Service tests
exercise durable sanitized diagnostics, owner boundaries, cancellation and
restart. The native Linux fixture preserves the marker through authenticated
encrypted export, SHA-256/TAR verification, curl resume, cleanup and a second
Ready inventory, with TLS, read-only SFTP and replica-invariance assertions under
2 CPU / 4 GiB limits. The gateway models a write-once contract; it is not HCP.

```powershell
pnpm --filter @plutonhq/core-backend test --runInBand
node --experimental-strip-types --test frontend/__tests__/*.test.ts
./scripts/validate-managed-resumable-unit.ps1
./scripts/validate-managed-resumable.ps1 -Modes small -SharedNamespace -WriteOnceReference -ApplicationEncrypted -ProductionCompose
./scripts/validate-deployment.ps1 -Image <fresh-local-source-image>
```

## Local validation record (2026-11-03)

Root cause confirmed in code: the HCP inventory loop classified every LIST entry
as an owned job artifact. The exact structural root could never match a job key.
Production evidence establishes the marker's key, not its size or HEAD identity;
those properties must still be verified against HCP by the operator.

The initial strict local implementation also caught an interoperability detail:
native LIST returned fractional seconds while HEAD returned HTTP-date seconds
(`timeExact:false`, `timeSameSecond:true`, both sizes zero, ETags equal). The fix
compares their common precision and retains all independent identity/size gates.
No provider values or real destination were used in this investigation.

Changed files (no production configuration or encryption-format changes):

- `backend/src/utils/managedExport/HcpWriteOnceStorage.ts`
- `backend/src/utils/managedExport/S3ExportStorage.ts`
- `backend/src/utils/managedExport/ExportDiagnostics.ts`
- `backend/src/utils/managedExport/ExportPolicy.ts`
- `backend/src/services/ManagedExportService.ts`
- `backend/__tests__/services/HcpDirectoryMarker.test.ts`
- `backend/__tests__/services/HcpWriteOnceStorage.test.ts`
- `backend/__tests__/services/ManagedExportService.test.ts`
- `backend/__tests__/integration/managedResumableRecovery.lab.ts`
- `scripts/validate-managed-resumable-unit.ps1`
- `docs/APPLICATION_ENCRYPTED_HCP.md`
- `docs/HCP_DIRECTORY_MARKER_UAT.md`

| Local check | Result |
| --- | --- |
| Complete serial backend, `CI=true` | PASS twice: initial run 215 suites / 4,410 passed; final revision 215 suites / 4,412 passed. Both have 4 existing platform skips, no failures. |
| Resource-limited Linux export/recovery/security suite | PASS: 13 suites; 437 passed, 1 existing Windows/root-only skip on non-root Linux. Includes marker XML, encryption, keyring, ownership, cleanup and recovery. |
| Entire frontend regression suite | PASS: 366 passed, 0 skipped. |
| Node deployment/Compose/release guards | PASS: 24 passed, 0 skipped. |
| Linux host-bundle, deployment policy, CA/key mounts, shell syntax | PASS: 46 Python tests and all POSIX shell syntax checks. |
| Full Linux Docker deployment acceptance | PASS: 19 scenarios, including bundle upgrade/restore, reapply, automatic/explicit rollback and exact mount/SQLite preservation; disposable resources removed. |
| Backend lint and production TypeScript | PASS. |
| `Dockerfile.source` production build | PASS, including frontend TypeScript/docs build, backend build and pinned runtime-client checks. |
| Frontend lint baseline | FAIL (unchanged): ESLint configuration's string `eslint-config-prettier` entry is rejected by `typescript-eslint.config()`, exit 2. No frontend source/configuration was changed or gate weakened. |

The 120 MB Production Compose/reference-provider scenario passed the complete
authenticated encryption/resume/TAR/cleanup sequence with the marker present
before admission and unchanged after cleanup. It also passed foreign-object and
public-access denial, hard process restarts, cancelled/failed multipart cleanup,
concurrent synthetic backup/replication and five replica manifests/read-data
checks. Original TAR: 120,005,632 bytes. Peak application cgroup memory:
1,249,210,368 bytes (about 1.16 GiB); server Node peak RSS: 392,011,776 bytes.
CPU averaged 61% of the two-CPU quota during the full scenario; measured client
transfer rate was 10.99 MiB/s. Server metadata occupied 131,584 bytes, temporary
server TAR bytes and orphan objects/uploads were zero, and no OOM event occurred.
All disposable fixture infrastructure was removed.

Local Windows and native Linux test fixtures use Node 24.16.0 and pnpm 10.20.0;
the production source image uses its pinned Node 24.22.1 and pnpm 10.20.0.
Hosted CI, actual HCP marker metadata/capabilities and production UAT remain
operator verification gates. No branch was pushed and no production resource,
namespace setting, credential, keyring, Agent or configuration was accessed or
modified by this task.
