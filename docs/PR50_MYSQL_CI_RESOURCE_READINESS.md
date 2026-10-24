# PR 50 Oracle Internal Recovery CI Readiness

## Confirmed failure and attribution

[Container workflow run 40088499718, job 120857157124](https://github.com/ffigoperdana/pluton/actions/runs/40088499718/job/120857157124)
failed in **Verify Oracle MySQL Internal disposable recovery and refusal
boundaries**. PR head was `afbc14eea3c9baf4283947ecc4265eb106e1ad16`; its base and
latest fetched main were both `e61eab28c3936aa53ad168151b9957fd9e7bc911`.

The failure was the fourth default scenario, **invalid-marker**, after success,
wrong-password and bad-tls passed. Its disposable smoke assertion was
`assert.equal(failed?.code, 'recovery-target-unsafe')`. Instead it received
`internal-resources-insufficient`, yielding `ERR_ASSERTION`. The worker reported
`stage=database-import`, `category=operation-refused`; the smoke stage remained
`preflight` because SQL preflight had not started. PowerShell then threw
`Oracle Internal integration failed.` This was a validation failure after image
build, not a Dockerfile build failure.

The execution path is:

1. The PowerShell driver starts a root-owned, bounded observation fixture and
   waits only for `capacity.json` to exist.
2. That fixture publishes real host/cgroup measurements from the unchanged
   `deploy/persistent-restore/operator.cjs` `resourceCapacity()` implementation.
3. The smoke client submits its authorized artifact to the worker over private IPC.
4. Before SQL connection/guard validation, the worker's
   `withRecoveryResourceGuard` checks worker bounds and
   `assertInternalMysqlCapacity`. A resource refusal therefore takes precedence
   over discovering the intentionally invalid database marker.
5. The client propagates the typed refusal; the scenario's strict, correct
   marker-error assertion fails.

**The fixture omitted an admission-readiness prerequisite.** Existence of an
observation is not proof that its values pass policy. A refused import must not
count as a marker-validation success.

The affected driver, smoke/observer and production guard code were unchanged
between the PR and main. In particular, the driver's Git blob was
`70a2b50b0c7d9bf6d2ff75e99581449fe829ba46` in both. The rename commit changes
neither this execution path nor recovery resource policy. This is inherited
environment-sensitive fixture behavior, not evidence of a rename regression;
it does not assert that a separate main CI run also failed.

## What the original evidence cannot prove

The old failure log has no capacity sample, so it cannot identify which guard
condition failed: memory headroom, pressure, swap, CPU, disk, freshness or an
unknown observation. It contains no OOM proof. Docker reported 4 CPUs, cgroup v2
and 15.61 GiB total RAM on the hosted runner; calling it an undersized 4/7 GiB
runner would be unsupported. Installed memory alone does not establish admission.

The unmodified six-case validation passed locally against newly built real
Oracle images. The exact historical hosted resource state is not reproducible
from its log. The correction establishes the missing precondition rather than
inventing a specific pressure/memory explanation or changing production policy.

## Minimal correction and security boundaries

- Before the first worker import, the test smoke now waits at most 60 seconds
  for the **existing production `assertInternalMysqlCapacity` function** to accept
  a fresh, unchanged measurement from the root observation fixture.
- Observation polling follows the existing two-second publication cadence.
  Already-ready admission starts immediately; there is no stability sleep, SQL
  retry, worker restart or accepted-error fallback. Sustained refusal fails CI
  with `fixture-resource-admission-blocked` before import.
- The worker still independently rechecks root proof, resource policy and its
  own cgroup before/during the actual import. A refusal after readiness still
  fails any scenario whose exact expected error differs.
- Logs whitelist mode/scenario, safe codes and numeric capacity fields. They
  never serialize target configuration, passwords, SQL, proof or raw exceptions.
- A separately named **resource-refused** case uses an actual 2 GiB observer
  cgroup. Only this case expects `internal-resources-insufficient`; disposable
  checks also require failed import status, no lease and a verified empty target.
  Its output explicitly says this is **not a successful recovery**.
- Original six scenarios and strict error assertions remain. Positive observer
  bounds stay 4 GiB/2 CPUs; DB remains 2 GiB/1 CPU/128 PIDs, worker
  384 MiB/0.5 CPU/64 PIDs and app 768 MiB/64 PIDs. No global limits increase.
- The 2,944 MiB available-memory requirement, PSI/swap/CPU/disk thresholds, SQL
  limit, TLS, marker validation, exact snapshot/digest, privilege boundaries,
  lease/ownership cleanup and all production source remain byte-identical.

The fixture uses bounded tmpfs and never certifies real host ext4/ENOSPC, root
operator installation, boot or production capacity. No Docker socket, privileged
container, host ports or production endpoints are used.

## Changed files

- `backend/__tests__/integration/mysqlAutomaticRecovery.capacity.mjs`: bounded,
  injectable-clock readiness helper, excluded from production images.
- `backend/__tests__/integration/mysqlAutomaticRecovery.smoke.mjs`: real guard
  readiness, closed numeric diagnostics and exact resource-refusal assertions.
- `backend/__tests__/integration/mysqlAutomaticRecovery.prepare.mjs`: named
  resource scenario and mode/scenario preparation output.
- `scripts/validate-mysql-automatic-recovery.ps1`: mount the helper read-only,
  add the explicit negative scenario and lower only its observer's cgroup limit.
- `scripts/__tests__/mysqlAutomaticRecoveryCapacity.test.mjs`: readiness,
  deadline, no-import-retry and unchanged security/scenario contract regressions.
- `.github/workflows/container.yml`: require the new tests in the existing
  validation job. Existing native jobs remain required and enabled.
- `docs/PR50_MYSQL_CI_RESOURCE_READINESS.md`: evidence and operator handoff.

## Verification

Local driver: Windows PowerShell with Docker Desktop's Linux/cgroup-v2 engine;
native containers use Node 24.22.1 and genuine Oracle MySQL 8.4.11. Application
and worker were built from their existing Dockerfiles under unique local tags,
without overwriting other images or publishing. The worker build passed its
official-package/hash/signature and UID 10001 checks. The runtime release scan
passed at UID/GID 10001 over 1,707 files with no fixture payload in the image.

| Check | Result |
| --- | --- |
| Unmodified disposable baseline | 6/6 passed; historical hosted shortage did not recur locally. |
| Corrected disposable validation | 7/7 passed, including real constrained resource refusal. |
| Corrected persistent validation | 7/7 passed; success includes native import, same-container Stop/Resume, retained database identity/content and owner cleanup. |
| Repeated invalid-marker plus resource-refused | 2/2 cases passed on each of two fresh repetitions. |
| Fixture and automatic security unit tests | 12 passed, 0 failed. |
| Deployment/rollback, lifecycle, persistence, image/supply-chain tests | 73 passed, 0 failed. |
| POSIX deployment policy / historical rollback fixture | 27/27 and 3/3 passed in non-root Linux containers without Docker access. |
| Focused rename and real resource-guard unit suites | 128 passed, 0 failed; clean exit. |
| Rename frontend DOM/client regression | 4 passed, 0 failed. |
| Full backend suite | 197 suites; 3,925 passed, 4 Windows-platform skips, 0 failed assertions; teardown limitation below. |
| Backend typecheck, lint and production build | Passed. |
| Source runtime and Oracle worker image builds | Both passed; non-root/native client verification passed. |
| JS, PowerShell, Linux deployment/bootstrap shell syntax; API inventory; diff whitespace | Passed; 160 API routes unchanged. |

Measured ready observations reported 4,096 MiB total, approximately
4,080–4,081 MiB available, 2 CPUs, zero PSI avg10/swap and sufficient disk.
The negative cgroup reported 2,048 MiB total and approximately 2,035 MiB
available, and was correctly refused. These are synthetic cgroup observations,
not physical 4 GiB host acceptance.

The full Windows Jest run retained the already documented stream handles in
unchanged MySQL oversized-frame tests and a Pino logger worker after printing
all passing assertions. Its exact owned runner was stopped after recording the
diagnostics, so the full command is **not reported as a clean exit**. No
`forceExit`, assertion or logger change was introduced. Focused suites exit 0;
the original hosted backend job also passed. Frontend's documented ESLint
configuration baseline is unchanged; no frontend lint/configuration fix is
claimed here.

A preliminary Windows Python policy run failed because POSIX `os.geteuid` is
unavailable there. The authoritative rerun was Linux (27 passed). The complete
POSIX Docker deployment/rollback rehearsal was not rerun locally because the
Windows host is not its supported host and no Docker-socket driver permission
was assumed. Its policy/history regressions were rerun; its required hosted job
remains unchanged. These limits do not certify every CI job or production safety.

## CI verification and rollback

The operator should push this branch manually, then inspect both **Backend Test
CI** and **Container image** for PR 50. In particular require:

1. New capacity tests in **Check narrow automatic recovery host operator and
   lifecycle boundaries**.
2. Both Oracle Internal validation steps showing all **7** scenarios passed,
   exact marker refusals and the separately named safe resource refusal.
3. Runtime/client provenance, Custom worker/retained tests, deployment/rollback,
   remaining Internal/native lifecycle checks and cleanup checks still passing.

The existing commands remain:

```powershell
./scripts/validate-mysql-automatic-recovery.ps1 -Mode disposable -WorkerImage pluton-mysql-worker:local -RuntimeImage pluton-recovery-ci:local
./scripts/validate-mysql-automatic-recovery.ps1 -Mode persistent -WorkerImage pluton-mysql-worker:local -RuntimeImage pluton-recovery-ci:local
```

If a hosted runner cannot reach admission within the bounded readiness budget,
CI must stay failed. Use the new sanitized sample to review runner provisioning;
do not weaken the guard, accept resource refusal for another scenario, or retry
an uncertain import. A post-readiness resource failure also remains a failure.

Rollback is a local revert of this CI-only follow-up after review; keep parent
`afbc14eea3c9baf4283947ecc4265eb106e1ad16` and its Remote Device rename fix.
No production deployment, schema, secrets, Agent, snapshot, enrollment or data
rollback is needed. No push, merge or production operation was performed.

## Cleanup and status

Fixture cleanup is checked against exact generated ownership labels; no prune
or unrelated object deletion is used. Final inventory: **0 fixture containers,
0 fixture volumes, 0 fixture networks**. Both newly built `pluton-pr50-*` local
validation image tags were removed after checking their exact fixture label and
absence of dependent containers; they can be rebuilt from the Dockerfiles.
There are no mount/loop/systemd resources in this test design. Test logs and
generated SQL/credentials are not committed. Shared Docker build caches and
pre-existing images were not cleanup targets.

**Local acceptance: passed for the native fixture correction and preserved
resource/security refusals. Hosted Actions verification: pending the operator's
manual push. Production readiness: not assessed or authorized by this task.**
