# Reliable Download progress and performance

This change affects the download panel and additive, bounded export diagnostics.
It does not change encryption, HCP publication, mandatory preflight, ownership,
cleanup, repository selection, backup scheduling, replication, or deployment
configuration. Existing export records remain readable without the optional
`performance` field.

## Confirmed UI defects and resulting behavior

Both panels previously toggled their action `busy` flag on every background
request. Reliable Download also cleared the job and authorization on effect
restart. A failed poll stopped automatic polling and removed the ready card.
Cancellation stopped the poll loop permanently, including cleanup status.
These behaviors explain flashing controls and lost/replaced progress content.
The existing stable Modal itself did not need replacement.

Background polling now retains the last validated response, has one outstanding
read, starts its next timer only after that read settles, and retries connection
failures with bounded backoff. A status request has a 30-second client deadline;
this does not change server export or cleanup deadlines. Abort/generation checks
discard obsolete reads. Only deliberate actions disable action buttons.
Cancellation is confirmed, protects against double submission, retains failures,
and resumes polling for pending cleanup. Closing never cancels a server job.

Mode changes cannot silently cancel an active preparation or leave an unobserved
Reliable Download running in another mode. Switching away from Standard Download
leaves its harmless preparation running. Up to 32 tab-local backup selections
and job IDs survive closing/reopening the panel. No proof, private URL, credentials
or keys are cached there; reopening fetches the owner-authorized job. A full page
reload loses these navigation hints; the server still deduplicates admitted active
and unexpired ready jobs by owner, snapshot/mode and destination.

The five stages describe work, not five equally sized percentages. Before the
archive size is verified, progress is indeterminate. Upload percentage uses
acknowledged bytes and stays at or below 99 until ready with verified integrity.
The ready card displays TAR size, SHA-256, expiry and resume instructions.
Network errors retain this evidence and show reconnect status; downloads still
pass server authorization, expiry and integrity checks. Regular Files Only keeps
its partial-restore warning. Counter updates are outside the live announcement
region, and reduced-motion styling removes panel animations/transitions.

## Pipeline and counter meaning

The recovery service binds the historical backup to the managed repository,
source, plan and exact snapshot. It obtains SFTP recovery options from that
repository's storage. It never selects an S3 replication destination as the export
source. Replication and temporary export storage are independent; concurrent
work can still compete for CPU, disk or network resources.

The pipeline is:

1. Acquire/build the bounded SQLite snapshot index and revalidate its binding.
2. Read the source TAR to validate entries, symbolic links, content hashes and
   canonical archive proof. This pass does not upload the backup.
3. Re-read and validate the canonical TAR against that proof, encrypt it, and
   stream it through a single fixed 16-MiB multipart buffer.
4. Complete publication, establish durable ownership with verified readback, and
   perform final object/decryption/integrity and binding checks before Ready.

No validation pass or readback was removed. A reusable validated proof can avoid
repeating the preparation pass; it never skips transfer comparison.

`processedBytes` is the archive data accepted by the upload sink, not total
Restic repository bytes read and not a browser-download counter. In encrypted
mode, ciphertext progress is mapped to complete plaintext chunk equivalents.
`uploadedBytes` advances only for successful multipart acknowledgements, also
mapped to plaintext equivalents. A 16-MiB ciphertext part contains slightly less
than four 4-MiB plaintext chunks, so the first acknowledgement can display
12 MiB. This is expected conservative accounting, not dropped data.

`averageBytesPerSecond` includes waiting for source/encryption, buffering and
publication in the upload phase. It is not pure HCP network bandwidth. A zero
counter during indexing/validation or while the first part fills is not proof
of a stalled HCP connection. Thirty seconds without reported upload progress is
labelled a stall observation, not a provider diagnosis or automatic failure.

## Safe diagnostics

The owner-bound status response adds a numeric `performance` projection:

