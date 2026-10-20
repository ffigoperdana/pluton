# Upgrade an existing enrolled Linux Agent

`installers/upgrade-agent.sh` replaces **Agent application artifacts only**. It
does not install/enroll a new Agent, regenerate configuration, change root grants,
install global Node/npm/pnpm, update Restic/Rclone, migrate the server or alter
other services. Agent 0.6.1 adds the local upgrade-hold protocol used by future
running upgrades. This is an operator procedure, not permission to deploy.

## Normal usage

Use the existing reviewed checkout on the Agent host. The path below is synthetic:

```bash
cd /srv/pluton
git pull --ff-only origin main
sudo bash installers/upgrade-agent.sh --check
sudo bash installers/upgrade-agent.sh
systemctl is-active pluton-agent
```

`--check` is optional. It reads local installation/service/source/disk state; it
does **not** build, download, poll, send a heartbeat, stop/restart the Agent, create
files or refresh the Git index. It cannot prove server availability or that server
queues are empty. `--help` needs no root or installed Agent.

Before the update, deploy the compatible server under its separate approval,
pause the Agent's plans and finish/reconcile queued or running backup and Source
Access requests in Pluton. Keep them paused through verification. The script has
no administrative server session and never calls `/poll` to discover work. Its
race-free local fence proves that no Agent operation is executing at replacement;
it is not a server queue inventory or a distributed maintenance reservation.

After one-time upgrade to protocol v1, subsequent updates normally require just
the pull, upgrade and status commands above. Server-side pause/drain remains an
operational prerequisite. Do not run concurrent host policy or installer commands.

## First upgrade from an older Agent

A running pre-0.6.1 Agent cannot acknowledge the root-owned installation hold.
The upgrader deliberately refuses it; absence of a child process is not proof of
idle execution. First pause plans, finish jobs and settle Source Access requests
in Pluton, then have the operator verify the host is idle and safely stop it:

```bash
# Only after separately verifying server/host drain:
sudo systemctl stop pluton-agent.service
sudo bash installers/upgrade-agent.sh --check
sudo bash installers/upgrade-agent.sh
systemctl is-active pluton-agent
```

The upgrader accepts an already stopped, enrolled installation only if its cgroup
is empty. It starts the upgraded Agent after verification. It does not invoke the
enrollment installer, require a new token, rotate identity, or clear receipts.
Do not stop an active backup merely to satisfy this prerequisite.

## Supported installation and preflight

- Linux x86_64, systemd with unified cgroup v2 and the installer-created
  `pluton-agent.service` (`Type=simple`, unprivileged `pluton-agent` user/group).
- Exact installed paths: `/opt/pluton-agent/runtime/bin/node`,
  `/opt/pluton-agent/app/dist/index.js`, `/opt/pluton-agent/bin`,
  `/etc/pluton-agent.env`, `/var/lib/pluton-agent`. Unit drop-ins, alternate
  executables/config/state paths and unknown service contracts require a separate
  reviewed procedure. No configuration is rewritten to force compatibility.
- Root-protected `.verified-install` provenance, ownership/modes and full
  runtime/bin/app tree integrity must match. Installed private Node/Corepack and
  Restic/Rclone versions must match the installer contract; only `app` is updated.
  Missing/obsolete provenance is a blocker, not permission to reinstall.
- The source checkout must be clean and committed. The exact commit is captured;
  `git archive` supplies the root-protected build snapshot. No branch is pulled,
  switched or published by the script. **Review/trust that commit first**: the
  build executes its code as root. A commit hash records provenance, not an
  independent signature or reviewer approval.
- The existing private Node invokes its own Corepack and the repository's exact
  pinned pnpm with the frozen lockfile and dependency lifecycle scripts disabled.
  Build/cache/temp files stay inside this upgrade's private backup directory.
  No global package manager or system Node is required or changed. Network access
  to the normal package registry may be needed; offline build is not guaranteed.
- At least **2 GiB plus two installed-app sizes free** is required on both `/opt`
  staging and `/var/lib` backup filesystems. Larger dependencies may require more.
  Any build/space error occurs before the service is stopped. Backups accumulate;
  pruning them is a separate exact-ownership operator task.
