# HCP dual HTTP 200 completion: diagnosis and operator gates

The incident remains **NO-GO, cleanup pending**. Do not run another production
preflight, adopt the race object or delete it automatically. This patch adds
precise response evidence and corrects diagnostic classification. It does not
certify HCP or implement a different integrity contract. No production resource,
secret, configuration, object or journal was accessed during development.

## Confirmed findings and unknowns

Base `86cc5d0` includes PR #59. The completion path persists exact-key intent and
owned upload IDs, sends MP/MP then MP/MP/PUT races, and lets the pinned SDK parse
the XML. The narrow middleware observes only numeric HTTP status before SDK
normalization. Resolved replies are durably acknowledged before race evaluation.
Valid multipart replies require HTTP 200, a bounded nonempty quoted ETag, no
real VersionId, and exact returned Bucket/Key equality. PUT does not return
Bucket/Key, so those checks are not required for its competitor.

The source defect is diagnostic: `race-multiple-successes` counted **all resolved
acknowledgements**, whereas public `multipleSuccesses` counted only schema-valid
replies. One valid and one invalid 200 therefore produced the reported mismatch.
New failures use `race-multiple-acknowledgements` for that case and reserve
`race-multiple-successes` for two schema-valid replies. The refusal is unchanged.

Old receipts contain only aggregate schema validity. They retain an ETag only
when **all** validation passed. An absent retained ETag on an invalid old receipt
does not prove HCP omitted it. Production evidence establishes two SDK-resolved
200 replies, one valid and one invalid. It identifies neither the failed field
nor two committed objects. Current HEAD cannot reconstruct a past response.
**The exact production invalid-response condition remains NOT ESTABLISHED.**
Original stored failures remain historical evidence and are not rewritten.

## Real SDK reproduction versus production behavior

- Real-SDK fixtures reproduce a valid 200 plus missing/unquoted ETag, missing or
  mismatched Bucket/Key, or real VersionId in a second 200. That second response
  can be emitted without a second commit. Each exact failed gate is now recorded.
- Two schema-valid replies likewise do not prove two commits: a response-only
  fixture emits them after one commit. Both valid replies still block admission.
- Normal `<Error>...</Error>` in HTTP 200 is caught by the SDK and can appear as
  SDK HTTP 503, with wire status 200 retained. In the pinned SDK, Error XML with
  trailing whitespace can instead resolve as HTTP 200 lacking ETag/Bucket/Key.
  Pluton rejects it as invalid. This reproduces the incident's **shape**, not its
  production cause. No error code is invented from a resolved response.
- Malformed and duplicate-field XML can throw generic Smithy parsing errors
  with attached `$response` and HTTP 200. Previously any wire-200 error was
  called embedded-error. The classifier now distinguishes non-service SDK
  deserialization failures, using only the presence of `$response`, never its
  contents. A reset during a 200 response body is transport-error, not proof of
  embedded XML. All remain ambiguous non-ACK outcomes.
- Same-route/different-route models exercise globally enforced write-once and
  a deliberately broken node-local collision rule. Two modeled commits with
  conflicting hashes stay blocked. These are not HCP nodes or certification of
  real load-balancer, replication or routing guarantees.

There is no demonstrated harmless production format exception. The parser and
publication retry policy are unchanged. Missing/mismatched fields or unquoted
ETags are not normalized, and unknown HTTP 200 is never recast as a rejected 409.
One valid ACK plus rejected 409 competitors is still required, followed by
independent conditional HEAD, nonce/binding/identity/size and complete SHA-256
readback before ownership proof. Ambiguous cleanup remains blocked even if live
HEAD or hash matches. Encryption, keyring, privacy and multipart cleanup guards
remain intact; diagnostic booleans never confer ownership.
Even if a later investigation proves the second reply differs only in harmless
formatting, normalizing it into another valid success would still produce **two
valid replies**, not the required single winner. A format fix alone cannot
authorize GO. Nor may an HTTP 200 XML error be relabeled 409 without a separately
proved provider contract for an unambiguous non-commit outcome.

## Official documentation and version limits

