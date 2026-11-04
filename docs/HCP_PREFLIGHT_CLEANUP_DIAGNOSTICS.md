# Write-once preflight failure and pending cleanup

This change adds diagnostics and a read-only inspection of an existing failed
preflight. It does not certify a provider, enable Reliable Download, change
namespace policy, or modify backup/replication destinations. No production HCP
was accessed during development. All compatibility evidence below uses local,
disposable protocol fixtures; actual destination compatibility remains unproven.

## Confirmed implementation findings

`S3ExportStorage.mode()` selects a **candidate** write-once contract only for the
already permitted shared-namespace configuration when a complete, valid versioning
response proves the disabled state. HTTP 501 now fails this mandatory check; see
[versioning verification and deadline diagnostics](HCP_CLEANUP_VERSIONING_DIAGNOSTICS.md).
All existing collision, encryption, identity,
privacy, readback, multipart, range and cleanup gates still have to pass.

`HcpWriteOnceStorage.preflight()` first journals a private nonce, checks absence
of its exact random probe key, and sends a 32-byte random PUT with AES256 and
ownership metadata. `record()` requires the successful creation response's ETag,
and HTTP 200, then an independent HTTP 200 conditional HEAD matching that ETag, byte count, timestamp,
unversioned state, AES256 and all job/binding/nonce markers. Only then does it
persist `ownedObjects`, followed by checksum readback. A key or matching HEAD
alone never establishes ownership.

Previously, a missing PUT ETag or incomplete/mismatched HEAD failed **before**
that durable ownership proof existed. Cleanup correctly refused to adopt/delete
the resulting object, but discarded its own error and raised only
`cleanup / cleanup-failed`. The original probe report always used
`unexpected-response`, even for a distinguishable provider error. Subsequent
service cleanup swallowed every cause and logged only `success=false`.

The local real-SDK fixture reproduces this sequence with HTTP 200 PUT and no
ETag. Other fixtures reproduce missing or mismatched HEAD ETag, absent timestamp,
missing/non-AES256 SSE evidence, unexpected HEAD status, access denial, multipart
listing incompatibility, denied DELETE, and a lost PUT response after server
creation. Each remains NO-GO; unknown objects are never deleted.

These are confirmed diagnostic defects and plausible explanations for the
reported production symptom. **The specific production HCP error is unknown.**
Inventory passing establishes prefix inventory at that time, not PUT response
compatibility, AES256 evidence, delete permission, retention policy, or durable
ownership of a subsequently created object. Historical discarded responses
cannot be reconstructed by this patch.

## Persisted evidence and public diagnostics

The private job journal now records an attempted creation and its acknowledged
successful response **before** response/HEAD validation. This receipt grants no
delete permission; `ownedObjects` remains the mandatory complete proof. Missing
receipt evidence on an old job means **not recorded**, not that no PUT succeeded.

`preflightFailure` preserves the first original probe diagnostic.
`cleanupFailure` preserves the first cleanup diagnostic. `lastCleanupFailure`
records the latest retry failure. Successful cleanup retains this history.
`probeFailure`, existing failure fields, owner binding, reservation accounting,
and export-job metadata remain available. Cancellation changes the job state;
it does not imply deletion or erase the diagnostics. SQLite's existing durable
metadata store persists these additive fields without an application migration.

Diagnostics contain only fixed operation/target names, capabilities, allowlisted
provider categories/codes, valid numeric HTTP status, and booleans. Arbitrary
provider names/messages, response bodies, headers, ETags, object keys, upload IDs,
nonces, credentials, endpoint values and signed URLs are excluded. Public/log
projection applies exact allowlists again. Each failure record is bounded;
there is no growing error history. Normal provider request counters are unchanged.

Example for a successful PUT with incomplete response metadata:

