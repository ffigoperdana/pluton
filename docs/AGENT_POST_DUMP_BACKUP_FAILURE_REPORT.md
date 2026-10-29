# Agent post-dump backup failure

Branch: `codex/fix-agent-post-dump-backup-failure`.
Base: `cd08fafd8092c4694d1ecb30d4f89d9ab627b100`, latest `origin/main` when fetched.
Implementation uses its own worktree. The unmerged
`codex/managed-symlink-download-restore` branch/commit and checkout are untouched;
none of its changes are incorporated. This task changes Agent control-plane
reliability and supporting diagnostics/tests only. No production access, Agent
installation, schedule change, push, merge or deployment was performed.

## Confirmed code defect and remaining incident uncertainty

The original `executeFilesystemBackup` sequence is:

1. `job.prepare()` runs the native database client, streams SQL to a private file,
   validates the output, records byte/hash receipts and emits `database-dump-completed`.
2. It performs `await input.shouldCancel()` before advancing the stage.
3. The runtime implements that callback using a signed `POST .../status` request.
4. A thrown HTTP, transport or decoding exception is untyped at the backup boundary.
   The stage variable still says `database-dump`, and the fallback code is `unexpected`.
5. The owned workspace is cleaned and a failed completion is reported. Repository
   preparation and Restic backup have not started.

This path is **reproduced**, using original compiled Agent code, actual Oracle
MySQL **8.4.11**, its native `mysqldump`, and a faulting control-plane fixture that
verifies the real signed requests. A completed dump followed by exactly one injected
HTTP 503 produced `database-dump/unexpected`, with one post-dump status attempt,
17 progress events, cleanup and no repository-preparation transition. The execution
and persisted completion replay took 245 ms on the small synthetic database. It
does not reproduce the production database size or its approximately 18-second dump.

The supplied production evidence does **not** identify the exception thrown at that
historical boundary. Progress-event 429s are confirmed, but a failing status request
is not. Other requests returning HTTP 200 do not establish that every status body
was valid and fully received. Installed-runtime divergence is also unverified.
The exact incident trigger therefore remains a production-only correlation gate.
The code defect and the corrective behavior are proven independently of that gate.

Known artifact/dump errors were already typed. For example, failure removing the
private credential file after the completion checkpoint previously produced a dump
failure code, not necessarily `unexpected`. This patch gives that boundary its own
artifact-finalization diagnostic rather than calling every post-dump error a
network problem.

## Correction

The explicit `post-dump-status-check` stage is set immediately after `prepare()`
returns. The `database-dump-completed` checkpoint advances local diagnostics to
`database-dump-validation` while finalization finishes. Other status checks use
`command-status-check` when a typed control-plane error stops execution.

`AgentClient.commandStatus` now:

- Requires a successful response envelope and an actual boolean `cancelled`.
  Malformed JSON, invalid status schema and application exceptions cannot become
  an implicit `cancelled=false`.
- Shares one in-flight check per exact command/lease token. It never caches a
  completed answer across the post-dump boundary.
- Tries at most three times for 429, 5xx, network failure or timeout, with 250/750 ms
  backoff, at most 5 seconds per request and a 15-second total check budget bounded
  by the known lease deadline. Each attempt receives a new timestamp, nonce and
  HMAC signature. It never resends a dump or backup as part of a status retry.
- Does not retry authorization refusal, unavailable/invalid lease, malformed
  response or unexpected application exception. Expired local leases fail before
  another request. No repository work begins without a successful required check.
- Uses the backend's optional `leaseExpiresAt` returned from the actual atomic
  renewal. Older servers' boolean-only response remains readable: the existing
  60-second renewal policy is bounded conservatively from request start, rounded
  down to SQLite's second precision, not response receive time. The backend lease
  duration and database schema are unchanged.

The transport exposes closed timeout/network/invalid-response errors. It does not
retain raw provider messages in those errors. Existing TLS certificate verification,
signed authentication, response bounds and outbound-only behavior remain intact.

