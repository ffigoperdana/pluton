# Assisted Replica Recovery timeout and progress

## Evidence

The latest operator-supplied event recorded `archive-output-idle` after 602,535 ms. The first output arrived after 1,129 ms and 2,232,832 raw TAR bytes had arrived before a full 600-second silence. Restic was still running with stdout open and no consumer acknowledgement or backpressure pending when Pluton sent SIGKILL. The approximately 4.63 MiB snapshot had passed replica eligibility and approval.

**Confirmed in code and local fixtures.** Approved execution revalidates the approved destination and its Restic config ID, original snapshot mapping, tree and ownership tags. It builds and validates the exact snapshot index, then calls `prepareManagedExport` to produce the per-file hashes and link proof from a complete authenticated Restic TAR. The preparation sink discards the canonical TAR bytes. Restic still reads the whole archive, even for a granular selection. Only then does the job call native restore into the empty private workspace, validate files and the selected SQL artifact, and revalidate the exact snapshot. A short byte count does not bound metadata calls, pack reads, native process shutdown or downstream validation time.

The first-output watchdog, midstream watchdog, and command watchdog could all surface as `timeout`. The midstream watchdog can fire with a live native process that has stopped emitting output, or with output already delivered to a stalled local consumer. Deterministic tests exercised both cases using the original timer callbacks. A loopback HTTPS S3 fixture completed staging and SHA-256 verification. A separate check in that fixture cancelled a real Restic archive while its output was backpressured and verified removal of the session's private credentials.

**Confirmed code defect.** The native stream used Node pipeline with end disabled to keep the caller's sink open. It resolved at stdout EOF even when the final write was smaller than the sink's high water mark and its callback had not returned. With a clean Restic exit, this disarmed the watchdog and reported success from the native stage while the upper layer could still wait for the write. A regression reproduced early success before the fix. A bounded forwarding stream now finishes only after the sink acknowledges all writes, and leaves the caller's sink open on success. Definitive native failure or cancellation tears down the stream and waits for subprocess closure. The original 15-second first-output and ten-minute inactivity durations remain in effect.

**Production trigger remains undetermined.** The latest event places the wait on the native output side of the pipe. The consumer acknowledged the last observed write and the Restic process was alive until the watchdog stopped it. The event lacks evidence of the exact operation inside Restic or Rclone. Restic runs the archive with --no-lock and --no-cache, which rules out a Pluton-requested Restic lock or persistent local cache for that command. Provider cache behavior, pack retrieval, network reads, retries and internal archive work require separate evidence. The supplied CPU and RAM observations were snapshots outside a continuous failure trace.

A healthy loopback replica completed verified staging of 4,366 files and about 4.5 MiB of payload. Holding an encrypted S3 data-pack body reproduced the production pipe state after 2,230,784 raw TAR bytes, within 2,048 bytes of the supplied event. A paced response took longer than a fixture idle window and still completed. A withheld consumer acknowledgement produced consumer idle after clean Restic exit. Unexpected Restic exit after partial output failed closed and the isolated test reaped Rclone. Explicit cancellation also reaped the children and left the replica and a non-session sentinel intact. The local result proves a held S3 response can cause this pattern. Attribution to a particular production request still requires correlated provider evidence.

The follow-up regression also proved the job could show completed while its replica session was still cleaning up. Completion now follows the verified result and session cleanup. A failure keeps its original readback diagnostic if a subsequent cache cleanup also fails. The coordinator records the result of cleaning the owned workspace separately.

## Timeout boundaries

