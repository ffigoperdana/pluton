# Remote Device Settings Rename Fix

## Root cause and reproduction

Branch `codex/remote-device-settings-fix` uses an isolated worktree from fetched
`origin/main` at `e61eab28c3936aa53ad168151b9957fd9e7bc911`.

The remote Device edit form submitted its entire `{ name, settings }` state even
when only the display name changed. A device without saved settings therefore
sent `settings: {}`. `DeviceService.updateDevice` tested the object's truthiness,
not whether any runtime value changed, and called
`RemoteStrategy.updateSettings` before updating SQLite.

That strategy's `UPDATE_SETTINGS` path unconditionally returns
`{ success: false, result: 'REMOTE_CAPABILITY_NOT_IMPLEMENTED' }`. The service
converted it into `Error('Failed to update device settings')`; the controller
converted every exception into HTTP 500. This is an unsupported-command dispatch
bug, not a failed SQLite write or a blank-directory filesystem error.

The new regression uses the actual router, authentication middleware, service,
RemoteStrategy and a migrated in-memory SQLite database. Before the fix,
`PUT /api/devices/device-01` with
`{ "name": "app-01 renamed", "settings": {} }` returned **500**, failing the
expected-200 assertion. The same test now passes and verifies persistence.

The reported ID-less `/api/devices/` request is a separate evidence discrepancy:
the reviewed frontend sends `/api/devices/:id`, and this source has no PUT route
without an ID. An ID-less request returns 404 and changes nothing. No production
or proxy inspection was performed, so a deployed asset/version or URL-rewrite
explanation is not proven. The client now rejects an empty ID before transport
and URL-encodes valid IDs; no identity is inferred from a display name.

## Updated behavior

| Input or outcome | Behavior |
| --- | --- |
| Remote display-name edit | Server metadata only; works independently of Agent online/offline status. |
| Omitted, null or empty `settings`; empty sections | Keep existing settings. |
| Blank optional string or numeric UI input | Keep the stored value, not an implicit reset. Explicit numeric zero is retained by the patch handler. |
| Unchanged optional settings | Do not invoke a runtime strategy. |
| Actual remote runtime change | HTTP 501 with host-configuration guidance; neither rename nor settings are persisted. No remote command is sent. |
| Actual local runtime change | Retain the local strategy; merge existing section values rather than replacing omitted siblings. A failed application returns sanitized HTTP 503. |
| Invalid input or immutable/unknown request fields | Sanitized HTTP 400; no metadata write. Names are trimmed, 1–100 characters, without C0/DEL controls. |
| Missing device | HTTP 404. |
| New display-name collision | HTTP 409. Check and metadata write share a synchronous SQLite transaction. |
| Unexpected storage failure | Generic HTTP 500, without native error/SQL details. |
| Omitted tags / explicit `tags: []` | Preserve tags / explicitly clear tags. |

Collision comparison follows SQLite `lower(trim(name))` semantics, including
ASCII case-insensitivity. Display names are not security identities. Existing
duplicate names need no migration; an unchanged name remains accepted.

The remote edit panel no longer presents unsupported runtime controls as
writable. It explains the host-managed configuration boundary. Local runtime
controls remain available. Requests are single-flight, never automatically
retried, preserve the session and PUT method, reject redirects/unexpected HTML,
and invalidate both list and exact-device queries after success. Update-related
payload/response console logging is removed. Mutation responses omit legacy
`key` and Rclone `configPass` values without deleting them from storage.

## Identity and compatibility review

The metadata store explicitly whitelists `name`, `settings` and `tags`; generic
telemetry updates retain their existing store path. Rename does not write Agent
identity/enrollment rows, encrypted secret material, approved source roots,
command queues, plan source IDs, repository credentials, snapshots or schedules.
Synthetic online/offline tests compare those identity, approval, enrollment,
queue and plan records before and after the request.

Source Diagnostics V2 consumes authenticated saved-progress `sourceFailure`
metadata and plan identity. Its bounded diagnostic schema, transport negotiation,
saved progress, source permissions and standalone Agent are unchanged.

The separate MCP V2 branch was reviewed read-only: token/grant scopes bind to
`agentIds`, `planIds` and storage IDs; operational reads select stable
`agentIdentities.agentId`/`deviceId` and source state by Agent ID. None are renamed
or regenerated. No MCP write action is added and no session-only device route
is exposed to MCP or bearer-only writes. MCP V2's worktree and PR are untouched;
this is contract review, not a claim that its unmerged branch was integrated or
its full suite executed here. Existing main-branch MCP integration tests pass.

There is **no schema migration, Agent update, protocol change, re-enrollment or
secret rotation**. Existing session/origin/CSRF protections are unchanged.

## Changed files

