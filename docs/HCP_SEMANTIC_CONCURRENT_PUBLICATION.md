# HCP final-error concurrent publication verdict

Base: `90c4e90` (main including PR #61). Branch:
`codex/hcp-concurrent-publication-verdict`. This is a narrowly scoped semantic
verdict fix for **new application-encrypted HCP preflights**. It does not grant
ownership of the historical failed preflight's object. That incident remains
NO-GO until separately authorized reconciliation. No production access, live
probe, namespace/configuration change, remote push, merge or production
deployment was performed. Runtime validations used disposable fixtures only.

## Confirmed cause and response path

The supplied evidence now distinguishes a final `OperationAborted` Error body
from a success body. On unchanged main, a deterministic real-SDK fixture with
multipart A returning that complete HTTP 200 Error and multipart B returning a
valid HTTP 200 success reproduces one resolved ACK, one valid success and an
ambiguous verdict. The baseline selected test passed with those NO-GO
expectations before production code was changed.

The old verdict required every losing request to have HTTP 409 and
`response:provider-error`. PR #61 correctly parsed and rejected the embedded
Error, retaining status 200 and `acknowledged:false`; the status-only loser rule
then rejected the race. Without a proven winner, cleanup correctly refused to
adopt/delete the object. The cleanup failure is consequential; it does not by
itself establish an HCP DELETE permission problem. Original preflight and later
cleanup failures remain separate records.

The complete path is HTTP handler -> command-local body inspector -> S3/Smithy
deserialization and retry middleware -> sanitized operation error -> synchronous
SQLite FULL race receipt -> verdict -> multipart absence -> independent object
verification -> durable ownership proof. An embedded completion Error body never
enters the successful publication or ACK count.

## Protocol evidence and its limits

- [HCP 9.7 completion](https://docs.hitachivantara.com/r/en-us/mk-95hcph001-20/using-the-hitachi-api-for-amazon-s3/working-with-multipart-uploads/completing-a-multipart-upload?contentId=lynj7qhRyB9IJQpFPhwHog)
  distinguishes the initial HTTP 200 processing acknowledgement from the final
  object-result or Error document. Returned identities describe success.
- [HCP 9.7 error codes](https://docs.hitachivantara.com/r/en-us/mk-95hcph002-19/using-the-hitachi-api-for-amazon-s3/requests-and-responses/error-codes)
  give error codes meaning in addition to transport status. `OperationAborted`
  describes a conflicting operation that cannot be performed, including creation
  at an existing name while versioning is disabled. Other listed contexts include
  retention-related deletion and operations on an object being written; those
  are not this known CompleteMultipartUpload request. Direct page retrieval
  returned an access error during this investigation; the public Hitachi-indexed
  9.7.x text was available. No protected documentation/account was accessed.
- [AWS CompleteMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html)
  likewise distinguishes a final embedded error from initial HTTP 200 headers.
  [AWS Error](https://docs.aws.amazon.com/AmazonS3/latest/API/API_Error.html)
  identifies `OperationAborted` as a conflict, rather than success.

The **protocol inference** used here combines the final Error contract with
OperationAborted's non-performing conflict meaning, for one known completion
request. The HCP error table lists that code under 409; it does not separately
enumerate the observed HTTP 200/code combination. We preserve the real 200 and
interpret only the verified final error semantics. This is not a claim that
every error is non-committing, nor certification of a particular HCP build or
cluster. The latest multipart-race manual is labeled a different HCP version
and is not used as evidence of a 9.7.3.14 guarantee.

A later retry could report OperationAborted after an earlier request committed.
Consequently neither the code string alone nor a final error after unknown
attempts proves non-commit. Single-dispatch evidence is mandatory. InternalError,
SlowDown, unknown codes, lost/truncated responses and incomplete parser evidence
remain ambiguous. If the provider violates this final-error contract, retain
NO-GO and require vendor resolution or an independently validated alternate
storage/publication design.

## Exact admission and ownership requirements

New application-encrypted races write `protocol:hcp-final-error-v1` with their
original intent **before completion/PUT publication**, binding the exact random
key, destination, snapshot binding, ownership nonce, distinct owned upload IDs,
expected lengths and SHA-256 digests. Cleanup never creates/upgrades this marker.

The semantic loser must meet every condition:

1. Known CompleteMultipartUpload request, rejected outcome, original and wire
   status 200, `embedded-error`, no success flag or retained success ETag.
2. Complete bounded UTF-8 XML, accepted strict parser, Error root, supported
   namespace and exactly one unambiguous scalar Code equal to OperationAborted.
   Duplicate/foreign/attributed/nested Code fields or mixed success identities
   cannot establish this witness. No code/message normalization supplies proof.
3. One observed completion dispatch, no blocked replay, and no SDK success
   deserialization. The Error remains rejected and never counts as an ACK.
4. Exactly one strict winning response, complete success schema/body for a
   multipart winner, and exactly one recorded request attempt for every
   competitor when semantic rejection is used. A normal PUT winner uses its
   appropriate response schema and SDK attempt evidence, not multipart XML.
5. All other competitors must have the same verified semantic rejection or a
   documented actual 409 OperationAborted conflict. Fresh unknown-code 409s,
   arbitrary HTTP 200 errors, multiple successes and inconsistent receipts fail.

The response verdict is only a **candidate**, not ownership. Both original
multipart IDs must remain durably journal-owned and distinct. Abort only the
known losing upload, verify each original upload absent through ListParts, and
require a complete empty bounded multipart listing before object proof. Unknown
or still-visible uploads block proof and are never aborted/adopted automatically.

Next require the matching successful creation receipt, exact ETag/size/version,
destination/snapshot binding and nonce metadata, and full byte-count/SHA-256
readback before publishing ownership to SQLite. Existing encryption/keyring,
authenticated plaintext readback, TLS, privacy, Range, conditional identity and
cleanup gates are retained. Actual archive upload/download encryption is
unchanged. Random race payloads are disposable probes, never real backup data.

The completion inspector runs inside SDK retry processing and blocks a second
dispatch before HTTP, even if a retry configuration regresses. Production
`maxAttempts:1` remains unchanged. Tests exercise both the real pinned standard
V2 retry strategy with controlled zero backoff and a duplicate-dispatch strategy;
both are stopped after one actual HTTP request.

## Historical records and restart safety

The new protocol and optional `operationAbortedVerified`, `requestAttempts` and
`replayBlocked` evidence are written only by new live processing. Historical
response diagnostics are not sufficient, are not backfilled and cannot change
an ambiguous old race into a winner. Matching key, HEAD, metadata, nonce or hash
alone remains insufficient. Existing legitimate legacy 409 receipt/proof cleanup
retains its prior contract; no old HTTP 200 error is newly adopted.

On a new-protocol crash before the winner receipt or while a competitor is
pending, cleanup remains blocked. After all fresh receipts are durably settled,
restart reconciliation may finish verification: it aborts only original owned
uploads, repeats multipart absence/listing checks, then independently verifies
the current object and durably records proof. A saved absence flag alone never
authorizes deletion. Unknown uploads, missing receipts, failed journal writes or
inconsistent current bytes/metadata keep NO-GO and protect the object.

Public diagnostics remain bounded to two races of at most three operations.
Only protocol enums, booleans, bounded attempt counts and existing allowlisted
categories/codes are added. No raw XML, object names, ETags, headers, signatures,
credentials, key material or encrypted bytes enter these diagnostics.

Synthetic diagnostic subset after fresh verification (not a production capture):

```json
{
  "protocol": "hcp-final-error-v1",
  "httpAcknowledgements": 2,
  "acknowledgedResponses": 1,
  "validSuccessResponses": 1,
  "ambiguityRemaining": false,
  "operations": [
    {
      "competitor": "multipart-a",
      "wireHttpStatus": 200,
      "httpStatus": 200,
      "response": "embedded-error",
      "providerCode": "OperationAborted",
      "acknowledged": false,
      "requestAttempts": 1,
      "uploadAbsent": true,
      "completion": {
        "body": "complete",
        "xml": "error",
        "xmlParser": "accepted",
        "sdkParser": "not-run",
        "operationAbortedVerified": true,
        "requestAttempts": 1,
        "replayBlocked": false
      }
    },
    { "competitor": "multipart-b", "response": "success", "acknowledged": true }
  ]
}
```

This is not overall GO on its own. All mandatory gates and cleanup must still
finish. After successful cleanup, current object ownership can be absent because
the disposable artifact was deleted; that does not erase the verified response
history. Multipart absence requires HTTP 200, explicit `IsTruncated:false` and
no remaining entries; missing indicators, partial listings and unexpected status
codes fail closed before proof is created.

## Existing incident: safe operator reconciliation

1. Preserve the current image/bundle, consistent SQLite/export journal, data
   volume, private keyring/CA and protected configuration. Do not edit receipts,
   protocol markers, proof fields, states or cleanup flags.
2. As the original authenticated owner, read
   `GET /api/managed-exports/preflights/<incident-id>` and explicitly read
   `GET /api/managed-exports/preflights/<incident-id>/diagnostics`. This performs
   bounded read-only metadata/parts inspection. Retain original failure and
   latest cleanup failure separately. An upgraded image cannot recreate missing
   historical dispatch/parser evidence.
3. Have an authorized HCP administrator independently attribute the exact current
   artifact and outstanding upload IDs using private audit/support records.
   Require the actual build/namespace/routing contract to be confirmed. Matching
   current metadata alone is insufficient; do not publish object identities or
   raw provider/support output.
4. Without adequate attribution, retain the object and NO-GO. Only independent
   attribution **and separate explicit deletion authorization** permit the
   existing [exact-object reconciliation procedure](HCP_CONCURRENT_PUBLICATION_RECOVERY.md#separate-explicitly-authorized-reconciliation).
   No bucket/prefix purge, marker deletion, replica deletion, namespace policy
   change or unknown-upload abort is authorized by this patch.
5. Verify all tracked artifacts and relevant multipart uploads absent. The
   original owner may then retry the existing owner-bound DELETE cleanup and
   require `cleanupPending:false`. State cancelled alone is insufficient.
   Preserve the historical failure and journal.

## Production GO/NO-GO and one controlled final preflight

| Gate | Required result |
| --- | --- |
| Review and CI | Exact operator-published commit reviewed; hosted CI actually completes. Local tests do not replace it. Resolve any recurring baseline logger/lint gate separately. |
| Existing incident | Independently reconciled with separate deletion authorization; cleanupPending false. No historical proof manufacture. |
| Inventory | Ready, zero reserved objects/uploads, exclusive true, verified empty directory marker if present. Any unknown entry blocks admission. |
| Configuration | Existing reviewed mode, verified TLS/CA, private keyring and isolated credentials/prefix; no overwrite/versioning/namespace change or weakened gate. |
| New owner-authorized preflight | One new disposable preflight, every mandatory check passes, one candidate winner per race, owned multipart absence, independent readback and completed cleanup. |
| Final state | ProductionReadiness GO and cleanupPending false. Any ambiguity, inconsistent proof or cleanup failure means NO-GO and stop. |

Only after the preceding prerequisites, the operator may deploy the reviewed
immutable image using the existing bundle and start **one** new preflight from
the owner-bound UI. Inspect its new protocol/parser/attempt evidence. Do not
loop probes over unresolved objects or retry completion manually. On failure,
stop and preserve sanitized evidence for the administrator/vendor. This task
does not authorize or run that production procedure.

After actual GO and clean cleanup, separately authorize the initial existing
120 MB snapshot test using Reliable Download. Verify final TAR size/hash and
extraction locally, interrupt the transfer and resume, and verify the same
complete TAR again. Keep signed links and contents private. Monitor CPU/RAM,
disk, network, upload/object cleanup and ongoing backup/replication behavior
using the existing [encrypted HCP runbook](APPLICATION_ENCRYPTED_HCP.md). A fresh
preflight is justified only after reconciliation, clean inventory, CI and
operator approval; the historical job must not be reused to obtain GO.

## Rollback and alternate design

Retain the prior approved immutable image/bundle, current SQLite and keyring.
Pause export admission through the reviewed operator procedure before rollback,
then use the existing bundle's image/script rollback with unchanged data and
mount contracts. Never restore an older database to erase pending cleanup or
regenerate/delete a keyring. Backup plans, original repositories, Agent,
replication and existing mounts are not changed by this fix. Older images may
refuse the new semantic receipts; retain their metadata and protect pending
objects for review rather than editing them into legacy proof.

This is a real verdict/ownership-boundary fix under the documented final-error
contract, not a replacement storage design. If the actual provider cannot honor
it, keep NO-GO. Alternatives require separately validated immutable generations
or cluster-wide compare-and-create plus exact immutable identities, durable
publication receipts, byte verification and safe conditional cleanup/GC. A
dedicated versioned destination has its own mode/support gates. Random keys,
application encryption, local locks or sticky routing alone do not supply
equivalent overwrite/ownership guarantees. No fallback is enabled here.

## Code diff and validation

- `ExportCompletion.ts`, `ExportCompletionShape.ts`: strict final-error witness,
  per-command dispatch guard and bounded optional diagnostic fields.
- `ExportDiagnostics.ts`: retain bounded SDK attempt evidence and a fixed replay
  rejection detail while stripping raw SDK attachments.
- `ExportPublication.ts`: fresh protocol-scoped semantic verdict; consistent
  success validation, distinct upload IDs and separate candidate/owned winner.
- `HcpWriteOnceStorage.ts`: persist fresh protocol before publication, record
  observed attempts, settle/verify owned uploads before proof, and recheck
  absence on restart. No historical protocol upgrade path.
- Protocol/crash/unit fixtures: both loser orders, other error codes, corrupted
  parser/identity/receipt data, unknown uploads, denied cleanup, hash/nonce
  mismatch, SDK retry/duplicate prevention and six actual SIGKILL checkpoints.
- Native TLS reference gateway/lab: model concurrent multipart conflicts as
  HTTP 200 OperationAborted while forwarding real MinIO storage, encrypted TAR,
  resume, cleanup and replica checks. The reference is not HCP certification.

No production configuration, dependencies, database schema or backup/restore
implementation changed. Existing response/body, encryption and deployment
regressions remain enabled. Detailed PASS/BLOCKED/NOT TESTED results follow.

### Review and verification matrix — 2026-11-04

Review checked four authority transitions: raw response to fixed witness;
durable receipt to candidate; candidate to independently verified ownership;
ownership to exact cleanup. Tests deliberately break each transition. No
ESLint rule, assertion, deadline, skip or CI gate was weakened.

| Check | Status | Evidence |
| --- | --- | --- |
| Exact baseline reproduction on unchanged main source | PASS | New deterministic fixture reproduces 200 OperationAborted A / valid 200 winner B, one valid ACK, ambiguous NO-GO before verdict changes; selected baseline test 12.105 s. |
| Repeated focused parser/verdict/ownership suites | PASS | 163 tests in each of three consecutive runs: 18.059 / 16.413 / 16.478 s. Final four-suite run includes two additional listing negatives: 165 passed, 16.707 s. |
| Full backend, CI=true, serial | BLOCKED by baseline teardown | Initial full run: 217 suites, 4,523 passed / 4 existing platform skips, exit 0, 338.275 s. Final run after two listing negatives: all 4,525 assertions passed / 4 existing skips, but PlanService's existing 5-second closeLoggers afterAll timed out; 216 suites pass / 1 teardown failure, exit 1, 326.172 s. Not reported as a final green gate. |
| Unmodified latest-main logger comparison | PASS diagnosis / baseline unresolved | Source archive of 90c4e90 with the same installed locked packages: isolated PlanService first passes (80 assertions, 8.496 s), then reproduces the same hook timeout (all 80 assertions pass, 7.450 s). Logger, setup and PlanService sources are unchanged. No timeout or logging fix is bundled here. |
| Final Linux security/export/recovery suite, 2 CPU / 4 GiB | PASS | 15 suites; 550 passed / 1 existing Windows/root-only skip; 138.118 s. Includes actual pinned SDK, standard V2 retries, six SIGKILL/reopen cases, historical ownership protection, incomplete/unknown multipart and failed persistence/readback. |
| Full frontend regression suite | PASS | 366 tests, no skips. |
| Backend lint; backend/frontend types | PASS | Exact backend ESLint command and TypeScript checks; production compilation also succeeds. |
| Frontend lint | BLOCKED by existing configuration | Exit 2: typescript-eslint.config rejects the string eslint-config-prettier in extends. Frontend configuration and gates are unchanged. |
| Deployment/Compose/release source guards | PASS | 24 Node tests. |
| Linux bundle/overlay/private CA/keyring policies | PASS | 46 Python tests and all deployment POSIX shell syntax checks. |
| Final production source image | PASS | Dockerfile.source frontend/docs/types/backend build and pinned client checks; Node 24.22.1. |
| Final runtime release boundaries | PASS | UID/GID 10001, read-only restricted inspection; 1,821 entries; test fixtures, private state and host operators excluded. |
| Full real Linux Docker deployment acceptance | PASS | 19 scenarios on the initial and final rebuilt images; host-bundle upgrade/restore, reapply, automatic/explicit rollback, SQLite, environment and mount preservation; disposable resources removed. |
| Final native TLS encrypted TAR / Range / resume | PASS | 120,005,632-byte original TAR verifies size/SHA-256/extraction. 14 HTTP 200 OperationAborted reference responses exercise the semantic path; hard restart, safe retry, cancellation and cleanup pass. Standard Download comparison, structural marker and five synthetic replica manifests/read-data checks remain intact. |
| Actual HCP build/cluster and production readiness | NOT TESTED / NO-GO pending handoff | No live HCP calls. The old ambiguous job is not upgraded or adopted. Actual provider conformance requires the separately authorized controlled preflight after reconciliation and clean admission. |
| Historical artifact deletion / namespace or production configuration changes | NOT TESTED / not performed | No permission to mutate production was exercised. Administrator attribution and separate exact-artifact authorization remain required. |
| Hosted GitHub Actions | NOT TESTED | Operator must publish/review the exact local commit and verify the hosted workflow. No CI PASS claim. |

Native final-run resource evidence: zero server temporary TAR bytes, zero orphan
objects or parts, zero OOM events/kills; application cgroup peak 1,208,115,200
bytes (about 1.13 GiB), server Node peak RSS 391,479,296 bytes, metadata disk
160,256 bytes, average CPU 56.66% of the two-CPU quota, measured client throughput
11.17 MiB/s. The fixture infrastructure was removed. These are local reference
measurements, not production HCP performance or vendor certification.

The verdict fix is implemented and exercised under the documented contract.
Production GO remains blocked by incident reconciliation, actual provider
verification, review/CI and operator authorization. No alternate protocol is
silently selected when a mandatory guarantee fails.

Validation entry points (from repository root, pinned pnpm 10.20.0):

```powershell
pnpm --filter @plutonhq/core-backend test --runInBand --runTestsByPath __tests__/utils/ExportCompletion.test.ts __tests__/services/HcpConcurrentPublication.test.ts __tests__/services/HcpWriteOnceStorage.test.ts __tests__/utils/ExportDiagnostics.test.ts
pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-frontend exec tsc -b
node --experimental-strip-types --test frontend/__tests__/*.test.ts
./scripts/validate-managed-resumable-unit.ps1 -Image pluton-hcp-body-native:local
./scripts/validate-managed-resumable.ps1 -Image pluton-hcp-body-native:local -Modes small -SharedNamespace -WriteOnceReference -ApplicationEncrypted -ProductionCompose
docker build -f Dockerfile.source -t pluton-hcp-verdict:local .
./scripts/validate-deployment.ps1 -Image pluton-hcp-verdict:local
```

Exact changed files:

```text
backend/src/utils/managedExport/ExportCompletion.ts
backend/src/utils/managedExport/ExportCompletionShape.ts
backend/src/utils/managedExport/ExportDiagnostics.ts
backend/src/utils/managedExport/ExportPublication.ts
backend/src/utils/managedExport/HcpWriteOnceStorage.ts
backend/__tests__/fixtures/hcpPublicationProtocol.ts
backend/__tests__/fixtures/hcpPublicationCrash.process.ts
backend/__tests__/services/HcpConcurrentPublication.test.ts
backend/__tests__/services/HcpWriteOnceStorage.test.ts
backend/__tests__/utils/ExportCompletion.test.ts
backend/__tests__/integration/writeOnceReferenceGateway.ts
backend/__tests__/integration/managedResumableRecovery.lab.ts
docs/HCP_COMPLETION_BODY_VERIFICATION.md
docs/HCP_SEMANTIC_CONCURRENT_PUBLICATION.md
```