Polling during native dump and Restic processes propagates exhausted/terminal
control-plane failure and terminates the owned process tree instead of ignoring a
known refusal. Overlapping Restic polls are prevented. Parent discovery cannot
swallow that refusal as a repository fallback. Cleanup still removes private local
state; post hooks cannot continue after typed authorization/status failure. Actual
user cancellation, including immediately after the dump, remains distinct.

| Failure                                                         | Reported code                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| User cancellation                                               | `cancelled`                                                           |
| Expired local lease or status 404/409/410                       | `command-lease-unavailable`                                           |
| Status 401/403                                                  | `command-authorization-rejected`                                      |
| Persistent status 429                                           | `control-plane-rate-limited`                                          |
| Persistent status 5xx                                           | `control-plane-unavailable`                                           |
| Check deadline/transport timeout                                | `control-plane-timeout`                                               |
| Interrupted connection/network failure                          | `control-plane-network-failed`                                        |
| Invalid JSON/envelope/status schema                             | `control-plane-response-invalid`                                      |
| Unexpected exception in the status path                         | `control-plane-unexpected`                                            |
| Completed dump, failed private credential/artifact finalization | `database-artifact-finalization-failed` at `database-dump-validation` |

404 is intentionally not interpreted as proof of one particular lease condition:
the existing API hides absent commands, wrong ownership and expired leases behind
the same refusal. All stop safely. A server reporting actual cancellation takes
precedence over its now-expired timestamp. These are closed classifications, never
raw SQL, credentials, environment values, lease tokens or response text.

## HTTP 429 and progress delivery

Ordinary progress was coalesced while a send was blocked but could still emit many
fast stage requests in a burst. The initial `accepted` event additionally bypassed
`ProgressDelivery`; its failure aborted before backup execution. The native fixture
confirmed that separate problem when every event request returned 429. It does not
explain the reported post-dump failure on its own.

All nonessential progress, including `accepted`, now uses the same best-effort
delivery path. It has one in-flight event and one coalesced pending event, spaced at
least one second apart. Journal/progress callback exceptions and failure-reporting
callback exceptions do not abort data-plane work. Event sequence numbers remain
monotonic; mandatory completion is serialized after the final progress flush,
persisted locally before delivery, and still fails/replays when delivery is uncertain.
Acknowledgement, cancellation/lease checks and completion are not made best-effort.

The native all-events-429 case completed a real backup and its SQL hash/snapshot
checks. Persistent **status** 429 instead stopped after three attempts, with no
repository preparation. These are separate outcomes. No WAF/ingress configuration
was changed. Any future ingress exception requires measured per-Agent/aggregate
request rates and separate review of the signed `/status`, `/events`, `/complete`,
`/ack`, heartbeat and poll endpoints. Authentication, nonce replay checks and
completion/idempotency controls must remain enforced; the supplied evidence does
not justify a global WAF adjustment.

## Native regression evidence

The disposable runner uses Oracle MySQL server/client 8.4.11, native Restic/Rclone,
the real compiled Agent `runOnce`, and an isolated HTTP control-plane emulator that
checks HMAC signatures, unique nonces and lease-token binding. A private internal
Docker network and shared container network namespace keep local-mode MySQL on
loopback; there are no published ports or host-network/production mounts. No TLS
verification setting is disabled. Credentials are random, ephemeral and never
printed. MySQL uses a fresh tmpfs database. The Agent runs unprivileged UID 10001
with a read-only root, no capabilities, 2 CPUs/3 GiB/no swap; the separate disposable
server is limited to 768 MiB/no swap. This is not a production VM capacity test.

The backend's real SQLite lease/authentication/idempotency tests run separately;
the native emulator is not a claim that the entire deployed backend/WAF was used.

The first patched 14-case matrix passed. The expanded 19-case matrix and final
20-case repeat also passed:

- Healthy status and `cancelled=false`: real dump, repository preparation, Restic
  completion, exact snapshot and SQL byte/SHA-256 receipt checks.
