# Disposable Oracle MySQL worker CI startup fix

Branch: `codex/fix-mysql-worker-ci-startup`, based on freshly fetched main
`ac7732910f020930cd4bb147caf693a1146fdd4c`. Validation date: 2026-10-25.
No push, merge, publication, deployment, production restart, live credential or
database access, standalone Agent change, or repository mutation was performed.

## Confirmed cause and evidence

The [failed run](https://github.com/ffigoperdana/pluton/actions/runs/40186605927)
at `ac77329` built the worker successfully but failed **Verify private IPC and real
disposable Oracle MySQL recovery**. Public run/job metadata confirms that the same
step passed on the [preceding main run](https://github.com/ffigoperdana/pluton/actions/runs/40120563587)
at `5cfaa3c`. The reported CI exception alone did not distinguish startup causes.

Local reproduction used an unmodified current-main worker built with the pinned
`Dockerfile.mysql-recovery-worker` and the unchanged original disposable runner.
It reproduced exactly **Disposable worker refused startup (no provider output
exposed)**, with no socket created. A separate controlled module-load probe in
the rootless Linux worker image identified an unsupported dynamic `fs` require
during module evaluation. Only fixed Boolean/error categories were emitted;
no raw environment, config, SQL, provider output or credential was printed.

The dependency path is:

```text
mysql-worker/index → server/protocol/recoveryDatabaseClients
  → recoveryValidation → ManagedSnapshotIndex → better-sqlite3
  → bundled CommonJS/native support → unsupported dynamic fs require in ESM
```

Managed snapshot streaming introduced a runtime `ManagedSnapshotIndex` import
and `instanceof` in the shared `recoveryValidation.ts` module. That preserved
the native SQLite dependency in the standalone ESM worker bundle. Normal backend
execution has its package layout and passed tests; the client-only worker has a
single standalone bundle. Its module graph failed before configuration validation,
native MySQL probes or IPC socket creation. The old image verifier checked Oracle
client identity but did not execute the worker entrypoint, so image build passed.

Restoring the offending import/`instanceof` in a regression build recreates the
bad graph. Removing that runtime dependency makes the same generated configuration,
named-volume copy-up ownership, 0700 IPC directory and rootless image start
successfully. No fixture chown/chmod repair or native-client/version change was
needed. This is a confirmed local reproduction and dependency cause, not a timing,
permission or runner-memory hypothesis. The original hosted run did not record a
classified module trace; its remote stack is not claimed as independently observed.

## Focused fix and safe diagnostics

- `recoveryValidation.ts` imports the index as a **type only** and distinguishes
  its internal manifest union using `Array.isArray`. Complete manifest checks,
  directory traversal/containment, file type/size/count and SQL hash verification
  remain unchanged. No caller-supplied object or new input authority is introduced.
- The worker build inspects the actual esbuild graph before writing its artifact.
  Native SQLite/bindings, executable dynamic-require shims and external package
  imports are refused. Built-in Node imports and the existing bundled dependencies
  remain supported. There is no new package, lockfile or Dockerfile change.
- The image verifier executes `/app/worker.mjs` without target configuration.
  It must reach the closed configuration refusal, exit 1 and never claim readiness.
  A module-loading crash or newly introduced native dependency now fails the image
  gate itself, before recovery integration starts.
- Module imports execute inside the entrypoint's existing sanitized error boundary.
  It emits only `mysql-worker-startup` with a fixed stage/status. Server callbacks
  identify identity, native client, IPC directory and socket stages; no exception
  message, stack, host, username or configuration value is included. After actual
  bind and socket chmod it emits `stage=ready,status=ready`.
- The disposable readiness helper inspects only Docker state and fixed IPC/config
  paths. It checks rootless identity, numeric ownership/mode, socket type and the
  current container start's ready event. It tolerates the brief bind/chmod interval
  and does not confuse a stale socket/old ready log with a new ready process.
- Early exit stops polling immediately, reporting a closed stage, allowlisted
  container status, numeric exit code and OOM Boolean. Configuration/trust/IPC
  ownership failures are distinct. A running worker without readiness has a real
  60-second elapsed-time deadline, including per-poll Docker overhead, suitable
  for runner scheduling. It is not a sleep added to conceal a reproducible crash.
  Raw `.State.Error`, inspect environment/configuration and log lines are withheld.
- Default validation performs three fresh worker starts before all 12 original
  scenarios; `-StartupRepeats 5` was used locally. Recreating only the worker leaves
  its stale socket for the existing safe restart logic to handle. All scenarios
  and required Actions gates remain mandatory and fail closed.

Worker execution still uses UID/GID **10001:10001**, read-only root filesystem,
private **0700** IPC directory, **0600** socket, dropped capabilities and
no-new-privileges. There is no privileged mode, host networking/port, Docker socket
inside Pluton, chmod 777, permissive credential or weakened trust path. Genuine
Oracle MySQL Community **8.4.11**, root-owned binaries/ancestors, approved endpoint,
verified TLS, guard markers, digest checks and ownership-safe cleanup remain required.
Only short-lived disposable setup containers retain their existing narrowly
authorized root ownership work. No production worker policy is relaxed.

## Validation

All Docker integration tests use randomized disposable names, internal/no external
network access, synthetic private credentials and read-only source mounts; they
clean up only their own resources. The worker uses its pinned Linux/amd64 Node
24.22.1 image, matching the CI runtime. The host is Windows/PowerShell with Docker
Desktop Linux, not a hosted Ubuntu Actions runner; hosted acceptance remains below.

| Check | Result |
| --- | --- |
| Original main worker image + original disposable runner | Reproduced the exact generic startup/socket failure |
| Controlled standalone module probe | Confirmed dynamic `fs` require failure before startup checks |
| `node --test scripts/__tests__/mysqlRecoveryWorkerImage.test.cjs scripts/__tests__/mysqlWorkerStartup.test.mjs` | 18 passed; includes actual bundle build/entrypoint, restored bad-import regression and bounded readiness scenarios |
| `docker build -f Dockerfile.mysql-recovery-worker -t pluton-mysql-startup-fixed:local .` | Passed; genuine Oracle client verification and actual worker entrypoint gate passed |
| `validate-mysql-recovery-worker.ps1 -StartupRepeats 5` | Five fresh startups passed; all 12 original genuine Oracle MySQL scenarios passed |
| `validate-mysql-persistent-restore.ps1` | 20 retained Custom scenarios passed, including 20 preflight plus 20 import cancellations and ownership-safe cleanup after each |
| `validate-mysql-automatic-recovery.ps1 -Mode disposable` | Seven native internal disposable scenarios passed, including TLS, credentials, marker, existing database, cancellation and expected resource refusal |
| `validate-mysql-automatic-recovery.ps1 -Mode persistent` | Seven native internal retained scenarios passed, including Stop/Resume, retained identity and ownership-safe cleanup |
| Backend test suite | 198 suites passed; 3,986 tests passed, four platform skips; 300.414 seconds |
| Linux recovery regression (`validate-phase6.ps1 -BackendTests -Image pluton-phase6-tests:local`) | 12 suites, 335 tests passed; one complementary platform skip; 87.641 seconds |
| Backend TypeScript check and backend lint | Passed |
| `pnpm build` | Three production build tasks passed (two unchanged tasks cached) |
| `git diff --check` | Passed |

The original 12 cases remain: success, wrong-password, invalid-marker,
existing-database, sql-failure, client-command, bad-digest, target-mismatch,
cancel, restart, bad-tls and unavailable. Native inspections check SQL and
credential files 0600, UID 10001, TLS, no password arguments/environment, and
cleanup after success/failure. Readiness tests cover delayed readiness, module,
configuration/native-client refusal, early exit/OOM, IPC ownership failure,
stale sockets and bounded timeouts, including assertions that captured private
provider text never reaches diagnostics.

The generic Windows test suite retains four platform skips. Linux-specific
recovery validation/permission tests are run separately with the existing
Jest-capable `pluton-phase6-tests:local` image. The first attempt used the native
DB fixture image, which lacks Jest; it failed before tests and was rerun using the
test-toolchain image. This environment selection issue did not require source or
test changes. No test assertion or native scenario was removed to obtain a pass.

No application database migration, environment variable, dependency, encryption
secret, primary storage setting, Agent version or deployment configuration changes.
The build gate intentionally rejects future CommonJS/native worker additions:
they require explicit architecture review rather than silently leaking server
dependencies into the single-file client-only artifact. Existing Node-loader
experimental warnings are unrelated and do not fail validation.

## Exact changed files

1. `backend/src/utils/recoveryValidation.ts` — removes the runtime index dependency.
2. `backend/src/mysql-worker/index.ts` — catches module loading and emits closed startup stages.
3. `backend/src/mysql-worker/server.ts` — observes startup stage without changing authorization/execution policy.
4. `scripts/build-mysql-recovery-worker.mjs` — rejects unsupported actual bundle graphs before publication.
5. `scripts/verify-mysql-recovery-worker.mjs` — executes the actual worker entrypoint in the existing image gate.
6. `scripts/mysql-worker-readiness.ps1` — bounded, sanitized container/IPC readiness.
7. `scripts/validate-mysql-recovery-worker.ps1` — uses readiness and repeats fresh startup; keeps all 12 scenarios.
8. `backend/__tests__/integration/mysqlRecoveryWorker.startup.mjs` — fixed-path read-only stat probe.
9. `scripts/__tests__/mysqlWorkerStartup.test.mjs` — real bundle and startup regressions.
10. `scripts/__tests__/mysqlWorkerReadiness.test.ps1` — deterministic readiness/error/redaction cases.
11. `.github/workflows/container.yml` — adds startup regression checks to the required validation job.
12. `docs/MYSQL_RECOVERY_WORKER_REPORT.md` — links this follow-up report.
13. `docs/MYSQL_WORKER_CI_STARTUP_FIX.md` — this evidence and manual verification guide.

`Dockerfile.mysql-recovery-worker`, `protocol.ts`, the synthetic preparation
script, Oracle package pins, production Compose profiles and standalone Agent were
audited but do not require changes.

## Manual GitHub Actions acceptance

1. Publish this local branch through GitHub Desktop and open a PR against current
   main. Review the exact commit and focused diff; no deployment is needed to test.
2. Confirm **Container image → Validate source and production build inputs** runs
   the worker package tests and the added startup regression test successfully.
3. Confirm **Build and verify runtime recovery clients** builds the optional worker;
   its existing image verifier now checks actual module loading/config refusal.
4. Confirm **Verify private IPC and real disposable Oracle MySQL recovery** reports
   three repeated private startups and all 12 scenarios. Any failure must show a
   closed stage/status/exit/IPC diagnostic, not raw logs or config.
5. Confirm the retained Custom, internal disposable, internal retained and existing
   remaining recovery gates all pass. Re-run this job once to check scheduling
   repeatability; do not add sleeps, skip/continue-on-error or permissive privileges.
6. Review both required jobs before merging manually. PR builds remain unpublished;
   the existing main/tag publication conditions and dependencies are unchanged.

The repaired hosted run cannot be claimed before manual publication. If it fails,
use the new closed stage to separate module/config/client/IPC/resource issues;
retain exact safe diagnostics and keep failures blocking publication. Privileged
host ext4/quota acceptance and production recovery testing remain outside these
disposable CI fixtures.
