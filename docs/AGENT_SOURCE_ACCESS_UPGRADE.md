# Agent Source Access: controlled upgrade and rollback

For the standard existing installation, prefer the upgrade-only
[Agent upgrader](AGENT_UPGRADE.md): `sudo bash installers/upgrade-agent.sh --check`
then `sudo bash installers/upgrade-agent.sh`. Agent 0.6.1 adds its local hold
protocol. Older running Agents need the one-time operator-verified drain/stop
described there. The manual artifact procedure below remains a separately
reviewed alternative for unsupported/custom installations; never rerun enrollment
as an upgrade workaround. All Source Access server-first, identity-preservation,
host-delegation and rollback compatibility prerequisites still apply.

**Prepared procedure; not executed.** Production access, installation, service
restart, host approval, ACL changes and a real/synthetic host backup each require
the applicable separate authorization. All addresses/paths identifying an
application below are synthetic. Keep the real host mapping and backup manifest
in the operator's private inventory, outside this public repository.

This procedure targets an existing enrolled Linux Agent using
`pluton-agent.service`, `/etc/pluton-agent.env`, private runtime
`/opt/pluton-agent/runtime/bin/node`, application `/opt/pluton-agent/app` and state
`/var/lib/pluton-agent`. Verify each installed path and unit locally before using
the commands. The supplied target environment has two existing application roots
and three requested additions. Preserve both existing roots exactly; resolve and
review all three additions on that same host before approval. No host inspection
or production compatibility claim has been made in this sprint.

## 1. Release and read-only operator preflight

- Review the exact source commit, artifact SHA-256, Agent 0.6.0 and server migration
  0019. Run real unprivileged Linux Agent policy/transport/permission tests first.
  Record all required hosted checks against the exact reviewed commit after CI is
  separately authorized. Windows model results do not approve a Linux rollout.
- Deploy the compatible server **first**, using its separately approved backup,
  immutable application and rollback contract. Preserve SECRET, ENCRYPTION_KEY,
  device/Agent identities, repository passwords, migration 0016 and 0018 state.
  No MySQL Internal activation or change to recovery guards is part of this task.
- Confirm the new server still supports the old Agent with its existing static
  roots, SFTP primary, Database & Hooks, plans and last successful backup.
- On the host, inspect service metadata without dumping the EnvironmentFile or
  identity to logs/chat. Confirm private Node/runtime ownership, expected service
  user, real installation paths and filesystem space.

```sh
systemctl show pluton-agent.service \
  -p FragmentPath -p User -p Group -p ActiveState -p SubState -p ExecStart
getent passwd pluton-agent
stat -c '%U %G %a %n' /opt/pluton-agent /opt/pluton-agent/app \
  /opt/pluton-agent/runtime/bin/node /var/lib/pluton-agent
readlink -f /srv/example-app
sudo -u pluton-agent test -r /srv/example-app
sudo -u pluton-agent test -x /srv/example-app
```

Repeat the last three checks for each privately recorded old/new canonical root.
Use the existing local `preflight --scan` as the service account when recursive
read evidence is needed; it is bounded and read-only. It does not grant access.
Do not replace a real application with the sample path or change ownership/ACLs
to make a test pass. Request a separate narrow permission change if necessary.

## 2. Drain, protected backup and immutable candidate

Pause all affected plan schedules through the normal UI. Wait for all queued,
leased and running Agent backup/replication operations to finish; check both the
server command history and Agent activity. Do not kill a backup mid-dump/copy.
No pending Source Access APPLY may remain during the binary switch.

Build with the pinned pnpm 10.20.0 and existing frozen lockfile in the reviewed
build workspace, not on an active production installation:

```sh
pnpm --filter @plutonhq/pluton-agent typecheck
pnpm --filter @plutonhq/pluton-agent test
pnpm --filter @plutonhq/pluton-agent build
```

Transfer the reviewed `agent/dist` and `agent/package.json` as one checksum-pinned
candidate to a root-protected staging directory. Check its transfer manifest
before extraction or copying. Do not install global Node, pnpm or dependencies,
download an unreviewed branch, or use a mutable artifact label as provenance.
The update uses existing private Node/Restic/Rclone and adds no runtime package.

