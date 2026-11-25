# Rebranding (GoRecover)

This fork shows the product as **GoRecover** in the UI, emails and in-app
documentation. It is based on Pluton (`plutonhq/pluton`, Apache-2.0); the
license, copyright notices and the acknowledgements page
(`/docs/reference/acknowledgements`) keep saying so. The rebrand changes display
text and artwork only. It needs no data migration, and existing installations,
backups and Agents keep working unchanged.

## Where the brand lives

| Place | What |
| --- | --- |
| `frontend/src/utils/brand.ts` | `BRAND_NAME`, `APP_NAME` (overridable with `VITE_APP_NAME`) and the single-colour logo paths. `constants.ts` re-exports `APP_NAME`. |
| `backend/src/utils/brand.ts` | `BRAND_NAME` for emails, notifications, defaults and user-facing errors. |
| `frontend/src/components/common/Logo/Logo.tsx` | Renders the mark from `brand.ts` with `currentColor`, so it follows the theme like the old logo. |
| `frontend/public/brand/` | Logo sources: `gorecover-mark*.svg` (icon) and `gorecover-wordmark*.svg` (icon + name), each as colour, `-dark` (for dark backgrounds) and `-mono` (`currentColor`). The wordmark text is Inter Bold converted to outlines. |
| `frontend/public/favicon.png`, `frontend/public/icons/` | Raster icons rendered from the colour mark on a white tile (512 px is maskable-safe). |
| `frontend/index.html`, `documentation/index.html` | `%APP_NAME%`, filled by a small `transformIndexHtml` plugin in each `vite.config.ts`. |

Colours, theme tokens and layout are unchanged.

## What was rebranded

- Frontend: footer, page titles, login/setup, PWA manifest name, and about 60
  component and utility strings. "Pluton Agent" is shown as "Agent".
- Documentation site chrome (`documentation/src`) and the article prose in
  `frontend/src/docs/articles` (plus titles in `frontend/src/docs/manifest.ts`).
  Commands, paths, identifiers and code spans were not touched.
- Backend: default app title (`APP_TITLE`, setup default), TOTP issuer fallback,
  SMTP sender default, the email wrapper (`{{BRAND_NAME}}` in `email.html`),
  notification subjects/titles (`terminalPayload.ts`), self-backup messages and
  other errors that reach the UI.
- Deployment: the `APP_TITLE` default in `deploy/compose.yml`,
  `docker-compose.yml` and `deploy/.env.example`.

### App titles after an upgrade

Two separate titles appear in emails. Neither is migrated automatically:

| Title | Where it is set | Used by |
| --- | --- | --- |
| `APP_TITLE` environment variable | `.env` / compose (default now `GoRecover`) | Header of plan backup and replication emails, and the sentence in the test email and test ntfy message |
| App Instance Title | **Settings → General** (stored in the database, copied from `APP_TITLE` at first setup) | Test-email header, self-backup failure email, TOTP issuer for new 2FA enrolments |

An installation with `APP_TITLE=Pluton` in its `.env`, or set up before the
rebrand, keeps showing "Pluton" there until both are changed. The TOTP issuer
is only a label in the authenticator app; changing it does not invalidate
existing 2FA codes. SMTP sender names are stored per notification channel and
in the SMTP integration, so existing channels keep their old sender name until
edited. Mail filters that match the old `[Pluton]` subject prefix need updating.

## What intentionally keeps the Pluton name

These are data or protocol contracts. Renaming any of them breaks existing
backups, Agents, webhook receivers or stored state.

| Identifier | Why it stays |
| --- | --- |
| Restic tags `pluton-plan-*`, `pluton-backup-*` | Existing snapshots are found by tag. |
| Rclone remote `rclone:pluton:`, snapshot path `/pluton/database/` | Recorded in existing repositories and dump paths. |
| HKDF label `pluton-agent-command-secrets-v1` and HMAC contexts | Changing them breaks sealed secrets and signatures. |
| Webhook headers `X-Pluton-*`, `User-Agent: Pluton-Notifications/1` | Receivers verify these. |
| `pluton_recovery_guard` marker | Checked during database recovery. |
| `pluton-agent.service`, user `pluton-agent`, `/etc/pluton-agent`, `/opt/pluton-agent`, `/var/lib/pluton-agent` | Installed on hosts; Source Access ACLs are granted to this user. UI commands show the real names. |
| Env vars (`PLUTON_*`), Docker image name, data directory (`AppPaths.ts`), OS keyring service (`KeyringService.ts`) | Existing deployments and stored keys. |
| Cookie, localStorage/sessionStorage keys, BroadcastChannel and DOM event names, `window.pluton*` | Stored or shared browser state. |
| MCP server name `pluton`, tool names `pluton_*`, config key `mcp_servers.pluton`, `PLUTON_MCP_ACCESS_TOKEN`, `WWW-Authenticate` realm | Client configurations and protocol responses. |
| Package names `@plutonhq/*`, `PlutonEdition`, self-backup blob magic | Build and file-format identifiers. |
| CLI text in `cliSelfRestore.ts`, `cliPasswordReset.ts`, startup log, `.env` comment, self-backup blob errors | Operator CLI output, not UI. Left as is to reduce upstream conflicts. |
| "Pluton" in the acknowledgements page, "Pluton PRO/Business" and "upstream Pluton" in docs | Refer to the upstream project. |
| Code comments, test fixtures | Not user-visible. |
| `frontend/public/screenshots/*.png` | Upstream PWA screenshots still show the old logo; replace them with new captures from a synthetic install. |

## Upstream merges

Expect conflicts in the files above whenever upstream edits the same lines,
mainly: user-facing strings in components and `frontend/src/utils/*.ts`,
`frontend/src/docs/articles/**`, `frontend/src/docs/manifest.ts`, `Logo.tsx`,
`index.html`, `vite.config.ts` (frontend and documentation), `email.html`,
`BaseNotification.ts`, `terminalPayload.ts` and the backend messages listed in
"What was rebranded". Resolve them by keeping upstream's change and using
`APP_NAME` (frontend) or `BRAND_NAME` (backend) for the name. New upstream text
that says "Pluton" in the UI should be switched the same way. Before renaming a
lowercase `pluton` identifier, check the table above.
