# Phase 5 remote database backup lifecycle

This is the independently implemented Phase 5 extension for remote managed
filesystem plans. It combines application files and one logical database dump
in one Restic snapshot, without copying or modifying the live application.
Local scripts and Legacy Repository behavior are not extended. Validation uses
disposable fixtures only. Production acceptance and SYS MON cutover remain
separate, explicitly authorized steps; keep SYS MON active.

## Architecture audit

The agent polls outbound, verifies a signed command, ACKs its lease, validates
the payload and realpath source against allowed roots, prepares private SFTP
credentials, checks or initializes its managed repository, runs Restic, and
reports a sanitized completion. Status polling refreshes the lease and detects
cancellation. The server queues references, not decrypted credentials.
`RemoteBackupService.materializeCommand` decrypts secrets only for authenticated
delivery. A cached completion and the stable backup tag prevent a successful
command replay from creating another unrelated snapshot.

Plans already have JSON settings and source configuration. The OSS local
`PlanScripts` and `executeUserScript` support interpreter selection, optional
root helpers and raw output. They are unsuitable for this agent boundary and
remain unchanged. Existing Cryptr encryption under the server `SECRET` is reused;
preserve the server's existing key material when redeploying.

Remote command failures remain terminal. Existing lease redelivery is not a new
automatic database retry engine. Another Backup Now creates a new backup/job;
each real attempt gets a fresh workspace. A cached successful command is replayed
without running the database dump or hooks again. New lifecycle settings cannot
be saved while that plan has an active backup.

There was no installed database-client evidence from the production agent. The
new inventory probes administrator-owned installed clients using bounded version
checks. MySQL requires a genuine `mysqldump`; MariaDB prefers `mariadb-dump` and
can use a MariaDB `mysqldump` alias. It never assumes that a MariaDB alias is a
MySQL client. Missing or unsafe clients are not advertised.

## Database lifecycle architecture

The smallest extension is an optional `settings.remoteLifecycle` on remote
managed plans and a version 2 `BACKUP_FILESYSTEM` payload. Filesystem-only plans
retain their version 1 envelope. The agent advertises `backupLifecycleVersion: 1`,
supported `databaseEngines`, and whether its hook root is safely provisioned.
Old agents remain usable for filesystem-only backups but cannot accept Phase 5
configuration. The agent reports version `0.3.0`.

The declarative database configuration selects engine, host, TCP port, transport,
database, username, dump filename, timeout, maximum bytes, and two allowlisted
flags: routines and events. There is no user-supplied binary, shell text, arbitrary
dump flags, socket path, output path or credentials file. Database/name/filename
validation prevents option and path injection.

The fixed dump command uses `--single-transaction --quick --skip-lock-tables
--hex-blob --databases <name>`. MySQL also uses `--set-gtid-purged=OFF` and
`--no-tablespaces`. Routine/event inclusion requires the corresponding account
privileges. Only a successful client exit with a regular, nonempty, private dump
can proceed to backup; this is not a general SQL semantic validator.

Remote TCP transport requires certificate and hostname verification. Explicit
`local` transport is accepted only for `localhost`, `127.0.0.1` or `::1`. Remote
TLS cannot silently fall back to plaintext. Custom CA/client-certificate selection
is not exposed by this phase; use an appropriate system trust setup and validate
the installed client's behavior in the pilot.

## Hook execution model

Optional pre/post hooks reference a flat identifier under
`/etc/pluton-agent/hooks`, plus fixed non-secret argv and a 1–300 second timeout.
Administrators deploy executable files, normally mode `0755`, owned by root.
Every ancestor must also be root-owned and not group/other writable. Symlinks,
nonregular files, nonexecutables, setuid/setgid files, traversal and outside paths
are rejected. Shell syntax and option/path-injection arguments are refused.

