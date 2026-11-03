# HCP concurrent publication: evidence, recovery and operator UAT

Reliable Download remains **NO-GO until the actual destination proves every
required capability and cleanup completes**. This change neither certifies HCP
nor adopts or deletes an existing historical object. No production resources
were accessed during development. Keep the existing incident job and audit trail.
For dual HTTP 200 results, see the [schema diagnostics and operator gates](HCP_HTTP200_COMPLETION_DIAGNOSTICS.md).

## Findings and evidence boundaries

| Evidence | What it establishes |
| --- | --- |
| Production incident supplied by the operator | Inventory Ready; 13 preflight gates passed; concurrent-publication failed; cleanup found the `race` target present without its durable ownership proof. The actual competing HTTP responses were not captured. |
| Source-code defect, reproduced against original main | A successful completion plus a competitor 404 throws before `record()` is called. The successful acknowledgement is lost from the journal. The new protocol regression fails on original main at the exact missing-acknowledgement assertion. |
| Source diagnostic defect | `unknown`/namespace failure flags could borrow proof from an unrelated archive/probe. Newly generated flags require an exact target; concurrent operations have separate receipt records. |
| HCP 9.7.x completion documentation | Completion can return HTTP 200 before reporting an XML error; success has a result body; multipart ETags do not establish a content checksum. The current request uses XML and does not send forbidden custom metadata headers on completion. |
| Supplied HCP race documentation | The currently accessible `latest` page identifies itself as **10.0.x**, describing first completion wins, later completions 409, with losing parts retained until abort. This is the modeled contract, not retrieved proof of a 9.7.3.14 cluster guarantee. The version-specific 9.7 race page could not be retrieved in this session. |
| Pinned SDK inspection and real-SDK protocol tests | The SDK detects embedded XML errors and may rewrite an HTTP 200 response to SDK status 503. A response namespace used by the 9.7 completion documentation parses correctly. No parser bypass or compatibility exception was justified. |
| Controlled simulation | 200/409, two valid success responses, 200 embedded errors, malformed/incomplete results, lost ACKs, unexpected competitor 400/404/412/500, inconsistent 409/live content, failed journal writes and process crashes have distinct tested outcomes. None proves what production returned. |

