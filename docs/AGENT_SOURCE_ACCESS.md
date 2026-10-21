# Managed Agent Source Access

Source Access v1 adds a bounded directory policy workflow to the public Agent.
It does not introduce remote shell execution, a file browser, privilege escalation,
filesystem permission changes, or a new database/hook policy.

## Authorization and compatibility

Fresh Agent enrollment now uses the separately configured standalone 0.7.0 Git
distribution and reviewed immutable commit; see
[AGENT_ENROLLMENT_DISTRIBUTION.md](AGENT_ENROLLMENT_DISTRIBUTION.md). Its planned
roots/mode are not a host delegation or an effective Source Access receipt.
Existing monorepo Agents keep their installer/upgrader and identity/policy state;
no automatic distribution migration or integrity rewrite is performed.

### Two host-controlled modes

**Host-Approved** is the default for existing installations. A new directory
outside the approved maximum stays Pending Host Approval until a trusted host
operator approves its canonical target locally, followed by explicit UI Apply.

**Server-Managed** requires explicit initial host delegation or a one-time local
opt-in for an enrolled Agent. The host delegates one or several canonical prefixes.
Pluton administrators can validate and enable application directories inside
those prefixes entirely through the UI, without recurring SSH, environment edits,
re-enrollment or service restarts. Actual Linux access permissions still apply.

Effective access is the intersection of the host maximum, UI-enabled selection
and Linux filesystem permissions. Delegating a parent trusts Pluton administrators
with all eligible readable descendants, including future applications there;
choose the narrowest useful canonical prefixes. System secrets, Agent state and
credential locations must remain excluded even inside a delegated prefix. No
directory scan or filesystem-wide delegation is implied.

Server-Managed refuses explicit/canonical paths inside `.ssh`, `.aws`, `.gnupg`
and `.kube`. Agent-local backup filters also exclude those directory names beneath
an enabled parent; command payloads cannot remove these filters. Host-Approved
retains its existing backup content behavior. These filters are not general secret
discovery: application configuration/data inside a deliberately approved root may
itself contain credentials. Choose scopes and Linux read ACLs accordingly, preserve
repository encryption, and never publish backup content or private inventories.

Selecting a different mode in the browser expresses intent only. Until the host
confirms the matching local setup, the current mode remains effective and the UI
shows pending host setup. An outside path can never become approved merely by
clicking Apply. Mode changes require drain/review of affected plans and pending
operations; returning to Host-Approved removes access outside its strict maximum.
Do not downgrade an Agent or replace policy state to bypass this boundary.

1. The host operator defines the maximum. Existing canonical
   `PLUTON_AGENT_ALLOWED_ROOTS` remain part of that maximum and the initial enabled
   selection. Additional canonical roots are stored in root-owned
   `/etc/pluton-agent/source-access.json`, bound to the enrolled Agent ID.
2. The authenticated Pluton administrator selects enabled canonical roots inside
   the maximum. The server cannot change the host approval file. Host approval
   alone does not enable a newly added directory.
3. The unprivileged Agent checks canonical containment, directory identity and
   actual read/traverse permissions. It repeats source validation at backup
   execution; a server report never substitutes for local enforcement.

The existing application has one administrative browser-session model, not a
multi-role user model. `/api/agent-admin` requires that session; an Agent HMAC,
generic API key, unauthenticated user or cross-origin write cannot use its
administrative directory endpoints. Agent callbacks keep their existing signed
body, timestamp, nonce, command lease, sequence and identity checks.

Old Agents do not advertise `sourceAccessVersion: 1`. Their static source policy
and existing plans remain supported by the new server. Deploy the server with
additive migration **0019** before upgrading Agents to **0.6.0**. New-Agent/old-server
inventory is deliberately refused by the old strict contract; it is not a
supported rollout order or a reason to strip security fields. Migrations 0016 and
0018, MySQL root operators, Resume sequence and recovery resource policy are
unchanged.

Installer-produced static roots are canonical. Hand-written static roots that
still contain a symlink must be reviewed and changed by the host operator to
their exact canonical targets before this upgrade. A moving symlink is never a
dynamic host approval. Overlapping historical roots remain reported; remove the
redundant selection deliberately before submitting a new nonoverlapping set.

## Administrator workflow

