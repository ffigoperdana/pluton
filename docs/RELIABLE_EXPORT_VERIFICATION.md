# Reliable Download verification UAT diagnostics

Base: main `b6ddae6` (PR #65). Branch:
`codex/reliable-export-verification-diagnostics`.

## Confirmed defect and remaining production unknown

The supplied UAT passed capability preflight and finished multipart upload, but
failed during object verification. This is later than admission and publication;
it is not the earlier NO-GO/connectivity UI problem.

Two implementation defects are independently confirmed:

1. HCP metadata operations already wrap SDK failures in `ExportOperationError`,
   which extends `TemporaryExportError`, not `ExportPreflightError`.
   The service catch only copied capability/category/status from the latter.
   A HEAD/GET refusal or connection failure therefore became
   `storage-unavailable` with missing operation/category/status fields.
2. GET body iteration/decryption could throw after SDK headers succeeded. Those
   errors bypassed the metadata wrapper and were collapsed by the service's
   generic failure fallback. The encrypted GET also returns plaintext-facing
   HTTP metadata; using it for diagnostics would lose the actual ciphertext
   HTTP 206. Verification now preserves the safe wire status separately.

The patch fixes diagnostic loss. It does not establish the live provider's
underlying error or claim to cure an unobserved storage/network defect.
HEAD refusal, connection setup timeout, conditional Range differences, a
truncated GET, privacy-check failure and cryptographic failure remain possible
until a newly authorized export records its exact phase/evidence. Historical
jobs cannot retroactively acquire missing receipts.

The reported verification duration of approximately five seconds is close to
the existing five-second SDK connection timeout. That is a hypothesis only:
the supplied result has no operation, headers, byte counters or timeout receipt
to prove it. Neither a passed preflight nor multipart success proves subsequent
object availability/integrity. Failed exports must remain unavailable.

## Exact verification path and preserved gates

After upload returns a durable publication identity, the service sets the
object-verification stage and calls `S3ExportStorage.verify()`:

1. Open the private keyring and validate the authenticated manifest/envelope,
   binding and key slot. No key material enters telemetry.
2. Validate the durable write-once identity against its recorded object proof.
3. Issue conditional HEAD and verify ETag identity, length, timestamp, ownership
   metadata, application format/manifest/purpose and absent/null version.
   Provider-SSE modes retain their existing AES256 evidence requirement.
4. Verify anonymous denial for the object and reserved-prefix listing. These
   requests inspect headers and intentionally destroy the response body.
5. Reopen the authenticated cipher and map the requested full plaintext archive
   to an exact ciphertext range. Even a full encrypted download uses
   conditional GET with Range and requires exact HTTP 206, Content-Range,
   Content-Length, immutable identity and ownership metadata.
6. Read ciphertext, authenticate AES-256-GCM frames before yielding their
   plaintext, reject truncation/extra data/bad tags, and validate the complete
   plaintext byte count and SHA-256.
7. Recheck anonymous privacy, then the service rechecks binding, isolation,
   cancellation and Verifying state before publishing Ready.

No gate is relaxed. There is no fallback accepting HTTP 200 for a required
206, no full-object ownership adoption, no body retry/re-encryption and no Ready
based only on counters. Existing one-reset retries for read/header requests
remain; writes and partial bodies are never replayed. Connection timeout
(5 seconds), SDK inactivity timeout (10 minutes), export deadline and cleanup
deadlines are unchanged.

## Safe failure evidence

An additive durable `verificationFailure` appears in both the existing
owner-authorized job status and global activity response. The service also
projects the category/status into its existing failure fields and writes one
sanitized `managed_export_verification_failed` log record.

| Field | Meaning |
| --- | --- |
| phase | keyring-manifest, identity, head, get-headers, ciphertext-body, decrypt, plaintext-body, plaintext-sha256, privacy-object or privacy-list |
| operation | fixed logical/SDK operation, including separate anonymous object/list requests |
| outcome | transport, provider, identity-integrity, privacy or keyring |
| category / providerCategory / providerCode | existing fixed allowlists; unknown provider codes are unrecognized |
| responseKind | transport/provider/SDK parsing, invalid body/response, integrity or keyring error |
| httpStatus | actual wire status if observed; absent when unavailable, never a fabricated success |
| attempts | actual SDK executions including the existing manual reset retry; absent if not observed |
| elapsedMs / phaseElapsedMs | monotonic verification wall time and cumulative time in the failing phase; capped at seven days |
| transportCode / abortReason / abortedAtStart | fixed safe categories, distinguishing reset, timeout and cancellation |
| wireBytesRead / plaintextBytesRead | ciphertext observed and plaintext read by final verification; not browser receipt |
| bodyComplete | normal body EOF was observed; this alone does not prove byte count, frame authentication or SHA-256 |

Metadata parsing errors retain only a numeric wire status and a parser category.
SDK request/response objects, XML, error messages, signatures, endpoints, object
keys, ETags, plaintext, manifests, credentials and key material are never stored
in this diagnostic. Ephemeral request receipts use a WeakMap of fixed fields,
not request/body copies. Frame tracing uses fixed counters and at most ten
phase accumulators, with no extra buffering or event history.

Synthetic example (not a diagnosis of the production failure):

```json
{
  "failure": "storage-unavailable",
  "failureStage": "object-verification",
  "failureCategory": "network-or-deadline",
  "verificationFailure": {
    "phase": "get-headers",
    "operation": "GetObject",
    "outcome": "transport",
    "providerCategory": "deadline",
    "providerCode": "unrecognized",
    "responseKind": "transport-error",
    "attempts": 1,
    "elapsedMs": 5000,
    "wireBytesRead": 0,
    "plaintextBytesRead": 0,
    "bodyComplete": false,
    "abortReason": "deadline"
  },
  "cleanupPending": false
}
```

`cleanupPending` remains derived from current durable cleanup/state fields.
`cleanupFailure` and `lastCleanupFailure` are historical attempts and deliberately
remain present after cleanup succeeds. The activity projection now includes
these safe histories, and the UI labels them as historical while independently
showing whether cleanup is currently pending. They never confer deletion
authority or cause the UI to fabricate a pending object.

## What the throughput evidence supports

Rounded operator timings show approximately 489 seconds of stream generation,
96 seconds of source wait, 403 seconds of destination write wait and 455 seconds
summed upload-request time. Destination wait is approximately 83% of stream
time; request time is approximately 93%. Those measurements overlap in a
backpressured streaming pipeline and must not be added together.

They support investigating the destination request path first, including network,
TLS/connection behavior, SDK serialization/signing, provider response latency and
VM scheduling/resource contention. They do not identify HCP alone as the cause.
Source wait can include propagated destination pressure and scheduling, so it
does not independently prove slow SFTP. Multipart completion was under a second;
it was not the dominant measured upload stage.

The reported byte delta is consistent with 32 GCM tags at 16 bytes each. That
small authenticated framing overhead cannot explain a rate near 0.27 MiB/s.
It is not evidence of corruption either. There is no CPU, RSS, per-part latency
distribution or transport-phase record in the supplied sample to establish an
encryption/VM/network/provider bottleneck. No concurrency, buffer or security
settings are changed based on this evidence. Keep the existing single exporter
and bounded buffers on the 2-vCPU/4-GiB VM.

The UI now says **Waiting for storage response — no recent progress reported**
after a gap. It can return to Working normally as counters move; this is not
a hard error or automatic cancellation. Actual failed/cancelled states retain
their distinct wording. Closing the window still leaves server work running.

## Next authorized UAT and rollback

1. Operator publishes/reviews the local branch, runs hosted CI, and approves
   the normal immutable-image rollout. Preserve the app volume/export journal,
   full keyring, approved private CA/settings and rollback digest. No migration
   or configuration variable is required.
2. Use the existing read-only readiness/activity views. Do not auto-run inventory
   or capability preflight. If GO expired or was superseded, follow the explicit
   operator procedure in [activity/readiness recovery](RELIABLE_DOWNLOAD_ACTIVITY.md);
   do not bypass a gate to run the test.
3. Explicitly admit a disposable UAT export from the selected completed backup.
   Capture safe pipeline counters and resource observations (CPU, RSS, cgroup
   memory/OOM, disk space and network rate) during the run. Do not log URLs,
   cookies, provider bodies or encryption material.
4. If verification fails, capture its exact phase/operation, wire HTTP status,
   provider category/code, response kind, attempts, elapsed/phase times,
   transport/abort categories, bodyComplete, wire/plaintext counts and all current
   failure fields. Capture cleanupPending plus both historical cleanup records.
   Without these fields, do not attribute a five-second failure to a particular
   HEAD, GET, privacy request or socket.
5. A get-headers deadline with no status/bytes suggests a pre-body request problem;
   investigate connection/TLS/proxy/pooling using independently authorized
   diagnostics. A 200 on required Range or 412 requires protocol/identity review.
   A ciphertext-body reset/truncation requires stream investigation. Decrypt or
   plaintext-sha256 failure requires integrity investigation. None authorizes
   falling back to weaker validation.
6. Wait for genuine verified Ready before downloading. Verify size/SHA-256 and
   existing authenticated Range/resume behavior. Compare with Standard Download
   only through a separately authorized test; it uses a different destination
   path and cannot prove the HCP export path healthy.
7. Observe cleanup until current cleanupPending clears. Retain historical
   failures. Do not manually delete keys/prefixes, edit proof fields, adopt an
   unknown object or discard journal/key slots.

An operator may extract only the safe projection from the browser's same-origin
authenticated console; IDs stay local and no token is copied:

```js
const id = prompt("Existing export ID");
if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("Invalid ID");
const response = await fetch("/api/managed-exports/activity", {
  credentials: "same-origin", redirect: "error", cache: "no-store"
});
if (!response.ok) throw new Error("Status unavailable (HTTP " + response.status + ")");
const result = await response.json();
const job = result.result?.jobs?.find(row => row.job.id === id)?.job;
if (!job) throw new Error("No export found for this authenticated owner");
console.log({
  state: job.state, failure: job.failure, failureStage: job.failureStage,
  failureDetail: job.failureDetail, failureCategory: job.failureCategory,
  failureCapability: job.failureCapability, failureHttpStatus: job.failureHttpStatus,
  verificationFailure: job.verificationFailure,
  cleanupPending: job.cleanupPending, cleanupFailure: job.cleanupFailure,
  lastCleanupFailure: job.lastCleanupFailure, performance: job.performance
});
```

Activity/status extraction performs GET journal reads only; it does not restart
an export, contact HCP or retry cleanup. Original owner authorization remains
required. The diagnostic job projection contains no private download link.

Rollback uses the existing approved `sh rollback.sh` procedure and a compatible
application-encryption image. Preserve the same destination, data volume, export
journal and full keyring; do not restore an older SQLite file. Old images can
ignore the additive diagnostic field but lose the new visibility. Restarting
an active export still follows existing interruption/reconciliation behavior.

## Local validation

Only synthetic fixtures and disposable local containers are used.

| Check | Result |
| --- | --- |
| Complete serial backend | 220 suites, 4,581 passing; four inherited platform skips |
| Final verification/service lifecycle tests | 58 passing, including complete multipart then failed readback, cleanup recovery and explicit fresh-job success |
| Linux security/provider/recovery suite | 17 suites, 603 passing; one inherited platform skip; 2 CPUs / 4 GiB, no external network |
| Complete frontend | 405 passing, no skips |
| Backend lint / backend and frontend type checks | Pass |
| Changed frontend runtime lint | Pass with the existing rules through a temporary config-loader adapter; adapter removed |
| Deployment / export-mount / release guards | 24 passing |
| Production source image | Frontend/docs/backend build passes; non-root read-only artifact check passes for 1,841 entries |
| Disposable Linux deployment acceptance | All 19 scenarios pass, including startup, host-bundle upgrade, reapply, rollback and mount/data preservation |
| Disposable native 120-MB encrypted TAR lab | Pass: SHA-256, arbitrary authenticated Range/resume, privacy, restart/cancellation/cleanup, read-only repository and unchanged replicas; no OOM, no orphan objects/uploads |

The protocol fixture drives the pinned SDK request handler with synthetic wire
headers, XML errors and readable bodies. It checks HEAD/GET 403, 412/501,
connection resets with bounded read retry, timeout/abort, ETag/metadata changes,
HTTP 200 on required Range, wrong Content-Range, truncated bodies, authenticated
frame corruption, valid-frame/wrong-plaintext-SHA failure and eventual valid
readback. A separate SDK parsing-envelope injection confirms that only numeric
wire status/classification survive an SDK error attachment; it does not claim
to identify a particular malformed response from production.

The service test reproduces the reported broad outcome after successful upload:
uploaded byte count complete, state Failed, storage-unavailable,
object-verification and integrity Pending. It additionally checks the new safe
operation/status evidence survives subsequent verified cleanup with
cleanupPending=false, remains owner-bound after GET rediscovery, and does not
carry into a new explicitly admitted successful export.

Commands:

```sh
pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend test --runInBand ExportVerification ManagedExportService
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-frontend exec tsc -b
node --experimental-strip-types --test frontend/__tests__/*.test.ts
docker build -f Dockerfile.source -t pluton-verification-diagnostics:local --build-arg APP_VERSION=verification-diagnostics-validation --build-arg VCS_REF=b6ddae6 .
```

The Windows drivers `scripts/validate-managed-resumable-unit.ps1` and
`scripts/validate-managed-resumable.ps1` run the Linux suites/lab using the
existing native fixture image. The latter was run with `-Modes small
-SharedNamespace -WriteOnceReference -ApplicationEncrypted -ProductionCompose`.
All fixtures are local, random and disposable; their success is not HCP
certification or a production performance benchmark.
`scripts/validate-deployment.ps1 -Image pluton-verification-diagnostics:local`
verified deployment behavior using disposable local state only and removed its
fixture resources afterward.

The original full-frontend lint command remains blocked by the existing
`tseslint.config()` string `eslint-config-prettier` in `extends`. It was run
and recorded separately. Resolving that installed config object in a temporary
adapter allowed unchanged intended rules to check all three modified frontend
runtime files without errors/warnings; no suppression or rule change was used.
The new crypto observer preserves stream ordering, buffers and error behavior;
its optional diagnostics cannot bypass authentication or throw into decryption.

Hosted CI and real-browser visual/assistive-technology checks have not run.
React DOM/JSDOM regressions cover waiting-to-progress transitions, failed
verification, cleanup history and current cleanup state. The local image was
verified separately from the native source-bound integration lab.
No production credentials, real HCP probe, production mutation, push, merge or
production deployment was performed. Real HCP retesting remains an explicit
operator action after review and a valid current GO.

## Changed files

| File(s) | Purpose |
| --- | --- |
| `backend/src/utils/managedExport/ExportVerification.ts` | Bounded phase/operation trace, safe failure class and projection |
| `backend/src/utils/managedExport/ExportRequestDiagnostics.ts` | Ephemeral fixed-field SDK attempt receipts |
| `backend/src/utils/managedExport/ExportPolicy.ts` | Additive durable verification failure field |
| `backend/src/utils/managedExport/S3ExportStorage.ts` | Verify/readback/anonymous privacy instrumentation and actual wire status capture |
| `backend/src/utils/managedExport/HcpWriteOnceStorage.ts` | Identity HEAD phases and sanitized SDK parser/request receipts |
| `backend/src/utils/managedExport/ExportEncryption.ts` | Optional no-throw phase/byte observation in the existing decrypt iterator |
| `backend/src/services/ManagedExportService.ts` | Preserve verification evidence through failure/cleanup; project status/activity and log only safe fields |
| `backend/__tests__/services/ExportVerification.test.ts` | SDK/protocol/body/decrypt/privacy failure fixtures and safe diagnostic assertions |
| `backend/__tests__/services/HcpWriteOnceStorage.test.ts`, `backend/__tests__/services/ManagedExportService.test.ts` | Post-publication failure, fresh verified success, owner isolation and cleanup-history recovery |
| `frontend/src/utils/exportFailureDiagnostics.ts`, `frontend/src/utils/reliableDownload.ts` | Allowlisted owner-visible diagnostic projection |
| `frontend/src/components/Plan/Backups/ReliableDownload.tsx` | Calm waiting message, verification details and separate historical/current cleanup |
| `frontend/__tests__/downloadProgressUI.test.ts`, `frontend/__tests__/reliableDownload.test.ts` | Progress/waiting/recovery wording, history visibility and sanitization regressions |
| `scripts/validate-managed-resumable-unit.ps1` | Include the new SDK verification suite in disposable Linux validation |
| `docs/RELIABLE_EXPORT_VERIFICATION.md` | Confirmed findings, unknowns, telemetry, operator UAT and rollback |
