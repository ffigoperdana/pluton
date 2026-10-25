# Managed browser pagination CI regression

Branch: `codex/fix-managed-browser-pagination-ci`.
Base: freshly fetched main, `b0861892b1a1e9e511a33decd02f76102725bbfd`.
Validation date: 2026-10-26. Local commit only; no push, merge, deployment,
production access or Agent change.

## Confirmed cause

The [reported CI run](https://github.com/ffigoperdana/pluton/actions/runs/40228192654)
uses the same base revision. The unmodified test passed locally at normal speed,
so this was investigated with test-only API/query/DOM diagnostics and slower
interaction timing rather than classified as a flaky assertion.

The real component scheduled a 300 ms search debounce on mount even though both
search values were empty. Its callback unconditionally reset the page offset.
With slower interaction timing, the observed file requests were:

```text
open /srv: offset 0, rows dir-0 … dir-199
Next enabled: offset 200
unchanged initial debounce fires: offset 0
Next enabled: offset 200, rows dir-200 … dir-399
dir-555 missing
```

Both Next controls were enabled when clicked, and React Query faithfully fetched
the reset offset. This was a genuine pagination-state bug caused by an unnecessary
search timer, alongside a test helper that assumed fixed 30 ms sleeps implied
readiness. The sidebar highlighting logic was not the cause.

The fix schedules a debounce only when `search !== debouncedSearch`, with both
values in the effect dependencies. The actual search delay remains 300 ms, and a
real filter change still resets the offset to zero. Navigation clears/cancels a
pending filter correctly. No pagination, query-cache or tree limit was increased.

The same slower diagnostic test now observes `0 → 200 → 400`, rows dir-400 through
dir-599, then navigation to `/srv/dir-555` at offset zero with selected-tree state.

## Regression evidence

The test helper now waits for actual query completion and enabled controls.
Page-specific waits additionally require the expected query path/offset, a ready
response, and the expected rendered row. A bounded failure diagnostic includes
query/loading state, first/last rendered directory rows, controls and selection.
The two-second diagnostic deadline is a test failure bound, not a readiness sleep
or an application timeout change.

Desktop and mobile cases independently gate the offset-200 and offset-400 network
responses. They verify loading states and rapid repeated clicks, exact offsets
`[0,200,400]`, dir-555 on page three, navigation into that folder, and highlighting
while the sidebar retains its first page. They preserve the 200-row request bound,
at most one retained file query, the eight-request ceiling and fewer than 210 tree
rows for the fixture. Mobile also toggles Folders during a pending response.

A test-controlled search clock advances only the application's 300 ms debounce;
query notifications and network responses retain their normal scheduling. A
separate test proves genuine search changes still reset a later page. All three
new deterministic cases fail against the unchanged main component (both pagination
cases return to page zero; the search case detects the unnecessary initial timer).
They pass against the fix without skipping or weakening the original assertions.

| Validation | Result |
| --- | --- |
| Focused managed browser suite | 11 passed |
| Repeated desktop/mobile/debounce cases, Windows Node 24.16.0 | 25 repetitions, 75 cases passed |
| Repeated cases, Linux Node 24.22.1 matching Actions | 25 repetitions, 75 cases passed, two CPUs / 1 GiB container |
| Complete frontend suite, Windows | 308 passed, no skips |
| Complete frontend suite, Linux Node 24.22.1 | 308 passed, no skips; two test workers / two CPUs / 1 GiB; 15.900 seconds |
| Backend snapshot index/cache/service/controller checks | Four suites, 180 passed; authorization, safe paths, streaming, cache limits and restore behavior retained |
| Frontend TypeScript, backend lint, production build | Passed; three build tasks, 38.826 seconds, pinned pnpm 10.20.0 |
| Changed component under existing frontend lint rules | Passed using the temporary config-loader correction described below |
| `git diff --check` | Passed |

The full frontend lint command still fails before file analysis because the
existing `typescript-eslint.config` loader does not accept the string
`eslint-config-prettier` in extends. A temporary uncommitted loader copy resolves
that string to the same config object for the changed-component check. No lint
rule, repository config, dependency or CI gate was changed or disabled.

All Linux checks used an existing disposable image, read-only source mounts,
no external network or live data, and CI's exact Node version. DOM/component
fixtures retain the existing virtual-list/row stubs; desktop/mobile interaction
coverage does not claim a new visual layout test. Product markup and styles did
not change.

## Changed files and delivery

- `frontend/src/components/Plan/SnapshotViewer/ManagedSnapshotViewer.tsx`: guard
  the no-op debounce and track both search values.
- `frontend/__tests__/managedSnapshotBrowse.test.ts`: state-driven waits, safe
  diagnostics, controlled slow responses, exact page/selection assertions, mobile
  coverage and actual-filter regression.
- `docs/MANAGED_BROWSER_PAGINATION_CI_FIX.md`: this report.

Classic tree/mobile navigation, lazy directory loading, bounded metadata/query
state, snapshot authorization/identity, streaming downloads and staged Restore
remain on the existing paths. Backend, standalone Agent, schema, environment,
lockfile and workflow files are unchanged.

After manual publication, verify **Container image → Test frontend state, polling,
accessibility and recovery regressions** passes on the new commit and confirm both
desktop/mobile selection cases run. Then verify the remaining required source,
build and recovery jobs. Hosted acceptance remains pending until that publication;
no remote run or deployment was triggered by this task.