```json
{
  "preflightFailure": {
    "stage": "preflight",
    "capability": "write-once-creation",
    "operation": "creation-response",
    "target": "probe",
    "category": "unexpected-response",
    "providerCategory": "invalid-response",
    "providerCode": "unrecognized",
    "detail": "missing-etag",
    "httpStatus": 200,
    "creationAcknowledged": true,
    "durableOwnershipProof": false,
    "objectCleanupPending": true,
    "multipartCleanupPending": true
  },
  "cleanupFailure": {
    "stage": "cleanup",
    "capability": "cleanup",
    "operation": "ownership-proof",
    "target": "probe",
    "category": "unexpected-response",
    "providerCategory": "invalid-response",
    "providerCode": "unrecognized",
    "detail": "ownership-proof-missing",
    "httpStatus": 200,
    "creationAcknowledged": true,
    "durableOwnershipProof": false,
    "objectCleanupPending": true,
    "multipartCleanupPending": false
  }
}
```

Pending means verification is incomplete, not proof that bytes exist. The
preflight snapshot can show multipart pending before cleanup has checked it.
For an object-specific target the acknowledgement/proof flags refer to that
target. Newly generated namespace/unknown diagnostics do not borrow acknowledgement or ownership
from another object; both flags are false when no exact target is identified.
Previously persisted context flags are retained as historical observations,
never interpreted as proof for a different target.
New concurrent requests have separate bounded `publications` diagnostics; see
[concurrent-publication recovery](HCP_CONCURRENT_PUBLICATION_RECOVERY.md).

## Read-only procedure for an existing failed preflight

An operator must first publish/review and install this patch through the normal
deployment process. The coding session does not deploy or contact production.
Before using it, retain the existing job journal and normal rollback material;
do not remove pending jobs, edit SQLite proof fields, or rotate the destination
to evade cleanup. Configuration/destination changes can prevent safe cleanup.

1. In the authenticated Pluton browser, identify the **existing** preflight ID.
   Do not start another preflight or real archive merely to diagnose this job.
2. Use the original owner's session to GET
   `/api/managed-exports/preflights/<preflight-id>`.
   This reads local journal status only. Save the sanitized failure fields and
   `productionReadiness`, `cleanupPending`, and the new diagnostic fields.
3. Explicitly invoke GET
   `/api/managed-exports/preflights/<preflight-id>/diagnostics`.
   There are no destination/key/credential overrides. Foreign sessions get 404;
   only failed, cancelled or expired HCP preflights are admitted; Ready/active
   jobs, other job kinds and changed destinations are refused.
   A cleanup already running must finish before inspection is admitted.
4. This endpoint performs only GetBucketVersioning, four exact-key HEADs,
   one bounded ListMultipartUploads (100 entries), and at most eight ListParts
   requests (one part each), with one inspection admitted per process and an
   overall 30-second provider deadline. The existing client may retry a metadata
   read once after connection reset. No GET body, PUT, completion, DELETE, abort,
   presigning, journal update, or ownership adoption occurs. Normal background
   maintenance can still run; observations are not an atomic storage snapshot.
5. Review `observations`: versioning inspection status, safe HTTP errors,
   `present`, ETag/timestamp/length presence, `sseS3Verified`,
   `ownershipMarkersMatch`, `durableOwnershipProof`, and
   `metadataMatchesProof`. Markers alone are informational, never delete authority.
   No GO is produced by this endpoint. On old jobs, original failure details and
   acknowledgement receipts may be unavailable even when an object is present.

For example, run this explicitly in the same-origin authenticated browser
console. The ID is entered locally; no cookie/token is copied or printed:

```js
const id = prompt("Existing preflight ID");
if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("Invalid preflight ID");
const response = await fetch(
  `/api/managed-exports/preflights/${encodeURIComponent(id)}/diagnostics`,
  {
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
  },
);
const body = await response.json();
if (!response.ok || body.success !== true)
  throw new Error("Read-only inspection refused; check local status");
console.log(body.result);
```

Do not export raw SDK debug logs, credential environment, database rows, request
headers or HCP responses for support. Share only the sanitized report through an
approved channel. The report still contains the application job/snapshot ID in
its status; redact those when posting publicly.

## Recovery and administrator boundaries

- **Complete durable proof, transient access/network failure:** after the HCP
  administrator resolves the exact API permission/compatibility problem, the job
  owner may explicitly retry the existing owner-bound DELETE endpoint. It
  cancels/retries cleanup; it is a storage mutation and is separate from the
  read-only diagnostic procedure. At most ten automatic attempts remain; an
  explicit owner retry is allowed after exhaustion. Never loop blindly.
