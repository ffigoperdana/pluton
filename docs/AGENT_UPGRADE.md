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

Recorded local results: upgrade transaction suite **25 PASS / 2 Linux SKIPPED**;
complete Agent suite **75 PASS / 77 Linux SKIPPED**; article/identity validation
**13 PASS**; Fumadocs **8 PASS**. Agent TypeScript/build, documentation TypeScript
and production build, Bash syntax/help/invalid-option checks, JavaScript syntax
and diff/privacy checks passed. No CI thresholds, dependency files or existing
installer behavior were changed. No full backend/Phase 6 audit was repeated.
