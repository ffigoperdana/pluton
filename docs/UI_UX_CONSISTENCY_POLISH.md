# UI/UX consistency polish (conservative refinement)

## Scope and execution

Branch `claude/ui-ux-consistency-polish`, started from reviewed `main` /
`origin/main` commit `04f5f2d` (PR #70 merged). Local commits only: no push,
pull request, merge, release, deployment or production access. Frontend only.
No backend, API contract, migration, Agent, scheduler, restore, replication,
S3/HCP, authorization, MCP authorization or CI change. No dependency was added.

This is a maintenance pass, not a redesign. The purple accent (`--primary-color`
`#575aff`), dark and light palettes, Inter typography, sidebar, dashboard
structure, card density and modal size classes are unchanged. The review used
the unslop skill (by Damir Sokolovsky, CC BY 4.0) in its "light slop / polish"
mode: fix what the audit proves, keep the existing brand and layout.

All preview data is synthetic (`app-01`, `example.internal`, `/srv/example-app`,
`192.0.2.x`). No production repository, endpoint or credential was used.

## Audit summary (before state)

Existing design system, retained:

- Tokens live in `frontend/src/styles/global.scss`: `:root` is Light,
  `[data-theme='dark']` overrides Dark. Text roles `--content-title-color`,
  `--content-text-color`, `--content-text-color-light`; surfaces
  `--background-color`, `--content-background-color`, `--surface-muted`,
  `--surface-hover`, `--field-bg`; semantic `--success-*`, `--warning-*`,
  `--error-*`; accent `--primary-color`, `--primary-color-light`,
  `--primary-color-foreground`.
- Existing contracts in `frontend/__tests__/themeStyles.test.ts` (4.5:1 text
  pairs, 3:1 input boundary) and the documented decisions in
  `docs/UI_THEME_SNAPSHOT_PAGINATION.md` (theme persistence, 1560px content,
  confined table scroll) were kept.
- Dialog buttons follow `.modalButton`: 4px radius, 600 weight, 0.75rem; primary
  is solid `--primary-color`, secondary uses `--line-color`.

Proven inconsistencies (verified in source and, where noted, in the running
`main` image with computed styles):

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                            | Evidence                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Toggle OFF track used `--line-active-color`, which is `#aaacff` (the accent) in Dark, so OFF and the purple-gradient ON both read as purple.                                                                                                                                                                                                                                                                                                       | Computed in the `main` container: OFF track `rgb(170,172,255)` with a dark thumb. |
| 2   | Toggle checkbox was `visibility: hidden`, so switches were not reachable with Tab and had no focus ring.                                                                                                                                                                                                                                                                                                                                           | Computed `visibility=hidden` on all four notification switches in `main`.         |
| 3   | Error text used `--error-button-color` (`#b54444`, a fill colour), about 3.0:1 on Dark cards. 15 declarations in 8 files.                                                                                                                                                                                                                                                                                                                          | `git grep` on `origin/main`.                                                      |
| 4   | MCP status badge: `#aaacff` background behind inherited light-grey text in Dark, about 1.15:1.                                                                                                                                                                                                                                                                                                                                                     | `Mcp.module.scss` `.badge`.                                                       |
| 5   | `turquoise` named colour for connected dots and mirror bars, about 1.65:1 on white. Disconnected device dot used the Dark accent `#aaacff`.                                                                                                                                                                                                                                                                                                        | `DeviceItem`, `DeviceSingle`, `BackupProgress` styles.                            |
| 6   | `border-color: var(line-active-color)` (missing `--`) in Edit Plan: an invalid declaration silently ignored.                                                                                                                                                                                                                                                                                                                                       | `EditPlan.module.scss`.                                                           |
| 7   | macOS and Kali logos hardcoded `fill="#222"`, nearly invisible on Dark cards.                                                                                                                                                                                                                                                                                                                                                                      | `Icon.tsx`.                                                                       |
| 8   | Icon-only buttons without an accessible name (close, remove, menu, password visibility, log paging). Hover-only actions stayed invisible on keyboard focus.                                                                                                                                                                                                                                                                                        | Changed-file inventory below.                                                     |
| 9   | Browse Snapshot: double frame (bordered browser inside the bordered dialog); root folder rows had 0px left padding; leaf and expandable rows misaligned (`10px` placeholder vs bordered `+`/`-` box); folder selection barely distinct in Light and lost on hover; file names used `break-all` inside fixed 46px virtualized rows; no row hover; header showed every identifier with equal weight; the local "Not compared" notice had no padding. | Screenshots of the `main` container and source.                                   |
| 10  | Snapshot Details: every field and explanatory paragraph had the same weight; the footer Close was unstyled text; comparison state was shown raw (`ready`, `missing`); the Detailed changes controls were lowercase `added/modified/deleted` buttons using `aria-expanded` as tabs; the list of 50 paths rendered immediately; Browse Changed Files sat below the pager although it silently used the selected change type.                         | Source and the `--original` synthetic preview.                                    |

Intentionally unchanged: dashboard and plan cards, sidebar, page structure,
backup history table, modal dimensions (`880px` details, `min(90vw,1400px)`
explorer, mobile full height), all wording that carries operational meaning
(safety footers, "Not recorded", recovery caveats), comparison eligibility and
validation, snapshot identities, download and restore actions.

## Implemented improvements

### Theme consistency

- New tokens `--toggle-track-off` (Light `#73778a`, unchanged; Dark `#767987`)
  and `--toggle-thumb` (Light `#fff`; Dark `#e8e8ec`).
- Error text uses `--error-text-color` everywhere; `--error-button-color`
  remains the fill behind white button text.
- MCP badge uses `--primary-color-light` / `--primary-color-foreground` (the
  existing status-label pairing).
- Connected dot `--success-text-color`, disconnected dot
  `--content-text-color-light`, mirror bars `--progress-fill`.
- Edit Plan focus border fixed; OS logos use `currentColor`.

### Toggle controls

- OFF is a neutral track with a light thumb; ON is solid `--primary-color`
  (the one-off purple-to-blue gradient was used nowhere else); disabled keeps
  the existing 0.6 opacity and not-allowed cursor.
- The native checkbox is visually hidden but focusable, carries `role="switch"`,
  and `input:focus-visible + label` shows the standard 2px focus ring.
- Same 32x18 size and pill shape. Thumb motion uses `transform` only.
- Event handling and stored values are unchanged.

### Browse Snapshot

- Header: plan name, date, size and file count on one line; Backup ID and
  Snapshot ID below as monospace chips (full values kept; one click selects the
  whole identifier for copying).
- Inner browser frame removed inside the explorer dialog (no double border).
- Tree: shared 16px toggle column so leaf and expandable rows align, caret
  icon instead of `+`/`-`, root rows padded, full path as row title, selection
  = surface step + 2px accent hairline + accent text, hover no longer overrides
  selection.
- File rows: single-line names with ellipsis and the full path as title, row
  hover, 28px action hit areas, smaller muted table header.
- Managed viewer: styled alerts, breadcrumbs with `/` separators and
  `aria-current`, comparison bar groups status (snapshot ID as chip), controls
  and the "historical results" notice (warning tone).
- Local viewer: the "Not compared" notice is padded and muted.

### Snapshot Details

- Section headings, muted labels with brighter values, smaller muted
  explanatory notes, monospace identifier chips, dashed separators between
  database artifacts, styled Retry/Close buttons, footer kept visible.
- Comparison hierarchy:
  1. status bar with the Compare / Retry / Cancel action;
  2. selected snapshot identities;
  3. compact Added / Modified / Deleted / Unchanged summary (text label plus a
     semantic dot, never colour alone);
  4. one change-type selection (`aria-pressed`) placed next to the primary
     **Browse Changed Files** action, with a one-line note explaining that both
     use the selected type;
  5. a collapsible **Detailed changes** disclosure (`aria-expanded`,
     `aria-controls`) holding the exact path list, `1–50 of N` range and
     Previous/Next changes.
- Browse Changed Files and Detailed changes are kept: they serve different
  needs (tree navigation with download/restore actions vs. a flat exact path
  list).
- Comparison states read as "Not compared yet", "Comparison ready",
  "Comparison failed", "Comparison cancelled", "Comparison unavailable"; a
  server-provided `reason` still takes precedence.

### Other small corrections

Accessible names for: SidePanel, Restore Wizard, Restore preview, Storage file
browser, Folder picker and Path picker close buttons; path chip removal;
script removal; restore row menu; password visibility; log paging. Storage file
row actions and plan storage actions now also appear on `:focus-within`.

### Behaviour differences to be aware of

- The Detailed changes path list is requested only when the disclosure is
  opened (previously on render). Filter, offset, page size (50) and the API
  call are unchanged.
- Light mode: error text is the darker `#8d2f2f` instead of `#b54444`; the MCP
  badge is pale lavender with purple text; OS logos use the grey icon colour.
- Nothing presents a snapshot as verified, recoverable, replicated or healthy
  that was not already stated; statuses still come from the API.

## Before/after evidence

Viewed in the desktop app's built-in browser at 1440x900 (and 390x844), Dark
and Light, against two local containers built from source with identical
synthetic data:

- `pluton-preview:before` = `04f5f2d` on `http://localhost:5191`
- `pluton-preview:after` = branch head on `http://localhost:5192`

plus the existing synthetic preview (`node __tests__/theme-preview/server.mjs`
on 5188, `--original` on 5189 with `main`'s frontend extracted to the ignored
`tmp/compact-original/`). Screenshots were reviewed in the pane, not committed.

| View                   | Before                                                                | After                                                                                    |
| ---------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Toggle OFF, Dark       | Lavender `#aaacff` track, dark thumb                                  | Neutral `#767987` track, light thumb                                                     |
| Toggle ON / disabled   | Purple-blue gradient                                                  | Solid `#575aff`; disabled faded                                                          |
| Toggle keyboard        | Not reachable (`visibility: hidden`)                                  | Tab reaches `role=switch`, `:focus-visible` ring `#aaacff` (Dark)                        |
| Browse Snapshot tree   | Root row at x=0, leaf rows offset, faint selection                    | Aligned rows, carets, accent hairline selection (both themes)                            |
| Browse Snapshot header | One flat line of mixed values                                         | Primary line + identifier chips                                                          |
| Snapshot Details       | Uniform text, raw state, Close as plain text                          | Hierarchy, readable state, styled actions, same 880px dialog                             |
| Comparison controls    | `added/modified/deleted` buttons, 50 paths rendered, Browse at bottom | Summary tiles, segmented type + primary Browse, collapsed list with `51–63 of 63` paging |

Two screenshots taken immediately after a live theme switch showed stale frames
(dark buttons in Light) because the pane was not repainting; computed styles
confirmed the correct Light values (`#dcdfea` secondary, `#eeeffd` pressed
segment, `#575aff` primary).

## Validation

Windows, Node 24.16.0, pnpm 10.20.0.

| Check                                                                 | Result                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node --experimental-strip-types --test frontend/__tests__/*.test.ts` | **447 passed, 0 failed, 0 skipped**                                                                                                                                                                                                                                                                                |
| New/updated tests                                                     | Toggle token contrast and saturation (Light/Dark), toggle focusability and `role=switch`, semantic-token guard (no error text on the fill token, no `turquoise`, no `var()` without `--`, device dot, MCP badge), Snapshot Details summary, lazy disclosure, `aria-pressed` selection driving Browse Changed Files |
| Test-first evidence                                                   | New toggle tests failed on the old styles ("Missing token", "visibility:hidden"); the updated Snapshot Details test failed before the component change; the guarded patterns exist in 9 files on `origin/main`                                                                                                     |
| `pnpm --filter @plutonhq/core-frontend exec tsc -b`                   | Passed                                                                                                                                                                                                                                                                                                             |
| `pnpm --filter @plutonhq/core-frontend build`                         | Passed (existing Browserslist and chunk-size warnings)                                                                                                                                                                                                                                                             |
| Docker `Dockerfile.source` builds of `04f5f2d` and the branch         | Passed; both containers healthy                                                                                                                                                                                                                                                                                    |
| Full frontend ESLint                                                  | Pre-existing configuration failure (string `eslint-config-prettier` in `extends`), unchanged                                                                                                                                                                                                                       |
| Targeted ESLint, temporary corrected config outside Git               | Per-file rule counts for all 17 changed TS/TSX files are identical to `origin/main` (the remaining findings are the existing `object-curly-newline` vs Prettier baseline)                                                                                                                                          |
| Prettier on changed files                                             | Clean, except `SnapshotBrowserDirectories.tsx`, already non-conformant on `main` and not reformatted                                                                                                                                                                                                               |
| `git diff --check`                                                    | Passed                                                                                                                                                                                                                                                                                                             |
| Backend tests                                                         | Not run: no backend file changed                                                                                                                                                                                                                                                                                   |

Accessibility checks performed: keyboard Tab/Shift+Tab to a switch,
`:focus-visible`, `role=switch`, `aria-pressed`, `aria-expanded` +
`aria-controls`, `aria-current` on breadcrumbs, accessible names on icon-only
buttons. Reduced motion stays covered by the existing global rule. This is not
a WCAG certification.

Responsive checks (measured in the `after` container, no document-wide
horizontal overflow at any width):

| Viewport  | Plan page `scrollWidth` | Browse Snapshot dialog | Snapshot Details dialog |
| --------- | ----------------------- | ---------------------- | ----------------------- |
| 390x844   | 390                     | 374 px wide            | not measured            |
| 1366x768  | 1351 (scrollbar)        | 1229x645 (90vw)        | 880x645                 |
| 1440x900  | visual check only       | visual check           | visual check            |
| 1920x1080 | 1920                    | 1400x907 (max width)   | 880x907                 |

Dialog sizes match the unchanged modal classes. 1366 and 1920 were measured,
not visually reviewed.

## Scope confirmation

Purple branding, dashboard structure, modal dimensions and functional
behaviour are preserved. No backend, security, API or production change.
No migration. No Agent update or re-enrollment. Server-only frontend asset
change: deploying the new image is sufficient.

## Changed-file inventory

Commits (oldest first): `2d5821e` theme tokens and toggles, `270ed02`
accessible names and focus reveal, `ba711db` Browse Snapshot / Snapshot
Details, `7ace756` local status line, `e96fc79` synthetic preview data, then
this report.

Theme tokens and toggles:

- `frontend/src/styles/global.scss`
- `frontend/src/components/common/form/Toggle/Toggle.module.scss`
- `frontend/src/components/common/form/Toggle/Toggle.tsx`
- `frontend/src/components/common/Icon/Icon.tsx`
- `frontend/src/components/Device/DeviceItem/DeviceItem.module.scss`
- `frontend/src/routes/DeviceSingle/DeviceSingle.module.scss`
- `frontend/src/routes/Mcp/Mcp.module.scss`
- `frontend/src/components/Plan/BackupEvents/BackupEvents.module.scss`
- `frontend/src/components/Plan/BackupProgress/BackupProgress.module.scss`
- `frontend/src/components/Plan/EditPlan/EditPlan.module.scss`
- `frontend/src/components/Plan/Mirrors/MirrorDetails.module.scss`
- `frontend/src/components/Plan/PlanItems/PlanItem.module.scss`
- `frontend/src/components/Plan/PlanSettings/PlanReplicationSettings.module.scss`
- `frontend/src/components/Settings/SelfBackupSettings/SelfBackupSettings.module.scss`

Accessible names and keyboard focus:

- `frontend/src/components/common/SidePanel/SidePanel.tsx`
- `frontend/src/components/Restore/RestoreWizard/RestoreWizard.tsx`
- `frontend/src/components/Restore/RestoreChangeViewer/RestoreChangeViewer.tsx`
- `frontend/src/components/Storage/StorageFileBrowser/StorageFileBrowser.tsx`
- `frontend/src/components/Storage/StorageFileBrowser/StorageFileBrowser.module.scss`
- `frontend/src/components/common/FolderPicker/FolderPicker.tsx`
- `frontend/src/components/common/PathPicker/PathPicker.tsx`
- `frontend/src/components/Plan/PlanSettings/PlanScriptsSettings.tsx`
- `frontend/src/components/Plan/Restores/Restores.tsx`
- `frontend/src/components/common/form/PasswordField/PasswordField.tsx`
- `frontend/src/components/common/LogViewer/LogViewer.tsx`
- `frontend/src/components/Plan/PlanStorageInfo/PlanStorageInfo.module.scss`

Browse Snapshot and Snapshot Details:

- `frontend/src/components/Plan/Backups/SnapshotDetails.tsx`
- `frontend/src/components/Plan/SnapshotViewer/SnapshotExplorerModal.tsx`
- `frontend/src/components/Plan/SnapshotViewer/ManagedSnapshotViewer.tsx`
- `frontend/src/components/Plan/SnapshotViewer/SnapshotViewerFile.tsx`
- `frontend/src/components/Plan/SnapshotViewer/SnapshotReview.module.scss`
- `frontend/src/components/common/SnapshotBrowser/SnapshotBrowser.module.scss`
- `frontend/src/components/common/SnapshotBrowser/SnapshotBrowserDirectories.tsx`

Tests, fixture and report:

- `frontend/__tests__/themeStyles.test.ts`
- `frontend/__tests__/snapshotReview.test.ts`
- `frontend/__tests__/theme-preview/app.tsx`
- `docs/UI_UX_CONSISTENCY_POLISH.md`

## Operator UAT (Chrome)

Deploy the reviewed image by digest as usual, close old Pluton tabs so the new
service worker serves the new assets, then check in both Dark and Light:

1. Plan → Edit → Advanced → Notification → expand "Existing community
   notification settings": OFF switches are grey. General: ON switches are
   purple, Encryption is faded (disabled). Press Tab to reach "Compress Source
   Files": a focus ring appears. Close without saving.
2. Backups row menu → Browse: header shows identifiers as chips; folder rows
   align; the selected folder has an accent edge; long names end with "…" and
   show the full path on hover.
3. Backups row menu → View Details: Close is a button; on a managed remote
   plan, Compare with previous → summary tiles; choose Deleted → Browse Changed
   Files opens the tree filtered to deleted entries; Detailed changes opens a
   paged list of 50.
4. MCP page: Enabled/Disabled badges are readable in Dark. Machines page: the
   connected dot is green-teal, a disconnected dot is grey.

If something looks wrong, record only: page, theme, browser width and a
screenshot without hostnames or identifiers.

## Rollback

Deploy the previous image digest (frontend assets only, no schema or data
change), or revert commits `e96fc79`, `7ace756`, `ba711db`, `270ed02`,
`2d5821e` and this report.

## Limitations and follow-up recommendations

- The managed (remote Agent) Browse Snapshot comparison bar was verified by
  unit tests only: local Docker plans use the local viewer, and the synthetic
  preview has no managed-browse fixture. Snapshot Details comparison was
  verified visually in the synthetic preview.
- "Edit Plan with Replication" was not rendered: it needs an HCP S3 storage.
  Toggles were checked in the Advanced tab instead.
- Not implemented (larger or functional, separate tasks):
  - Select/MultiSelect/StorageProviderSelect/TimePicker caret buttons have no
    `type="button"` and could submit an enclosing form; they also lack names.
  - FileManager and RestoreFileSelector selection toggles need `aria-pressed`
    and names; RadioIconSelect, Tristate, Select options and PlanSizeChart
    ranges are clickable elements without role/tabindex; the backup title edit
    icon is a mouse-only `span`.
  - Skeleton shimmer sweeps a white band over Dark surfaces; the tertiary
    button hover (`brightness(0.95)`) is nearly invisible in Dark; the modal
    close button rotates on hover and dialogs use an overshooting easing.
  - `--shadow-color` is unused; `--primary-color-mid` has no Dark value.
  - Fix the frontend ESLint loader (import the `eslint-config-prettier` object)
    and resolve the `object-curly-newline`/Prettier conflict.
  - A shared copy-to-clipboard control for identifiers.