| Field | Interpretation |
| --- | --- |
| indexingMs, indexedEntries | Index acquisition plus required snapshot checks; count known once the index is acquired |
| archiveValidationMs | Preparation/proof validation including its session checks |
| firstTarByteMs | Time from starting the transfer TAR generator to its first canonical TAR byte |
| streamMs, streamBytes, streamBytesPerSecond | Canonical TAR generator wall time and plaintext throughput |
| sourceWaitMs | Gaps waiting for the next source write after the previous input callback completed |
| destinationWaitMs | Time the upload sink held a write while a full multipart buffer was sent |
| uploadRequestMs, uploadedWireBytes, uploadRequestBytesPerSecond | Summed multipart request time and acknowledged wire bytes, including SDK/local request work |
| multipartCompletionMs | Successful CompleteMultipartUpload request duration; does not prove ownership |
| verificationMs | Final object/decryption/readback verification duration |
| lastProgressAgeMs | Age of the last reported sink or multipart progress, capped at seven days |

These timings overlap in a streaming pipeline and must not be added together.
Source wait includes Restic, SFTP, scheduling and propagated pressure; it does not
isolate SFTP latency by itself. First-byte timing excludes earlier preflight,
indexing and preparation. Failed/interrupted phases may have partial or absent
timings; absence never means successful work.

Only known numeric fields and a fixed phase enum are exposed. Counts, byte
quantities and durations are bounded. The stream sampler runs at most once per
five seconds, uses no per-chunk history or additional buffer, and is a no-op for
consumers without an observer. Upload counters share existing progress writes.
Successful exports emit one `managed_export_performance` summary using the
existing logger. It has no filenames, source paths, object keys, ETags, provider
bodies, credentials, plaintext or resume URLs. Historical records without these
fields remain valid; diagnostics never authorize publication/deletion.

## Local evidence and remaining uncertainty

The synthetic lab uses native SFTP/Restic, TLS MinIO behind a
local write-once protocol reference, real AES-256-GCM and authenticated download
Range requests. It is not HCP certification or a production benchmark.

Local measurements (2026-11-04, exporter limited to 2 CPUs / 4 GiB):

| Measurement | 120 MB source | 1.23 GB source |
| --- | ---: | ---: |
| TAR bytes | 120,005,632 | 1,230,007,296 |
| Entries | 8 | 11 |
| Admission to ready | 17.542 s | 70.552 s |
| Index acquisition | 2.438 s | 2.403 s |
| Archive validation | 5.157 s | 21.547 s |
| First canonical TAR byte | 0.561 s | 0.546 s |
| TAR stream duration | 4.800 s | 32.173 s |
| Observed source wait | 3.526 s | 26.808 s |
| Destination write wait | 2.058 s | 15.606 s |
| Multipart requests (sum) | 2.062 s | 15.080 s |
| Multipart completion | 0.010 s | 0.048 s |
| Final verification | 1.306 s | 10.968 s |
| TAR stream throughput | 23.8 MiB/s | 36.5 MiB/s |
| Multipart request throughput | 55.5 MiB/s | 77.8 MiB/s |
| Peak application Node RSS | 376.7 MiB | 438.2 MiB |
| Whole lab cgroup peak | 1.28 GiB | approximately 4.00 GiB |
| Whole lab CPU / two-CPU quota | 55.61% | 82.16% |
| OOM events / kills | 0 / 0 | 0 / 0 |

Resource peaks/CPU cover the whole fault-injection lab, not only the first export.
The larger fixture reached the memory limit with approximately 3.44 GiB file
cache and 433 MiB anonymous memory at the final sample; do not interpret Node
RSS alone as spare VM capacity. Host build/test work also ran during parts of
the lab, so these are observed validation measurements, not capacity guarantees.
Both used two source archive reads. Their entry counts differ from the reported
production snapshot, so metadata/path/entry overhead is not an equivalent workload.