- **Object present, no complete durable proof (including lost response or
  incomplete creation/HEAD metadata):** application deletion must remain refused.
  Do not manufacture proof from the key, marker, current HEAD, or an old receipt.
  Escalate through the HCP administrator's separate, explicitly authorized audit
  and recovery process. Only independently attributed disposable test objects
  may be considered for separately approved manual cleanup. If attribution cannot
  be established, retain the object/job and NO-GO. Never clear the shared prefix
  or change retention/overwrite/namespace settings as a workaround.
- **Unknown multipart upload:** never abort it from matching key/listing alone.
  Exact upload ID returned by creation and durably recorded for that job remains
  mandatory. Known interrupted uploads can be retried with their durable proof;
  list/abort/absence verification must all work. Unknown uploads require the same
  separate administrator review.
- **Administrator has independently removed attributed leftovers:** read-only
  inspection must show exact objects absent and upload inspection available.
  Then an owner-bound DELETE retry independently verifies absence again before
  releasing the reservation and setting `cleanupPending:false`. This does not
  grant GO to the failed/cancelled preflight; a later new disposable preflight
  must pass every mandatory gate before any real export.

Administrator investigation may be required for missing ETag/user metadata or
timestamps, unobservable/unsupported AES256 evidence, retention/delete denial,
HTTP 405/501 multipart APIs, credentials or signature rejection, proxy-stripped
headers, TLS chain validation, or versioning state changes. HTTP 501 versioning
inspection remains unverified and blocks cleanup; enabling or suspending versioning
also blocks nonversioned cleanup. A provider that cannot
prove encryption, publication isolation, exact identity, privacy, enumeration
and cleanup must remain NO-GO. No check may be disabled to force compatibility.

## Validation

Reproduce with only synthetic local fixtures, Node.js 24 and pnpm 10.20.0:

```sh
pnpm install --frozen-lockfile
pnpm --filter @plutonhq/core-backend test --runInBand --runTestsByPath \
  __tests__/services/HcpPreflightDiagnostics.test.ts \
  __tests__/services/HcpWriteOnceStorage.test.ts \
  __tests__/services/S3ExportStorage.test.ts \
  __tests__/services/ManagedExportService.test.ts \
  __tests__/utils/ExportDiagnostics.test.ts
CI=true pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-frontend exec tsc -b
node --test scripts/__tests__/apiInventory.test.mjs scripts/__tests__/managedExportCompose.test.cjs
node --experimental-strip-types --test frontend/__tests__/*.test.ts
pnpm build
git diff --check
```

The real-SDK tests supply local protocol responses through the request handler;
they do not mock away SDK XML/header parsing or contact HCP. The async command
fixtures additionally cover collision races, range/readback, unknown ownership,
incomplete multipart uploads, failed PUT followed by interrupted cleanup,
cancellation, owner isolation, cleanup retry and SQLite crash/restart evidence.
Validation results and hosted CI status follow below.

### Local results (2026-11-02)

Base: freshly fetched `origin/main` at
`dee456a35d175d5aa8028c786b595d3f28802e32`.
Branch: `codex/hcp-preflight-cleanup-diagnostics`.

