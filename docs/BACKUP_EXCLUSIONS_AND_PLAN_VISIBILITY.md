# Managed Agent exclusions and plan visibility

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

The intended candidate contains these 36 source, test, workflow and documentation
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