The [HCP 9.7.x completion manual](https://docs.hitachivantara.com/r/en-us/mk-95hcph001-20/using-the-hitachi-api-for-amazon-s3/working-with-multipart-uploads/completing-a-multipart-upload?contentId=lynj7qhRyB9IJQpFPhwHog)
describes success XML with Bucket/Key/quoted ETag, VersionId only with versioning,
and possible XML errors after HTTP 200. Its namespace variant is tested through
the SDK. [AWS completion](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html)
also distinguishes initial HTTP status from the final result.

The [latest HCP race page](https://docs.hitachivantara.com/r/en-us/mk-95hcph002/latest/using-the-hitachi-api-for-amazon-s3/working-with-multipart-uploads/about-multipart-uploads/considerations-for-working-with-multipart-uploads/multiple-multipart-uploads-for-objects-with-the-same-name)
is labeled 10.0.x and describes first completion winning, later ones 409. The
version-specific 9.7 race page was not retrievable. Do not treat the latest page
as a verified 9.7.3.14 cluster guarantee.

Official indexed release-note excerpts provide historical context:

- [9.6.1 HCP-46190](https://docs.hitachivantara.com/api/khub/documents/pmD_WLVAD~eTPQ~b02sBpg/content)
  describes differing same-node/cross-node simultaneous-write behavior in an
  overwrite compatibility issue. It does not identify this incident's replies.
- [9.7 HCP-46223](https://docs.hitachivantara.com/api/khub/documents/cX8H2dkRv5GAh6h630ThHQ/content)
  describes last-finisher behavior for **overwrite-enabled** namespaces; that
  condition does not establish this deployment's behavior.

Full release-note downloads returned access errors; official indexed excerpts
were available. Neither note proves an applicable bug/fix in 9.7.3.14. Require
administrator/vendor confirmation for the actual build/policy/routes. Do not
enable overwrite or pin routing to hide a failed race.

## Sanitized schema diagnostics

`publications` remains bounded to two races of three operations. Additive
`acknowledgedResponses`, `validSuccessResponses` and `multipleAcknowledgements`
separate receipt counts from valid reply counts. Existing `multipleSuccesses`
still means multiple schema-valid replies, **not independently verified commits**.
No commit count is inferred. Example of a synthetic second 200 missing identity:

```json
{
  "competitor": "multipart-b",
  "operation": "CompleteMultipartUpload",
  "httpStatus": 200,
  "wireHttpStatus": 200,
  "response": "invalid-response",
  "acknowledged": true,
  "durableReceipt": true,
  "validationEvidence": "recorded",
  "validation": {
    "status200": true,
    "entityTagPresent": true,
    "entityTagQuoted": true,
    "versionAbsentOrNull": true,
    "objectIdentityRequired": true,
    "bucketPresent": false,
    "bucketMatches": false,
    "keyPresent": false,
    "keyMatches": false
  }
}
```

All gates are evaluated, not just the first short-circuit condition. False fields
identify failed requirements. Old acknowledged receipts show
`validationEvidence:not-recorded`; pending/rejected operations show
`not-evaluated`. Corrupt/incomplete records are not repaired or projected as
verified. No historical evidence is backfilled. `httpStatus` is SDK status;
`wireHttpStatus` is the numeric pre-normalization observation when available.

Projection allows only fixed booleans, enum values and bounded HTTP numbers.
No actual Bucket/Key, ETag, VersionId, node address, request ID/signature,
header, raw XML/body, credential or encryption material is copied. New checks
are informational and cannot reconstruct or relax proof. Job/page limits,
durable receipt boundaries and ownership verification remain unchanged.

## Existing incident: read-only first, separate deletion authorization

Use the current incident ID from the operator's private record, target `race`;
do not change a previous reconciled job or commit real identifiers here.

1. Preserve image digest, reviewed bundle/Compose contract, protected `.env`,
   exact data volume, private keyring/CA overlays and a consistent journal backup
   using the existing approved procedure. Do not copy live SQLite inconsistently,
   edit proof fields or restore an older journal to clear cleanup-pending.
2. With the original owner's authenticated same-origin browser, GET
   `/api/managed-exports/preflights/<incident-id>` and explicitly GET
   `/api/managed-exports/preflights/<incident-id>/diagnostics`. The latter performs
   bounded read-only metadata/parts inspection, no body download or mutation.
   Wrong owner, active job, concurrent cleanup and changed destination are refused.
   Preserve sanitized status/failures before any separately approved deployment.
3. Old receipts cannot reveal a schema bit that was not saved. After an
   operator-approved patch deployment, old evidence still says `not-recorded`.
   Do not start a replacement preflight over an unresolved object to obtain bits.
4. Ask the authorized HCP administrator to correlate the exact live object and
   owned upload IDs with retained completion/audit and routing records. Inspect
   current size, ETag, timestamps and metadata privately through existing tools.
   Retained raw responses may be examined only within approved private vendor
   support handling, never posted or added to application logs. No additional
   AWS CLI, Python or SDK installation in production is required.
5. A matching filename/hash/HEAD/owner/metadata alone cannot establish current
   object ownership or absence of a competing commit. Without sufficient
   attribution, retain the protected object, journal and NO-GO.
6. Only with independent administrator attribution of the **current exact object**
   and separate explicit operator deletion authorization, follow the existing
   [single-object reconciliation procedure](HCP_CONCURRENT_PUBLICATION_RECOVERY.md#separate-explicitly-authorized-reconciliation).
   Pause new export admission through the reviewed process, recheck identity,
   remove only the authorized individual artifact and preserve audit evidence.
   No prefix/bucket delete, marker deletion, unknown-upload abort or policy change.
7. Independently verify all four tracked objects absent and no relevant multipart
   upload remains. The original owner may then invoke the existing
   `DELETE /api/managed-exports/preflights/<incident-id>` cleanup retry and poll
   for `state:cancelled`, `cleanupPending:false`. Keep original failure history.
8. Before any later preflight, require read-only Inventory Ready, `objects:0`,
   `uploads:0`, `exclusive:true`, and `directoryMarker:verified-empty` if present.
   Any unknown entry blocks admission. Only a separately authorized new preflight
   after clean admission may obtain new actual provider evidence.

## Alternatives if conflicting publications are genuinely allowed

These are evaluations, not implemented fallbacks or current GO:

| Candidate | Additional separately validated contract | Current decision |
| --- | --- | --- |
| Existing HCP write-once | One durable valid winner, rejected competitors and consistent independent readback/cleanup across actual routes | BLOCKED until proven. |
| Atomic conditional publication | Cluster-wide PUT/multipart compare-and-create, losing-upload handling, identity, crash recovery and cleanup | NOT VALIDATED; accepting a conditional header does not prove CAS. |
| Immutable versioned destination | Stable version-specific readback/Range/cleanup and guaranteed retention of selected bytes, with reviewed encrypted-mode support | NOT IMPLEMENTED for this encrypted-HCP configuration. No automatic mode/policy switch. |
| Enforced immutability/retention | Overwrite/deletion protection for required lifetime, finite quotas, authorized cleanup/expiry and encrypted recovery support | NOT VALIDATED; changing shared retention is outside this task. |
| Application lock, random keys or sticky routing alone | Cannot prevent other writers, provider races or deletion | INSUFFICIENT; cannot receive GO. |

AES-GCM detects substituted/corrupt data; it does not prevent overwrite/deletion
or guarantee durability. A new design requires a separately validated integrity,
durability, overwrite-protection, privacy, keyring and cleanup/restart contract.

## Deployment, UAT and rollback

Operator publishes/reviews the branch, checks hosted CI on the exact commit and
merges only after approval. Retain keys/journal/configuration and previous digest
before deploying the approved immutable image with the existing reviewed bundle:

```sh
sudo sh /opt/pluton/install.sh 'sha256:<approved-image-digest>'
sudo sh /opt/pluton/status.sh
```

No `.env`, region, endpoint, bucket, keyring, namespace, mount or Agent change is
needed. Status must verify health/image/UID/mounts/export environment privately.
Preserve application-encrypted mode and read-only keyring. Diagnostics can be
deployed while the unresolved object stays protected; admission remains blocked.

After reconciliation, clean Inventory and separately authorized new preflight,
require one valid response, rejected competitors, independent ownership proof,
all mandatory capabilities, `state:ready`, actual `productionReadiness:GO`, and
`cleanupPending:false`. Then test an existing small regular-file snapshot:
authenticated TAR byte count/SHA-256/extraction, staged Restore, interruption and
Range/resume, expiry/renewal, cleanup and clean inventory again. Follow the exact
private-client/resource checks in [marker UAT](HCP_DIRECTORY_MARKER_UAT.md).
Only advance to medium/large snapshots after small UAT. Preserve all backup,
Standard Download, Restore, Agent, SFTP and S3 replication settings/schedules.

Ambiguous/conflicting outcomes retain NO-GO; do not loop preflight or disable a
gate. Pause new export admission through the reviewed procedure if necessary.
For regression, retain the new journal/receipts and use image rollback:

```sh
sudo sh /opt/pluton/rollback.sh
sudo sh /opt/pluton/status.sh
```

Rollback does not reverse migrations or permit deletion of an unknown object.
Do not replace SQLite with an older copy, regenerate keys or force-clear cleanup.
Investigate unhealthy rollback through the existing reviewed recovery procedure.

## Reproduction commands

```powershell
pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
node --experimental-strip-types --test frontend/__tests__/*.test.ts
./scripts/validate-managed-resumable-unit.ps1
./scripts/validate-managed-resumable.ps1 -Modes small -SharedNamespace -WriteOnceReference -ApplicationEncrypted -ProductionCompose
docker build -f Dockerfile.source -t pluton-hcp-schema:local .
./scripts/validate-deployment.ps1 -Image pluton-hcp-schema:local
```

All fixtures are isolated/disposable. Routing tests are explicit models, not HCP
certification. Existing parser/encryption/privacy/ownership/cleanup tests remain
enabled. Record frontend lint baseline failures separately. Local PASS is not
hosted CI PASS or production GO.

## PASS / BLOCKED / NOT TESTED record (2026-11-03)

Branch: `codex/hcp-completion-response-diagnostics`, based on `origin/main`
`86cc5d0`. No production mutation, push, merge, deployment or security downgrade.

| Check | Status and evidence |
| --- | --- |
| Complete backend with `CI=true`, serial Jest | PASS: 216 suites; 4,455 passed, 4 existing platform skips, no failures; 260.595 s. |
| Linux export/recovery/security suite, 2 CPU / 4 GiB | PASS on isolated recheck: 14 suites; 480 passed, 1 existing Windows/root-only skip; 98.029 s. Initial run alongside native/build work had 479 passed and one existing 5-second ownership-test timeout in `RemoteRepositoryRecoveryService`; recheck passed with unchanged timeouts, assertions and resource limits. Resource contention is plausible, not a proven root cause of that unrelated timing failure. |
| Full frontend regressions | PASS: 366 tests, no skips. |
| Backend lint, backend/frontend types | PASS. |
| Node deployment/Compose/release security guards | PASS: 24 tests. |
| Linux host-bundle/Compose/keyring/CA policies and POSIX syntax | PASS: 46 Python tests and all deployment shell syntax checks. |
| `Dockerfile.source` production build | PASS: frontend/docs/types, backend build and pinned client checks. |
| Actual built runtime release boundaries | PASS: 1,813 entries checked, Node 24.22.1 / UID/GID 10001; private state, fixtures and crash driver excluded. |
| Full real Linux Docker deployment acceptance | PASS: 19 scenarios including bundle upgrade/restore, same-digest reapply, automatic/explicit rollback and SQLite/mount preservation. Disposable resources removed. |
| Native authenticated encrypted 120 MB TAR | PASS: Range/resume, size/SHA-256/extraction, standard-download comparison, privacy denials, hard process restart, failed multipart retry, cleanup, unchanged marker and five synthetic replica manifests/read-data checks. |
| Frontend lint baseline | FAIL (unchanged), exit 2: `typescript-eslint.config()` rejects string `eslint-config-prettier` in extends. No frontend code/configuration or CI gate was changed or suppressed. |
| Actual HCP incident's failed schema condition | BLOCKED: required old response fields/bits were not retained; current HEAD cannot reconstruct them. New historical status explicitly reports `not-recorded`. |
| HCP 9.7.3.14 concurrent publication across actual routes | NOT TESTED; no production access. Remains NO-GO until independently proved. |
| Alternative integrity/storage designs | NOT VALIDATED or activated. No fallback receives GO. |
| Historical object removal / journal repair | NOT PERFORMED. Object remains protected pending independently attributed, separately authorized operator reconciliation. |
| Hosted CI / production UAT | NOT TESTED; operator publication and verification required. |

The native scenario produced a verified 120,005,632-byte TAR with zero server
temporary TAR bytes, zero orphan objects/uploads and zero OOM events. Application
cgroup peak: 1,402,867,712 bytes (about 1.31 GiB); server Node peak RSS: 393,097,216
bytes. CPU averaged 57.15% of its two-CPU quota; measured client throughput was
12.98 MiB/s; server metadata disk usage was 143,872 bytes. Fixture infrastructure
was removed. These are local reference-provider measurements, not production
performance or HCP certification. Local test fixtures use Node 24.16.0 and pnpm
10.20.0; the production source image uses its pinned Node 24.22.1.

Exact changed files:

- `backend/src/utils/managedExport/ExportPublication.ts`: per-field boolean
  validation, bounded projection, distinct ACK/schema-valid counts and old-record
  evidence availability; existing winner/proof rules unchanged.
- `backend/src/utils/managedExport/HcpWriteOnceStorage.ts`: persist schema bits
  with each resolved receipt, expose safe wire status on resolved replies, correct
  failure naming and SDK parsing/transport classification; no new provider reads,
  response body capture, proof adoption or cleanup bypass.
- `backend/src/utils/managedExport/ExportDiagnostics.ts`: fixed allowlist entry
  for `race-multiple-acknowledgements`.
- `backend/__tests__/fixtures/hcpPublicationProtocol.ts`: controlled dual-200,
  schema, parser/stream and routing models with independent fixture commit counts.
- `backend/__tests__/services/HcpConcurrentPublication.test.ts`: real-SDK schema
  and classification regressions, no inferred commits, protected cleanup and
  read-only diagnosis, retaining all original crash/encryption/ownership tests.
- `backend/__tests__/utils/ExportDiagnostics.test.ts`: exact boolean projection,
  private/corrupt-field exclusion, and no historical evidence fabrication.
- `docs/HCP_CONCURRENT_PUBLICATION_RECOVERY.md`: link to current investigation.
- `docs/HCP_HTTP200_COMPLETION_DIAGNOSTICS.md`: findings, limits, safe diagnostics,
  alternatives, reconciliation/UAT/rollback and this validation record.
