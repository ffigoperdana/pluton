# Assisted Replica Recovery timeout and progress

## Evidence

The first UAT report stopped around 10 minutes and 14 seconds after source approval. A repeat on the diagnostic build recorded integrity-preparation, archive-readback, archive-output-idle and approximately 601257 ms, with no successful staged result or pending cleanup. The reported snapshot was about 4.63 MiB. This report uses the operator-supplied state only.

**Confirmed in code and local fixtures.** Approved execution revalidates the approved destination and its Restic config ID, original snapshot mapping, tree and ownership tags. It builds and validates the exact snapshot index, then calls `prepareManagedExport` to produce the per-file hashes and link proof from a complete authenticated Restic TAR. The preparation sink discards the canonical TAR bytes. Restic still reads the whole archive, even for a granular selection. Only then does the job call native restore into the empty private workspace, validate files and the selected SQL artifact, and revalidate the exact snapshot. A short byte count does not bound metadata calls, pack reads, native process shutdown or downstream validation time.

The first-output watchdog, midstream watchdog, and command watchdog could all surface as `timeout`. The midstream watchdog can fire with a live native process that has stopped emitting output, or with output already delivered to a stalled local consumer. Deterministic tests exercised both cases using the original timer callbacks. A loopback HTTPS S3 fixture completed staging and SHA-256 verification. A separate check in that fixture cancelled a real Restic archive while its output was backpressured and verified removal of the session's private credentials.

**Confirmed code defect.** The native stream used Node pipeline with end disabled to keep the caller's sink open. It resolved at stdout EOF even when the final write was smaller than the sink's high water mark and its callback had not returned. With a clean Restic exit, this disarmed the watchdog and reported success from the native stage while the upper layer could still wait for the write. A regression reproduced early success before the fix. A bounded forwarding stream now finishes only after the sink acknowledges all writes, and leaves the caller's sink open on success. Definitive native failure or cancellation tears down the stream and waits for subprocess closure. The original 15-second first-output and ten-minute inactivity durations remain in effect.

**Production trigger remains undetermined.** The EOF defect is a separate proven local stall mechanism. The repeated production verdict does not establish that it occurred there. A healthy loopback replica completed staged recovery for 3,214 files, including 3,200 empty files and about 4.5 MiB of payload. A TLS proxy holding an encrypted data-pack response after the first TAR bytes reproduced output idle with the consumer clear and Restic still running. Holding the last consumer write after clean Restic exit reproduced consumer idle instead. Slow data-pack reads continued successfully over more than one idle window. These are controlled lab results, not a diagnosis of a specific HCP request or its network path.

## Timeout boundaries

| Scope | Existing boundary | Diagnostic evidence |
| --- | --- | --- |
| Rclone read-only probe | 5-second connect, 10-second I/O idle, one retry setting at each level. Pluton also has a 60-second command watchdog. Primary availability has a separate 15-second caller deadline. | Explicit dial timeout and general I/O timeout are separate when the bounded native classifier has that evidence. A watchdog firing is recorded as its own category. |
| Exact repository config and snapshot reads | 60 seconds per buffered command. A snapshot metadata deadline after a successful primary probe remains ineligible for connectivity-based fallback. | `repository-identity` or `snapshot-metadata` with `command-deadline` or a caller deadline. |
| Streamed Restic index and diff | 15 minutes per metadata subprocess. A candidate's read-only preflight has a separate three-minute caller deadline across its operations. | `metadata-stream-deadline` or `replica-preflight-deadline` when that deadline actually aborts the candidate. |
| Integrity preparation | 15 seconds until first TAR output. After output starts, ten minutes of inactivity, reset on native stdout or destination drain. No separate preparation wall-clock cap. | `archive-first-output`, `archive-output-idle`, `archive-consumer-idle`, or `archive-exit-idle`. Output idle records what the local process observed. Consumer idle records an outstanding write acknowledgement or observed backpressure, including a final write below the high water mark. Exit idle records a drained pipeline still waiting for the child to close. |
| Native staging restore | 60 minutes for the approved replica restore subprocess. Filesystem verification uses the job cancellation signal. | `native-restore-deadline` for the restore watchdog. Local failures retain the phase and safe failure code. |
| Whole approved job | No independent overall wall-clock timer. The ten-minute approval expiry applies to consuming approval. After approval, explicit cancellation or shutdown propagates to the active operation and cleanup waits for native termination. | No overall deadline category is inferred from job age. Terminal status and cleanup pending are reported independently. |

The pinned binaries report Restic 0.19.1 and Rclone 1.75.1. Restic's default wait to establish its Rclone connection is one minute. Rclone's CLI defaults are a one-minute connect timeout and five-minute I/O idle timeout, with three high-level and ten low-level retries. The explicit probe overrides these Rclone defaults. Restic's Rclone transport has its own behavior and may stop earlier due to the enclosing Pluton watchdog. The watchdog is not a measurement of HCP request latency.