1. Open **Sources → remote machine → Source Access**. Check Agent identity,
   connection, report freshness, host-approved maximum, enabled/effective paths,
   per-path permission status and policy revision.
2. Enter up to 32 absolute Linux directories, one per line, at most 1024 characters
   each. **Validate paths** probes only those paths, resolves their canonical
   targets and checks access. It does not change access or start a backup.
3. In **Server-Managed**, review the canonical preview and choose **Apply** for
   readable paths inside the delegation. No host command is required. Outside
   paths are refused and require a separately reviewed change to host delegation.
4. In **Host-Approved**, **Request access** submits the desired enabled set. An
   outside directory stays **Pending host approval**. Copy the displayed host
   instruction to the trusted host operator, who reviews the exact host, Agent ID,
   policy revision and canonical roots before approving.
5. After Host-Approved local approval, refresh the report, select the newly
   approved roots and choose **Apply enabled roots**. Both modes persist selection
   durably and wait for a confirmed version. No policy-only restart is needed.
6. Disable obsolete enabled roots explicitly. The UI names affected plans; the
   backend requires the exact confirmation, paused affected plans and no related
   queued/running backups. It rechecks immediately before dispatch. Plan execution
   also checks current policy before credentials are materialized.

Validation/request history distinguishes queued, validating, validated, pending,
applied, rejected and cancelled. Offline/stale reports cannot approve new access.
An unreadable root remains a recorded enabled selection until deliberately
removed; it is not an effective readable source. Host revocation always removes
effective access, even if Pluton previously enabled that directory.

For a new plan, choose an effective root or validate an explicit path, inspect the
canonical result and select **Use validated canonical path**. Pending access does
not select a source. Existing plan sources remain fixed; edit can validate the
current path without rewriting its repository, credentials or other settings.
Older Agents retain their manual source form and enforce their existing static
policy locally.

## Narrow local host approval

### One-time mode setup for existing or newly enrolled Agents

Enrollment initially retains strict Host-Approved behavior. Selecting
Server-Managed during enrollment guides the one-time setup after the new Agent
is ONLINE; it does not add unsupported flags to the existing installer or weaken
enrollment. In Source Access, select the requested mode and canonical delegation
prefixes. Pause all plans on that Agent and finish queued/running work. Request
the mode setup in Pluton. The server checks the drain, signs a narrow leased setup
command and blocks new backup materialization until the transition is confirmed.

The Agent stores the exact identity-, revision-, request- and scope-bound setup
receipt. The UI displays a copyable local host command for this request. A trusted
host operator reviews and executes that command once. It is not a remote shell
API, and the receipt expires after 15 minutes. Do not invent an ID or reuse an
expired setup receipt. The local activity fence also prevents a mode change while
Agent work is executing; root approval cannot rely on a checkbox as proof of drain.

The receipt also binds to the current boot and a monotonic deadline. Reboot or a
wall-clock rollback cannot extend it, and retrying preparation must not renew its
deadline. The server conservatively keeps operations frozen through its request
expiry plus the existing authentication clock-skew margin; do not cancel the UI
state and resume work while a usable host receipt may still exist. A reboot is
not part of setup or this source sprint.

Use the generated `source-access delegate` command for Server-Managed, or
`source-access host-approved` to return to strict approval. Both bind the existing
Agent ID, current host revision and exact setup request. The delegation command
also requires explicit delegation and drain acknowledgements and repeated exact
canonical roots. Refresh and verify the current mode before enabling folders or
resuming plans. Newly delegated directories still require explicit UI Apply.

After setup, Server-Managed uses **Validate Paths → canonical preview → Apply**
for new directories inside the delegation. No recurring host command is needed.
Outside paths cannot be enabled by Apply. Host-Approved continues using the
per-addition command below. Never use mode setup as a way to approve an expired
source request or to reset identity, replay counters or initialized policy state.

These commands are preparation examples, not authorization to run them on a host.
Use the Agent ID and current revision displayed for that exact machine. Paths below
are synthetic. A trusted host operator authenticates locally; no password, token or
identity secret is copied into Pluton, a ticket, a command argument or this document.

```sh
sudo /opt/pluton-agent/runtime/bin/node /opt/pluton-agent/app/dist/index.js \
  source-access approve --config-file /etc/pluton-agent.env \
  --agent-id 'agent-example' \
  --expected-host-policy-revision '<current-64-hex-revision>' \
  --root '/srv/example-app' --root '/srv/example-worker'
```