| Scope | Existing boundary | Diagnostic evidence |
| --- | --- | --- |
| Rclone read-only probe | 5-second connect, 10-second I/O idle, one retry setting at each level. Pluton also has a 60-second command watchdog. Primary availability has a separate 15-second caller deadline. | Explicit dial timeout and general I/O timeout are separate when the bounded native classifier has that evidence. A watchdog firing is recorded as its own category. |
| Exact repository config and snapshot reads | 60 seconds per buffered command. A snapshot metadata deadline after a successful primary probe remains ineligible for connectivity-based fallback. | `repository-identity` or `snapshot-metadata` with `command-deadline` or a caller deadline. |
| Streamed Restic index and diff | 15 minutes per metadata subprocess. A candidate's read-only preflight has a separate three-minute caller deadline across its operations. | `metadata-stream-deadline` or `replica-preflight-deadline` when that deadline actually aborts the candidate. |
| Integrity preparation | 15 seconds until first TAR output. After output starts, ten minutes of inactivity, reset on native stdout or destination drain. No separate preparation wall-clock cap. | `archive-first-output`, `archive-output-idle`, `archive-backend-retrying`, `archive-consumer-idle`, or `archive-exit-idle`. Backend retrying replaces output idle or first output when Restic reported failed backend requests after the last output; `archive.backendRetries` then names the retried object and error class ([RESTIC_RETRY_DIAGNOSTICS.md](RESTIC_RETRY_DIAGNOSTICS.md)). Output idle records what the local process observed. Consumer idle records an outstanding write acknowledgement or observed backpressure, including a final write below the high water mark. Exit idle records a drained pipeline still waiting for the child to close. |
| Native staging restore | 60 minutes for the approved replica restore subprocess. Filesystem verification uses the job cancellation signal. | `native-restore-deadline` for the restore watchdog. Local failures retain the phase and safe failure code. |
| Whole approved job | No independent overall wall-clock timer. The ten-minute approval expiry applies to consuming approval. After approval, explicit cancellation or shutdown propagates to the active operation and cleanup waits for native termination. | No overall deadline category is inferred from job age. Terminal status and cleanup pending are reported independently. |

The pinned binaries report Restic 0.19.1 and Rclone 1.75.1. Restic's default wait to establish its Rclone connection is one minute. Rclone's CLI defaults are a one-minute connect timeout and five-minute I/O idle timeout, with three high-level and ten low-level retries. The explicit probe overrides these Rclone defaults. Restic starts Rclone as a child and uses its stdin and stdout for the repository transport. The archive stdout that Pluton observes is a separate stream. The explicit probe's successful completion only proves its own request completed. Its timings do not describe later data-pack reads. [Pinned Restic Rclone backend](https://github.com/restic/restic/blob/v0.19.1/internal/backend/rclone/backend.go)

