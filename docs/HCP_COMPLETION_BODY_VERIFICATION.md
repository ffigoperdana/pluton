# HCP multipart completion body verification

For the subsequent verified final-error verdict, fresh-receipt safeguards and
current handoff, see [semantic concurrent publication](HCP_SEMANTIC_CONCURRENT_PUBLICATION.md).
The investigation below records PR #61's earlier conservative verdict.

The reported destination remains **NO-GO**. This change resolves a reproducible
SDK response-classification defect and adds safe evidence for a later authorized
investigation. It does not establish which body HCP returned, certify concurrent
publication on HCP 9.7.3.14, or authorize cleanup of the existing ambiguous object.
No production access, provider probe, configuration change or object mutation was
performed. Base: `origin/main` `3952c27`, including PR #60.

## Proven defect versus production assumptions

The pinned `@aws-sdk/client-s3` is 3.1159.0. Its locked S3 middleware is
`@aws-sdk/middleware-sdk-s3` 3.972.83; Smithy core is 3.37.0. The path is:

1. The HTTP handler returns status, headers and a stream. A 200 acknowledges the
   request before it necessarily finishes publication.
2. `throw200ExceptionsMiddleware` collects the completion body. For this pinned
   version it recognizes an embedded Error using a suffix check for `</Error>`
   in the last 16 bytes. Empty bodies are also changed to an SDK error status.
3. Whitespace **after** `</Error>` defeats that suffix check. Smithy's success
   deserializer then maps the Error document against the success schema, which
   has none of its expected Bucket, Key or ETag fields. It resolves status 200
   with those fields absent. Other malformed shapes can instead throw; Smithy
   attaches `$response` to parser exceptions. Pluton never exposes that object.
4. Before this change Pluton correctly refused the invalid success schema, but
   could not distinguish an Error body from other missing-identity responses.

This was reproduced on unmodified main using the real pinned SDK protocol
fixture: one valid completion plus a second HTTP 200 Error with trailing XML
whitespace produces two resolved acknowledgements, one valid response, and
false ETag/Bucket/Key presence flags for the second. A committed regression also
invokes the unmodified SDK directly and asserts that exact result shape.

**The production cause remains unverified.** A trailing-whitespace Error is a
demonstrated explanation, not a capture of the production response. Empty,
malformed, truncated, unexpected-envelope or schema-incompatible responses, or
a malformed acknowledgement after a real commit, remain possibilities. Neither
the SDK result nor current HEAD proves the historical body or a second commit.