The CLI parses only known literal configuration entries; it never sources/evaluates
shell text. Configuration/approval files and their ancestors must be root-owned,
not symlinks and not writable by the Agent or other users. The extra approval
file is root-owned and readable; it contains paths and binding data, never secrets.
Approval/revocation uses a local revision comparison and atomic file replacement,
file fsync and parent-directory fsync. Incorrect Agent/revision, ambiguous paths,
overlap and broad/system roots are rejected. It does not alter application ACLs.
The Agent must separately prove service-user access after host approval.

An exclusive root-owned writer lock prevents concurrent host commands from
overwriting a revocation. An interrupted operator process leaves that lock closed
to new writes. A trusted operator must inspect its exact Agent/operation/PID and
prove the owning process is gone before approving removal of that one lock; the
CLI never removes an unknown existing lock. Each additional root also has a host
grant epoch. Revoking and later approving the same spelling does not reactivate
an old selection: Pluton requires a fresh explicit review and Apply. Unrelated
host additions preserve the still-valid grants of other applications. A missing
unused approved path does not disable healthy selected roots, and exact local
revocation can remove its approval without accessing or deleting the directory.

Use `source-access revoke` with the same arguments to revoke only additionally
approved roots. Static environment roots require an explicit local configuration
review; this CLI never silently rewrites them. Drain affected backups before a
host revocation. Do not delete or replace host approval/state files to reset policy.

## Durability, concurrency and replay

The server stores immutable request inputs plus safe outcomes in new SQLite
tables. APPLY binds request ID, expected enabled version, host-policy revision,
Agent, signed command and live lease. Only an explicit APPLY can advance the
enabled version; validation, heartbeat, refresh and queue reconciliation cannot
grant a new selection. Signed timestamps order health reports, including changed
host maxima. Clock rollback can make reports stale; correct host time normally
and wait for a fresh report instead of resetting replay state.

The Agent stores its enabled selection separately from identity and credentials.
An exclusive pending marker serializes writers. The marker and initial anchor
are durable before selection publication. Selection data and its parent are
fsynced before success. Repeating the same durable request is idempotent; an older
version or different request cannot re-enable a disabled root. Missing, malformed,
symlinked or improperly protected initialized state fails closed; the Agent never
reconstructs a fresh authorization from static configuration after initialization.

If a crash/fsync failure leaves a pending marker, do not submit a new request or
delete the marker. A trusted operator may run the following only after inspecting
the exact failed request and confirming that its selection was already persisted:

```sh
sudo /opt/pluton-agent/runtime/bin/node /opt/pluton-agent/app/dist/index.js \
  source-access recover-selection --config-file /etc/pluton-agent.env \
  --agent-id 'agent-example' \
  --expected-host-policy-revision '<current-64-hex-revision>' \
  --request-id '<exact-existing-request-id>'
```

Recovery accepts only an existing selection matching the marker, request,
incremented version and current host maximum. It resyncs existing protected files,
then clears the marker durably. It cannot create a selection, change roots or
increment a version. If publication did not reach that point, it refuses and
requires review/restoration of the exact known protected state during a drain;
there is no automatic reset or blind cleanup operation. The server still requires
a correlated explicit request before accepting a selection change.

Final marker-removal fsync failure restores the exact pending fence and latches
the running Agent closed across polling objects. If broken storage also prevents
writing that fence, the process remains closed; do not restart it as a workaround.
After a trusted operator has repaired storage and recovered the exact persisted
selection, a drained, separately authorized Agent restart may be needed to clear
the old process's in-memory failure latch. No new root or sequence is authorized
by that restart. Crash/power-loss behavior still requires disposable Linux fault
validation; this source implementation does not claim physical crash acceptance.

Directory validation is bounded and never recursively enumerates content. Nested
symlinks remain archived links under the existing backup policy. The application
must still tolerate normal source changes during backup; path replacement or a
symlink escape during validation is rejected. Linux execution/ownership/fsync
behavior needs Linux evidence; Windows model tests are not a substitute.

See [upgrade and rollback](AGENT_SOURCE_ACCESS_UPGRADE.md) and the focused
[implementation report](AGENT_SOURCE_ACCESS_REPORT.md) before rollout.
