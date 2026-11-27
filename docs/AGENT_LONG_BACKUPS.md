# Long Managed Agent backups

A first upload of a large source to a slow destination can run for hours or
days. Three behaviours used to turn such a run, or the Agent's other plans,
into a failure or a silent gap. This server release and Agent 0.8.1 change them.

## What changed

| Before | Now |
| --- | --- |
| The Agent sends no heartbeat while it executes a command, so after 90 seconds it showed **Offline**, and every scheduled run of its other plans was refused and only logged (`remote_backup_not_queued`): no history row, no notification. | An Agent that holds an unexpired lease on a command is **busy**, shown as online. A scheduled or manual run of another plan is queued and runs as soon as the Agent is free. `lastSeen` still moves only with a heartbeat. Queueing behind the live lease uses the Agent's last healthy Source Access report; executing the run still needs a fresh one (see below). |
| A backup lease was renewed for 60 seconds. | A `BACKUP_FILESYSTEM` lease is renewed for **10 minutes** by each status check and progress event (`AGENT_BACKUP_LEASE_RENEWAL_MS`). The first lease of every command, and every renewal of the other command types, stays 60 seconds. |
| An Agent stopped a backup when three status checks failed within about 15 seconds (a Pluton restart, a proxy reload, a short network cut). | Agent 0.8.1 keeps the backup running through `control-plane-unavailable`, `-network-failed`, `-timeout` and `-rate-limited` until the lease the server granted ends. A refusal, a lost lease, cancellation and shutdown still stop it at once. |
| A source file deleted while Restic was reading (a rotated attachment, a `git gc`) failed the whole run as `source-missing`, and the saved snapshot was not recorded. | For Agent 0.8.1 the server adds the signed payload field `vanishedSourceEntriesVersion: 1`. The Agent then keeps the snapshot when every Restic error was a missing entry below an unchanged root, within a bound, and completes with `result.sourceWarnings: { vanishedEntries }`. The backup is **completed** with the note "Snapshot completed; N source entries vanished while the backup ran and are not in this snapshot." and the log event `backup_source_entries_vanished`. |

The vanished-entry bound is the larger of 100 entries and 1% of the entries
Restic saw, and never more than 10% of them. Anything else still fails as
before: an unreadable entry (`EACCES`, `EPERM`), an I/O error, the root itself,
a root that is gone or on another filesystem afterwards (an unmounted share),
or a fatal Restic exit. The Agent reports a count, never a path.

## Source Access while the Agent is busy

An Agent with Source Access (`sourceAccessVersion: 1`) reports its effective
roots with every heartbeat, and it sends no heartbeat while it executes a
command. The first release of this change made such an Agent count as available
but still refused to queue another plan's run, because queueing also required a
Source Access report younger than `AGENT_OFFLINE_TIMEOUT_SECONDS`. A plan
scheduled while another plan of the same Agent ran (for example a code tree at
01:35 behind a filestore that runs from 01:00 to 01:48) was skipped every night
with only the log reason `Source Access needs a fresh healthy report from the
remote agent.`

Queueing now accepts the last report when, and only when, the Agent holds an
unexpired lease on another command (`AgentStore.hasLiveCommand`) and is not
revoked. That report must still be healthy, the source must still be a
canonical path inside its effective roots, and a pending mode setup or a
pending removal of the source still refuses. Queueing grants nothing: the Agent
sends a heartbeat with a new report before every poll, and credential
materialization at that poll still requires a fresh healthy report, so a source
that lost access fails the run visibly instead of running on the old report.
Plan creation and changes keep the strict check.

## Trade-offs

- **Queued runs wait.** The Agent is still a serial executor. While a first
  upload runs, the queued run of each other plan waits (one per plan; a plan that
  already has a queued run skips its next schedule and logs the reason). Plan the
  long first upload for a window where that gap is acceptable, or keep another
  backup of the same data meanwhile.
- **Slower requeue after an Agent crash.** If the Agent process dies during a
  backup, the server requeues the command when the lease ends, now up to ten
  minutes later instead of one. Until then the run shows as running and the
  Agent as busy.
- **Not a point-in-time copy.** Restic reads files one by one. A file changed
  while it is read is stored as read; use a quiet window for code trees and a
  database dump (not the live database files) for databases.

## Compatibility and order

1. Deploy this server first. It lists `0.8.1` among the supported install
   versions and sends `vanishedSourceEntriesVersion` only to Agent 0.8.1 or later,
   by version; Agent 0.8.0 and older never receive it and behave as before.
2. Upgrade Agents to 0.8.1 with the standalone upgrader after draining them (see
   [AGENT_UPGRADE.md](AGENT_UPGRADE.md)). Agent 0.8.1 adds no inventory capability,
   so a server rollback does not refuse its heartbeat.

The busy-Agent queueing and the 10-minute backup lease need no Agent change and
apply to every Agent version. Only Agent 0.8.1 uses the longer lease to survive
an outage; older Agents still stop after about 15 seconds of failed checks.

## Checks

```sh
cd backend
pnpm exec jest __tests__/stores/AgentStore.test.ts __tests__/services/AgentService.test.ts \
  __tests__/services/RemoteBackupService.test.ts __tests__/utils/sourceDiagnostics.test.ts \
  __tests__/utils/agentDistribution.test.ts __tests__/agentSourceAccess.test.ts
```