The agent executes the file directly, using its administrator-controlled shebang,
with `shell: false`. It never selects an interpreter from UI text or invokes sudo.
Hooks run as the non-root agent in the private job workspace with a small fixed
environment. `PLUTON_JOB_WORKSPACE` identifies that workspace; it does not grant
permission to modify a live source. Output is discarded and bounded. Timeouts,
cancellation and even successful parent exits terminate remaining descendants.
The post hook is bounded cleanup and is still attempted after cancellation.
It continues status polling to refresh the 60-second command lease while ignoring
the cancellation result, so a long post hook can still report the completed snapshot.

A root-deployed hook is trusted administrator code, not a sandboxed web script.
Administrators must review its fixed-argument semantics and make cleanup
idempotent. Never deploy hooks that write to the live application, accept shell
fragments, launch daemons, or expose secrets. Hooks are disabled by default.

## Schema and secret handling

Migration `0007_phase5_remote_database_credentials` adds one table,
`remote_plan_database_credentials(plan_id, encrypted_password)`, with a cascading
plan reference. No existing plan/source/storage/repository records are rewritten.
Plan and credential create/update operations share a SQLite transaction. Plan
deletion explicitly removes its credential, including when older migrations
left foreign-key enforcement disabled. Schedule-update rollback restores the
previous plan and ciphertext together.

The password is a write-only API input. Public plan settings contain only
`passwordConfigured: true`; the credential table is not joined into public plan
or device queries. Empty replacement keeps the saved password; disabling the DB
removes its credential. Unknown encrypted-password/secret-reference fields are
rejected. Frontend logs that printed plan inputs were removed.

The signed agent response contains the transient plaintext secret, as Phase 4
already does for storage credentials. Use HTTPS for untrusted transport; the
existing explicitly enabled trusted-LAN HTTP exception is unchanged. Durable
commands, identity completion records, progress, logs and snapshot metadata never
contain the DB password.

The dump client receives a `0600` defaults file as its first option. Host, user
and password are quoted and escaped there, not put in argv or `MYSQL_PWD`.
An empty private client home/login-file path prevents inherited MySQL login
configuration. Parent application environment, repository credentials and raw
stdout/stderr are never forwarded to dump clients or hooks. The defaults file is
deleted before Restic and the post hook start.

## Workspace and snapshot paths

Each attempt creates `/var/lib/pluton-agent/jobs/job-<random>/` at mode `0700`,
owned by the agent, with `pluton/database/<filename>.sql` at mode `0600`. This is
outside the source and never reuses an old dump. Restic receives the original
absolute source and the relative artifact path, with its cwd set to the job
workspace. No application copy, source symlink or root-level staging mount is
needed. The SQL is naturally visible at `/pluton/database/<filename>.sql` in
Browse, staged Restore and full Download.