- 429 on every progress event, including `accepted`: backup still completes.
- One transient status 429/502/503: a fresh signed retry succeeds, without redumping.
- Persistent status 429/503: exactly three attempts, specific safe failure.
- Timeout, interrupted connection, invalid JSON and invalid boolean schema: specific
  safe failure; malformed responses are not retried as authorization.
- Lease refusal and authorization refusal: immediate stop, no repository transition.
- User cancellation immediately after dump: distinct cancelled completion.
- Cancellation and lease refusal during an actual dump blocked by a disposable
  MySQL table lock: owned native process stops; no partial SQL receipt or backup.
- A deliberately lost completion response: the receipt is already persisted, then
  a fresh Agent process replays it without another dump or snapshot.
- Credential finalization failure induced by making only the owned job directory
  read-only: precise finalization failure, separate cleanup warning; the fixture
  explicitly repairs/removes only that disposable directory afterward.
- SFTP repository unavailable after a successful dump: repository-stage transport
  failure, never reclassified as a dump problem.
- Synchronous journal callback throws at the post-dump stage: healthy backup still
  completes with independently checked artifact/snapshot, not an unexpected failure.

Every case reconciles its durable completion through a separate Node process and
checks no extra dump execution. Successful cases independently read the SQL artifact
from the exact Restic snapshot, compare its byte count/SHA-256 with the receipt,
and assert one snapshot. Failed cases have no successful result/SQL receipt.
Workspace cleanup and credential exclusion assertions remain. Tests/logs never
print raw subprocess output, SQL, request signatures or credential material.

Representative expanded-run end-to-end timings, including process replay and
verification: healthy 8–10 seconds; transient recovery about 9 seconds; persistent
429/503 about 2.3 seconds; timeout about 16.4 seconds (15-second status budget plus
cleanup/progress/reconciliation); malformed/lease refusal about 1.2–1.3 seconds;
repository failure about 23.7 seconds under its existing native deadline. The real
dump is intentionally small; these are not production throughput estimates.

Reproduce the patched native matrix locally:

```powershell
pnpm install --frozen-lockfile
docker build -t pluton-agent-post-dump:local -f scripts/fixtures/agent-post-dump/Dockerfile .
./scripts/validate-agent-post-dump.ps1
```

The Dockerfile is a local fixture derivative of the existing Oracle worker test
image and existing native tool image; it is not a production image change. The
runner pins the available official MySQL 8.4.11 image by digest. `-Baseline` requires
`-AgentDist` pointing to an independently compiled original-base Agent in a separate
disposable checkout; it deliberately refuses to pretend the patched build is the
baseline. Baseline source is the base commit recorded above. Do not repoint or
modify the unmerged symlink worktree to run that control.

## Checks and compatibility

| Check                                                                                     | Result                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Full Linux backend (`jest --config jest.config.ts --runInBand --silent --verbose=false`)  | 201 suites, **4,100 passed**, seven existing conditional skips; 288.638 seconds                                                     |
| Full Linux Agent (`node --test /app/agent/dist/*.test.js`, existing unprivileged fixture) | **176 passed**, one existing conditional skip; 46.138 seconds                                                                       |
| Windows Agent (`pnpm --filter @plutonhq/pluton-agent test`)                               | **97 passed**, 80 existing Linux/native conditional skips; 5.682 seconds                                                            |
| Full frontend (`node --experimental-strip-types --test frontend/__tests__/*.test.ts`)     | **332 passed**, zero skips; 30.323 seconds                                                                                          |
| MySQL worker startup/image, runtime security and API inventory Node tests                 | **25 passed**, zero skips                                                                                                           |
| Backend lint, Agent/backend/frontend types                                                | PASS                                                                                                                                |
| Production `pnpm build`                                                                   | PASS: all three workspace build tasks; 78.725 seconds                                                                               |
| Frontend lint                                                                             | Existing ESLint configuration cannot load (`eslint-config-prettier` string in typescript-eslint `extends`); configuration unchanged |
| Baseline native reproduction / patched native matrix                                      | Confirmed original failure; patched 14, 19 and 20-case runs PASS                                                                    |