- Config is parsed as literal installer-style EnvironmentFile values, never
  sourced/evaluated as shell. Unsupported quoting, duplicate entries and arbitrary
  service environment additions are refused. TLS files must remain readable by
  the service user. CA/mTLS, roots, hooks, database client paths and credentials
  remain in their original files.

## Transaction and health checks

The script creates a root-owned 0700 `/opt/pluton-agent/.upgrade-lock` and a unique
0700 `/var/lib/pluton-agent-upgrades/<UTC>-<commit-prefix>-<random>/` directory.
The latter retains source/build artifacts, a durable receipt, previous app,
configuration/unit backups (0600) and previous `.verified-install`. These are
private operator files and must never enter Git, support tickets or public logs.
No historical identity, secret or Source Access state is copied back by rollback.

New Agents hold all normal execution before heartbeat/poll while the installation
hold exists. Before build, the upgrader exclusively publishes the existing Agent
activity fence, then rechecks drain and preserved hashes after build. An existing activity fence, child job, pending
selection transaction, live mode-setup receipt, host writer lock or nonempty jobs
workspace causes refusal. Unknown/stale markers require exact review; none is
blindly deleted. The running process executable, argument vector and cgroup must
match before Stop. The upgrader does not execute or cancel Source Access commands.

The service is stopped only after the local fence is durable. Configuration,
unit, identity/receipts and host/selection policy hashes must remain exact. The
old app is backed up and fsynced. The new app is copied onto the installation
filesystem, checked as the service account, then published with **two individually
atomic renames while stopped**. A durable journal covers the gap; this is not a
single atomic directory exchange and is not claimed power-loss acceptance.
Only application provenance is updated. Runtime, private tools, configuration,
unit, identity, policy and command receipts are not replaced.

Only `pluton-agent.service` is started/restarted. During the hold, an explicit
unprivileged `check` sends an authenticated TLS heartbeat **without polling**;
stable MainPID/running state is checked again after three seconds. No enrollment,
unit rewrite, daemon reload or enable/disable operation occurs. After hashes and
health pass, the exact activity fence and installation hold are durably released.
Normal polling then resumes. A heartbeat is not a synthetic backup/restore test;
use a separately approved pilot before resuming production plans.

## Failure, interruption and rollback

Ordinary failures before publication retain the old app. Post-publication failures
attempt to restore only the known previous app and its provenance while still
drained; the original active/inactive state is respected. Unknown artifacts,
changed identity/policy/receipts, failed durability or a live owner leave the hold
closed and retain evidence for review. No `rm -rf` of installation/state is used.

The receipt and retained filenames identify the transaction. After a killed
process or interrupted rename, inspect the exact root-private receipt locally,
prove the recorded owner is gone, keep server plans paused and use its exact ID:

```bash
sudo bash installers/upgrade-agent.sh --rollback <exact-upgrade-id>
systemctl is-active pluton-agent
```

Rollback validates the receipt, Agent binding, preserved-state hashes, previous
artifact hash and exact owned fences. If interrupted before replacement, it
aborts that transaction without changing the app. It never restores stale
identity/configuration/policy from the backups. An interrupted rename can be
recovered even if `app` is temporarily absent, using the transaction's protected
private-Node digest. Failed/candidate/previous artifacts remain for investigation.

Rollback **refuses after identity receipts, selected roots, credentials, host
policy or configuration have evolved**. A downgrade then needs a separate review
of old-code policy compatibility; do not reset state to make hashes match.
If final hold release has begun, the script never stops/rolls back a process that
may already have accepted work. An uncertain release restores the hold where
possible and requires operator review. Do not erase a marker, kill an unknown job
or restore an old identity to bypass any refusal. A failure before a complete
receipt exists requires exact manual review rather than automatic cleanup.

## Safe failure diagnostics

Failed upgrades now print closed, structured fields. For example only (this does
not diagnose an earlier failure):

```text
Failed stage: HEALTH_CHECK
Error code: AGENT_HEARTBEAT_FAILED
Rollback: SUCCESS
Previous Agent preserved: YES
```

