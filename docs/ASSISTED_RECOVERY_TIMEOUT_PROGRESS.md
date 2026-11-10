# Assisted Replica Recovery timeout and progress

## Evidence

The reported UAT obtained approval for isolated staging, then stopped with a generic timeout around 10 minutes and 14 seconds after the source was approved. The reported backup was small. The job had no successful staged result and showed no pending cleanup. This report uses the supplied timestamps and state only.

**Confirmed in code and local fixtures.** Approved execution revalidates the approved destination and its Restic config ID, original snapshot mapping, tree and ownership tags. It builds and validates the exact snapshot index, then calls `prepareManagedExport` to produce the per-file hashes and link proof from a complete authenticated Restic TAR. The preparation sink discards the canonical TAR bytes. Restic still reads the whole archive, even for a granular selection. Only then does the job call native restore into the empty private workspace, validate files and the selected SQL artifact, and revalidate the exact snapshot. A short byte count does not bound metadata calls, pack reads, native process shutdown or downstream validation time.

The first-output watchdog, midstream watchdog, and command watchdog could all surface as `timeout`. The midstream watchdog can fire with a live native process that has stopped emitting output, or with output already delivered to a stalled local consumer. Deterministic tests exercised both cases using the original timer callbacks. A loopback HTTPS S3 fixture completed staging and SHA-256 verification. A separate check in that fixture cancelled a real Restic archive while its output was backpressured and verified removal of the session's private credentials.

**Production cause still undetermined.** The time and last visible phase are consistent with the ten-minute archive inactivity bound plus preceding work. The historical record cannot distinguish native stdout inactivity, local backpressure, or exit wait. It also cannot identify an HCP request, retry or transport failure. Storage latency, Restic/Rclone retry behavior and local processing remain hypotheses. The patch retains the existing watchdogs and the same verification pipeline.

## Timeout boundaries

| Scope | Existing boundary | Diagnostic evidence |
| --- | --- | --- |
| Rclone read-only probe | 5-second connect, 10-second I/O idle, one retry setting at each level. Pluton also has a 60-second command watchdog. Primary availability has a separate 15-second caller deadline. | Explicit dial timeout and general I/O timeout are separate when the bounded native classifier has that evidence. A watchdog firing is recorded as its own category. |
| Exact repository config and snapshot reads | 60 seconds per buffered command. A snapshot metadata deadline after a successful primary probe remains ineligible for connectivity-based fallback. | `repository-identity` or `snapshot-metadata` with `command-deadline` or a caller deadline. |
| Streamed Restic index and diff | 15 minutes per metadata subprocess. A candidate's read-only preflight has a separate three-minute caller deadline across its operations. | `metadata-stream-deadline` or `replica-preflight-deadline` when that deadline actually aborts the candidate. |
| Integrity preparation | 15 seconds until first TAR output. After output starts, ten minutes of inactivity, reset on native stdout or destination drain. No separate preparation wall-clock cap. | `archive-first-output`, `archive-output-idle`, `archive-consumer-idle`, or `archive-exit-idle`. Output idle records what the local process observed. Consumer idle records EOF or backpressure while the pipeline is still pending. Exit idle records a drained pipeline still waiting for the child to close. |
| Native staging restore | 60 minutes for the approved replica restore subprocess. Filesystem verification uses the job cancellation signal. | `native-restore-deadline` for the restore watchdog. Local failures retain the phase and safe failure code. |
| Whole approved job | No independent overall wall-clock timer. The ten-minute approval expiry applies to consuming approval. After approval, explicit cancellation or shutdown propagates to the active operation and cleanup waits for native termination. | No overall deadline category is inferred from job age. Terminal status and cleanup pending are reported independently. |

The pinned binaries report Restic 0.19.1 and Rclone 1.75.1. Restic's default wait to establish its Rclone connection is one minute. Rclone's CLI defaults are a one-minute connect timeout and five-minute I/O idle timeout, with three high-level and ten low-level retries. The explicit probe overrides these Rclone defaults. Restic's Rclone transport has its own behavior and may stop earlier due to the enclosing Pluton watchdog. The watchdog is not a measurement of HCP request latency.

The existing owner-authorized job GET and scoped list return an optional diagnostic for a new failure. It contains only `phase`, `operation`, `elapsedMs`, `timeoutCategory` and `failureCode`. The elapsed value is a monotonic operation duration when available and a phase duration otherwise, bounded to 24 hours. `undetermined` means a timeout was reported without a more precise source. Historical records created before the patch keep their original safe failure code. The existing `managed_native_archive` log event now includes the closed timeout category where available. Job diagnostics exclude paths, provider text, request details and credential material.

