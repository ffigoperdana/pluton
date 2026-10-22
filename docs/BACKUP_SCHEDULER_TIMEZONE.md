# Backup scheduler timezone audit and safe WIB rollout

## Confirmed code behavior and remaining production uncertainty

The old schedule editor submitted `settings.interval` (`type`, `time`, `days`,
`hours`, `minutes`) without a timezone. `PlanService` persisted that JSON in
`plans.settings`; `intervalToCron` converted clock fields into a wall-clock cron
expression. All three CronManager timer-construction paths called Croner without
`timezone`. Thus a process in UTC interprets Daily `04:00AM` as 04:00 UTC, or
11:00 WIB. This is deterministic code behavior, not proof of the production
incident's full cause. No production plan, history, logs, queue or host was read.
Downtime, pause state, queue delays, Agent availability or source authorization
could independently prevent the expected run.

Croner supports explicit IANA timezone and asynchronous overrun protection; see
its [configuration contract](https://croner.56k.guru/usage/configuration/).
The installed, locked version remains 9.1.0. No dependency upgrade was needed.

## New semantics and existing-plan handling

- New plan creation explicitly stores `settings.interval.timeZone`, defaulting to
  `Asia/Jakarta`. The editor has the same default. API clients may select another
  valid IANA zone; the UI offers WIB, UTC and any already-saved zone.
- Daily 04:00 Asia/Jakarta becomes 21:00 UTC on the preceding calendar day.
  Weekly Monday 04:00 WIB is Sunday 21:00 UTC. DST in other IANA zones is resolved
  by Croner/Intl, never a hardcoded seven-hour subtraction.
- Existing JSON without `timeZone` retains the historical process-local meaning.
  On the unchanged UTC production runtime it remains 04:00 UTC / 11:00 WIB until
  an operator explicitly selects a timezone and saves the plan. Unrelated edits
  by an older client preserve an existing explicit zone or its historical absence.
  Do not change the process/OS timezone during this rollout.
- No DDL migration or bulk JSON update is performed. IDs, timestamps, credentials,
  database lifecycle, replication settings and other plan fields are preserved.
  UTC epoch timestamps in SQLite are unchanged. Invalid explicit zones fail with
  HTTP 400, without silently falling back to another timezone.
- The historical editor spelling `thur` now maps to Thursday like `thu`; the
  editor writes `thu`. Previously it could produce an invalid weekly expression.
  The empty-time display now matches the existing midnight fallback, rather than
  showing 10:00 AM while executing at midnight. New plans still default to 10 AM.

`GET /api/plans/schedule-preview?interval=<bounded-JSON>` is an additive,
authenticated, no-store read-only endpoint. It returns the canonical `timeZone`,
`legacyTimeZone`, UTC ISO `nextRunAt`, UTC `evaluatedAt` and `missedRunPolicy=skip`.
It does not create a plan, timer, job, Agent command or backup. Its temporary
Croner calculator is paused and stopped after calculation. Frontend displays
that server result in the same selected zone, with WIB explicitly labeled.
The result is a calendar preview, not scheduler/queue health or a run guarantee.

## Startup, missed runs, overlap and failure policy

1. `CronManager` loads its derived `schedules.json` cache. Cached local and remote
   backup timers are held until reconciliation authorizes their DB plan. It
   awaits real async callbacks and handles failures with closed diagnostics.
2. `createApp` performs interrupted-operation recovery before PlanService's local
   and remote reconciliation. Local reconciliation repairs cron/timezone/paused
   drift for backup timers, removes orphaned schedules using the existing scope,
   and releases only successfully reconciled cached plans. Other scheduler-owned
   sync kinds are preserved. Remote reconciliation uses its existing repository
   and plan ownership checks, then releases the corresponding cached timer.
   A failed cached reconciliation stays held rather than executing stale work.
3. There is **no catch-up/backfill** after downtime, restart or a held startup
   slot. Timers calculate the next future slot. No historical scheduled-run
   records are fabricated. Restart at the boundary can therefore miss a run;
   an operator may authorize one manual run after checking history and activity.
4. Local `JobQueue` is in memory. It deduplicated exact payloads, but fresh
   `backupId` values previously allowed repeated scheduled ticks for one plan
   to accumulate duplicates. A scheduled dispatch now checks that plan's queued,
   running and retrying Backup job before allocating another ID. Distinct plans
   and existing manual-run behavior are preserved. Callback overlap protection
   also spans timer replacement within the process.
5. JobProcessor still enforces its existing concurrency, cancellation, retry
   count and delay. BackupHandler still prevents concurrent execution of the same
   plan. Neither execution engine nor retry policy was replaced.
6. Remote dispatch still validates plan activity, Agent identity/freshness,
   capability and Source Access. The existing transactional
   `RemoteManagedRepositoryStore.createBackupAndCommand` checks for an active
   backup and atomically persists the backup plus durable non-secret command
   reference. Agent 0.7.0 protocol, signatures, leases, acknowledgments and
   credential materialization are unchanged. Offline refusal emits only a closed
   event/status, not provider output or secrets; a later future tick may retry.
7. Interrupted in-memory local work is handled by existing `StartupRecovery`;
   there is no durable replay of the local queue. Existing durable Agent command
   recovery remains authoritative for already-enqueued remote work, not a reason
   to create new commands for every missed calendar slot.

This remains a **single active Pluton scheduler** deployment. In-process guards
are not distributed leader election or global exactly-once execution across
multiple Server replicas. Queued work lost on a crash is not automatically
reconstructed. `schedules.json` remains a derived cache, not a durable per-slot
execution ledger; DB reconciliation repairs missing cache entries.

## Source trace

Editor: `frontend/src/components/Plan/PlanSettings/PlanScheduleField.tsx`,
`PlanForm/PlanForm.tsx`, shared `common/form/IntervalField/IntervalField.tsx`.
Defaults/types: `frontend/src/utils/constants.ts`, frontend/backend `types/plans`.
API: `routes/plans.ts` and `controllers/PlanController.ts`.
Validation/calculation: `utils/planSchedule.ts`, `utils/intervalToCron.ts`.
Persistence: `db/schema/plans.ts`, `stores/PlanStore.ts`; no schema file changed.
Registration/recovery: `managers/CronManager.ts`, `services/ScheduleReconciler.ts`,
`services/RemoteBackupService.ts`, `services/StartupRecovery.ts`, `createApp.ts`.
Dispatch/execution: `managers/BaseBackupManager.ts`, `jobs/JobQueue.ts`,
`jobs/JobProcessor.ts`, `jobs/tasks/BackupTask.ts`, `managers/handlers/BackupHandler.ts`.
Remote durability: `stores/RemoteManagedRepositoryStore.ts` and AgentStore.
History/UTC: existing BackupStore/BackupEventService and backup-history filtering;
history timezone remains separate from scheduling timezone.

## Operator acceptance and rollback — not executed

1. Review/publish this feature branch manually, obtain green CI for the exact
   commit and approve an immutable app digest. Record the previous digest,
   approved overlays/mounts and current plan intervals/activity privately.
   Confirm one scheduler instance, existing worker/Agent health and correct UTC
   host clock. Do not print expanded Compose, keys or credentials.
2. Drain active backup/restore/replication/cleanup work and prevent new work
   during the window. Preserve the existing consistent SQLite/WAL/config/key
   backup and recovery evidence. Do not init, rotate secrets, reinstall Agents
   or modify `/data`, host operators, storage ownership or unrelated services.
3. With separate production authorization, deploy the approved app digest using
   the installed immutable `deploy.sh` workflow and unchanged ordered overlays,
   including any approved `compose.lab.yml`. Recreate only Pluton. Confirm health,
   image/mount identity and successful schedule reconciliation. Keep old plans'
   intervals unchanged initially and verify their legacy timezone preview.
4. Review each intended timezone conversion with the operator. For the synthetic
   example Daily 04:00, selecting Asia/Jakarta changes execution from 11:00 WIB
   to 04:00 WIB; selecting UTC leaves the old instant unchanged. Inspect the next
   UTC instant and local date/time before Save. Do not bulk-update real plans.
5. Separately authorize one small disposable scheduled acceptance after checking
   queue/Agent readiness. Verify one job/backup ID, actual start/end UTC timestamps
   converted to WIB, content, normal retention/replication and absence of an
   overlapping run. Validate restart just before/after a synthetic slot with
   controlled clocks, not repeated production backups. No such live acceptance
   or real backup was run for this patch.
6. Check sanitized startup/scheduler errors, failed/interrupted backup history,
   queue processor status, Agent heartbeat/polling and Source Access refusal.
   A calculated next time alone does not establish execution readiness. If a
   run was missed, investigate before authorizing one manual run; never replay
   every missed run or edit history to make the schedule appear successful.
7. **Older images ignore `timeZone`.** Before rolling back to an unaware image,
   drain work and explicitly pause every plan created/converted to an explicit
   timezone (including derived cache state). Record their prior settings. Only
   then use the reviewed `rollback.sh` with the same volume/overlays, verify
   health and keep those plans paused pending operator review. JSON is additive
   and does not require schema rollback, but time semantics are not transparent
   to old code. Never restore an old database automatically. If an older runtime
   must execute a WIB schedule, any conversion of wall time/weekly day to UTC
   requires separate reviewed operator action; do not silently remove the zone.

`AGENT_INSTALL_COMMIT`, Agent permissions, TLS, Restic/rclone, SFTP/S3/HCP,
replication/retention/restore, legacy repository access and deployment contracts
are outside the mutation scope of this patch. Production incident attribution,
actual queue health and a live standalone Agent installation remain NOT TESTED.

## Validation

Deterministic timezone, controlled-clock startup/tick, queue/retry, authenticated
API, legacy edit preservation, Agent 0.7.0 command contract and real React query/
editor tests are included. Local verification uses Node.js 24.22.1 and the
existing pinned pnpm 10.20.0 dependency cache; no dependency or lockfile changed.

| Check | Result |
| --- | --- |
| Affected backend and dependent regressions | 473 PASS, 17 suites: timezone calculation, real Croner controlled clocks, cache hold/reconciliation, queue/retry/concurrency, PlanService/Store, startup recovery, BackupTask, system tasks, Agent service and authenticated control-plane integration |
| Disposable Linux with process `TZ=UTC` | 156 PASS, nine suites; explicit WIB, old UTC semantics, dates/DST, restart/missed slots, safe errors, Agent/queue/API boundaries |
| Complete frontend regression runner | 273 PASS; includes actual React/query editor selection, pending/error states, accessibility label/status and immutable legacy input |
| Backend/frontend typecheck | PASS |
| Backend lint | PASS |
| Frontend/backend production builds | PASS; documentation security/compiler tests run as part of the frontend build |
| Frontend lint | Existing FAIL before code analysis: typescript-eslint rejects the string `extends` entry `eslint-config-prettier`; unchanged and not suppressed |
| Patch whitespace / sensitive-file exclusions | Checked before local commit; no fixtures, local configuration, logs or credentials staged |
| Hosted CI, live scheduler/queue and production Agent/backup acceptance | NOT TESTED; no push, SSH, production access, actual backup or service restart |

The first complete frontend run exposed a test harness import of Vite-only
`import.meta.env` via the new schedule query. The Source Access test now supplies
only a pending schedule-query adapter, consistent with its other service
adapters; its assertions remain intact. `planScheduleUi.test.ts` separately
executes the real query hook, JSON request, selected zone and server-result
rendering. The final complete frontend run passes.

The clock tests use fake timers, not real daily waits. Linux tests run as non-root
in a network-isolated read-only container, with synthetic SQLite/temp state only.
No native backup, VM/reboot, TTL workload or production configuration is exercised.
Real standalone 0.7.0 installations and external storage/provider availability
remain deployment acceptance work; the compatibility tests verify unchanged
protocol/command boundaries, not that any production machine is healthy.

Reproduction from the reviewed checkout with Node 24.22.1 and pinned pnpm:

```sh
pnpm --filter @plutonhq/core-backend test --runInBand --runTestsByPath \
  __tests__/utils/planSchedule.test.ts __tests__/managers/CronManagerTimezone.test.ts \
  __tests__/managers/CronManager.test.ts __tests__/managers/BaseBackupManager.test.ts \
  __tests__/services/PlanService.test.ts __tests__/services/ScheduleReconciler.test.ts \
  __tests__/services/RemoteBackupService.test.ts __tests__/routes/plans.test.ts \
  __tests__/jobs/JobQueue.test.ts __tests__/jobs/JobProcessor.test.ts \
  __tests__/utils/intervalToCron.test.ts __tests__/stores/PlanStore.test.ts \
  __tests__/services/StartupRecovery.test.ts __tests__/jobs/tasks/BackupTask.test.ts \
  __tests__/jobs/SystemTaskManager.test.ts __tests__/services/AgentService.test.ts \
  __tests__/agentControlPlane.integration.test.ts
node --experimental-strip-types --test frontend/__tests__/*.test.ts
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-frontend exec tsc -b
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-frontend lint
pnpm --filter @plutonhq/core-frontend build
pnpm --filter @plutonhq/core-backend build
git diff --check
```