The final SQLite-precision compatibility correction was followed by another full
Windows Agent run (97 passed, 80 existing platform skips), the 20 Linux status
tests (all passed), and 73 focused Windows backend protocol/lease/diagnostic tests
(all passed). No security assertions, scenario or CI gate were skipped or removed
to obtain these results. Frontend lint remains an explicitly reported baseline
configuration failure, not a disabled gate.

Node in the main Linux/backend/native Oracle runtime was 24.22.1; Windows Node was
24.16.0. The existing Linux Agent fixture uses its own bundled runtime/tools. pnpm
was the pinned 10.20.0 with the frozen unchanged lockfile. Backend Jest used a
separate 6 GiB compilation container, not the 3 GiB native Agent profile. No hosted
CI result is claimed: this task does not publish a branch or dispatch production work.
An initial lease assertion expected milliseconds; it was corrected to verify the
existing SQLite second precision rather than changing the production lease policy.

New stage/code values are accepted by the backend completion schema and mapped to
closed operator-facing descriptions. Existing codes, payload versions and result
receipts remain valid. `leaseExpiresAt` is an additive optional status result field;
older Agents ignore it, and the new Agent accepts the old boolean-only response.
No endpoint, database migration, lease duration or backup/repository format changed.

**Deployment order is backend first, Agent second.** An old backend's strict enum
would reject the new diagnostic stage/code values in a completion. Updating the
backend alone cannot correct installed Agent code. An operator-reviewed update of
the existing Agent runtime is required for the bounded retries, stage correction
and progress behavior; this task does not reinstall, re-enroll or update one. The
current display version is not sufficient to distinguish all local builds; record
the immutable reviewed release commit and installed artifact hashes as well.

## Authorized production diagnostics and UAT

These commands are a plan for an authorized operator. They have **not** been run
against production. Set actual paths/time windows locally; keep actual IDs and
operational inventories in private incident evidence, not public repository text.
Do not print environment/config/identity files, HTTP bodies or authorization headers.

Read-only source-host checks (ISO timestamps should include the timezone):

```sh
FROM='2026-10-28 17:55:00 UTC'  # illustrative window; operator selects actual dates
TO='2026-10-28 18:10:00 UTC'
date --iso-8601=seconds
systemctl show pluton-agent.service -p ActiveState -p SubState -p MainPID -p FragmentPath
# Installed file paths must come from the operator's reviewed installation manifest.
sha256sum /opt/pluton-agent/current/agent/dist/runtime.js \
  /opt/pluton-agent/current/agent/dist/backupFilesystem.js \
  /opt/pluton-agent/current/agent/dist/client.js
# Emit only closed stage/code/checkpoint text, never an unfiltered journal line.
journalctl -u pluton-agent.service --since "$FROM" --until "$TO" -o json --no-pager |
  node --input-type=module -e '
    import readline from "node:readline";
    for await (const line of readline.createInterface({input:process.stdin})) {
      let item; try { item=JSON.parse(line); } catch { continue; }
      const message=String(item.MESSAGE||"");
      if(!message.includes("BACKUP_FILESYSTEM")) continue;
      const stage=message.match(/\bstage=([a-z-]{1,64})\b/)?.[1];
      const code=message.match(/\bcode=([a-z-]{1,64})\b/)?.[1];
      const checkpoint=message.match(/\b(database-dump-started|database-dump-completed|cleanup-completed|cleanup-warning|stage started|backup completed)\b/)?.[1];
      if(stage) console.log(JSON.stringify({timestamp:item.__REALTIME_TIMESTAMP,stage,code,checkpoint}));
    }'
```

The illustrative `/opt/.../current/agent/dist` layout must be replaced with the
operator's actual release-manifest paths; do not guess a running binary from the
version label. `systemctl cat`, `/proc/.../environ` and `identity.json` dumps are not
needed. Correlate the selected backup and command in the private operator UI and
backend command records. Where the server host has an authorized SQLite CLI, the
following query reads only non-secret command metadata and never `lease_owner` or
the signed payload (which can contain credentials):