The status panel shows a themed, reduced-motion-aware spinner for checking and approved execution. Time starts at request creation for a check and at approval for execution. The live region announces the phase and observed archive activity. Elapsed time is outside that region to avoid announcing each tick. Archive activity describes first-output evidence, and does not claim provider latency or continuous progress. Polling and owner-scoped GET rediscovery use the existing route and intervals. Closing or navigating leaves admitted work active.

## Validation

- Local verification passed 375 backend tests across eight focused suites and all 472 frontend tests. Backend lint, both application type checks, and the Linux production Docker build passed. The compiled image passed the non-root release boundary and HTTPS/LAN checks.
- Deterministic subprocess tests cover first output, output inactivity, blocked-consumer inactivity, metadata stream timeout, caller deadline, connection versus I/O category, process termination and private config cleanup. Service tests cover owner isolation, one-time approval, candidate order, diagnostic persistence on restart and explicit cleanup. Existing TAR proof, exact identity and restore tests cover the readback and staging boundaries.
- Frontend tests exercise checking and running indicators, a terminal failure, elapsed display, an owner-authorized refresh, and terminal polling behavior. A progress percentage or simulated bytes are never inferred from the spinner.
- The real Docker lab uses loopback SFTP and SigV4 HTTPS S3, a synthetic private CA, UID 1000, a read-only root filesystem and network none. It verifies source mapping, primary-offline staged recovery, ownership, one-time approval, rejection of an untrusted CA and native cancellation with private credential cleanup.
- The 24 release and worker boundary checks passed. The API inventory comparison is byte-for-byte and failed on the Windows CRLF checkout. The same test passed in Linux with LF input matching CI.
- Hosted CI and a production HCP retest are pending. The frontend lint command currently stops in the unchanged ESLint configuration because its typescript-eslint extends array contains the string eslint-config-prettier.

## Operator UAT

1. Use an approved image and a small eligible snapshot with an already verified S3 replica. Check that the earlier job is terminal and cleanup is clear. Leave the primary online for a manual replica test. Keep the operation limited to isolated staging.
2. Open the replica details, explicitly check the chosen replica, and approve the exact snapshot once. During checking and running, confirm that phase and elapsed time are visible. Close and reopen the dialog, then refresh the page and confirm that the same owner-authorized job reappears. A phase label and elapsed time describe activity only.
3. Require the terminal staged-integrity success before accepting the result. If the job fails, keep the failure for review and collect only the allowlisted fields below. Do not immediately repeat the recovery to obtain more logs. If cleanup is pending, use the existing owner-authorized cancel/discard control and confirm it clears before another attempt.
4. Compare the diagnostic with the timestamp of the existing `managed_native_archive` event in the same window. Record its safe classification, elapsed duration, timeout category, exit status and signal, if available. For `archive-consumer-idle`, also check CPU, memory and staging volume pressure. For `archive-output-idle`, review whether a read was still active with the storage operator before attributing it to HCP. Share only approved aggregate measurements and sanitized fields.

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
  });
  console.log({
    status: job.status,
    phase: job.phase,
    failureCode: job.failureCode,
    cleanupPending: job.cleanupPending,
    diagnostic: pick(job.diagnostic),
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

## Rollback and file scope

Finish or explicitly cancel active and pending jobs, verify cleanup, and use the existing immutable-image rollback runbook to reapply the prior approved image. [Assisted Replica Recovery rollback](ASSISTED_REPLICA_RECOVERY.md#rollback) The extra fields are optional members of the existing job payload. Keep migration 0022 and all job metadata, and avoid restoring an earlier application database over current backup history. The previous image will not display the new fields. The local loopback lab does not certify HCP latency, provider behavior under load or large-snapshot capacity.

| Area | Files |
| --- | --- |
| Job lifecycle and persistence | backend/src/services/AssistedRecoveryService.ts, backend/src/stores/AssistedRecoveryStore.ts |
| Native operations and preparation | backend/src/services/RemoteRepositoryRecoveryService.ts, backend/src/utils/restic/ManagedSftpRepositorySession.ts, backend/src/utils/restic/ManagedSnapshotIndex.ts, backend/src/utils/restic/ManagedTarExport.ts |
| Progress and diagnostics | frontend/src/utils/assistedRecovery.ts, frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.tsx, frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.module.scss |
| Regression coverage | backend/__tests__/integration/replicaRecovery.lab.ts, backend/__tests__/services/AssistedRecoveryService.test.ts, backend/__tests__/utils/restic/ManagedSftpRepositorySession.test.ts, frontend/__tests__/assistedRecovery.test.ts |
| Runbook | docs/ASSISTED_RECOVERY_TIMEOUT_PROGRESS.md |