| Check                                                                                     | Result                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unpatched origin/main HCP implementation + the same local real-SDK missing-ETag fixture   | Reproduced `write-once-creation / unexpected-response`, followed by generic `cleanup / cleanup-failed`, no durable proof and zero DELETE requests; original cleanup detail unavailable                                                                              |
| Complete Linux serial backend, first run                                                  | 213 suites; 4,315 passed, seven inherited skips; 230.203 s; natural exit 0                                                                                                                                                                                          |
| Complete Linux serial backend, second run (adds the provider InvalidRequest case)         | 213 suites; 4,316 passed, seven inherited skips; 262.232 s; natural exit 0                                                                                                                                                                                          |
| Final Windows focused provider, security, cleanup, cancellation and SQLite restart suites | Five suites, 112 passed; 5.485 s                                                                                                                                                                                                                                    |
| Final Linux focused suites after the Ready-job refusal guard                              | Five suites, 112 passed; 6.760 s; backend lint, type check and production recompilation also passed                                                                                                                                                                 |
| Full frontend regressions on Linux                                                        | 365 passed, zero skipped; 26.318 s                                                                                                                                                                                                                                  |
| API inventory, deployment and export Compose policy on Linux                              | 18 Node tests passed; 38 Python tests passed                                                                                                                                                                                                                        |
| Backend lint; backend and frontend type checks                                            | Passed                                                                                                                                                                                                                                                              |
| Production workspace build on Linux                                                       | All three tasks passed; 51.314 s                                                                                                                                                                                                                                    |
| Native shared-namespace write-once reference lab, 120,000,000 synthetic source bytes      | Integrity, range resume, slow client, authenticated renewal, Standard Download, hard restarts, cancellation, multipart failure/retry and cleanup passed; five synthetic Restic S3 replicas unchanged and read-data checks passed; unknown prefix sentinel preserved |
| Native resource/cleanup evidence                                                          | Two CPU / 4 GiB limit; cgroup peak 1,430,888,448 bytes; zero OOM events/kills; 16 MiB part buffer; zero temporary server TAR bytes; zero orphan objects/parts; disposable resources removed                                                                         |
| Frontend lint (separate Windows check)                                                    | Existing configuration failure, exit 2: `tseslint.config()` rejects the string `eslint-config-prettier` in `extends`; unchanged by this patch and not suppressed                                                                                                    |
| Whitespace / tracked and untracked source review                                          | Passed; generated logs and local fixture resources excluded from Git                                                                                                                                                                                                |

Linux used Node 24.22.1 and locked pnpm 10.20.0 in disposable containers with
2 CPU / 4 GiB limits. Backend/validation containers had external networking
disabled. The native lab used its own internal Docker network, local TLS MinIO
and write-once reference gateway, random disposable credentials, real SFTP/Restic
fixtures, and no published ports. Windows focused tests used Node 24.16.0 and
the same pinned pnpm/lockfile. No dependencies, CI gates, production Compose,
Agent or backup/replication configuration were changed.

The final endpoint guard additionally refuses Ready jobs so read-only diagnosis
cannot be mistaken for a new GO. Hosted CI has **not** run for this unpublished
local branch. After operator publication, run the Container Image and Backend
Test workflows. Local reference-provider success is not production HCP
certification; a fresh operator-approved destination preflight is still required
before any real Reliable Download.

### Exact changed files

| File                                                         | Purpose                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `backend/src/utils/managedExport/ExportDiagnostics.ts`       | Bounded diagnostic types, fixed provider/operation/detail allowlists and safe projection          |
| `backend/src/utils/managedExport/ExportPolicy.ts`            | Additive durable job evidence fields                                                              |
| `backend/src/utils/managedExport/HcpWriteOnceStorage.ts`     | Creation receipts, precise validation errors, separate cleanup history and read-only observations |
| `backend/src/utils/managedExport/S3ExportStorage.ts`         | Propagate child-probe cleanup progress; expose HCP inspection                                     |
| `backend/src/services/ManagedExportService.ts`               | Owner/state/configuration/concurrency guard, safe status/logging and durable retry diagnostics    |
| `backend/src/controllers/ManagedExportController.ts`         | Authenticated no-override read-only controller with disconnect cancellation                       |
| `backend/src/routes/managedExportPreflight.ts`               | Add the session-only diagnostic route                                                             |
| `backend/__tests__/utils/ExportDiagnostics.test.ts`          | Sanitization and size bounds                                                                      |
| `backend/__tests__/services/HcpPreflightDiagnostics.test.ts` | Real AWS SDK parsing of local protocol responses                                                  |
| `backend/__tests__/services/HcpWriteOnceStorage.test.ts`     | Incomplete metadata, unknown ownership, multipart cleanup and safe restart cases                  |
| `backend/__tests__/services/ManagedExportService.test.ts`    | SQLite persistence, interrupted cleanup, cancellation, retries and diagnostic authorization       |
| `docs/api-inventory.json`                                    | Generated endpoint inventory                                                                      |
| `docs/API_COVERAGE_MATRIX.md`                                | Generated endpoint coverage                                                                       |
| `docs/HCP_PREFLIGHT_CLEANUP_DIAGNOSTICS.md`                  | Evidence, example output, operator procedure, recovery boundaries and local validation            |
