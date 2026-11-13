# Menus and notifications: one open dropdown, self-closing success toasts

Frontend only. No backend, migration, Agent or configuration change.

## Problems reported (13 Nov 2026)

1. Several dropdowns could be open at the same time (for example two row menus on Storages).
2. Success notifications ("Backup Plan Paused") stayed until each one was closed by hand and
   piled up when many plans were paused.
3. Move repository was only reachable from a hover button on the plan's Storage box.

## Root causes

1. Every menu kept its own open state (`useState`). Nothing closed other menus, and most menus did
   not close on an outside press.
2. `ToastContainer` in `App.tsx` had `autoClose={false}`, so every toast type waited for a click.
3. The relocation dialog had no menu entry.

## Changes

- `frontend/src/utils/exclusiveMenu.ts`, `frontend/src/hooks/useExclusiveMenu.ts`: opening a menu
  announces it on `window`; every other menu closes. A press outside the menu or Escape also closes
  it. Used by the row menus on Storages, Devices and Plans, the plan page menu, backup and restore
  row menus, and the form `Select` and `MultiSelect` dropdowns.
- `frontend/src/utils/toastDefaults.ts`, `App.tsx`: success, info and warning toasts close after
  3 seconds; at most 4 show at once (newest on top, the rest wait). **Errors still stay until
  closed**, including the error state of `toast.promise`, so their text can be read or reported. A
  call that sets its own `autoClose` keeps it.
- `PlanSingle.tsx`: **Move Repository** in the plan ⋮ menu (Remote Agent plans only), opening the
  same dialog as the Storage box button.

## Validation

| Check | Result |
| --- | --- |
| `node --experimental-strip-types --test frontend/__tests__/*.test.ts` | 487/487 (new: `exclusiveMenu.test.ts`) |
| New render test fails on the previous `Select` (two dropdowns open) and passes now | confirmed |
| `pnpm --filter @plutonhq/core-frontend exec tsc -b` | pass |
| ESLint on new files (temporary config with the known `eslint-config-prettier` loader fix) | clean; changed existing files show only findings already present on `main` |
| Production image build (`Dockerfile.source`, includes the frontend build) | pass |
| Local browser preview (synthetic data) | Move Repository in the ⋮ menu opens the dialog; opening a second Storages row menu closes the first; "Backup Plan Paused" closes by itself |

Not verified in a browser: an error toast staying open (covered by unit tests), the light theme.

## Rollback

Revert the commit or roll back the image. No data or schema is involved.