The existing owner-authorized job GET and scoped list return an optional diagnostic for a new failure. The diagnostic includes `phase`, `operation`, `elapsedMs`, `timeoutCategory` and `failureCode`. The elapsed value is a monotonic operation duration when available and a phase duration otherwise, bounded to 24 hours. `undetermined` means a timeout was reported without a more precise source. Historical records created before the patch keep their original safe failure code. For a native archive failure the diagnostic also includes a bounded archive observation. It records first-byte latency, bytes observed from stdout, age of the last output, whether a consumer acknowledgement is pending, the pending duration where known, backpressure, stdout EOF and child state at the stop decision. Completion describes the later observed child outcome. Bytes measure raw TAR traffic and include headers and padding. The event `managed_native_archive` emits the same observation on success or failure with the safe completion classification. Job status includes fixed-name `phaseTimingsMs` after execution. For approved archive reads, after 30 seconds without output and with the consumer clear, Linux samples process counters at five-second intervals. The optional `archive.nativeIo` records the last sample window, age, and Restic/Rclone byte and CPU-tick deltas. Missing counters are omitted when the process, kernel or permissions prevent sampling. These counters aggregate process I/O, including file and pipe activity. They do not measure an S3 request or count retries. Sampling runs independently of timeout and cancellation. The payload adds no paths, process IDs, provider text, request details or credential material. [Linux I/O counter definitions](https://www.kernel.org/doc/html/latest/filesystems/proc.html#display-the-io-accounting-fields)

The status panel shows a themed, reduced-motion-aware spinner for checking and approved execution. Time starts at request creation for a check and at approval for execution. The live region announces the phase and observed archive activity. Elapsed time is outside that region to avoid announcing each tick. Archive activity distinguishes waiting for first output, reading, a sustained output pause, a pending consumer write and waiting for native exit. Staged file verification and cleanup have their own labels. Polling and owner-scoped GET rediscovery use the existing route and intervals. Closing or navigating leaves admitted work active.

## Validation

- Nine focused backend suites passed 380 tests. All 472 frontend tests passed. Backend lint, both application type checks, the Linux production Docker build and runtime release isolation passed.
- Deterministic subprocess tests cover first output, output inactivity, blocked-consumer inactivity, metadata stream timeout, caller deadline, connection versus I/O category, process termination and private config cleanup. Service tests cover owner isolation, one-time approval, candidate order, diagnostic persistence on restart and explicit cleanup. Existing TAR proof, exact identity and restore tests cover the readback and staging boundaries.
- Frontend tests exercise checking and running indicators, a terminal failure, elapsed display, an owner-authorized refresh, and terminal polling behavior. A progress percentage or simulated bytes are never inferred from the spinner.
- The real Docker lab uses loopback SFTP and SigV4 HTTPS S3, a synthetic private CA, UID 1000, a read-only root filesystem and network none. It verifies source mapping, primary-offline staged recovery, ownership, one-time approval and rejection of an untrusted CA. Its fault proxy holds or paces encrypted data-pack responses without modifying replica objects. The held response recorded first output in 579 ms, 2,230,784 raw TAR bytes and 2,000 ms since the last byte. Both sampled processes had zero read-byte, write-byte and CPU-tick deltas over a 201 ms sample. The slow case exceeded the idle window while continuing to emit archive data. The scaled observation and two-second idle windows exist only in the isolated fixture. Native cancellation reaped the process tree and kept the non-session sentinel and the replica intact.
- The 43 deployment, release and worker contract checks and all 19 disposable Docker deployment acceptance scenarios passed, including upgrade, reapply, rollback and mount preservation.
- Hosted CI and a production HCP retest are pending. The frontend lint command currently stops in the unchanged ESLint configuration because its typescript-eslint extends array contains the string eslint-config-prettier.

## Operator UAT

1. Use an approved image and a small eligible snapshot with an already verified S3 replica. Check that the earlier job is terminal and cleanup is clear. Leave the primary online for a manual replica test. Keep the operation limited to isolated staging.
2. Open the replica details, explicitly check the chosen replica, and approve the exact snapshot once. During checking and running, confirm that phase and elapsed time are visible. Close and reopen the dialog, then refresh the page and confirm that the same owner-authorized job reappears. A phase label and elapsed time describe activity only.
3. Require terminal staged-integrity success before accepting the result. If the job fails, collect the allowlisted fields below once. If cleanup is pending, use the existing owner-authorized cancel/discard control and confirm it clears before considering another explicitly approved attempt.
4. Correlate the job diagnostic and phase timings with the `managed_native_archive` event in the same UTC window. The production log path reported for this deployment is `/data/logs/app.log` inside the container. Use the configured application log source if it differs. For consumer idle, check the pending acknowledgement, EOF and process completion, then compare local CPU, memory and staging pressure. For output idle with stdout open, no pending write and a running process, ask the storage operator for approved aggregate read timings and status categories in the same window. Compare the last `nativeIo` deltas and their window age with time to headers, time to complete the response body, response status categories and retry aggregates when the storage operator can safely provide them. Zero I/O deltas show no observed I/O in that sample. They cannot identify the blocked request. Collect simultaneous host CPU, memory and OOM counters if available. Do not collect full URLs, raw provider logs or request headers.

This read-only example runs in the operator's already signed-in Pluton tab. Replace the placeholder with the job ID from the dialog. It prints a limited summary and does not log the full response.

~~~js
(async () => {
  const jobId = 'PASTE_JOB_ID_FROM_DIALOG';
  const response = await fetch('/api/assisted-recovery/' + encodeURIComponent(jobId), {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    console.log({ status: response.status });
    return;
  }
  const { result: job } = await response.json();
  const counters = (value) => value && ({
    readBytes: value.readBytes,
    writtenBytes: value.writtenBytes,
    cpuTicks: value.cpuTicks,
  });
  const archive = (value) => value && ({
    ...Object.fromEntries([
      'firstByteMs', 'bytesReceived', 'lastOutputAgeMs', 'consumerPending', 'consumerPendingMs',
      'consumerBackpressured', 'stdoutEnded', 'processAtStop', 'completion', 'backendRetries',
    ].map(key => [key, value[key]])),
    nativeIo: value.nativeIo && {
      windowMs: value.nativeIo.windowMs,
      sampleAgeMs: value.nativeIo.sampleAgeMs,
      restic: counters(value.nativeIo.restic),
      rclone: counters(value.nativeIo.rclone),
    },
  });
  const pick = (value) => value && ({
    phase: value.phase,
    operation: value.operation,
    elapsedMs: value.elapsedMs,
    timeoutCategory: value.timeoutCategory,
    failureCode: value.failureCode,
    archive: archive(value.archive),
  });
  console.log({
    status: job.status,
    phase: job.phase,
    failureCode: job.failureCode,
    cleanupPending: job.cleanupPending,
    diagnostic: pick(job.diagnostic),
    phaseTimingsMs: job.phaseTimingsMs && Object.fromEntries([
      'approval-revalidation', 'staging-preparation', 'snapshot-indexing', 'snapshot-validation',
      'integrity-preparation', 'staged-restore', 'filesystem-validation', 'final-verification',
      'staging-cleanup',
    ].map(key => [key, job.phaseTimingsMs[key]])),
    primaryDiagnostic: pick(job.primary?.diagnostic),
    candidateDiagnostics: job.candidates.map(c => ({
      position: c.position,
      diagnostic: pick(c.diagnostic),
    })),
    milestones: job.audit.filter(event => [
      'operator-approved', 'recovery-source-approved', 'staged-recovery-failed',
    ].includes(event.event)).map(({ at, event, code }) => ({ at, event, code })),
  });
})();
~~~

## Rollback and follow-up file scope

Finish or explicitly cancel active and pending jobs, verify cleanup, and use the existing immutable-image rollback runbook to reapply the prior approved image. [Assisted Replica Recovery rollback](ASSISTED_REPLICA_RECOVERY.md#rollback) The extra fields are optional members of the existing job payload. Keep migration 0022 and all job metadata, and avoid restoring an earlier application database over current backup history. The previous image will ignore the added diagnostic fields. Leave the existing one-time approvals, staging rules and backup storage in place. The local loopback lab does not certify HCP latency, provider behavior under load or large-snapshot capacity.

| Area | Files |
| --- | --- |
| Job lifecycle and diagnostics | backend/src/services/AssistedRecoveryService.ts, backend/src/services/VerifiedReplicaRecoveryService.ts |
| Readback and observation | backend/src/services/RemoteRepositoryRecoveryService.ts, backend/src/utils/restic/ManagedSftpRepositorySession.ts, backend/src/utils/restic/ManagedTarExport.ts, backend/src/utils/restic/archiveProcessObservation.ts |
| Status panel | frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.tsx, frontend/src/utils/assistedRecovery.ts |
| Regression coverage | backend/__tests__/integration/replicaRecovery.lab.ts, backend/__tests__/integration/replicaArchiveFaults.fixture.ts, backend/__tests__/services/AssistedRecoveryService.test.ts, backend/__tests__/services/VerifiedReplicaRecoveryService.test.ts, frontend/__tests__/assistedRecovery.test.ts |
| Runbook | docs/ASSISTED_RECOVERY_TIMEOUT_PROGRESS.md |
