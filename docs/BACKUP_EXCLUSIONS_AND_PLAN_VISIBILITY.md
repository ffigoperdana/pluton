# Managed Agent exclusions, plan visibility and Source Access history

## Delivered behavior and boundaries

The model already persisted `plans.source_config.excludes`, the server sent it
in filesystem commands and Restic received raw patterns. Managed Agent editing
offered only a root selector; the bounded source scanner did not apply filters.
This change exposes the existing field and adds an explicit relative-pattern
contract rather than changing host permissions or suppressing Restic failures.
Local/device-main backups, storage sync, repository adoption, retention/prune,
root operator and database recovery protocols remain unchanged.

No database migration is required. Existing empty-exclusion plans keep command
versions 1/2/3. Nonempty exclusions require `backupExclusionsVersion: 1` and a
version 4 envelope. Agent 0.7.0 accepts v4 with optional lifecycle v1 or v2 and
continues accepting legacy envelopes. Unknown fields/versions remain rejected.
Server validation is repeated at creation/edit, queueing and materialization;
an unavailable/degraded capability fails closed. Exclusion edits after queuing
are refused instead of silently changing the policy described by backup history.
The exact original source configuration remains in the backup record.

## Pattern contract

- Maximum 100 patterns, 512 UTF-16 code units each and 16,384 total before dedup.
- Trim surrounding spaces; ignore one trailing slash; deduplicate exact patterns.
- Relative paths with letters/numbers (including Unicode), spaces, `.`, `_`,
  `+`, `-`, `*`, `?`, and whole-component `**` only. Linux `/` separators only.
- Bare `.git`, `node_modules`, `.cache`, `*.tmp` match at any depth. Slash patterns
  are source-relative: `*/cache` is exactly one level; `**/cache` includes root.
- A match prunes the entry/subtree. Trailing `/` does not limit matching to
  directories: a same-name regular file or link is excluded too.
- At most one effective recursive `**` is supported, plus optional terminal `/**`
  subtree markers. Multiple interior recursive components (`**/dir/**/cache`)
  are rejected: native Restic testing demonstrated inconsistent zero-directory
  matches for them. This restriction is validated at all three boundaries.
- Absolute paths, empty components, `.`/`..`, backslashes, controls, negation,
  character classes, brace expansion and shell/environment syntax are rejected.
- `node_modules/**` prunes the root `node_modules` entry; use
  `**/node_modules` for all depths. `.cache` and `cache` are different names.
  Terminal `/**` components are compiled to the matching subtree root without
  changing its anchoring. Native testing found that sending multiple globstars
  with a terminal `/**` directly to Restic could retain a directory entry;
  normalization keeps permission preflight and real snapshot contents consistent.
- Source roots containing Restic wildcard/escape syntax are refused for nonempty
  exclusions rather than constructing a filter that might broaden its scope.

The pure component matcher uses bounded wildcard/state matching, not unbounded
backtracking regex or a shell. Agent/server/browser contract copies have common
parity regressions. Before traversal/access, the scanner prunes excluded child
entries. Root readability/canonicalization and host scope checks always run.
Nested symlinks are archived as links, never followed. Mandatory server-managed
private-directory filters remain Agent-local and cannot be negated by a plan.
The bounded scan can report entry/deadline limits; Restic remains authoritative
for every included entry and any nonzero backup exit is still a failure.