The existing owner-authorized job GET and scoped list return an optional diagnostic for a new failure. The diagnostic includes `phase`, `operation`, `elapsedMs`, `timeoutCategory` and `failureCode`. The elapsed value is a monotonic operation duration when available and a phase duration otherwise, bounded to 24 hours. `undetermined` means a timeout was reported without a more precise source. Historical records created before the patch keep their original safe failure code. For a native archive failure the diagnostic also includes a bounded archive observation. It records first-byte latency, bytes observed from stdout, age of the last output, whether a consumer acknowledgement is pending, the pending duration where known, backpressure, stdout EOF and child state at the stop decision. Completion describes the later observed child outcome. Bytes measure raw TAR traffic and include headers and padding. The event `managed_native_archive` emits the same observation on success or failure with the safe completion classification. Job status includes fixed-name `phaseTimingsMs` after execution. The payload adds no paths, provider text, request details or credential material.

The status panel shows a themed, reduced-motion-aware spinner for checking and approved execution. Time starts at request creation for a check and at approval for execution. The live region announces the phase and observed archive activity. Elapsed time is outside that region to avoid announcing each tick. Archive activity describes first-output evidence, and does not claim provider latency or continuous progress. Polling and owner-scoped GET rediscovery use the existing route and intervals. Closing or navigating leaves admitted work active.

## Validation

- Nine focused backend suites passed 377 tests, including Managed Replication, authorization, native sessions and TAR integrity. The full frontend suite passed 472 tests. Backend lint, both application type checks, the Linux production Docker build, release image isolation and compiled HTTPS/LAN checks passed.
- Deterministic subprocess tests cover first output, output inactivity, blocked-consumer inactivity, metadata stream timeout, caller deadline, connection versus I/O category, process termination and private config cleanup. Service tests cover owner isolation, one-time approval, candidate order, diagnostic persistence on restart and explicit cleanup. Existing TAR proof, exact identity and restore tests cover the readback and staging boundaries.
- Frontend tests exercise checking and running indicators, a terminal failure, elapsed display, an owner-authorized refresh, and terminal polling behavior. A progress percentage or simulated bytes are never inferred from the spinner.
- The real Docker lab uses loopback SFTP and SigV4 HTTPS S3, a synthetic private CA, UID 1000, a read-only root filesystem and network none. It verifies source mapping, primary-offline staged recovery, ownership, one-time approval and rejection of an untrusted CA. Its fault proxy holds or paces encrypted data-pack responses without modifying replica objects. The slow case completed 6,370,304 raw TAR bytes in 4,581 ms across 14 paced pack reads. The held response recorded first TAR output in 475 ms and a last-output age of 2,002 ms with no consumer write pending. The two-second idle window exists only in the isolated fixture. Native cancellation reaped the process tree and kept the non-session sentinel and the replica intact.
- The 43 deployment, release and worker contract checks and all 19 disposable Docker deployment acceptance scenarios passed, including upgrade, reapply, rollback and mount preservation.
- Hosted CI and a production HCP retest are pending. The frontend lint command currently stops in the unchanged ESLint configuration because its typescript-eslint extends array contains the string eslint-config-prettier.

## Operator UAT

1. Use an approved image and a small eligible snapshot with an already verified S3 replica. Check that the earlier job is terminal and cleanup is clear. Leave the primary online for a manual replica test. Keep the operation limited to isolated staging.
2. Open the replica details, explicitly check the chosen replica, and approve the exact snapshot once. During checking and running, confirm that phase and elapsed time are visible. Close and reopen the dialog, then refresh the page and confirm that the same owner-authorized job reappears. A phase label and elapsed time describe activity only.
3. Require terminal staged-integrity success before accepting the result. If the job fails, collect the allowlisted fields below once. If cleanup is pending, use the existing owner-authorized cancel/discard control and confirm it clears before considering another explicitly approved attempt.
4. Correlate the job diagnostic and phase timings with the `managed_native_archive` event in the same window. For consumer idle, check the pending acknowledgement, EOF and process completion, then compare local CPU, memory and staging pressure. For output idle with stdout open, no pending write and a running process, ask the storage operator for approved aggregate read timings and status categories in the same window. Pluton's pipe evidence alone cannot distinguish a native stall from network, Rclone or S3 response delay. Preserve that uncertainty if the storage evidence is unavailable. Do not collect full URLs, raw provider logs or request headers.

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
  const pick = (value) => value && ({
    phase: value.phase,
    operation: value.operation,
    elapsedMs: value.elapsedMs,
    timeoutCategory: value.timeoutCategory,
    failureCode: value.failureCode,
    archive: value.archive && Object.fromEntries([
      'firstByteMs', 'bytesReceived', 'lastOutputAgeMs', 'consumerPending', 'consumerPendingMs',
      'consumerBackpressured', 'stdoutEnded', 'processAtStop', 'completion',
    ].map(key => [key, value.archive[key]])),
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
| Job lifecycle and persistence | backend/src/services/AssistedRecoveryService.ts, backend/src/stores/AssistedRecoveryStore.ts |
| Native forwarding, cancellation and observations | backend/src/utils/restic/ManagedSftpRepositorySession.ts |
| Regression coverage | backend/__tests__/integration/replicaRecovery.lab.ts, backend/__tests__/integration/replicaArchiveFaults.fixture.ts, backend/__tests__/services/AssistedRecoveryService.test.ts, backend/__tests__/utils/restic/ManagedSftpRepositorySession.test.ts |
| Runbook | docs/ASSISTED_RECOVERY_TIMEOUT_PROGRESS.md |
