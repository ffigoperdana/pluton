# Operational notifications: replica copies and Agent availability

Status: implemented on branch `claude/ops-notifications`. Extends the durable Webhook and SMTP
outbox (migration `0010_phase7_notification_outbox.sql`).

## 1. Goal

Before this change, durable notifications reported only terminal backup and recovery-test results.
Two operational problems stayed silent:

- a replica copy that failed, or stopped uncertainly and now holds the replication queue;
- an Agent that went offline. Its scheduled backups wait in the queue and are never marked failed,
  so no `backup.failed` message is ever sent.

## 2. Events

| Event | Raised when | Scope |
| --- | --- | --- |
| `replication.failed` | A `managed_replication_jobs` row reaches `failed` or `uncertain` | The plan of the backup |
| `agent.offline` | An Agent has been offline longer than the grace period (10 minutes) | Every plan of that Agent |
| `agent.online` | An Agent that raised `agent.offline` is online again | Every plan of that Agent |

Delivery uses the existing rules: the channel must select the event, and a plan subscription must
select the event and the channel. An Agent event is sent once per channel, even if several plans of
the Agent subscribe to it.

## 3. Decisions

| Topic | Decision | Reason |
| --- | --- | --- |
| Replica source | SQLite triggers on `managed_replication_jobs` feed `notification_sources` (kind `replication`), like backups and recovery tests | Durable and independent of callbacks; survives restarts |
| Repeats | One message per job and outcome (`failed`, `uncertain`); a retry that fails again is not sent again | The operator already acts on that copy in the UI |
| Existing failures | The migration records existing failed and uncertain jobs as observed | Upgrading never floods inboxes with history |
| Agent liveness | The UI rule: a heartbeat within `AGENT_OFFLINE_TIMEOUT_SECONDS`, or a live command lease (a busy Agent sends no heartbeat) | One definition of offline |
| Grace period | 10 minutes after the offline threshold | Agent upgrades and short restarts stay quiet |
| Server downtime | The grace period starts no earlier than when this server started watching | Heartbeats missed while Pluton was down are not an Agent outage |
| First observation | An Agent already offline when first observed is a baseline without an alert; its return is still reported | Upgrading never alerts about old outages |
| State | `notification_agent_states` (offline since, notified); revoked or deleted Agents are pruned | Exactly one offline and one online message per outage |
| Robustness | An Agent evaluation failure is logged and never blocks backup and recovery deliveries | Operational events must not cost the existing ones |

## 4. Payload

Payload version 1 gains two optional objects:

- `replication`: `id`, `replication_id`, `replica_name`, `status` (`failed` or `uncertain`),
  `attempts`; together with `plan`, `backup` and `error.category` (a server-generated category).
- `agent`: `id`, `name` (the source name in Pluton), `last_seen`, `offline_since`. Agent events
  carry no `plan`.

Email subjects: `Replica Copy Needs Attention — <plan>`, `Agent Offline — <agent>`,
`Agent Back Online — <agent>`.

## 5. Limits

- Replication admission refusals before a job exists (for example `artifact-binding-mismatch`) are
  recorded on the backup mirror only and are not sent.
- Backup failover, copy-back and replica promotion have no events of their own; their backup runs
  still raise backup events.
- Existing channels and plan subscriptions do not select the new events automatically.

## 6. Tests

| Area | Coverage |
| --- | --- |
| Store | `backend/__tests__/stores/NotificationOperationalEvents.test.ts`: failed and uncertain copies, one message per outcome, subscription filter, unsafe categories, grace period, busy Agent, short restart, server downtime, baseline of an existing outage, channel selection, revoked Agents, migration without replay, triggers on the real schema |
| Existing | All notification store, manager, route, lifecycle and policy tests, with the fixture extended by the tables the new queries read |
| UI | `frontend/__tests__/notificationDelivery.test.ts`: event choices |