Both the [HCP 9.7.x completion manual](https://docs.hitachivantara.com/r/en-us/mk-95hcph001-20/using-the-hitachi-api-for-amazon-s3/working-with-multipart-uploads/completing-a-multipart-upload?contentId=lynj7qhRyB9IJQpFPhwHog)
and [Amazon S3 completion reference](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html)
describe completion errors after an initial HTTP 200 and require examination of
the final response. HCP's documented success body contains Bucket, Key and ETag.
The [HCP error-code reference](https://docs.hitachivantara.com/r/en-us/mk-95hcph002-19/using-the-hitachi-api-for-amazon-s3/requests-and-responses/error-codes)
also lists failures returned inside a 200 response. An upload failure such as
InvalidPart is not evidence that namespace collision protection was enforced.
We therefore do not relabel embedded errors as proven rejected 409 competitors.

## Targeted change and unchanged security contract

Only HCP write-once completion responses are inspected, for both disposable
preflight and real archive publication. A command-local middleware runs before
the SDK's embedded-error middleware consumes the response. It caps collected
completion bytes at 64 KiB under the existing AbortSignal, destroys the stream
on exit, checks clean EOF and declared Content-Length, and parses strict UTF-8 XML. XML depth is
limited to 16 and elements to 256. DTDs, invalid XML/UTF-8, duplicate or nested
identity fields, foreign identity namespaces and Error inside a result fail
closed. Existing deadlines and the no-write-replay (`maxAttempts:1`) policy stay
unchanged. Archive/download bodies are never buffered by this inspection.

`saxes` 6.0.0 is now a direct production dependency to validate XML grammar and
namespaces. That exact package/version already existed in the lockfile; no
package was upgraded. The SDK parser alone is insufficient because it accepts
an Error under a success schema. The validator rejects DTDs and never resolves
external entities or loads external resources.

Complete result envelopes in the documented S3 2006 and HCP 2020 namespaces,
or without a namespace, still go unchanged through the pinned SDK. The parser
never supplies missing identity values. Races durably journal resolved invalid
schemas before refusing them. Archive completion now also applies the same
quoted-ETag, exact Bucket/Key, HTTP 200 and absent/null-version requirements
before ownership recording. This closes the separate archive path's previous
reliance on ETag plus HEAD without validating returned Bucket/Key.

A complete Error, including namespaced XML and trailing whitespace, is an
explicit failure with the original wire status and an allowlisted error code.
Empty, incomplete, malformed, oversized or unexpected bodies are distinct from
SDK deserialization errors and transport errors. No missing field is accepted,
no status is invented, and no response is replayed to repair uncertain state.

Admission still requires one valid winner and actual rejected 409 competitors,
then independent conditional HEAD, nonce/binding/identity/size checks and full
SHA-256 readback. HTTP acknowledgement, SDK resolution, a schema-valid response,
an actual provider commit and durable ownership proof are separate facts.
Diagnostic counts never infer a provider commit. Historical receipts and proof
are not backfilled, migrated, adopted or rewritten.

AES-256-GCM, authenticated manifests, private keyring, TLS, privacy, Range/resume,
TAR correctness and fail-closed ownership cleanup are retained. Versioned S3
completion, backup/replication, Standard Download, Restore and Agent paths are
unchanged. No environment, Compose, production or namespace setting changes.

## Sanitized evidence

Owner-bound preflight status/diagnostics add `httpAcknowledgements` and per-
operation `httpAcknowledged`. Existing `acknowledgedResponses` means resolved
SDK receipts, while `validSuccessResponses` means strict schema-valid receipts.
New `completion` evidence contains only exact enums and booleans. It records
body completion/limit state, XML root classification, namespace class, strict
XML parser outcome, SDK outcome and identity-field presence/uniqueness. Absence
of this object means historical evidence was not recorded, never reconstructed.
Field flags describe accepted XML only; consult `xmlParser` before interpreting
them. A rejected or unexamined body does not establish which fields were absent.

Synthetic trailing-whitespace Error example after the fix:

```json
{
  "competitor": "multipart-b",
  "operation": "CompleteMultipartUpload",
  "wireHttpStatus": 200,
  "httpStatus": 200,
  "httpAcknowledged": true,
  "acknowledged": false,
  "response": "embedded-error",
  "providerCategory": "service-error",
  "providerCode": "InvalidPart",
  "durableReceipt": true,
  "validationEvidence": "not-evaluated",
  "completion": {
    "body": "complete",
    "xml": "error",
    "namespace": "none",
    "xmlParser": "accepted",
    "sdkParser": "not-run",
    "entityTagPresent": false,
    "bucketPresent": false,
    "keyPresent": false,
    "identityUnique": true
  }
}
```

The race has two HTTP acknowledgements, one resolved SDK success, one valid
success and remaining ambiguity. No object proof is issued. `httpStatus` on a
validator-rejected response is the observed status, not evidence the SDK parser
ran; consult `sdkParser`. No raw XML, headers, request IDs, ETags, object names,
signatures, credentials or encrypted bytes are retained in these diagnostics.
The existing two-race/three-operation projection bounds remain. Original
preflight failure and subsequent cleanup failures remain separate journal data.

## Existing failed job: read-only diagnosis and controlled recovery

1. Preserve the reviewed image digest, deployment bundle, consistent export
   journal, data volume, private keyring and protected configuration through the
   existing operator procedure. Never edit proof bits or erase the journal.
2. As the original authenticated owner, read
   `GET /api/managed-exports/preflights/<incident-id>` and explicitly read
   `GET /api/managed-exports/preflights/<incident-id>/diagnostics`. Diagnostics
   inspect bounded metadata/parts only, without downloads or writes. Preserve
   original failure, latest cleanup failure and safe per-operation evidence.
   An upgraded image cannot recover a body that was never recorded.
3. Ask the authorized HCP administrator/vendor to correlate the exact private
   incident's upload/audit records and actual node routes. Request the final
   completion result/error category and body-completion evidence, without adding
   raw responses or object identities to public issues/application logs. Require
   guarantees applicable to the actual build and namespace policy; neither a
   different HCP version's manual nor one sticky route establishes them.
4. A matching key, ETag, current HEAD, hash or metadata is insufficient ownership
   proof for the ambiguous historical object. Keep NO-GO and retain it unless
   independent administrator attribution and separate explicit deletion
   authorization permit the existing
   [single-object reconciliation procedure](HCP_CONCURRENT_PUBLICATION_RECOVERY.md#separate-explicitly-authorized-reconciliation).
   No prefix deletion, directory-marker deletion, replica deletion or unknown-
   multipart abort is permitted. This patch performs no reconciliation.
5. After independently verified absence of the exact tracked objects and
   relevant multipart uploads, the original owner may use the existing
   owner-bound DELETE cleanup retry and require `cleanupPending:false`. State
   `cancelled` by itself is insufficient. Preserve historical failure evidence.

### Is a new HCP preflight justified?

**Not while historical cleanup is pending.** After reviewed publication/hosted
CI, an operator-approved image update, independent incident reconciliation and
Inventory Ready (`objects:0`, `uploads:0`, `exclusive:true`, verified empty
directory marker if present), a separately authorized new disposable preflight
can obtain the missing response-shape evidence. It is justified for diagnosis,
not an expectation that this parser fix makes the destination GO. Do not start
real backup exports until all mandatory preflight gates pass. This coding task
does not authorize that probe or any deployment.

GO still needs an unambiguous single winner, actual collision rejection across
required routes, independent readback/privacy/integrity verification and clean
cleanup. HTTP 200 Error, unverifiable schema, double success, lost/truncated
response or unknown ownership keeps NO-GO. An explicit failure code by itself
does not demonstrate the concurrency guarantee.

### Alternatives and rollback

If the destination cannot meet that contract, use a separately validated
immutable/versioned destination or provider-supported cluster-wide atomic
compare-and-create with immutable identities and safe conditional cleanup.
The existing versioned mode has its own gates; this is not an automatic switch
for encrypted HCP. An append-only encrypted manifest with unique per-attempt
objects would require a new durable publication/GC protocol and independently
proved object identity/overwrite/cleanup guarantees. Random keys, a local lock,
AES-GCM or sticky routing alone do not provide these guarantees. No alternate
contract is implemented or silently receives GO.

Rollback uses the existing reviewed image/bundle rollback procedure. Retain the
current journal, receipts, data and private keyring. The metadata addition is
optional and needs no database migration. Do not restore an older database to
erase pending cleanup. Older images lack the new body diagnostics and archive
identity guard, so keep Reliable Download admission blocked during rollback and
require operator review before any new preflight/export. Backup protection does
not depend on this feature being enabled.

## Local validation

See the verification record below. Local fixture results do not certify HCP or
constitute hosted CI. The native provider is an isolated TLS S3 reference with
an independently written write-once gateway, never a real HCP namespace.

The full regression set includes real SDK/XML fixtures, response-only double
success versus two independent modeled commits, missing identity, schema/parser
disagreement, malformed/absent/oversized/truncated bodies, embedded Error,
cancellation, incomplete multipart cleanup, unknown ownership, SQLite reopen,
SIGKILL checkpoints, encrypted archive publication, authentication/authorization,
keyring, Range/resume, backend/frontend and disposable deployment/rollback.

Changed files:

- `backend/src/utils/managedExport/ExportCompletion.ts`: bounded control-body
  inspection before SDK deserialization, explicit Error/invalid-body refusal.
- `backend/src/utils/managedExport/ExportCompletionShape.ts`: fixed enum/boolean
  evidence and defensive projection.
- `backend/src/utils/managedExport/HcpWriteOnceStorage.ts`: shared completion
  wrapper, durable per-operation evidence and strict archive identity checks.
- `backend/src/utils/managedExport/S3ExportStorage.ts`: route only write-once
  archive completion through the shared wrapper; versioned path unchanged.
- `backend/src/utils/managedExport/ExportPublication.ts`: separate HTTP counts,
  persisted body shape and bounded public projection; verdict rules unchanged.
- `backend/src/utils/managedExport/ExportDiagnostics.ts`: sanitized body evidence,
  failure kind and documented provider-code allowlist additions.
- `backend/src/services/ManagedExportService.ts`: serialize already-sanitized
  optional shape in primitive-valued log records.
- `backend/__tests__/utils/ExportCompletion.test.ts`: real pinned-SDK baseline,
  strict XML, transport, schema disagreement, archive and sanitization regressions.
- `backend/__tests__/services/HcpConcurrentPublication.test.ts`: precise new
  classifications, SQLite reopen, repeated protected cleanup and SIGKILL evidence.
- `backend/package.json`, `pnpm-lock.yaml`: direct exact existing parser dependency.
- `scripts/validate-managed-resumable-unit.ps1`: include completion regressions
  in the isolated Linux security/export suite.
- `docs/HCP_HTTP200_COMPLETION_DIAGNOSTICS.md`: link forward without rewriting
  PR #60's historical investigation.
- `docs/HCP_COMPLETION_BODY_VERIFICATION.md`: this evidence, operator procedure,
  compatibility limits, alternatives and verification record.

### Verification record (2026-11-03)

Branch: `codex/hcp-completion-body-verification`. Local Node 24.16.0 and pinned
pnpm 10.20.0; production source image uses pinned Node 24.22.1. No test assertion,
timeout, skip, CI gate or production configuration was weakened.

| Check | Result |
| --- | --- |
| Original-main deterministic production-shaped reproducer | PASS: real SDK fixture reproduced two resolved 200 replies, one valid and missing second-response identity fields. Selected original test took 1.644 s. This establishes a possible mechanism, not the production body. |
| Repeated completion/concurrent-publication tests | PASS: 79 tests on each of three consecutive runs (9.678 / 9.336 / 9.616 s), then 80 tests after the additional sanitized-error preservation case (11.071 s). Final full backend and Linux checks also include that case. |
| Final full Windows backend, `CI=true`, `--runInBand` | **FAIL at suite teardown**, not reported green: 216 suites pass, `PlanService` fails the existing 5-second `closeLoggers()` afterAll hook; all 4,496 assertions pass, 4 existing platform skips, 280.374 s. |
| Unchanged-main logger comparison | Same hook failure reproduced in a disposable main-source archive using the installed locked packages. Three isolated runs: two PASS and one FAIL, all 80 assertions pass every time. Logger, setup and PlanService sources match main byte-for-byte. The underlying logger timing defect is outside this patch; no logger/backup code or timeout was changed. |
| Full isolated Linux backend attempt | 215 suites pass; baseline PlanService teardown fails, plus 16 restore smoke failures because the manually broadened read-only fixture lacked a writable `/data` volume. Not reported as a full-suite PASS. All 16 smoke cases subsequently PASS (26.135 s) with a fresh owned disposable data volume and Docker copy-up disabled. No production mount or application code was changed to obtain that result. |
| Final native Linux security/export/recovery suite, 2 CPU / 4 GiB | PASS: 15 suites, 521 passed / 1 existing Windows/root-only skip; 107.375 s. Includes actual SDK parsing, encryption/keyring, unknown ownership, pending multipart cleanup, cancellation, SIGKILL/reopen and safe reconciliation. |
| Full frontend regressions | PASS: 366 tests, no skips. |
| Backend lint and backend/frontend type checks | PASS. |
| Node deployment/Compose/release security guards | PASS: 24 tests. |
| Linux host-bundle, keyring, CA, overlay policies and POSIX syntax | PASS: 46 Python tests and all deployment shell syntax checks. |
| Final `Dockerfile.source` production build | PASS: frontend/docs/types, backend production build and pinned recovery-client checks. |
| Actual final runtime image release boundaries | PASS: Node 24.22.1, UID/GID 10001; 1,821 entries checked; private state, tests and host fixtures excluded. |
| Full real Linux Docker deployment acceptance | PASS: 19 scenarios on both the initial and final rebuilt image, including bundle upgrade/restore, same-digest reapply, automatic/explicit rollback, SQLite and mount preservation. All disposable resources removed. |
| Native application-encrypted 120 MB TAR acceptance | PASS: original TAR/hash/extraction, real interrupted Range/resume, proxy renewal, standard-download comparison, hard restart, failed multipart retry and cleanup. Marker and five synthetic replica manifests/read-data checks remain intact. |
| Frontend lint baseline | FAIL (unchanged), exit 2: `typescript-eslint.config()` rejects string `eslint-config-prettier` in extends. Frontend configuration and CI gates were not changed or suppressed. |
| Actual HCP / hosted CI / production UAT | NOT RUN. NO-GO retained; historical cleanup remains an operator/vendor matter. No publication, push, merge or deployment was performed. |

The native scenario verified a 120,005,632-byte original TAR, zero server
temporary TAR bytes, zero orphan objects/uploads and zero OOM events. Application
cgroup peak was 1,369,157,632 bytes (about 1.28 GiB); server Node peak RSS was
396,754,944 bytes. CPU averaged 55.21% of the two-CPU quota, measured client
throughput was 17.89 MiB/s and server metadata disk usage was 152,064 bytes.
Disposable fixture resources were removed. These are local reference-provider
measurements, not HCP certification or predictions of production throughput.

The full backend gate is **not green** because of the reproduced baseline logger
teardown failure. Hosted CI on the exact published commit still needs operator
verification; this report does not claim CI PASS. A separate logger lifecycle
investigation is needed if that baseline gate recurs on the hosted runner.

Key reproducer/validation commands (from repository root):

```powershell
pnpm --filter @plutonhq/core-backend test --runInBand --runTestsByPath __tests__/utils/ExportCompletion.test.ts __tests__/services/HcpConcurrentPublication.test.ts
pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-frontend exec tsc -b
node --experimental-strip-types --test frontend/__tests__/*.test.ts
./scripts/validate-managed-resumable-unit.ps1 -Image pluton-hcp-body-native:local
./scripts/validate-managed-resumable.ps1 -Image pluton-hcp-body-native:local -Modes small -SharedNamespace -WriteOnceReference -ApplicationEncrypted -ProductionCompose
docker build -f Dockerfile.source -t pluton-hcp-body:local .
./scripts/validate-deployment.ps1 -Image pluton-hcp-body:local
```