Restic receives absolute filters anchored to the canonical selected source.
Generated SQL/manifest artifacts in the separate lifecycle workspace cannot match
them. Existing state-overlap and lifecycle artifact validation are unchanged.
Source SQL files are ordinary source data and can be intentionally excluded.
No old snapshot is changed or deleted. Semantics follow the supported subset of
[Restic's documented patterns](https://restic.readthedocs.io/en/stable/040_backup.html#excluding-files).

## UI

Advanced → General shows a saved multiline Backup Exclusions field, syntax and
recovery warnings, validation errors and an Agent upgrade notice when needed.
Invalid edits remain invalid and cannot be saved through the normal form.
The local read-only CLI scanner also accepts repeated `--exclude <pattern>`.

Plans defaults to 9 records in both layouts; its selector offers 9/18/27. The
existing full-list API is unchanged; search/filter/stable sort precede slicing.
Size/filter changes reset page 1 and refreshed/deleted lists clamp immediately.
Other collection pages keep their 10/25/50 options and responsive grids are intact.

Cards show a small database configuration icon/label only when configured. Detail
summary shows engines/count, including old single-DB and mixed collections.
No database names, users, connection strings or passwords enter these labels.
Missing receipts and failed/completed jobs never become a verified backup claim.
Snapshot contents and recovery results continue to be independently reported.

## Deployment and rollback

1. Review/publish the exact commit and inspect Linux CI before deployment approval.
2. Deploy the matching server first: old strict inventory schemas do not recognize
   the new Agent capability. No production operation is authorized by this note.
3. Pause/drain plans and upgrade enrolled Agents through the reviewed app-only
   upgrade procedure. Preserve identity, TLS, source policy and all receipts.
4. Verify Agent 0.7.0 and its authenticated capability, then configure exclusions
   per plan after reviewing what recovery must include. No automatic defaults.
5. Run a separately authorized shadow backup; inspect its actual snapshot,
   generated database artifacts and restore before resuming schedules.

Before a server/Agent downgrade, drain jobs and explicitly remove/review nonempty
exclusions. An old Agent cannot consume v4; a new Agent's capability is rejected
by old servers. Follow the existing state-preserving rollback restrictions; never
rewind identity/policy or reset receipts to force a downgrade. Existing repositories
and snapshots do not need migration, rekeying or cleanup for this feature.

## Validation

Tests use only generic paths and disposable data. The native Linux integration
uses non-root permissions and the installer's approved Restic 0.19.1 SHA-256 pin.
It proves mode-000 excluded directories are pruned, included unreadable files
fail, real snapshot contents match filters, and separate SQL/metadata survive
`*.sql`/manifest exclusions. A workflow-level Agent test verifies exact argv,
mandatory private filters and refusal before a second backup on included denial.
Backend tests cover validation, Agent capability, ephemeral v4 materialization,
durable source history and queued-policy changes. UI tests render actual cards,
details/editor and exercise edits/removal, validation and pagination counts
7/9/10/18/19. DOM/SSR verification is not a screenshot or human visual sign-off.

The Agent upgrade safety workflow downloads only the checksum-pinned public
Restic fixture into runner temp and explicitly enables this native test. A
download/checksum/execution failure fails CI rather than silently skipping it.
No publication, deployment, elevated host operation or required-check change is
introduced. Existing Phase 5 tests requiring `PLUTON_PHASE5_TEST_TOOLS` remain
separately classified when that fixture is absent.

Production permissions, production backups and real database dumps were not
accessed or tested. Synthetic passes do not establish a production backup fix.

### Local results

All package commands used the repository-pinned pnpm 10.20.0 and existing lockfile.
No global toolchain or dependency configuration was changed.

| Check                                                                   | Result                                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux Agent `node --test dist/*.test.js`, non-root disposable container | 122 PASS, 35 existing Phase 5 fixture-dependent SKIP, 0 FAIL                                                                                            |
| Real Restic 0.19.1 snapshot/filter integration                          | PASS, including 12 pattern sets, unreadable included exit 3 and separate generated SQL/manifest preservation                                            |
| Agent `tsc --noEmit -p agent/tsconfig.json`                             | PASS                                                                                                                                                    |
| Final v4 parser regression with lifecycle v1/v2                         | 1 PASS                                                                                                                                                  |
| Backend Jest focused/dependent suites                                   | 6 suites, 227 PASS                                                                                                                                      |
| Frontend `node --experimental-strip-types --test` focused suites        | 25 PASS, 0 SKIP                                                                                                                                         |
| Backend and frontend production builds                                  | PASS                                                                                                                                                    |
| Documentation and Fumadocs validation included in builds                | 13 PASS and 8 PASS                                                                                                                                      |
| ESLint on changed backend production files                              | PASS, 0 warnings                                                                                                                                        |
| Frontend ESLint                                                         | BLOCKED by existing configuration loader error: `tseslint.config()` rejects the string `eslint-config-prettier` in `extends`; unchanged config/lockfile |
| Prettier and Git whitespace checks                                      | PASS                                                                                                                                                    |

Backend Jest used `--silent --runInBand --runTestsByPath` with
`services/RemoteBackupService.test.ts`, `services/AgentService.test.ts`,
`utils/backupExclusions.test.ts`, `services/PlanService.test.ts`,
`stores/PlanStore.test.ts` and `utils/remoteLifecycle.test.ts` under
`backend/__tests__/`. Frontend checks ran `planDatabase.test.ts`,
`planEnhancements.test.ts`, `tableCollections.test.ts` and
`remoteLifecycle.test.ts` under `frontend/__tests__/`.
Build commands were `pnpm --filter @plutonhq/core-backend build` and
`pnpm --filter @plutonhq/core-frontend build`.

The Linux fixture mounted compiled public test code/tools read-only, used a
non-root UID, no network, dropped capabilities and a disposable tmpfs for its
synthetic repositories. No application service, installed Agent, production
repository or real database was used. Container resources were automatically
removed and their exact ownership label checked afterward. Hosted CI has not
run for this local candidate. UI verification is DOM/SSR only; no screenshot,
browser layout acceptance or human visual sign-off is claimed. Existing React
Router SSR layout-effect warnings remain visible in the UI test output.

### Changed-file inventory

The initial three-feature commit contains these 36 source, test, workflow and documentation
files. Private logs, fixture tools, repositories and build outputs are excluded.

```text
.github/workflows/test-agent-upgrade.yml
agent/src/backupExclusions.test.ts
agent/src/backupExclusions.ts
agent/src/backupFilesystem.test.ts
agent/src/backupFilesystem.ts
agent/src/filesystemPolicy.ts
agent/src/index.ts
agent/src/inventory.ts
agent/src/types.ts
backend/__tests__/services/AgentService.test.ts
backend/__tests__/services/RemoteBackupService.test.ts
backend/__tests__/utils/backupExclusions.test.ts
backend/src/services/AgentService.ts
backend/src/services/RemoteBackupService.ts
backend/src/types/agents.ts
backend/src/utils/backupExclusions.ts
docs/BACKUP_EXCLUSIONS_AND_PLAN_VISIBILITY.md
frontend/__tests__/planDatabase.test.ts
frontend/__tests__/planEnhancements.test.ts
frontend/__tests__/tableCollections.test.ts
frontend/src/@types/devices.ts
frontend/src/components/Plan/PlanItems/PlanItem.module.scss
frontend/src/components/Plan/PlanItems/PlanItem.tsx
frontend/src/components/Plan/PlanSettings/PlanAdvancedSettings.tsx
frontend/src/components/Plan/PlanSettings/PlanBackupExclusions.tsx
frontend/src/components/Plan/PlanSettings/PlanSettings.module.scss
frontend/src/components/Plan/RecoveryTesting/RecoverySummary.tsx
frontend/src/components/common/Table/CollectionControls.tsx
frontend/src/components/common/Table/collection.ts
frontend/src/components/common/Table/useCollectionPage.ts
frontend/src/docs/articles/backup-plans/advanced.md
frontend/src/docs/articles/backup-plans/managed-agent.md
frontend/src/routes/Plans/Plans.tsx
frontend/src/utils/backupExclusions.ts
frontend/src/utils/planDatabase.ts
frontend/src/utils/plans.ts
```

## Fourth task: compact Source Access request history

The existing view returned at most 20 requests and rendered up to 12 verbose
entries. It now previews the newest five compact rows, including mode setup.
Each keyboard-operable row expands independently into the existing detailed
renderer and explicit Cancel/host-approval actions. Request ID, kind, status,
reason, requested/canonical paths, validation, expected version/revision, requested
mode and creation/completion/setup-expiry timestamps are retained. No command
payload, signature, identity credential or lease token is returned by history.

**View all requests** uses the existing stable, focus-contained modal: 10 per page,
newest first, optional status/type filters, Previous/Next, explicit loading/error/
empty states and Refresh. Details and the preview use bounded scroll areas;
narrow screens wrap into two summary columns. Escape closes the modal and restores
focus. Ordinary reads/expansion never submit or cancel a request.

### Additive retrieval API and compatibility

`GET /api/agent-admin/devices/:id/source-access/requests` uses the existing
administrator session middleware and `Cache-Control: no-store`. Read-only API
keys do not authorize it. Query parameters are `limit` (default 10, maximum 50),
`cursor` (opaque, bounded navigation data), `status` and `kind`. Invalid inputs
return 400, unknown/non-Agent devices 404, and unexpected errors remain sanitized.
The result contains `requests`, `total`, `pageSize`, `cursor` and optional
`nextCursor`. Every query remains scoped to the selected Agent, including when
a caller reuses/modifies a cursor. A cursor is never an authorization credential.

SQLite queries use the existing Agent/time index, a deterministic descending
creation-time/ID keyset and a read-transaction rowid high-water mark. At most
`limit + 1` request rows are loaded; totals use a SQL count. New insertions cannot
shift existing pages, even with equal/backdated timestamps. Previous revisits the
same membership boundary. Refresh/filter changes intentionally start a new
boundary. Status/outcome fields remain live audit data, not a frozen database
export; status changes can alter filtered membership. Refresh after database
maintenance/restore instead of persisting cursors as durable identifiers.

The old Source Access view keeps its original bounded 20-request response and
public field projection, preserving validation/pending/mode-management consumers.
History GET itself performs no reconciliation or authorization transition. No
migration, Agent change, retention policy or audit deletion is introduced. Deploy
the matching server before the new UI. An older UI continues using the original
view; a new UI paired with an old server shows a history retrieval error rather
than inventing a truncated full history. UI/server rollback needs no data rewrite.

### Fourth-task validation and changed files

- Backend: 128 tests PASS across Source Access, AgentService and RemoteBackupService.
  The first sandbox run could not connect Supertest's local disposable sockets
  (`EACCES`); the same tests passed with loopback access. Assertions were retained.
- Source history tests cover 0/1/5/6/125 entries, tied timestamps, stable new/
  backdated insertions, exact page boundaries, filters, invalid cursors, cross-Agent
  scope, sanitized failures and admin-only HTTP access. Reads run with SQLite
  `query_only=ON`; complete serialized database contents remain unchanged.
- Frontend: 43 tests PASS across history/Source Access and the prior three features.
  Real components, query hooks, response handling and modal are exercised with
  synthetic HTTP responses. Tests cover 0/1/5/6/75 entries, expansion/full details,
  pagination/filters/refresh, loading/failure/recovery and keyboard focus/Escape.
- Backend/frontend typechecks and production builds PASS; changed backend source
  lint PASS. Frontend lint remains BLOCKED by the unchanged baseline configuration
  error described above. Formatting and Git diff checks PASS.
- Responsive CSS and DOM behavior are checked. No rendered browser screenshot,
  human visual sign-off, production operation or hosted CI result is claimed.
  Agent/Linux execution is unchanged by this task; previous native exclusion
  evidence remains applicable and was not rerun.

Commands: backend Jest `--silent --runInBand --runTestsByPath` on
`__tests__/agentSourceAccess.test.ts`, `__tests__/services/AgentService.test.ts` and
`__tests__/services/RemoteBackupService.test.ts`; frontend Node tests on
`sourceAccessHistory.test.ts`, `agentSourceAccess.test.ts`, `planDatabase.test.ts`,
`planEnhancements.test.ts`, `tableCollections.test.ts`, `remoteLifecycle.test.ts`.
Build/type/lint commands use the same pinned toolchain described above.

The fourth task changes these 14 files (the initial three features remain in the
preceding local commit):

```text
backend/__tests__/agentSourceAccess.test.ts
backend/src/controllers/AgentAdminController.ts
backend/src/routes/agentAdmin.ts
backend/src/services/AgentSourceAccessService.ts
backend/src/stores/AgentSourceAccessStore.ts
backend/src/utils/sourceAccessHistory.ts
docs/BACKUP_EXCLUSIONS_AND_PLAN_VISIBILITY.md
frontend/__tests__/sourceAccessHistory.test.ts
frontend/src/@types/agentSourceAccess.ts
frontend/src/components/Device/SourceAccess/SourceAccess.module.scss
frontend/src/components/Device/SourceAccess/SourceAccess.tsx
frontend/src/components/Device/SourceAccess/SourceAccessHistory.tsx
frontend/src/docs/articles/remote-agent/permissions.md
frontend/src/services/agentSourceAccess.ts
```