Only after the drain is confirmed, a separately authorized operator may run the
following. `/srv/pluton-upgrade/candidate/agent` is an example transfer location;
replace it with the exact reviewed protected location. Set a unique review ID and
reviewed manifest path. The backup directory must not already exist.

```sh
set -eu
review_id='source-access-reviewed-id'
candidate='/srv/pluton-upgrade/candidate/agent'
saved="/var/lib/pluton-agent-upgrades/$review_id"
test -d "$candidate/dist"
test -f "$candidate/package.json"
test ! -e "$saved"
# Verify the separately recorded trusted SHA-256 manifest before this point.
sudo install -d -o root -g root -m 0700 "$saved"
sudo systemctl stop pluton-agent.service
sudo cp -a /opt/pluton-agent/app "$saved/app"
sudo cp -a /etc/pluton-agent.env "$saved/agent.env"
sudo cp -a /etc/systemd/system/pluton-agent.service "$saved/agent.service"
sudo cp -a /var/lib/pluton-agent "$saved/state"
if sudo test -d /etc/pluton-agent; then
  sudo cp -a /etc/pluton-agent "$saved/host-policy"
fi
test ! -e /opt/pluton-agent/app.source-access-next
sudo install -d -o root -g root -m 0755 /opt/pluton-agent/app.source-access-next
sudo cp -a "$candidate/dist" /opt/pluton-agent/app.source-access-next/dist
sudo install -o root -g root -m 0644 "$candidate/package.json" \
  /opt/pluton-agent/app.source-access-next/package.json
sudo chown -R root:root /opt/pluton-agent/app.source-access-next
sudo chmod -R go-w /opt/pluton-agent/app.source-access-next
test ! -e /opt/pluton-agent/app.source-access-previous
sudo mv /opt/pluton-agent/app /opt/pluton-agent/app.source-access-previous
sudo mv /opt/pluton-agent/app.source-access-next /opt/pluton-agent/app
sudo systemctl start pluton-agent.service
systemctl is-active pluton-agent.service
```

Stop on any failure. Do not repeat the move sequence over unknown directories.
Inspect exact ownership and the two known application paths before restoring the
saved application. Keep the protected backup until the retention/review decision;
do not blindly remove it at the end of a chat or task.

The update does **not** rewrite the environment, service unit, host policy,
identity, database client paths, hook configuration, CA, mTLS material, SFTP config
or repository credentials. The existing installer is **not** this upgrade command:
it writes a new EnvironmentFile and unit, only explicitly preserves selected
optional configuration, restarts the service and finalizes its own transient
rollback files. Re-running it without preserving the full configuration can lose
custom Database & Hooks/TLS settings. Do not use `--re-enroll`, uninstall or purge.

## 3. Identity, roots and host approval

Choose the authorization mode after the controlled upgrade. Existing enrolled
Agents remain Host-Approved until explicit host-side setup confirms otherwise.
For Server-Managed, review multiple narrow canonical delegated prefixes once,
including actual service-user traversal/read access and any secret-bearing
descendants. Selecting Server-Managed in the UI is pending host setup; it does
not authorize the server to widen the host maximum. Keep affected plans paused
and queued/running operations drained during the transition. After confirmation,
future source paths inside that maximum use Validate and Apply in Pluton without
another local approval. Paths outside it still require a separate host decision.

When switching back, confirm the strict maximum and review every affected plan.
Delegation-only sources cannot remain effective under Host-Approved. Resume only
after the fresh host report and enabled selection match the intended mode. A
rollback to older Agent code requires the same no-widening review; preserve all
current identity, selection and replay receipts instead of restoring stale state.

Compare the current identity with the protected stopped backup **locally**, without
printing either secret. Use the private Node runtime and require exact equality of
`agentId`, `deviceId` and `secret`; `completedCommands` may legitimately advance
after restart. The old identity must never be copied back merely to reset a lease.
Confirm the unchanged Agent/device row, HTTPS verification, ONLINE heartbeat,
Agent 0.6.0 and Source Access v1 in Pluton. Review `journalctl` privately and share
only safe stage/code summaries.

The two existing roots must still be present and readable. For each proposed new
application, the host operator verifies its canonical target and service-account
read/traverse rights. A path alias under `/var/www/example-app` may resolve outside
the current maximum; **Pending host approval** is expected until the canonical
target has been explicitly approved. Never approve the alias as a moving boundary.