`BUILD`, `CANDIDATE_VERIFY`, `ACTIVATE_PREVIOUS`, `ACTIVATE_CANDIDATE`,
`PROVENANCE`, `SERVICE_START`, `HEALTH_CHECK`, preservation checks and fence/hold
release are distinguished. `HEALTH_CHECK` can report `AGENT_NOT_RUNNING`,
`AGENT_NOT_STABLE`, `AGENT_HEARTBEAT_FAILED` or `AGENT_HEALTH_TIMEOUT`.
Heartbeat failure alone does not identify network, TLS, authentication or
server-version compatibility. Timeout means the bounded local subprocess hit its
execution deadline; a child exiting nonzero is not called a timeout based on its
output. Build, startup, filesystem permission/space/IO and preservation failures
have separate codes. No checks or rollback requirements are bypassed.

Backup operations now distinguish `COPY_APP` / `APP_BACKUP_COPY_FAILED`,
`SYNC_APP` / `APP_BACKUP_SYNC_FAILED`, `COPY_PROTECTED_FILES` /
`PROTECTED_BACKUP_COPY_FAILED`, and `SYNC_BACKUP` / `BACKUP_SYNC_FAILED`.
Known filesystem errors retain their existing safe permission/space/IO codes;
`SYNC_ENTRY_UNSAFE` refuses non-regular files, file replacement during open, or links
outside the owned build scratch. The original stage/code survive rollback.

The earlier whole-transaction walker treated `build/stage/runtime` as a file:
the builder deliberately creates that directory symlink, `lstat()` does not call
it a directory, and opening its target with `r+` fails with `EISDIR` on Linux.
This can happen after every app byte was copied correctly; an app-only inventory
does not inspect build scratch. It is a source defect consistent with a generic
`BACKUP_FAILED`, but the historical stage/code alone cannot prove that incident's
exact syscall or errno. Copy/timestamp, regular-file sync and directory sync
failures were previously indistinguishable. Do not backfill old receipts.

Regular files are now checked before/after opening with `O_NOFOLLOW` and fsynced
through read-only descriptors on Linux. This does not chmod source files, alter
their ownership or bypass a sync error. The Windows synthetic harness retains a
writable handle because Windows requires it for `FlushFileBuffers`; Windows is
not an installation target. Every regular file, including retained build files,
is still fsynced and every real directory is synced after its children. Links
are allowed only below this transaction's `build/` directory: their containing
directories are synced and targets are never opened or traversed. App and
protected-backup paths remain strict. No build/transaction evidence is deleted.

An incomplete backup can still make automatic rollback fail closed even when
the original app remains intact. Such failures retain the exact hold and receipt
for the existing explicit rollback/operator procedure; they never activate the
candidate or reset policy/identity to force recovery. A late sync failure with a
complete verified backup can restore/start the previously active app normally.
The prepared receipt is still published only after all required syncs succeed.

