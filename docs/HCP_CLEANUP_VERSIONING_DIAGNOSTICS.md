# HCP cleanup versioning verification and deadline diagnostics

Base: `65014f3` (main, including PR #62). Scope: Reliable Download only.
No production access, HCP request, deployment, namespace change, or object deletion
was performed to develop or validate this change.

## Findings and limits of the evidence

**Confirmed implementation defects, reproduced against untouched main:**

1. Pinned `@smithy/node-http-handler` 4.13.0 renames `ECONNRESET` and `EPIPE`
   errors to `TimeoutError`. `ExportDiagnostics.provider()` checked that name
   before the concrete transport code. Two immediate socket resets therefore
   produced `GetBucketVersioning / namespace / network-or-deadline / deadline`,
   with no HTTP status and an abort signal that had **never fired**. The existing
   single reset retry was already operating; the second reset was misclassified.
2. The pinned S3 XML deserializer maps an empty HTTP 200 body and an unrelated
   XML root to an absent `Status`. Main accepted both as disabled versioning and
   completed synthetic cleanup. A valid empty `VersioningConfiguration` also
   worked on main. There is no demonstrated SDK incompatibility with that valid
   document or its HCP 2020 namespace.
3. HTTP status/phase evidence could be lost when a response failed after headers.
   The old error record could not distinguish a reset, a real SDK timeout, an
   already aborted caller, or cancellation during body collection.

The operator's direct signed request and existing application failure record do
**not** establish the production transport failure's cause. Neither request
duration nor original socket code was retained. A reset is a demonstrated possible
explanation, not a confirmed production root cause. DNS, HTTPS and another S3 API
working do not establish equivalence of request path, signing, connection reuse,
address family, proxy handling, or response framing. This patch does not claim to
have fixed an independently verified HCP network outage.

**Trace through the application:** the owner-bound DELETE changes the job state
to cancelled and schedules cleanup. `ManagedExportService.cleanup()` deduplicates
that job, creates a fresh controller, and `performCleanup()` creates a fresh S3
client after isolation checks. Cleanup combines the shutdown signal with a new
size-based deadline from `exportCleanupDeadline()`. It does not reuse the export
job's aborted signal. The first HCP cleanup operation is GetBucketVersioning; it
is repeated before owned-object deletion and before marking absence verified.
A nested capability probe shares this attempt's total deadline. Different jobs
do not share this client's four-socket pool. A fresh retry also uses a fresh pool.

SDK path: command serialization produces the bucket-level `GET /?versioning`,
endpoint resolution uses the configured path-style endpoint, SigV4 uses the
configured region/credentials, and NodeHttpHandler uses strict TLS/private CA and
keep-alive. Its connection timeout is 5 seconds and socket inactivity timeout is
10 minutes. Its SDK attempt count is one; Pluton's existing read-only connection
reset retry remains one. All of these values and production deadlines remain
unchanged. The new command-local middleware observes the actual response before
SDK XML deserialization. It consumes only bounded versioning control XML, never
an object/download body. Parsing failures cannot be recast as disabled versioning.

## Fix and admission policy

- Concrete reset/broken-pipe codes are reported as network failures. Actual SDK
  deadlines, caller deadline expiry and cancellation remain distinct evidence.
- A complete, bounded (16 KiB), valid UTF-8 XML `VersioningConfiguration` and
  successful, agreeing SDK deserialization are required. `Status` must be absent for HCP
  cleanup. Enabled/Suspended/unknown/duplicate/nested/foreign states fail closed.
- HTTP 200 alone, empty/wrong-root XML, truncated bodies, invalid framing, an
  expired signal, or an SDK error never prove disabled versioning. The same
  response gate is applied during mode admission before new probe writes.
- **Compatibility tightening:** explicit 501 now remains unsupported/NO-GO for
  mandatory versioning verification. The earlier unsupported-API fallback cannot
  certify absence of hidden versions. 403 remains access denied. No fallback is
  used to force acceptance. A destination must return valid versioning evidence.
- New diagnostics contain fixed enums, booleans, HTTP status and bounded timings
  only. Raw errors, XML, headers, endpoints, credentials, keys and signatures are
  never retained. Success observations are available through read-only inspection;
  failures survive SQLite restart in the existing first/last cleanup fields.
- Cleanup still requires exact original ownership and full readback before any
  owned-object deletion. Unknown historical objects are not adopted. Independently
  removed objects can be reconciled via fresh HEAD absence and multipart checks;
  absence creates no ownership receipt. Cancelled jobs remain NO-GO after cleanup.

`phase` is the last reached SDK/request/body/XML/deserialization phase, not a
claim about an unobserved DNS/TLS stage. `headersMs` measures time from operation
entry to final-attempt headers; `elapsedMs` includes the existing reset retry.
`abortReason: none` with `providerCategory: deadline` identifies an SDK-generated
timeout, not proof that the caller's total deadline fired. `attempts: 0` means
the command did not reach the transport observer. Historical records have no
new request evidence; missing fields must not be inferred retroactively.

Sanitized example of the reproduced reset after the fix (timings illustrative):

```json
{
  "operation": "GetBucketVersioning",
  "target": "namespace",
  "category": "network-or-deadline",
  "providerCategory": "network",
  "request": {
    "phase": "request",
    "elapsedMs": 12,
    "attempts": 2,
    "abortedAtStart": false,
    "abortReason": "none",
    "transportCode": "ECONNRESET",
    "bodyComplete": false
  },
  "objectCleanupPending": true,
  "multipartCleanupPending": true
}
```

## Operator deployment and read-only verification

1. Review and publish the local commit through the normal PR process. Require
   hosted CI to complete; local results do not establish hosted CI PASS.
2. Preserve the approved immutable image/bundle, private keyring, CA mount,
   configuration, consistent SQLite export-job metadata and existing data mounts.
   Deploy only with operator authorization through the existing upgrade process.
   This patch requires no environment, Compose, backup-plan or namespace changes.
3. Keep Reliable Download NO-GO until the historical cleanup state is resolved
   and any separately authorized new capability verification succeeds. Do not
   repeatedly create new preflights, edit journal flags, or clear stored failures.
4. Authenticate as the **original job owner** in the Pluton UI. On that same
   origin, the following browser-console commands use the existing protected
   session cookie; do not extract/paste a cookie, bearer token or S3 credentials.
   Enter the incident UUID privately. Do not publish it or the full status record.

Read-only status and real application SDK verification (run once):

```js
const cleanupIncident = prompt('Historical preflight UUID (private)');
if (!/^[a-f0-9-]{36}$/.test(cleanupIncident || '')) throw new Error('Invalid UUID');
const cleanupPath = '/api/managed-exports/preflights/' + cleanupIncident;
const cleanupRead = async suffix => {
  const response = await fetch(cleanupPath + suffix, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store',
    signal: AbortSignal.timeout(35000)
  });
  if (!response.ok) throw new Error('Read-only verification HTTP ' + response.status);
  const body = await response.json();
  if (body.success !== true) throw new Error('Read-only verification failed');
  return body.result;
};
const cleanupStatus = await cleanupRead('');
console.log({ state: cleanupStatus.state, cleanupPending: cleanupStatus.cleanupPending,
  lastCleanupFailure: cleanupStatus.lastCleanupFailure });
const cleanupInspection = await cleanupRead('/diagnostics');
console.log({ readOnly: cleanupInspection.readOnly,
  ownershipAdopted: cleanupInspection.ownershipAdopted,
  observations: cleanupInspection.observations });
```

The diagnostics endpoint uses the application's actual SDK, configuration and CA.
It performs GetBucketVersioning, HEAD on the four exact journal keys, bounded
multipart listing and ListParts for recorded uploads. It performs no mutation,
ownership adoption or object-body read. It has a separate 30-second inspection
deadline; the browser permits 35 seconds for that result. If cleanup is already
active, the endpoint fails rather than racing it. Wait for that attempt to finish
before another operator-approved inspection. A 404 from the application is not
proof of provider object absence: confirm the original owner and incident ID.

Expected versioning observation: `versioningInspection: disabled`, `httpStatus:
200`, `request.phase: complete`, `bodyComplete: true`, `abortReason: none`.
All exact objects and relevant uploads must be verified absent, with no failed
observation. Merely seeing zero in a separate namespace inventory is insufficient.
An unknown object/upload, versioning change, 501/403, malformed response, or
uncertain absence keeps cleanup pending. Follow the separately authorized
[historical reconciliation procedure](HCP_CONCURRENT_PUBLICATION_RECOVERY.md#separate-explicitly-authorized-reconciliation)
if administrator action is required. No prefix-wide deletion is authorized here.

If the SDK verification fails while an independently signed request succeeds,
retain only the bounded new diagnostic. Compare internally: exact endpoint/path,
region, CA validation, DNS/address family, proxy use, connection reuse and
server request timing. Do not enable raw SDK/debug logging. `request` + no status
means no headers observed; `body` + status means framing/stream progress failed;
`xml` means the received document was rejected; `deserialize` means SDK processing
or a cancellation race after collection. Establish that difference before blaming
the provider, changing timeout values, or requesting a namespace change.

## One explicitly authorized cleanup retry

Only after the read-only observations genuinely verify absence and the operator
authorizes this exact incident, run the following **once** in the same browser
session. DELETE is an application cleanup retry, not a read-only operation: its
existing safeguards may delete objects for which the journal has valid ownership
proof. Do not execute it merely to obtain diagnostics.

```js
if (prompt('Type RETRY to authorize one cleanup retry for the inspected incident') !== 'RETRY')
  throw new Error('Cleanup retry not authorized');
const cleanupRetry = await fetch(cleanupPath, {
  method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
  signal: AbortSignal.timeout(35000)
});
if (!cleanupRetry.ok) throw new Error('Cleanup retry HTTP ' + cleanupRetry.status);
console.log({ accepted: true, httpStatus: cleanupRetry.status });
```

The response acknowledges scheduling, not completion. Manually rerun only this
GET after the attempt has had time to finish; do not repeat DELETE automatically:

```js
const cleanupAfter = await cleanupRead('');
console.log({ state: cleanupAfter.state, cleanupPending: cleanupAfter.cleanupPending,
  productionReadiness: cleanupAfter.productionReadiness,
  lastCleanupFailure: cleanupAfter.lastCleanupFailure });
```

Acceptance is `state: cancelled`, `cleanupPending: false`; the historical
preflight remains NO-GO. A retained old `lastCleanupFailure` is historical evidence,
not a reason to edit metadata. If pending remains true, compare its new request
evidence and stop. No live preflight or backup download is authorized by this
procedure. A real application HCP retest is still necessary to establish that
the production cleanup failure is resolved.

Rollback uses the previous approved immutable image/bundle and preserves current
SQLite, keyring, CA and data mounts. Do not restore stale metadata to erase cleanup
obligations. The new diagnostic fields are additive; no migration or deletion of
historical metadata is required. Rolling back also loses these stricter response
checks and diagnostics, so it does not prove the destination safe.

## Validation record

Local verification on 2026-11-04 used pinned pnpm 10.20.0, Windows Node 24.16.0
and Linux/production Node 24.22.1. The transport fixture uses
actual pinned SDK/Smithy and Node HTTP on loopback with random synthetic
credentials. Only that fixture substitutes HTTP for TLS. Production TLS and private
CA validation are exercised separately by the disposable native encrypted export
lab. There are no live HCP requests or production identifiers in the fixtures.

| Check | Result |
| --- | --- |
| Untouched main transport reproducer | Exact deadline diagnostic reproduced from two resets with no abort; valid XML succeeds; empty/wrong-root HTTP 200 incorrectly completed cleanup before this fix |
| Final SDK transport, timing, parsing, cancellation, read-only and restart suite | 25 PASS; three repeated runs 2.900 / 2.876 / 2.941 seconds; later read-only/admission assertions also PASS |
| Full Windows backend, final implementation | 218 suites PASS; 4,552 tests PASS, 4 existing platform skips; 347.937 seconds |
| Linux security/encryption/provider/cleanup/recovery suite | 16 suites PASS; 577 tests PASS, 1 existing Windows/root-only skip; 152.316 seconds |
| Frontend regression suite and type check | 366 tests PASS; type check PASS |
| Backend lint and type check | PASS |
| Deployment/Compose/release Node checks | 24 PASS |
| Linux fixture/policy/CA/keyring checks | 46 PASS |
| Production source image and runtime artifact boundaries | PASS; UID/GID 10001, Node 24.22.1, 1,829 entries checked, network disabled/read-only runtime |
| Linux Docker deployment acceptance | 19 PASS, including bundle upgrade/reapply, automatic/explicit rollback and mount preservation; repeated successfully on the final rebuilt image |
| Native TLS/private CA encrypted TAR, interruption/Range/resume/restart/cleanup | PASS; 120,005,632-byte archive; SHA/integrity, semantic concurrent publication and unchanged synthetic SFTP/S3 replicas verified |
| Hosted GitHub Actions | NOT RUN; branch was not pushed |
| Actual HCP cleanup | NOT TESTED; operator read-only verification and one authorized retry still required |

One intermediate full backend run passed all 4,551 then-existing test assertions
but failed the unchanged `PlanService` suite's logger `afterAll` five-second
teardown bound. The first full run and the final run above passed. Comparison on
untouched current main passed all 217 suites/4,525 tests (315.260 seconds), and
three focused main PlanService runs passed. Thus the intermittent teardown failure
was **not reproduced on current main during this task**, although the same issue
is recorded in the previous [validation report](HCP_SEMANTIC_CONCURRENT_PUBLICATION.md).
No logger code, teardown timeout, assertions or CI gates were changed/suppressed.

Final native lab resource evidence: 2-vCPU / 4-GiB application limit, peak cgroup
memory 1,202,544,640 bytes, metadata disk 160,256 bytes, no temporary server TAR,
zero orphan objects/parts and zero OOM events/kills. CPU was 59.42% of the two-CPU
quota; measured local client throughput was 12.51 MiB/s, not an HCP performance
prediction. All disposable lab resources were removed. Existing authenticated
encryption, SHA/readback, owner checks, Standard Download, restore/recovery and
replica invariance assertions remained enabled.

Exact changed files:

- `backend/src/utils/managedExport/ExportVersioning.ts`
- `backend/src/utils/managedExport/ExportRequestDiagnostics.ts`
- `backend/src/utils/managedExport/ExportDiagnostics.ts`
- `backend/src/utils/managedExport/HcpWriteOnceStorage.ts`
- `backend/src/utils/managedExport/S3ExportStorage.ts`
- `backend/src/services/ManagedExportService.ts`
- `backend/__tests__/fixtures/hcpVersioningTransport.process.ts`
- `backend/__tests__/services/HcpVersioningTransport.test.ts`
- `backend/__tests__/services/HcpWriteOnceStorage.test.ts`
- `backend/__tests__/services/ManagedExportService.test.ts`
- `backend/__tests__/utils/ExportDiagnostics.test.ts`
- `scripts/validate-managed-resumable-unit.ps1`
- `docs/HCP_CLEANUP_VERSIONING_DIAGNOSTICS.md`
- `docs/HCP_PREFLIGHT_CLEANUP_DIAGNOSTICS.md`
- `docs/MANAGED_RELIABLE_DOWNLOAD_UAT.md`

`ExportPolicy.ts` was traced and left unchanged: cleanup deadlines and capability
metadata remain intact. No dependency/lockfile, frontend, Agent, backup-plan,
Compose or production configuration was changed.

Commands:

```text
pnpm --filter @plutonhq/core-backend exec jest --runInBand __tests__/services/HcpVersioningTransport.test.ts
pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
node --experimental-strip-types --test frontend/__tests__/*.test.ts
pnpm --filter @plutonhq/core-frontend exec tsc -b
powershell -File scripts/validate-managed-resumable-unit.ps1 -Image pluton-hcp-body-native:local
docker build -f Dockerfile.source -t pluton-hcp-versioning:local --build-arg APP_VERSION=hcp-versioning-validation --build-arg VCS_REF=65014f3 .
powershell -File scripts/validate-deployment.ps1 -Image pluton-hcp-versioning:local
powershell -File scripts/validate-managed-resumable.ps1 -Image pluton-hcp-body-native:local -Modes small -SharedNamespace -WriteOnceReference -ApplicationEncrypted -ProductionCompose
```

Official references:
[S3 GetBucketVersioning response and never-enabled example](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetBucketVersioning.html),
[AWS SDK transport timeout/agent options](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-client-constructors.html).
Pinned installed implementation inspected: `@smithy/node-http-handler` 4.13.0
`setConnectionTimeout`, `setSocketTimeout`, `buildAbortError`, `NodeHttpHandler.handle`;
`@aws-sdk/client-s3` 3.1159.0 GetBucketVersioning schema/deserializer.