Both fixtures passed full TAR size/SHA verification, interrupted Range resume,
authenticated proxy delivery, structural-marker preservation, verified empty
post-cleanup inventory, read-only repository checks and unchanged existing
replicas. The 120-MB fixture additionally exercised concurrent native backup and
replication, multiple interrupted transfers, partial exports, expiry,
cancellation and crash/restart cleanup. All disposable resources were removed.

An example sanitized status fragment is:

```json
{"performance":{"phase":"verification","indexingMs":2438,"archiveValidationMs":5157,"firstTarByteMs":561,"sourceWaitMs":3526,"destinationWaitMs":2058,"uploadRequestMs":2062,"multipartCompletionMs":10,"verificationMs":1306,"indexedEntries":8}}
```

Validation:

- Complete backend: 219 suites, 4,556 passing tests, four existing platform skips.
  Command: `pnpm --filter @plutonhq/core-backend test --runInBand`.
- Linux encryption/provider/cleanup/recovery regressions: 16 suites, 578 passing,
  one existing platform skip. Command:
  `./scripts/validate-managed-resumable-unit.ps1 -Image pluton-hcp-body-native:local`.
- Complete frontend: 373 passing. Command:
  `node --experimental-strip-types --test frontend/__tests__/*.test.ts`.
  Deterministic UI tests cover slow polls, DOM/control retention, abort deadlines,
  reconnect, reopening, one creation, stale read rejection, confirmation, failed
  cancellation, double submission, cleanup and ready verification.
- Final diagnostics/export focused checks: 68 passing; backend lint and backend/
  frontend type checks pass. No security assertions were removed.
- The repository's original `pnpm --filter @plutonhq/core-frontend lint` cannot
  load its existing config: `tseslint.config()` receives the string
  `eslint-config-prettier` in `extends`. The five changed frontend runtime files
  pass all the same intended rules without errors or warnings using a disposable
  adapter that resolves that string to its installed config object. The adapter
  was removed; this is not a full-frontend lint pass or a disabled gate.
- Synthetic integration command:
  `./scripts/validate-managed-resumable.ps1 -Image pluton-hcp-body-native:local -Modes small,large -SharedNamespace -WriteOnceReference -ApplicationEncrypted -ProductionCompose`.
- Production Docker build passes (frontend/docs/backend), and the non-root
  read-only release-content check passes for 1,833 entries. Docker deployment
  acceptance passes all 19 scenarios, including host-bundle upgrade, config
  reapply, explicit/automatic rollback and mount/data preservation. Deployment/
  Compose/release guards pass 24 Node tests and 46 Linux Python tests.
  Commands: `docker build -f Dockerfile.source -t pluton-download-ux:local .`,
  `./scripts/validate-deployment.ps1 -Image pluton-download-ux:local`.
  Hosted CI, real HCP performance, real browser visual/assistive
  technology inspection and production UAT remain operator checks. DOM assertions
  and CSS reduced-motion checks do not constitute a visual browser measurement.

The reported production rate of approximately 0.1 MiB/s cannot be attributed to
HCP, SFTP, CPU or scheduling from existing counters alone. Compare the new phase
and request timings on an explicitly authorized UAT export. Do not relax
validation, increase concurrency, enlarge buffers or change encryption based
only on the displayed average.

## Operator deployment, rollback and UAT

1. Publish/review the branch and wait for hosted Backend Test and Container Image
   workflows. Local success is not a hosted-CI pass.
2. Record the current immutable image digest and verify the ordinary protected
   backup of application data, export journal and full private keyring. Keep the
   existing approved Compose stack, export settings, private CA and read-only key
   mount. This patch needs no migration, new variable or host-bundle reapply.
3. Schedule the image restart while no export is active; restart reconciliation
   can interrupt an active preparation. Keep ready export metadata and all key
   slots. From the approved deployment directory, the operator uses
   `sh deploy.sh sha256:<approved-image-digest>`, then `sh status.sh`.
   Never substitute a moving tag or print environment/credential values.