Copy the single bulk `source-access approve` instruction from the UI; it includes
the exact Agent ID, host revision and reviewed canonical targets. It reads the
existing root-owned configuration without evaluating shell text, adds only those
extra roots and leaves old static roots unchanged. No service restart is needed.
Refresh Source Access and explicitly enable the additions. Check the confirmed
version and per-path results before changing a plan or resuming schedules.

## 4. Verification before real workloads

For a Server-Managed transition, the UI-generated one-time instruction has this
shape. Use its exact request ID, current revision and reviewed scope; these
placeholders are not runnable authorization:

```sh
sudo /opt/pluton-agent/runtime/bin/node /opt/pluton-agent/app/dist/index.js \
  source-access delegate --config-file /etc/pluton-agent.env \
  --agent-id 'agent-example' \
  --expected-host-policy-revision '<current-64-hex-revision>' \
  --request-id '<exact-signed-mode-setup-request>' \
  --confirm-delegation --confirm-drained \
  --root '/srv/example-apps' --root '/srv/example-workers'
```

Returning to strict mode uses the corresponding generated `source-access
host-approved` instruction with the same binding arguments and
`--confirm-drained`, without delegated roots. Request that transition through
Pluton first; the root command cannot bypass the server's setup/drain receipt.
If interruption consumes a receipt before host publication completes, stop and
review the exact protected state. Do not replay the consumed receipt, reset a
counter or use reinstall as recovery. Keep operations paused until the outcome
is confirmed; a new authorization requires a new explicit reviewed request.

With separate fixture/scope approval, approve one small synthetic source outside
the live applications. Create/validate its canonical source through the UI, run a
small SFTP-primary backup, browse/restore one synthetic file and compare content.
Check that old static plans and saved Database & Hooks/SFTP settings remain
unchanged. Reject traversal, out-of-scope and stale requests in disposable tests;
do not probe private live paths or run a real application backup for validation.

Only after the operator approves the evidence may existing schedules be resumed.
Keep the existing external backup system's cron, data and repositories untouched.
Physical cleanup of the approved synthetic fixture is its own exact ownership
procedure; Source Access removal does not remove application data or repositories.

## 5. Drain-first rollback

1. Pause schedules and drain commands again. Record current source selection,
   host-policy revision, identities, pending requests and latest receipts privately.
2. **Before an Agent downgrade**, require no pending source commands and verify
   that effective enabled roots are exactly the old static configuration. An old
   Agent does not understand a narrower managed selection; downgrading while its
   old static roots are broader would silently widen policy. If the sets differ,
   stop and approve a narrow local configuration adjustment or keep the new Agent
   drained. Do not delete policy state to force rollback. Pause plans requiring
   newly approved roots that an old Agent cannot use.
3. Once those prerequisites hold, stop the service and switch only the exact known
   application directories. The following leaves the failed candidate available
   for investigation; it does not delete unknown resources:

```sh
sudo systemctl stop pluton-agent.service
test -d /opt/pluton-agent/app.source-access-previous
test ! -e /opt/pluton-agent/app.source-access-failed
sudo mv /opt/pluton-agent/app /opt/pluton-agent/app.source-access-failed
sudo mv /opt/pluton-agent/app.source-access-previous /opt/pluton-agent/app
sudo systemctl start pluton-agent.service
systemctl is-active pluton-agent.service
```

4. Leave current identity and completion receipts intact. Environment and unit
   were unchanged; verify them against the protected backup. Restore one only if
   a separate reviewed change actually requires it. Do not overwrite current
   ownership journals, source sequences or credentials with an old state snapshot.
5. Verify ONLINE identity, old static access and a separately approved synthetic
   backup/restore before resuming existing schedules. A server rollback uses its
   own drain/SQLite/artifact contract; do not downgrade the server under active
   v1 Agents or remove additive 0019 tables as a convenience.

Stop/rollback triggers include identity mismatch, unexpected root expansion,
unexplained binary ownership/digest, missing policy state, durability uncertainty,
source-policy replay, broken TLS or a failed synthetic recovery. Permission denial
is a refusal to fix narrowly, never a reason to run the Agent as root or bypass
admission. For an exact persisted Source Access transaction interrupted after
publication, use the narrow reviewed recovery procedure in
[AGENT_SOURCE_ACCESS.md](AGENT_SOURCE_ACCESS.md), not reinstall/re-enrollment.