Sources: [HCP 9.7.x completion](https://docs.hitachivantara.com/r/en-us/mk-95hcph001-20/using-the-hitachi-api-for-amazon-s3/working-with-multipart-uploads/completing-a-multipart-upload?contentId=lynj7qhRyB9IJQpFPhwHog),
[current HCP race page (10.0.x)](https://docs.hitachivantara.com/r/en-us/mk-95hcph002/latest/using-the-hitachi-api-for-amazon-s3/working-with-multipart-uploads/about-multipart-uploads/considerations-for-working-with-multipart-uploads/multiple-multipart-uploads-for-objects-with-the-same-name),
[AWS completion](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html).
Do not replace missing production evidence with the newer manual or a local PASS.

The incident's 32-byte binary sample is consistent with random concurrency-probe
data; it is not a backup TAR. Its size does not identify the winning request.
The acquired sample's digest identifies that copy, not the current live object.
An HCP account owner is not job ownership; Deletion Allowed is not application
authorization. “Multipart object; no hash” does not mean an active unfinished
upload still exists. Retain the incident-specific IDs, names and hash in the
operator's private incident record, not this public repository.

## Publication and cleanup contract

Before sending competing completions, Pluton commits a bounded intent for two
multipart competitors and, in the separate three-way check, a PUT competitor.
Private intent binds exact key, destination, job binding, nonce, expected byte
count and SHA-256, plus already owned upload IDs. Each settled operation commits
its own receipt immediately, before waiting for unrelated competitors. SQLite's
existing `journal_mode=DELETE`, `synchronous=FULL`, atomic single-row updates and
32 KiB job limit remain in use; no schema migration or credential data is added.

A receipt is evidence of the observed response, **never delete permission**.
Exactly one valid success response and only genuine rejected HTTP 409 competitors
may form a settled single-winner candidate. Multipart success additionally binds
the response Bucket/Key; a missing ETag, unexpected version or malformed response
remains invalid. Independent conditional HEAD and full checksum readback must
verify ownership nonce, binding, metadata, ETag, size, timestamp and expected hash
before a complete race ownership proof is committed. Both MP/MP and MP/MP/PUT
checks remain mandatory. The SDK, TLS and single-attempt publication behavior
remain unchanged; the narrow middleware records only a numeric wire status.

Two successes, non-409 errors, parsing errors, lost acknowledgements and pending
requests remain ambiguous. Even a currently matching HEAD or hash cannot remove
that ambiguity. A failed durable write cannot authorize cleanup from volatile
state. Known uploads can be aborted/verified absent, but the ambiguous object is
protected. Unknown uploads/objects and the exact zero-byte structural directory
marker remain untouched.

After restart, only a **new-format, completely settled single-winner journal**
with original still-tracked upload ownership and successful acknowledgement can
finish interrupted independent HEAD/readback verification. No receipt or pending
competitor means no adoption. Legacy jobs have no new-format evidence and never
receive synthesized intent, receipts or proof. Already cleared proof records
cannot be recreated to adopt a reappearing object. SIGKILL fixtures exercise
before receipt, after an ACK with a competitor still in flight, and after all
outcomes are durably settled. These test process crashes and SQLite reopen, not
host power loss or storage hardware that falsely acknowledges fsync.

## Bounded public diagnostics

Owner-bound job status and the existing read-only diagnostics endpoint add
`publications` (at most two races and three operations each). Private keys, upload
IDs, ETags, expected hashes, nonces, manifests, credentials, signed URLs and raw
provider responses are excluded. Example of a **simulated**, unresolved outcome:

```json
{
  "target": "race",
  "multipleSuccesses": false,
  "ambiguityRemaining": true,
  "proofVerified": false,
  "objectProof": false,
  "multipartCleanupPending": false,
  "objectCleanupPending": true,
  "operations": [
    {"competitor":"multipart-a","operation":"CompleteMultipartUpload","httpStatus":200,"response":"success","acknowledged":true,"durableReceipt":true,"uploadAbsent":true,"abortAcknowledged":false},
    {"competitor":"multipart-b","operation":"CompleteMultipartUpload","httpStatus":404,"wireHttpStatus":404,"response":"provider-error","acknowledged":false,"durableReceipt":true,"providerCategory":"not-found","providerCode":"OperationAborted","uploadAbsent":true,"abortAcknowledged":true}
  ]
}
```

`httpStatus` is the SDK's status; `wireHttpStatus` is the observed numeric status
before SDK normalization when available. `embedded-error` never counts as an ACK.
`invalid-response` means the SDK resolved but required creation evidence failed.
`sdk-parsing-error` and `transport-error` distinguish parser and network failures.
`multipleSuccesses` describes multiple valid success replies, not live identity.
`proofVerified` retains the historical verification result after cleanup;
`objectProof` describes retained current proof. `abortAcknowledged` reports a
successful abort response; `uploadAbsent` requires an independent missing-parts
observation and can be true for a completed upload that did not need aborting.
Old jobs return no new receipts: absence means not recorded, not no publication.
Original `preflightFailure`, first `cleanupFailure` and `lastCleanupFailure`
remain distinct and are retained after reconciliation.
Historical snapshots keep their originally recorded context flags; an old
`unknown` target's true flags never establish acknowledgement or proof for the
race object. Compare the exact-target observations and private journal instead.

## Existing incident: begin with read-only evidence collection

This procedure targets the existing incident preflight and **only its `race`
target**. Enter its recorded ID privately; do not create a replacement preflight.
Do not request another sample/screenshot as a prerequisite. The operator-provided
observations remain evidence with the limitations above.

1. Review this patch and its tests; operator publishes the branch and verifies
   hosted CI on the exact commit. Preserve the current immutable image digest,
   protected `.env`, ordered Compose overlays, approved keyring/CA mounts, data
   volume, deployment contract/history and consistent export-job journal backup.
   Use the existing protected backup procedure; do not make an inconsistent live
   SQLite copy or paste raw journal/envelope records into support chat.
2. In the original owner's authenticated browser, GET
   `/api/managed-exports/preflights/<incident-id>` and save only sanitized status
   and failure fields. Then explicitly GET
   `/api/managed-exports/preflights/<incident-id>/diagnostics`. It performs bounded
   read-only HEAD/versioning/upload/parts inspection, with no body download,
   mutation, state repair or ownership adoption. An inspection is refused while
   cleanup is running, for a foreign owner, active job or changed destination.
   Preserve old diagnostics before any separately approved image change.
3. Correlate the private journal's existing creation receipts and owned upload
   IDs with HCP access/audit records. Ask the HCP administrator for the completion
   histories and routing/node records of those exact upload IDs. No new SDK,
   Python or AWS CLI installation in the production container is required.
4. With authorized existing provider tools/Namespace Browser, inspect the exact
   live target read-only: HEAD status, current size, ETag, timestamps, metadata,
   annotations and retention, plus a fresh bounded multipart listing. Compare
   privately with original job identity/nonce/binding, acquisition time and the
   supplied sample size/hash. Treat response headers/keys as private evidence.
   Repeated observations are not an atomic snapshot, and no individual matching
   filename, hash, ETag, owner or metadata value establishes job ownership.
5. If no successful completion receipt exists for this target, the patch cannot
   manufacture it. Retain the object and NO-GO unless the independent evidence
   and authorized administrator can attribute the **current live object** to
   this disposable incident. Shared credentials or the visible account owner
   alone are insufficient. If attribution/routing semantics remain uncertain,
   stop and request provider support; do not retry preflight over the object.

### Separate, explicitly authorized reconciliation

Only after independent HCP administrator attribution and explicit operator
authorization for this one current object:

1. Arrange a controlled window with new export admissions paused through the
   existing reviewed application procedure. Preserve ordinary backup schedules,
   Agent, replication and namespace policy. Recheck exact live identity and
   absence of unrelated active uploads immediately before the approved action.
2. The authorized HCP administrator may delete **only the individually selected
   incident race object** using the existing provider procedure. Verify a
   single-object confirmation, never a directory/prefix/bucket delete. Do not
   delete the structural marker, other replicas, or abort unknown upload IDs.
   Deletion denial/retention or changed identity is a stop condition, not grounds
   to change retention, overwrite, authorization or namespace settings.
3. Re-run the read-only diagnostic endpoint and independently verify the four
   tracked test objects are absent and no relevant multipart upload remains.
   Then the original job owner may invoke the existing owner-bound
   `DELETE /api/managed-exports/preflights/<incident-id>` once, and poll status.
   Require `state:cancelled` and `cleanupPending:false`. The application verifies
   absence; it does not backfill proof or adopt the historical object. Keep the
   original journal/failures and administrator audit evidence.

If separate authorization/attribution is unavailable, retain the object and
cleanup-pending job. Do not edit SQLite, force `cleaned`, clear history or switch
credentials/prefixes to bypass admission. That outcome remains NO-GO.

## Reviewed deployment, UAT and rollback

After review/hosted CI and the reconciliation decision, deploy only when
appropriate using the existing approved bundle and immutable GHCR digest:

```sh
sudo sh /opt/pluton/install.sh 'sha256:<approved-image-digest>'
sudo sh /opt/pluton/status.sh
```

This patch changes no Compose input, mount, endpoint, signing region, CA,
credential, keyring, encryption format or namespace policy. Preserve all of
them and retained job metadata. Status must verify health/image/UID/mounts/export
environment without values. Authenticated configuration must still report
`application-encrypted-hcp` and a configured keyring. Do not rotate or regenerate
keys, deploy Agent or reconfigure backup/replication to apply this fix.

The operator's mandatory order is:

- [ ] Review findings/tests, publish, verify hosted CI, retain rollback materials.
- [ ] Independently reconcile the historical object, or explicitly retain it and
  stay NO-GO. Deploy the reviewed fix only when appropriate.
- [ ] Confirm application health, exact immutable image and private keyring mount.
- [ ] Read-only Inventory Check: Ready, valid `verified-empty` marker, no unknown
  objects/uploads. Known unresolved historical objects are not waived.
- [ ] Only after clean admission, run a **new** HCP preflight. Review each actual
  competing response and independent object proof. Require all capabilities,
  `state:ready`, `productionReadiness:GO`, `cleanupPending:false`.
- [ ] Test an existing small regular-file Backup Plan snapshot without changing
  its schedule/source. Verify authenticated TAR byte count, SHA-256, extraction
  and Restore into an explicitly approved empty staging directory.
- [ ] Test interruption and authenticated Range/resume of the same Ready job,
  including final complete SHA-256/TAR verification, expiry/renewal and cleanup.
  Follow the exact private-client steps in [marker UAT](HCP_DIRECTORY_MARKER_UAT.md).
- [ ] Repeat Inventory Check; require no orphan object/upload and the unchanged
  marker. Move to medium/large snapshots only after small UAT/resource approval.

If HCP returns multiple successful creations or cannot provide first-writer-wins
across its real routing paths, stop: administrator/vendor correction or a
separately reviewed storage/architecture change is required. Never pin routing
to hide a failing race, accept 404/412/500 as 409, disable the gate or silently
downgrade encryption/isolation. Thirteen passed checks do not substitute for GO.

On regression, pause new Reliable Download admission through the reviewed
configuration procedure, retain keys/journal/destination, and use the existing
image rollback and health gates:

```sh
sudo sh /opt/pluton/rollback.sh
sudo sh /opt/pluton/status.sh
```

Do not replace job SQLite with an older copy or lose new receipts. Older images
cannot recover the new receipts, but ambiguous jobs have no minted object proof
for them to delete. Rollback does not reverse database migrations or provide
permission to delete an unresolved object. Keep the current namespace and backup
protection unchanged; investigate an unhealthy rollback separately.

## Validation commands and environment

All infrastructure is isolated and disposable. The native encrypted 120 MB
fixture enforces 2 CPU/4 GiB, preserves the marker and five synthetic replicas,
and exercises real TAR/hash/Range, hard process restarts and cleanup. Protocol
fixtures use real SDK XML parsing without a network destination; their anonymous
privacy callback is stubbed only there. Native acceptance retains real TLS,
authentication, anonymous-access denial and provider privacy checks.

```powershell
pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
node --experimental-strip-types --test frontend/__tests__/*.test.ts
./scripts/validate-managed-resumable-unit.ps1
./scripts/validate-managed-resumable.ps1 -Modes small -SharedNamespace -WriteOnceReference -ApplicationEncrypted -ProductionCompose
docker build -f Dockerfile.source -t pluton-hcp-race:local .
./scripts/validate-deployment.ps1 -Image pluton-hcp-race:local
```

Use the pinned pnpm 10.20.0 and existing lockfile. Local Node 24 test fixtures and
the pinned production image are distinct from hosted CI. Record the existing
frontend ESLint configuration failure separately; do not suppress it. Local
PASS is not hosted CI or production HCP certification. No branch is pushed or
production action initiated by this task.

## Local verification record (2026-11-03)

Base: `origin/main` at `522299b` (directory-marker fix already merged). Branch:
`codex/hcp-concurrent-publication-safe-recovery`.

| Check | Result |
| --- | --- |
| Original-main 200 winner + competitor 404 reproducer | Expected FAIL: exact race acknowledgement missing. Original source was restored byte-for-byte after the controlled baseline run. No production inference is made from the simulated 404. |
| Complete backend, `CI=true`, `--runInBand` | Final PASS: 216 suites, 4,438 passed / 4 pre-existing platform skips. Initial concurrent validation run passed all assertions but failed `PlanService`'s existing 5-second logger teardown hook. Unchanged isolated `PlanService` passed 80 tests, followed by the full PASS after heavy build/native jobs ended. Timeouts/assertions were not changed; contention is plausible, not a proven root cause for that unrelated hook failure. |
| Linux 2 CPU / 4 GiB security/export/recovery suite | PASS: 14 suites, 463 passed / 1 existing Windows/root-only skip. Includes real SDK responses, publication receipts, SIGKILL/reopen, keyring, encryption, inventory, cleanup and authorization. |
| Complete frontend regression suite | PASS: 366 tests, no skips. |
| Backend lint and backend/frontend type checks | PASS. |
| Node deployment/Compose/release guards | PASS: 24 tests. |
| Linux host-bundle/overlay/keyring/CA policies | PASS: 46 Python tests; all POSIX deployment shell syntax checks passed. |
| `Dockerfile.source` production build | PASS, including frontend/docs/type build, backend production build and pinned runtime-client checks. |
| Actual production-image release boundary verification | PASS: Node 24.22.1, UID/GID 10001; 1,813 entries checked; test fixtures, crash drivers and private state excluded. |
| Complete real Linux Docker deployment acceptance | PASS: 19 scenarios including approved reapply, automatic/explicit rollback, old host-bundle upgrade/restore, SQLite/mount preservation and resource cleanup. |
| Native encrypted 120 MB reference-provider scenario | PASS: original TAR/hash/extraction, real interruption/resume, authentication/privacy denials, hard restart and cleanup, unchanged marker and five replica manifests/read-data checks. No server TAR, orphan objects/uploads or OOM. |
| Frontend ESLint baseline | FAIL (unchanged), exit 2: string `eslint-config-prettier` in `typescript-eslint.config()`'s extends array is unsupported. No frontend configuration/source or CI gate was changed or suppressed. |

The native scenario produced a verified 120,005,632-byte original TAR. Peak
application cgroup memory was 1,405,468,672 bytes (about 1.31 GiB), server Node peak
RSS 395,460,608 bytes, mean CPU 58.63% of the two-CPU quota, measured client
throughput 14.68 MiB/s and server metadata disk usage 143,872 bytes. All disposable
fixture resources were removed. These measurements do not predict production
throughput or certify real HCP routing/concurrency. Local tests use Node 24.16.0
and pnpm 10.20.0; the production source image uses pinned Node 24.22.1.

Changed files and purpose:

- `backend/src/utils/managedExport/HcpWriteOnceStorage.ts`: per-request durable
  race evidence, numeric wire-status observation, complete readback before new
  proof persistence, safe new-format reconciliation and owned-upload diagnostics.
- `backend/src/utils/managedExport/ExportPublication.ts`: bounded private intent,
  strict single-winner validation and sanitized historical/current projection.
- `backend/src/utils/managedExport/ExportPolicy.ts`: additive private journal type;
  no database schema migration.
- `backend/src/utils/managedExport/ExportDiagnostics.ts`: exact-target flags,
  bounded parser/network classification and fixed race failure details.
- `backend/src/services/ManagedExportService.ts`: owner-bound public result adds
  safe per-operation diagnostics; authorization/lifecycle boundaries unchanged.
- `backend/__tests__/fixtures/hcpPublicationProtocol.ts`: real-SDK synthetic HTTP
  provider, including deliberate unsafe outcomes and controlled PUT races.
- `backend/__tests__/fixtures/hcpPublicationCrash.process.ts`: temp-path-confined
  SIGKILL checkpoints with independently persisted provider fixture state.
- `backend/__tests__/services/HcpConcurrentPublication.test.ts`: protocol,
  persistence, historical unknown ownership, mixed publication and crash tests.
- `backend/__tests__/services/HcpWriteOnceStorage.test.ts`: existing reference
  fixture emits the real completion Bucket/Key identity fields.
- `backend/__tests__/utils/ExportDiagnostics.test.ts`: no borrowed proof and no
  private/unbounded/corrupt publication values in public output.
- `scripts/validate-managed-resumable-unit.ps1`: run new regressions on Linux.
- `docs/HCP_PREFLIGHT_CLEANUP_DIAGNOSTICS.md`: clarify historical/context flags and
  link this recovery procedure.
- `docs/HCP_CONCURRENT_PUBLICATION_RECOVERY.md`: findings, limitations, controlled
  reconciliation, deployment/UAT/rollback and validation evidence.

The existing historical object remains unresolved by this coding session.
Actual HCP responses, provider guarantees, hosted CI after publication and
production UAT are still unverified. Do not report production GO from this patch.