```sh
# Set DATABASE_PATH locally from the approved server configuration; do not echo it.
sqlite3 -readonly "$DATABASE_PATH" <<'SQL'
SELECT id, type, state, datetime(created_at,'unixepoch'),
       datetime(leased_at,'unixepoch'), datetime(lease_expires_at,'unixepoch'),
       datetime(completed_at,'unixepoch'), attempt_count, last_event_sequence
FROM agent_commands
WHERE type='BACKUP_FILESYSTEM'
ORDER BY created_at DESC LIMIT 20;
SQL
```

This reveals only currently persisted lease state, not a historical renewal trace.
Use existing backend/WAF access telemetry for the same private command ID and time
window. Record endpoint suffix, response status, elapsed time and a validated
request-correlation ID; exclude bodies, query secrets, headers and client inventory.
Specifically distinguish `/events` from `/status` and `/complete`, correlate nonce
refusal/lease renewals with command state/attempt and Agent event sequence, and
compare backend/WAF and source-host clocks. Do not infer a failing status call from
an unrelated event 429. No ingress setting is proposed without these measurements.

After review, hosted CI and separately authorized release, perform **one** controlled
backup of the affected plan through its existing operator UI. Do not use `run --once`
as a read-only probe: it can lease and execute arbitrary queued work. Acceptance is:

1. Dump completion and post-dump status success.
2. Repository preparation followed by Restic completion and the exact snapshot ID.
3. SQL artifact receipt and independently verified byte count/SHA-256.
4. Mandatory Agent completion accepted, durable command closed and UI Complete.
5. Separate isolated staged recovery succeeds; download/dump success is insufficient.
6. Previous successful snapshot inventory is unchanged; no duplicate snapshot exists.

Historical status body/exception, installed runtime hash, actual failure-time
resources and the deployed WAF's aggregate rates remain production-only unknowns.
The local tests do not resolve those facts or prove production application recovery.

## Rollback and scope

Rollback only through the reviewed release process: drain active commands with the
existing upgrade guard, revert the local change/redeploy the prior reviewed Agent,
and retain the additive backend compatibility until all new-code completions are
delivered. Do not roll back the backend enum first while patched Agents may report
new failures. Preserve enrollment identity and durable completion receipts. Do not
delete production workspaces manually, replay a backup command, alter credentials,
disable TLS/HMAC/leases or change schedules as a rollback shortcut. There is no
database or repository migration to undo. Rollback restores the old misleading
failure classification and progress behavior, so it is not a recovery claim.

Changed production sources are limited to Agent backup/client/transport/polling and
progress modules, plus `AgentService`'s additive status/diagnostic contract and
`remoteBackupDiagnostics`. Tests, this report and the disposable runner/image are
supporting files. Browse, TAR export, Download/Restore, S3, replication, schemas,
production image definitions and the parallel symlink branch have no changes.

Exact changed files:

- `agent/src/backupFilesystem.ts`
- `agent/src/backupLifecycle.ts`
- `agent/src/client.ts`
- `agent/src/commandStatus.ts`
- `agent/src/commandStatus.test.ts`
- `agent/src/lifecyclePolicy.ts`
- `agent/src/lifecycleProcess.ts`
- `agent/src/progressDelivery.ts`
- `agent/src/runtime.ts`
- `agent/src/transport.ts`
- `backend/src/services/AgentService.ts`
- `backend/src/utils/remoteBackupDiagnostics.ts`
- `backend/__tests__/services/AgentService.test.ts`
- `backend/__tests__/stores/AgentStore.test.ts`
- `backend/__tests__/utils/operationalHardening.test.ts`
- `backend/__tests__/integration/agentPostDump.lab.ts`
- `backend/__tests__/integration/agentPostDump.restart.mjs`
- `scripts/fixtures/agent-post-dump/Dockerfile`
- `scripts/validate-agent-post-dump.ps1`
- `docs/AGENT_POST_DUMP_BACKUP_FAILURE_REPORT.md`