References: [Linux open errors](https://man7.org/linux/man-pages/man2/open.2.html),
[file and directory fsync](https://man7.org/linux/man-pages/man2/fsync.2.html), and
[Windows FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).

The first failure's stage/code survive automatic rollback. `Rollback: SUCCESS`
means app restoration and owned-fence cleanup completed; `NOT_NEEDED` means no app
rollback was needed; `FAILED` means recovery/cleanup could not complete. A failed
rollback prints its own stage/code separately. `NOT_ATTEMPTED` means the safe
rollback boundary was not entered (including post-release or uncertain Stop).
`Previous Agent preserved: YES` requires matching previous app and preserved-state
hashes at reporting time; otherwise the value is `UNKNOWN`. It is not a claim
that an originally stopped service was restarted. Keep plans paused until its
separately verified intended service state is restored.

For new failed transactions, the root-private receipt has a `failure` object with
the same sanitized fields; `INCOMPLETE` can remain if interrupted during rollback.
Diagnostic persistence is best effort and cannot trigger a service action or
replace the primary error. `Diagnostic receipt: UNCONFIRMED` means that write
could not be durably confirmed; retain the console fields locally. Do not publish
the full receipt: its existing ownership/binding fields are private. Console and
failure fields exclude child stdout/stderr, environment, command arguments,
exception messages/stacks, sensitive paths and identity/credential material.

A historical `rolled-back` phase with both artifact digests does not identify the
failure stage: the candidate digest was recorded before activation. Later local
preflight success and an empty warning journal cannot recover the discarded
cause; the explicit heartbeat runs outside the service journal. Old receipts
without `failure` remain undiagnosed. Do not edit/backfill them or rerun a
production upgrade without the applicable authorization. Use only the safe
stage/code and existing private operator evidence to plan a controlled retry.

## Tests and evidence limits

On disposable Linux, without sudo or a real service:

```bash
bash installers/tests/upgrade-agent.test.sh
pnpm --filter @plutonhq/pluton-agent typecheck
pnpm --filter @plutonhq/pluton-agent test
git diff --check
```

The transaction suite uses real temporary files and fake service/build adapters:
success, exact preservation, active-job/pending-policy refusal, failed build,
startup rollback, interrupted build/rename recovery, ownership, changed receipts,
corrupt backup, durability failure, service contract and disk admission. Linux
cases additionally exercise real directory fsync, POSIX permissions and symlinks;
the Agent has a Linux runtime test proving the hold prevents polling.

Local development validation was on Windows: cross-platform transaction models,
Bash parsing/help and available Agent regressions were run. Linux-only cases
remain **SKIPPED**, not PASS. Real systemd/service-user startup, registry/private
Corepack builds, physical crash and production upgrade/rollback have **not** been
executed. Hosted Linux CI and a separately authorized disposable-systemd pilot
are required before production use. No existing Agent was accessed by this task.

The focused `Agent upgrade safety` workflow is prepared to run these transaction
and complete Agent tests on hosted Ubuntu with Node 22.18.0 after manual branch
publication. It has read-only repository permissions, no secrets, privileged
service actions, publishing or deployment steps. It has **not run** locally or
remotely as part of this task.

Original upgrader baseline results: upgrade transaction suite **25 PASS / 2 Linux SKIPPED**;
complete Agent suite **75 PASS / 77 Linux SKIPPED**; article/identity validation
**13 PASS**; Fumadocs **8 PASS**. Agent TypeScript/build, documentation TypeScript
and production build, Bash syntax/help/invalid-option checks, JavaScript syntax
and diff/privacy checks passed. No CI thresholds, dependency files or existing
installer behavior were changed. No full backend/Phase 6 audit was repeated.

Diagnostics extension: the same upgrade safety suite now has **38 PASS / 2 Linux
SKIPPED** (40 tests), including the original guard/rollback regressions and new
stage/category, rollback-result, preservation-mismatch, output-redaction and real
bounded subprocess exit/deadline checks. Bash harness, both helper syntax checks,
workflow parsing/permissions and diff/privacy checks pass locally. The dedicated
Linux workflow also watches the diagnostics helper; hosted Linux/systemd and
production execution were not performed for this revision. Agent/backend source
and transaction authorization rules are unchanged; their full suites were not
rerun for this diagnostics-only patch.

Backup synchronization follow-up: upgrade transaction tests **45 PASS / 4 Linux
SKIPPED** locally (49 tests). They include a real 88-file copy with a private
build directory link, non-dereference checks, copy-then-file-fsync and directory
sync failures, partial backup, permission errors and original-artifact/state
preservation. Linux-only tests reproduce the old `r+` directory-link `EISDIR`,
exercise read-only file fsync and directory fsync, and test actual permission
refusal without relaxing source modes. The local machine had no running Docker
daemon or disposable Linux distro; the Linux cases have **not** run here.
Passing Windows tests is not approval for another production attempt. Run the
existing Agent upgrade safety Linux workflow on the final commit, then review
its results and authorize any controlled retry separately. No existing Agent,
production transaction or service is accessed by these tests.

Agent typecheck/build with the repository's installed TypeScript compiler and
the complete Agent suite passed (**75 PASS / 77 Linux SKIPPED**). Two initial
sandbox loopback failures passed when rerun with local-test network access;
no checks were disabled. One Windows hold-file assertion failed once and was
not reproduced in five isolated reruns or the final full upgrade harness. Its
assertion remains strict, now with sanitized failure metadata; the original
one-off cause is unresolved. Bash syntax/help/refusal checks and the final
upgrade harness pass. These limits still require independent Linux validation.
