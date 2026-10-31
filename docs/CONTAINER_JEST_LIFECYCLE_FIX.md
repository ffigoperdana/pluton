# Container Image Jest lifecycle fix

Base: `7be5c0cba6a51b993b3645f3c7b48bd1e15ffcc4`.
Incident: [Container Image run 41141937998](https://github.com/ffigoperdana/pluton/actions/runs/41141937998).

## Evidence and root cause

The hosted job log confirms 209 passing suites, 4,278 passing tests and seven
existing skips in 162.49 seconds, followed by Jest's asynchronous-operations
warning. The job remained in `Test backend` hours after its assertions completed.
That is a process-lifecycle failure, not an assertion failure.

The shared Jest setup initializes a real Pino transport for each suite but did
not close it before Jest disposed that suite's environment. The installed
Pino 9.14.0 / thread-stream 3.1.0 implementation creates a referenced worker and
unrefs it on transport readiness. Readiness and process-exit hooks do not replace
explicit ownership/teardown when suites end while background work is starting.

A Linux focused serial run with `--detectOpenHandles` reported this allocation:

```text
WORKER,MESSAGEPORT
thread-stream createWorker -> ThreadStream -> pino transport
  -> initializeLogger (backend/src/utils/logger.ts)
  -> beforeAll (backend/__tests__/setup.ts)
```

That group passed all 304 tests (one existing skip) in 8.439 seconds and still
reported the referenced logging worker. Individual suites can exit normally;
the allocation/termination behavior depends on suite ordering and scheduling.
The two new snapshot suites alone passed and terminated normally. Comparison
and snapshot-index sweep timers were already unreferenced and their fixtures
already awaited service/cache closure. Bounded process-name/thread/memory checks
did not identify a live Restic/Rclone child as the remaining resource. SQLite
connections were investigated; the reported exit-blocking handle was the Pino
worker/message port.

Both workflows install the same pinned Node/pnpm versions. Backend Test CI uses
`pnpm --filter @plutonhq/core-backend test`, with two workers under `CI=true`.
Container Image adds `--runInBand`. Serial execution keeps transports in the main
Jest process; parallel execution has a separate worker-pool teardown. This
explains why a green parallel workflow is insufficient evidence of clean serial
resource ownership; it is not a reason to switch off the serial gate.

The exact unmodified full command was also exercised locally. The Alpine fixture
had an additional early-exit manifestation (status 1 before the final summary),
so those runs are **not** claimed as a reproduction of the hosted complete-summary
hang or counted as passing runs. The focused allocation trace, real-transport
regression tests, hosted log and complete post-fix runs are the evidence for the
cleanup fix. Hosted verification remains required.

## Targeted change

`closeLoggers()` drains and awaits `close` for the owned main logger and cached
plan logger streams, deduplicates streams, removes its listeners, clears owned
references, and permits clean reinitialization. A failing stream does not prevent
waiting for the other owned streams; failure messages are fixed and do not expose
captured provider contents. The shared Jest `afterAll` awaits this function while
the environment is still alive. Logging destinations, levels, development pretty
printing, production startup and application shutdown configuration are unchanged.

The Container Image backend step now has a ten-minute timeout. A CI-only Jest
reporter emits a warning after nine minutes, or five seconds after suites finish
if the process is still active. It distinguishes assertion/interruption failures
from completed suites waiting to exit and prints only bounded numeric results,
allowlisted resource-type counts and a diagnostic command. Unknown resource
strings become `Other`; no environment, arguments, handle objects, socket details,
provider output or whole diagnostic reports are printed. Reporter timers are
unreferenced and a child-process regression proves they do not keep Node alive.
It never changes Jest's exit code or forces process exit.

No test assertion was removed and no new skip, dependency upgrade, production
configuration change, Agent change, snapshot/export/restore/replication change or
`--forceExit` was introduced.

## Reproduction and verification

Use a disposable Linux checkout, Node **24.22.1**, pnpm **10.20.0**, the existing
frozen lockfile and `CI=true`:

```sh
CI=true pnpm --filter @plutonhq/core-backend test --runInBand
CI=true pnpm --filter @plutonhq/core-backend test --runInBand --detectOpenHandles
```

For a smaller diagnostic allocation trace:

```sh
CI=true pnpm --filter @plutonhq/core-backend test --runInBand --detectOpenHandles \
  __tests__/utils/rclone/helpers.test.ts __tests__/utils/processTree.test.ts \
  __tests__/utils/recoveryResourceGuard.test.ts __tests__/utils/recoveryProcess.test.ts \
  __tests__/utils/restic/restic.test.ts __tests__/managers/ProgressManager.test.ts \
  __tests__/services/ManagedReplicationService.test.ts \
  __tests__/managers/handlers/RestoreHandler.test.ts \
  __tests__/managers/handlers/BackupHandler.test.ts
```

Tests require writable private temporary storage and executable synthetic tool
fixtures, as on GitHub's Linux runner. An application-container fixture's inherited
`IS_DOCKER`, production/data-directory flags and noexec tmpfs do not match that CI
environment and must not be mistaken for application regressions. Local runs used
fresh disposable data, no external network at test runtime, 2 CPU / 4 GiB, zero
swap and bounded external diagnostic deadlines. Those deadlines are failure
guards; both complete post-fix runs exited naturally before them.

| Check | Result |
|---|---|
| Linux serial full suite, run 1 | 211 suites, 4,284 passed, seven existing skips; 226.619 s; natural exit 0 |
| Linux serial full suite, run 2 | Same counts; 230.497 s; natural exit 0 |
| Linux normal Backend Test CI command (two workers) | Same counts; 136.674 s; natural exit 0 |
| Focused Linux `--detectOpenHandles`, including new lifecycle tests | 11 suites, 310 passed, one existing skip; 7.348 s; natural exit 0, no open-handle warning |
| New/existing logger and reporter regressions on Windows | Three suites, 22 passed |
| Linux source/security/workflow checks | 150 passed; no skips |
| Exact Linux Oracle worker package/readiness gate, real PowerShell | 19 passed; no skips |
| Linux deployment/bundle/CA policy tests and shell syntax | 38 passed; syntax valid |
| Linux automatic-recovery boot Python checks | Nine passed |
| Linux backend lint and backend/frontend type checks | Passed |
| Full Linux frontend suite | 365 passed |
| Linux production build | Three workspace build tasks passed |
| Frontend lint baseline | Existing `tseslint.config()` string-extends configuration error, exit 2; unchanged, matching the workflow's existing nonblocking baseline |

The 209 existing suites remain present; the two additional suites cover real
transport flushing/readiness/reinitialization/error teardown and sanitized,
nonblocking lifecycle diagnostics. No production resources or credentials were
used. The remaining `validate` job checks were exercised locally after the two
serial runs. Hosted Container Image, image-build and native integration jobs
still need operator verification after publication; no hosted CI PASS is claimed.
