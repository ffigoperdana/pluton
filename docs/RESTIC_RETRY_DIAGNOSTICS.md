# Restic retry diagnostics for archive reads

A native archive read (snapshot TAR for downloads, exports and Assisted Replica Recovery) used to
discard Restic's stderr entirely. When Restic kept retrying one backend request, Pluton only saw an
idle stdout and reported `archive-output-idle` after ten minutes. In the HCP gzip incident
([HCP_RANGE_GZIP_FIX.md](HCP_RANGE_GZIP_FIX.md)) the message that named the failing pack and error
was on that discarded stream, and it took several production iterations to reconstruct it. Pluton now
reduces that stderr to a closed, bounded summary and reports a retry loop as a retry loop.

## Behavior

Restic 0.19.1 reports each backend retry on stderr as
`Load(<data/0123456789>, <length>, <offset>) returned error, retrying after <delay>: <error>`, a
give-up as `... failed: <error>` and a later success as `... operation successful after N retries`
([report function](https://github.com/restic/restic/blob/v0.19.1/internal/global/global.go)). The
handle prints at most ten characters of the object ID
([Handle.String](https://github.com/restic/restic/blob/v0.19.1/internal/backend/file.go)). Restic
forwards its Rclone child's errors as `rclone: <date> <time> ERROR : <path>: ...`.

`ArchiveBackendRetries` (`backend/src/utils/restic/archiveBackendRetries.ts`) parses those lines and
keeps only:

| Field | Content |
| --- | --- |
| `retryCount`, `gaveUpCount`, `recoveredCount`, `serverErrorCount` | Counters for the four line kinds |
| `errorClasses` | Counts per closed class: `http-status`, `partial-read` (wrong-size response), `unexpected-eof`, `stream-reset`, `timeout`, `connection-reset`, `dns-not-found`, `tls`, `not-found`, `other` |
| `loads` | Up to four most recent distinct requests: object type, the 10-hex pack prefix Restic prints, length, offset, attempts, last error class and HTTP status when one was reported |
| `lastRetryAfterMs` | Restic's last backoff delay |
| `lastServedBytes`, `lastExpectedBytes` | From Rclone `wrote X/Y bytes` |
| `truncated` | Set when the 4 KiB line bound or the 20,000-line bound was reached |

Every other line, and the error text itself, is discarded. Raw provider text, URLs, hostnames,
addresses, object paths beyond the pack prefix and credentials never leave the parser.

The summary is attached as `archive.backendRetries` to the archive diagnostic, the persisted Assisted
Recovery job diagnostic (copied field by field) and the `managed_native_archive` log event. When the
inactivity or first-output watchdog fires and Restic reported a failed request after the last stdout
output, the timeout category is `archive-backend-retrying` instead of `archive-output-idle` or
`archive-first-output`. While running, the live activity becomes `archive-backend-retrying` instead
of `archive-output-paused`. Timeouts, kill behavior and every other category are unchanged.

The Assisted Recovery panel shows a status ("Restic kept retrying a repository read. Recovery
stopped after the inactivity limit."), a running detail, operator advice and one sentence such as:

> Restic retried a repository read 12 times · data pack 00e0e0ca8b at byte 2,605,056 (13,960 bytes) ·
> last error: response ended early · server sent 2,875 of 13,960 bytes

## Validation

| Check | Result |
| --- | --- |
| New parser suite (`archiveBackendRetries.test.ts`): formats, chunk splitting, CRLF, bounds, hostile input with URLs, IPs, signatures and secrets, all classes, Go durations | passed |
| Session test: retry after output yields `archive-backend-retrying`, the summary, and no secret, host or bucket text from the fixture's stderr | passed |
| Service test: summary persists across a restart, field by field, without planted extra fields | passed |
| Focused backend suites (parser, session, service) | 129/129 passed |
| Full backend suite (`--runInBand`, Windows, Node 24.16.0) | 230/230 suites; 4,835 passed, 4 skipped by default |
| Frontend tests (all) | 474/474 passed |
| Backend type check, backend lint, frontend `tsc -b` | passed |
| `pnpm build` | 3/3 tasks successful |
| Replica recovery lab (`scripts/validate-replica-recovery.py`, Docker, network none) | all scenarios passed, exit 0 |

In the lab, the gzip scenario (real Restic 0.19.1 and Rclone 1.75.1, gzip re-enabled on purpose)
now reports `archive-backend-retrying` with `retryCount: 3` and `errorClasses: { partial-read: 3 }`;
the real Restic text there was `net/http: server replied with more than declared Content-Length;
truncated`. The held-response scenario, where Restic waits without retrying, still reports
`archive-output-idle`. A separate synthetic capture confirmed the `rclone: ` prefix and the
`http2: handler wrote more than declared Content-Length` and `unexpected EOF` texts.

`tsconfig.test.json` is not part of the standard checks and was not used as a gate. Hosted CI and
production UAT are pending.

## Operator UAT

1. Deploy the image by digest as usual. No migration and no Agent action.
2. Run one replica check and staged recovery as in
   [ASSISTED_RECOVERY_TIMEOUT_PROGRESS.md](ASSISTED_RECOVERY_TIMEOUT_PROGRESS.md). A healthy run must
   complete exactly as before, with no retry line in the panel.
3. If a run fails with `archive-backend-retrying`, record the panel sentence or `archive.backendRetries`
   from the console snippet in that runbook (it now includes the field). The pack prefix, offset,
   length and error class are enough to rerun
   `scripts/diagnostics/serve-restic-range-sweep.mjs --range <offset>:<length>` against the replica.

## Rollback

Redeploy the previous image digest. The new field is optional; older images ignore it, and job rows
written by this version remain readable. No data, schema or replica change is involved.

## Limitations

- Only the archive read path parses stderr. Metadata commands keep their existing private 16 KiB
  classification, and native restore keeps its existing handling.
- The summary relies on Restic 0.19.1's message format. A future Restic that changes it would leave
  the summary empty and fall back to the previous categories; it would not break the read.
- Lines are parsed only when they end with a newline or the process closes; Restic always terminates
  its lines.

## Changed files

| Area | Files |
| --- | --- |
| Backend | `backend/src/utils/restic/archiveBackendRetries.ts` (new), `backend/src/utils/restic/ManagedSftpRepositorySession.ts`, `backend/src/services/AssistedRecoveryService.ts` |
| Frontend | `frontend/src/utils/assistedRecovery.ts`, `frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.tsx` |
| Tests | `backend/__tests__/utils/restic/archiveBackendRetries.test.ts` (new), `backend/__tests__/utils/restic/ManagedSftpRepositorySession.test.ts`, `backend/__tests__/services/AssistedRecoveryService.test.ts`, `backend/__tests__/integration/replicaArchiveFaults.fixture.ts`, `frontend/__tests__/assistedRecovery.test.ts` |
| Reports | `docs/RESTIC_RETRY_DIAGNOSTICS.md` (new), `docs/ASSISTED_RECOVERY_TIMEOUT_PROGRESS.md` |
