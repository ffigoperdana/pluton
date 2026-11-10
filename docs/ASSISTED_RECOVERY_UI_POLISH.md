# Assisted Replica Recovery and Mirror Details UI polish

## Scope and execution

Part of branch `claude/ui-ux-consistency-polish` (the separate
`claude/assisted-recovery-ui` branch was fast-forwarded into it and deleted at
the owner's request). Local commits only: no push, pull request, merge,
deployment or production access. Frontend presentation only.

Unchanged: recovery business logic, approvals and their binding, polling,
cancellation, primary retry, staging, API contracts, backend, permissions and
security behaviour. All button labels, status texts and the native radio
inputs are kept, so the existing recovery tests exercise the same controls.

The review used the unslop skill (by Damir Sokolovsky, CC BY 4.0) in polish
mode with Pluton's existing tokens; no new colours, gradients or decoration.

## Audit (before state)

Reviewed in a synthetic preview of every recovery state (see Evidence).

| Finding                                                                                                                                                                        | Evidence                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `AssistedRecovery` had no stylesheet: all actions were unstyled text buttons; "Continue with S3 Replica" looked the same as "Retry Primary" and "Close".                       | Source (no `className`) and preview screenshots.  |
| Recovery metadata was a browser-default `<dl>` (indented values, no grouping); identifiers were plain text with inline `style={{ overflowWrap }}`.                             | Source lines with inline styles.                  |
| The status sentence (`recoveryStatus`) had the same weight as explanatory text, so "Awaiting your approval", "failed" and "completed" were not distinguishable at a glance.    | Preview.                                          |
| Replica choices were a browser-default `fieldset` with native radios and no selected/unavailable distinction beyond the radio itself.                                          | Preview.                                          |
| Mirror Details showed the recovery controls before the replica results, without separation; the retry button hard-coded `color: white` on hover; provider images had no `alt`. | `MirrorDetails.tsx`, `MirrorDetails.module.scss`. |
| Inside the Mirror Details modal, the recovery `<h3>` inherited the modal title style (`.modal .modalContent h3`, 17px), so a sub-section looked like a second dialog title.    | Computed style in the preview.                    |

## Implemented changes

`AssistedRecovery` (`AssistedRecovery.tsx`, new `AssistedRecovery.module.scss`):

- Header: section title (now `h4`, 15px under the 17px dialog title) and a
  muted context line with the backup ID as an identifier chip.
- Status: the `recoveryStatus` sentence becomes a status banner whose tone
  comes from a new pure helper `recoveryTone(job)` in
  `utils/assistedRecovery.ts`: checking/running = progress, awaiting
  approval and cleanup pending = attention, completed and primary-ready =
  success, failed and uncertain = error, cancelled = neutral. Cleanup pending
  outranks a finished status and is never shown as success. Text is unchanged,
  so colour never stands alone.
- Metadata: a two-column grid between hairlines; job and snapshot IDs as
  monospace chips.
- Replicas: each candidate is a bordered row; the selected one gets the
  primary border and `--primary-color-lighter`; unavailable ones are muted with
  a not-allowed cursor. The native radio is kept (accent colour, 16px).
- Actions: primary "Continue with S3 Replica" and "Check replica recovery";
  danger outline for "Cancel Recovery" / "Discard staged result"; secondary for
  "Retry Primary", "Refresh recovery status" and "Close". Same dialog button
  convention as elsewhere (4px radius, 0.75rem, 600).
- Alerts use the error tokens; explanatory paragraphs are smaller and muted;
  the manual path field uses `--field-bg` / `--field-line-color`; the footer
  (refresh, close, persistence note) is separated by a hairline.
- Inline style objects removed; `type="button"` on every action.

`MirrorDetails` (`MirrorDetails.tsx`, `MirrorDetails.module.scss`):

- Order: incomplete-redundancy notice (warning tone), retry note, replica
  results, then the recovery controls in a separated section.
- Replica rows: storage name emphasised, size/duration muted, status label
  coloured by state (completed, failed, in progress, pending), retry as a small
  secondary button using tokens, identifiers as chips, error box spacing on the
  4px grid, `alt=""` on the decorative provider image.
- Modal width (560px) and its scroll behaviour are unchanged.

## Follow-up: wizard frame, readable values, new-check label (`fb8af1f`)

- **Restore Wizard frame (proven):** in assisted mode `RestoreWizard`
  rendered `AssistedRecovery` directly inside its panel, without the wizard
  header, close button or padding, so the content touched the panel edge.
  The assisted step now uses the normal wizard header ("Restore Backup", the
  same close action as the panel's Close button) and a padded body that
  scrolls within the full-height panel.
- **Readable values:** `target` and `operation` already arrive as sentences
  from `AssistedRecoveryService` ("Isolated Pluton staging", "File/directory/SQL
  artifact staging (no database import)"). The earlier note naming
  `restore-files` / `private-staging` came from the synthetic preview data, not
  the backend. Phases (`primary-check`, `replica-check`,
  `staging-preparation`, `integrity-verified`, `staging-cleanup-pending`, ...),
  the primary state, audit events and diagnostic codes are kebab-case values.
  A new `recoveryLabel()` turns them into words mechanically
  (`staging-preparation` -> "Staging preparation"); nothing is re-interpreted.
  The exact value stays available: phase and primary state as a `title`,
  diagnostic and audit codes as a monospace chip next to the words.
- **Manual check under a finished job:** the form is still shown in exactly
  the same states (only blocking jobs hide it), so the workflow is unchanged.
  When an earlier job is shown it now carries the heading "Start a new replica
  check", so it no longer reads as an action on that job. With no earlier job
  there is no heading.
- Tests: readable phase/codes with the exact codes kept and no request started;
  no heading without an earlier job; mechanical `recoveryLabel`; wizard header
  and padded body. Full frontend suite **471 passed**.

## Evidence

Synthetic preview (fixture only, every mutation refused):
`node __tests__/theme-preview/server.mjs` in `frontend/`, then
`http://127.0.0.1:5188/__tests__/theme-preview/recovery.html`. It renders
checking, awaiting approval (one passed and one unavailable replica), running,
completed, failed, cleanup pending and uncertain, plus Mirror Details, in both
themes. Screenshots were reviewed in the desktop app's browser pane, not
committed.

Measured after the change: status tones per state as listed above (computed
banner backgrounds in Dark: progress `#222631`, attention `#3a301d`, success
`#173830`, error `#342424`); button classes per state were the expected
primary/danger/secondary; Mirror Details order `mirrorList -> recovery`;
inner heading 15px vs dialog title 17px; at 390px no document-wide overflow
and no horizontal scroll inside the 351px dialog.

## Validation

| Check                                                                 | Result                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --experimental-strip-types --test frontend/__tests__/*.test.ts` | **471 passed, 0 failed** (465 before `fb8af1f`)                                                                                                                                                                                                                     |
| New `recoveryPresentation.test.ts`                                    | Tone for every state including cleanup pending; themed module, no inline styles, primary approval action, replica rows, token-only stylesheets; Mirror Details order, `alt`, no fixed colours. Failed before the change (missing helper, then contract assertions). |
| `assistedRecovery.test.ts` (existing behaviour)                       | Passes unchanged in its assertions; its esbuild setup gained the same `.scss` stub other UI tests use, because the component now imports a stylesheet                                                                                                               |
| `pnpm --filter @plutonhq/core-frontend exec tsc -b`                   | Passed                                                                                                                                                                                                                                                              |
| `pnpm --filter @plutonhq/core-frontend build`                         | Passed                                                                                                                                                                                                                                                              |
| Targeted ESLint (temporary corrected config)                          | Identical per-file findings to `origin/main` for `AssistedRecovery.tsx`, `MirrorDetails.tsx` and `utils/assistedRecovery.ts`                                                                                                                                        |
| Prettier on changed files, `git diff --check`                         | Clean                                                                                                                                                                                                                                                               |

## Changed files

- `frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.tsx`
- `frontend/src/components/Restore/AssistedRecovery/AssistedRecovery.module.scss` (new)
- `frontend/src/utils/assistedRecovery.ts` (`recoveryTone`, presentation only)
- `frontend/src/components/Plan/Mirrors/MirrorDetails.tsx`
- `frontend/src/components/Plan/Mirrors/MirrorDetails.module.scss`
- `frontend/src/components/Restore/RestoreWizard/RestoreWizard.tsx` and `RestoreWizard.module.scss` (assisted frame)
- `frontend/__tests__/recoveryPresentation.test.ts` (new)
- `frontend/__tests__/assistedRecovery.test.ts` (`.scss` stub only)
- `frontend/__tests__/theme-preview/recovery.html`, `recovery.tsx` (new synthetic preview)
- `docs/ASSISTED_RECOVERY_UI_POLISH.md`

No migration, no Agent update, no backend change. Deploying the frontend image
is sufficient.

## Operator UAT (Chrome)

1. On a managed plan with Assisted Failover, open a backup's mirror badge →
   Mirror Details: replica results come first, then the recovery section; a
   failed replica shows a coloured status and a Retry button.
2. Open Restore for a backup whose primary is unavailable: the status banner is
   amber while awaiting approval, the verified replica row is highlighted when
   selected, "Continue with S3 Replica" is the only purple button.
3. Check the same in Light mode; do not approve or cancel unless that is the
   intended operation.

Record only the state name, theme, width and a screenshot without identifiers
if something looks wrong.

## Rollback

Revert `fb8af1f` and `0cb2475` (newest first; frontend only), or deploy the
previous image. They can be reverted without touching the rest of the branch.

## Remaining inconsistencies (not changed here)

- The audit history is a plain list with local times only (no date or zone).
- Other dialogs still use `.modalButton` or local button styles; a shared
  dialog button component would remove the remaining per-feature copies.