- `backend/src/controllers/DeviceController.ts`: typed sanitized errors and secret-free mutation response.
- `backend/src/services/DeviceService.ts`: effective-patch handling; metadata versus runtime separation.
- `backend/src/stores/DeviceStore.ts`: restricted transactional metadata updates and collisions.
- `backend/src/utils/deviceSettingsUpdate.ts`: strict request validation and preserving optional merge.
- `backend/__tests__/services/DeviceSettingsRegression.test.ts`: actual router/SQLite reproduction and error/identity/permission tests.
- `backend/__tests__/services/DeviceService.test.ts`: real supported local path and unsupported remote behavior; sanitized runtime failure.
- `backend/__tests__/controllers/DeviceController.test.ts`: unexpected errors do not reflect raw messages.
- `frontend/src/components/Device/EditDevice/EditDevice.tsx`: rename-only remote form and submission guard.
- `frontend/src/services/devices.ts`: exact identity, safe response handling and query invalidation.
- `frontend/src/utils/deviceSettingsUpdate.ts`: changed-field payload generation.
- `frontend/__tests__/deviceSettings.test.ts`: payload, transport and actual remote React-panel regressions.
- `docs/api-inventory.json`, `docs/API_COVERAGE_MATRIX.md`: regenerated test-reference metadata; no new routes.
- `docs/REMOTE_DEVICE_SETTINGS_FIX.md`: root cause, evidence and operational handoff.

## Validation

Environment: Windows, Node 24.16.0, pinned pnpm 10.20.0, frozen existing lockfile.
No dependencies were added. SQLite regression data is private and disposable;
opaque markers are inert comparison values, not usable credentials. Test logs,
installed dependencies and generated bundles are not release source artifacts.

| Check | Result |
| --- | --- |
| Initial rename regression before fix | Expected reproduction: 1 failed test, received 500 instead of 200. |
| Focused device router/service/controller suites | 82 passed, 0 failed. |
| Complete backend Jest suite | 197 suites; 3,925 passed, 4 skipped, 0 failed. Full `--detectOpenHandles` rerun exited 0 with the diagnostic warnings described below. |
| Complete frontend Node suite | 296 passed, 0 failed. |
| Existing MCP integrations, `test:mcp` | 11 passed, 0 failed. |
| API inventory test | 1 passed, 0 failed; 160 method/path contracts unchanged. |
| Backend and frontend typechecks | Both passed. |
| Backend lint | Passed. |
| Frontend lint | Blocked by unchanged baseline ESLint configuration described below. |
| Production `pnpm build` | Passed; all three workspace build tasks succeeded, including frontend and backend production artifacts. |
| `git diff --check` | Passed; checked again before commit. |

Commands: `pnpm --filter @plutonhq/core-backend test --runInBand`,
`node --experimental-strip-types --test frontend/__tests__/*.test.ts`,
`pnpm --filter @plutonhq/core-backend test:mcp`,
`node --test scripts/__tests__/apiInventory.test.mjs`,
`pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json`,
`pnpm --filter @plutonhq/core-frontend exec tsc -b`, both package `lint` commands,
`pnpm build`, and `git diff --check`.

The unchanged frontend ESLint 10 configuration passes the string
`eslint-config-prettier` inside `tseslint.config()`'s extends array, which that
helper rejects before checking files. No rules were disabled or configuration
changed to hide it. The production build also reports existing generated-CSS
and bundle-size warnings. No browser/production acceptance, real backup/restore,
native database import or remote Agent execution is claimed by these tests.

One complete non-instrumented backend rerun printed all 197 passing suites but
retained an asynchronous handle after Jest's completion summary. Only that exact
completed worktree-owned runner was stopped, preserving the warning and result;
its command therefore did not exit successfully. No `forceExit` option or test
assertion was changed. The changed device suites separately pass all 82 tests
with `--detectOpenHandles` and exit normally. The full diagnostic rerun also
reports 197 passing suites and 3,925 passing tests, with two
`STREAM_END_OF_STREAM` handles originating from unchanged fixture listeners in
`backend/__tests__/utils/mysqlPersistentDatabaseImporter.test.ts` (oversized frame
test, fixture listener at line 57) and
`backend/__tests__/utils/mysqlRecoveryWorker.test.ts` (oversized frame test,
fixture listener at line 124). Those test/importer files match `origin/main` and
are outside the rename fix. This diagnostic rerun exited naturally with status
0 despite those potential-handle warnings; it was not stopped or forced to
exit. The earlier non-instrumented runner termination is reported separately,
not hidden as a successful command. Four platform-dependent tests remain
skipped on Windows; this is not Linux/native acceptance evidence. CI must
confirm normal process teardown in its Linux job.

## Safe deployment and rollback

After review and required CI checks, build matching server/frontend artifacts
from the reviewed commit through the existing immutable-image workflow. Deploy
them together using the existing rollback tooling and an approved maintenance
window; do not run installer/re-enrollment flows for this server-only change.
Retain the prior image digest and an application-consistent backup of persistent
application data. Preserve the existing `/data` volume, SQLite database,
`SECRET`, `ENCRYPTION_KEY`, stored credentials and Agent identities unchanged.

Smoke-check on a disposable device first: rename with an empty temp directory,
reload the device list/detail, verify unchanged device/Agent IDs and plan links,
and verify an intentional duplicate/invalid name returns a safe error. Verify
the actual PUT includes its ID. Agent connectivity is not a prerequisite for
this metadata operation; do not start a backup to test rename.

Rollback by restoring the previous matching server/frontend image digest with
the same volume and secrets. There is no migration to reverse or reason to
restore an older SQLite database. A successful display rename remains stored
after rollback; reverting that label is a separate explicit metadata edit.
The previous UI/backend can reintroduce the unsupported-settings 500 behavior.
Blank optional inputs deliberately do not clear existing settings; clearing
runtime configuration requires a separately authorized host-configuration
procedure rather than a display-name update.

All implementation and validation are isolated from the existing MCP V2
worktree. No production access, push, PR change, merge, deployment, real
repository operation or Agent reinstall was performed.