4. Select the already approved completed backup in the existing managed plan.
   Start with approximately 120 MB and Full Download. Confirm the explanatory
   text, indeterminate preparation, actual counters and stable controls. Slow
   polling must not move focus, reset counters or enable a second active mode.
5. Close and reopen the panel in the same tab. Confirm the same job, then briefly
   interrupt only the browser connection. Last confirmed progress should remain;
   reconnection must not create another export. Test reduced motion and keyboard
   focus/confirmation. Do not disrupt the server's repository or HCP network.
6. Wait for Ready. Verify size/SHA-256, expiration and the partial warning if
   separately testing Regular Files Only. Interrupt/resume a client transfer at
   several offsets; renew authorization when needed. Verify the complete TAR
   SHA-256, byte size and archive entries. Browser resume support varies; use an
   authenticated Range-capable client for a controlled resume check. Keep private
   URLs and cookies out of shell history, screenshots and logs.
7. Observe CPU, memory, network and storage while one export runs. For example,
   `docker stats --no-stream --format 'cpu={{.CPUPerc}} memory={{.MemUsage}} network={{.NetIO}} block={{.BlockIO}} pids={{.PIDs}}' pluton`
   is read-only. Inspect available data-volume capacity privately, OOM/restart
   counters and the sanitized performance fields. On a 2-vCPU/4-GiB VM retain
   one exporter and the existing fixed buffers. If CPU is saturated, schedule UAT
   outside concurrent backup/replication work. If source wait dominates, investigate
   repository latency and Restic work; if multipart request time dominates,
   investigate the Pluton-to-HCP path. Do not infer a diagnosis from one sample.
8. After the test, explicitly confirm cancellation/cleanup for its temporary
   export or wait for its configured expiry. Observe cleanupPending until verified
   clear and check prefix inventory through the existing authorized UI. Never
   delete a prefix, fabricate ownership or clear the export journal.
9. Verify the next scheduled backup, existing Standard Download, staged Restore,
   Agent health, SFTP repository access and replication remain successful.
10. If rollback is needed, run `sh rollback.sh` from the same approved deployment
    directory to the recorded compatible image. Preserve database/journal and
    private keyring; do not restore an old SQLite file or disable exports while
    ready downloads must remain available. Use a format-v1-capable image as
    described in [the encrypted export runbook](APPLICATION_ENCRYPTED_HCP.md).

No production access, HCP probe, credential inspection, deployment or download
was performed by the coding agent.

## Changed files

| Area | Files |
| --- | --- |
| Stable polling and panel | `frontend/src/hooks/useDownloadJob.ts`, `frontend/src/components/Plan/Backups/DownloadPreparation.tsx`, `frontend/src/components/Plan/Backups/ReliableDownload.tsx`, `frontend/src/components/Plan/Backups/DownloadPreparation.module.scss` |
| Safe UI progress / requests | `frontend/src/utils/downloadProgress.ts`, `frontend/src/utils/reliableDownload.ts` |
| Frontend regressions | `frontend/__tests__/downloadProgressUI.test.ts`, `frontend/__tests__/downloadPreparation.test.ts`, `frontend/__tests__/reliableDownload.test.ts` |
| Export diagnostics | `backend/src/utils/managedExport/ExportPerformance.ts`, `backend/src/utils/managedExport/ExportPolicy.ts`, `backend/src/utils/managedExport/S3ExportStorage.ts`, `backend/src/utils/restic/ManagedTarExport.ts`, `backend/src/services/ManagedExportService.ts`, `backend/src/services/RemoteRepositoryRecoveryService.ts` |
| Backend / native regressions | `backend/__tests__/utils/ExportPerformance.test.ts`, `backend/__tests__/services/ManagedExportService.test.ts`, `backend/__tests__/services/S3ExportStorage.test.ts`, `backend/__tests__/integration/managedResumableRecovery.lab.ts` |
| Evidence and operator instructions | `docs/RELIABLE_DOWNLOAD_UX_DIAGNOSTICS.md` |