Restic supports combining absolute and relative paths; snapshot metadata still
records absolute input paths even though the tree's relative artifact name is
stable. See [Restic backup path documentation](https://restic.readthedocs.io/en/stable/040_backup.html#absolute-and-relative-paths).
The implementation confirms an exact full 64-character snapshot ID, both managed
tags, and the dump node/size before reporting success. Existing global excludes
also affect the artifact; do not exclude the SQL dump. A missing/excluded dump
fails snapshot confirmation, not successful completion.

## Failure semantics and observability

The sequence is source/tool validation, fresh workspace, pre hook, dump,
regular-file validation, managed repository preparation, filesystem/artifact
backup, exact snapshot confirmation, post hook, and workspace/config removal.
A replay checks its existing snapshot before preparing another workspace.

Pre/dump failure prevents filesystem backup. Backup failure still attempts post
and filesystem cleanup. Post or cleanup failure after a confirmed snapshot leaves
the snapshot successful and adds closed warnings in
`completionStats.lifecycle.warnings` and a visible **Complete · Cleanup warning**.
The source is never silently converted into a failed snapshot by cleanup errors.
Cancellation before backup completion stops process trees and removes partial
artifacts. A confirmed success that beats cancellation is retained.

Agent journal and authenticated events report only fixed stages, including
`pre-backup-started`, `database-dump-started`, `database-dump-completed`,
`backup-started`, `backup-completed`, `post-backup-started`, `cleanup-completed`
and `cleanup-warning`. Failures have closed `failureStage`/`failureCode` values;
DB authentication/unavailable/timeout/output-limit errors are classified without
logging provider text. Server persistence discards raw Phase 5 agent error text.
Successful dump metadata contains only logical path, byte count and SHA-256.

## UI behavior

Remote plan Advanced settings have **Database & Hooks** sections. Saved passwords
are never prefilled or returned. Database enable/disable and pre/post hook fields
are optional; local plans retain their existing Scripts UI. The server rejects
unsupported agents or selected database engines independently of frontend checks.
Completed snapshot recovery stays on the existing Phase 4 path, including SQL
files. No database-import or automatic recovery-testing feature is added.

## Files and validation

Changed files are grouped below; no dependencies or lockfile changes are required.

| Area              | Files                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent lifecycle   | `agent/src/backupLifecycle.ts`, `lifecyclePolicy.ts`, `lifecycleProcess.ts`, `backupFilesystem.ts`, `config.ts`, `index.ts`, `inventory.ts`, `runtime.ts`, `types.ts`                                                                                                                                                                                                                           |
| Agent tests       | `agent/src/backupLifecycle.test.ts`; `agent/test-fixtures/phase5/{Dockerfile,RealDatabase.Dockerfile,database-client.mjs,hook.mjs,restic.mjs,rclone.mjs}`                                                                                                                                                                                                                                       |
| Backend lifecycle | `backend/src/utils/remoteLifecycle.ts`, `types/remoteLifecycle.ts`, `types/agents.ts`, `types/backups.ts`, `types/plans.ts`, `stores/PlanStore.ts`, `services/{PlanService,RemoteBackupService,AgentService,remoteCommandPreparation}.ts`                                                                                                                                                       |
| Schema            | `backend/src/db/index.ts`, `db/schema/remotePlanCredentials.ts`; `backend/drizzle/0007_phase5_remote_database_credentials.sql`, `meta/0007_snapshot.json`, `meta/_journal.json`                                                                                                                                                                                                                 |
| Backend tests     | `backend/__tests__/services/{PlanLifecycle,RemoteBackupService,AgentService}.test.ts`, `stores/{RemotePlanCredentials,PlanStore}.test.ts`, `utils/remoteLifecycle.test.ts`, `integration/{phase5Credentials,phase5Database}.smoke.ts`                                                                                                                                                           |
| Frontend          | `frontend/src/components/Plan/PlanSettings/{PlanAdvancedSettings.tsx,PlanRemoteLifecycleSettings.tsx,PlanRemoteLifecycleSettings.module.scss}`, `PlanForm/PlanForm.tsx`, `Backups/Backups.tsx`, `AddPlan/AddPlan.tsx`, `EditPlan/EditPlan.tsx`; `frontend/src/@types/{plans,backups}.ts`, `utils/{plans,remoteLifecycle}.ts`, `services/plans.ts`; `frontend/__tests__/remoteLifecycle.test.ts` |
| Documentation     | `docs/PHASE5_DATABASE_LIFECYCLE.md`, `docs/ARCHITECTURE.md`                                                                                                                                                                                                                                                                                                                                     |

Tests cover both engine command models, missing clients, wrong credentials,
unavailable DB, timeouts, size caps, empty dumps, file modes, post/pre failures,
backup failure, fresh retries, successful replay, cancellation/process trees,
unsafe hook paths/args/permissions, transaction rollback, secret redaction and
server failure transport. Phase 4 filesystem, Browse/Restore/Download and Legacy
regressions remain part of the full suites.

Verification on the implementation branch:

- Focused backend lifecycle/plan/real migration tests: **97 passed**.
- Full backend Jest (`pnpm --filter @plutonhq/core-backend test --runInBand --silent --verbose=false`): **133 suites passed; 2,686 tests passed; 1 skipped**.
- Complete non-root Linux agent suite: **44 passed, none skipped**, including the Phase 4 filesystem regressions and post-cleanup lease polling.
- Frontend lifecycle/download utility tests: **14 passed**.
- Agent and backend typechecks, frontend `tsc -b`, backend lint and root production build: **passed**.
- Real disposable MariaDB **11.8.8**, Restic **0.19.1**, Rclone **1.75.1**, SFTP lifecycle/recovery smoke: **passed**.
- Existing Phase 4 real recovery smoke: **passed**, including two historical TAR downloads, 14 files, cancellation, full/granular/custom staging, matching hashes and unchanged source/repository.
- `git diff --check`: **passed**. New source/fixtures/docs contain no real pilot inventory or credentials.

Frontend lint was attempted but cannot load the unchanged baseline configuration:
ESLint 10 / `tseslint.config()` rejects its string `extends: 'eslint-config-prettier'`.
That configuration was already present at the starting commit and is not changed
by Phase 5. Production build also emits existing bundle-size/Browserslist warnings;
Jest reports an existing exit-listener warning. These are not reported as clean
frontend lint or warning-free validation.

The SQLite rollback tests use an isolated Node/TSX process per scenario, with the
real store, all migrations and in-memory databases. This avoids shared native
SQLite state across Jest VM realms; actual insertion errors and rollback are
asserted, not mocked away. All validation used disposable state, not a live DB.

The opt-in `backend/__tests__/integration/phase5Database.smoke.ts` initializes an
isolated MariaDB, uses a limited synthetic account, runs the real agent against
Restic 0.19.1/Rclone 1.75.1/SFTP, and verifies SQL hashes through Browse, full
Download and staged Restore. It proves cleanup and unchanged application files.
It does not connect to production, and its generated credentials are discarded.

Run the documented commands in [ARCHITECTURE.md](ARCHITECTURE.md). The Linux agent
fixture harness needs executable temporary scripts, a non-root user and immutable
fixture executables. It has no host network or production mount:

```sh
pnpm --filter @plutonhq/pluton-agent build
docker build -t pluton-phase5-validation -f agent/test-fixtures/phase5/Dockerfile .
docker run --rm --network none --read-only --tmpfs /tmp:exec,mode=1777,size=128m \
  --mount type=bind,src="$PWD/agent/dist",dst=/app/agent/dist,readonly \
  --entrypoint /bin/sh pluton-phase5-validation \
  -c 'node --test /app/agent/dist/*.test.js'
node --experimental-strip-types --test frontend/__tests__/remoteLifecycle.test.ts frontend/__tests__/backupDownload.test.ts
```

The real-DB Dockerfile uses the local pinned Phase 4 validation image as its base;
it is opt-in, not a production image. Mount backend `src`, integration tests,
agent `dist` and `agent/package.json` read-only into `/app`, set disposable test
application settings, and run with `--network none --read-only` and a private
`/tmp` tmpfs of at least 512 MiB. Nothing is persisted to a host DB volume.

## Limitations and compatibility

Single-transaction consistency covers transactional tables such as InnoDB, not
MyISAM/MEMORY or concurrent schema changes. A DB dump plus changing application
files is not an atomic application checkpoint. Choose a quiet pilot window and
review application consistency requirements before cutover. These limitations
are documented by [MariaDB](https://mariadb.com/docs/server/clients-and-utilities/backup-restore-and-import-clients/mariadb-dump)
and [MySQL](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html).

Current real-client integration evidence is MariaDB, not a live MySQL server;
MySQL argv/security/error behavior is covered by synthetic executable tests.
Validate the intended installed MySQL client/server version and TLS trust before
using that engine. Dump clients are administrator-installed, not downloaded by
the agent installer. One database and one SQL filename are supported per plan.
Dump size is capped at 100 GiB, dump time at one hour, hook output at 64 KiB per
stream and Restic execution at 24 hours for lifecycle jobs.

SIGTERM/cancel performs cleanup. SIGKILL, host power loss or filesystem denial
can leave private stale workspaces. They are never reused. A cleanup warning
requires administrator inspection/removal of the exact inactive job directory;
do not delete a broad state/source/repository root. Hooks are not re-executed on
cached successful completion replay.

Existing Phase 4 agent identities, plans and storages can be reused after server
and agent redeployment; no plan/storage recreation or source-path change is
required. No Legacy Repository mutation path or new retention/prune/unlock path
exists. Filesystem-only plans remain on their original envelope and behavior.

## Pilot procedure and SYS MON cutover blockers

1. Keep SYS MON active. Back up server key material and DB before deployment;
   deploy the additive server migration and updated agent using the existing
   identity. Confirm inventory shows agent 0.3.0, filesystem capability and the
   selected database engine. Do not enroll a second device just for the update.
2. Install the intended dump client on a test agent. As the actual `pluton-agent`
   user, run `/usr/bin/mariadb-dump --no-defaults --version` or
   `/usr/bin/mysqldump --no-defaults --version`. Check root ownership, executable
   permissions and administrator-controlled ancestor directories. No password
   is needed for this detection step.
3. First use a disposable InnoDB test database `example_db` with a small known
   row such as `synthetic-fixture`. Grant only the required read/view/trigger
   privileges to `backup_reader`; leave routines/events off. Do not grant root,
   write, SUPER or broad cross-database privileges. Supply the password privately
   through the UI, never paste credential/config dumps into chat or shell argv.
4. Use a selected test source such as `/srv/example-app` under the agent's allowed
   root. Record hashes of its files. A separate managed test destination is
   recommended for the first pilot; never use an imported Legacy repository.
   An existing approved managed plan/storage can also be used without recreation.
5. Enable Database Backup in Advanced → Database & Hooks. Select the actual engine,
   host/port, `example_db`, `backup_reader`, password and `app.sql`. Choose verified
   TLS for remote TCP; loopback-only transport is an explicit test option. Leave
   hooks off initially, use a finite timeout/size cap, save, then reopen the form:
   it must say password saved and show an empty password input.
6. Run Backup Now. Confirm the safe dump/backup/cleanup stages, status Complete,
   a full snapshot ID, no cleanup warning and
   `completionStats.lifecycle.database.path == /pluton/database/app.sql`.
   Privately compare that metadata's SHA-256 with recovered SQL. Do not share SQL
   contents or secrets. Check `jobs/` has no directory for this completed attempt.
7. Browse that exact backup and locate `/pluton/database/app.sql`. Download its
   full archive into an isolated test folder; verify the SQL contains the known
   fixture row and `sha256sum` matches completion metadata. Use staged Restore
   for the same backup, verify the same SQL hash, and compare application-file
   hashes with step 4. Never restore into the live application or import SQL into
   a production DB. Optionally import it only into another disposable DB to
   verify logical recovery, under separately selected test credentials.
8. Exercise wrong test password, unavailable test port and cancellation. Each
   must fail safely without a filesystem backup, remove partial artifacts, and
   avoid credential/SQL output in logs. Correct the configuration and use another
   Backup Now; it must use a fresh workspace. Test optional reviewed pre/post
   executables separately, including a deliberate post failure that preserves
   a successful snapshot with a visible cleanup warning.
9. Only consider SYS MON replacement after engine/version/TLS checks, repeated
   scheduled backups, restore/import verification, failure and cancellation
   drills, hook review, consistency requirements, retention ownership, disk/time
   capacity and an explicit rollback/cutover decision. This implementation and
   disposable smoke success alone do not authorize disabling SYS MON.
