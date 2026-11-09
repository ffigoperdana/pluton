# Reliable Download browser delivery

## Confirmed source defect

The production PWA configuration in `frontend/vite.config.ts` excluded `/docs`
from Workbox's navigation fallback, but allowed `/api`. A controlled browser
navigation to an export's `/link` therefore received cached `index.html` instead
of reaching Express. React then rendered its missing-page route at the API URL.
The same shared Ready component is used by the backup modal and floating tracker.

A disposable Chrome profile, the generated production Workbox worker, real React
components and real export controller/service reproduced the failure: **zero
`/link` or `/content` requests reached the server**. After excluding the API
namespace, the same browser followed **303 -> same-origin `/content` -> 200** and
saved the complete synthetic TAR with matching size and SHA-256.

Workbox's navigation fallback matches document navigation, not ordinary fetch
requests. This explains successful HEAD and Range fetches alongside a failing
anchor click. A manual fetch's `opaqueredirect`/status 0 alone cannot reveal the
redirect destination. No production browser, ingress or HCP was accessed; an
additional ingress issue in a particular deployment remains an operator check.
No WAF change is justified by this reproduction.

## Small runtime changes

- Exclude all `/api` navigation, case-insensitively with a namespace boundary,
  from the PWA shell. Retain documentation and ordinary application routing.
- The Ready button now requests the existing job's authorization once, validates
  its immutable size/hash and proxy URL, and checks authenticated HEAD metadata.
  It then delegates the transfer to the browser using a temporary download
  anchor. No TAR fetch/blob or whole-file frontend buffer is introduced.
- Authorization and HEAD refuse redirects and HTML. Known refusal reasons,
  session/permission errors, rate limiting and gateway failures appear in the
  modal. Malformed grants are permanent protocol errors. There is no automatic
  authorization retry or export admission. Concurrent clicks share a guard;
  unmount/job changes abort pending initiation and discard stale grants.
- The UI says **Download requested**, explicitly deferring transfer progress and
  errors to the browser. Neither authorization nor HEAD proves completed delivery.
  A GET can still fail after HEAD; a regression verifies that this leaves the app
  open without claiming a completed browser transfer. Use the browser Downloads
  page for these later errors, then explicitly retry after checking the cause.
- Get or renew resume link remains an explicit action for the same Ready object.

The backend redirect, authentication, status, authorization and streaming code
were inspected and remain unchanged. `/link` still authorizes independently and
returns a private, non-cacheable 303. `/content` rechecks owner, expiration,
configuration/isolation and object identity; HEAD returns metadata only. GET
retains streaming/backpressure, GCM decryption, full-response SHA-256, exact byte
counts and identity revalidation. Range, If-Range and 416 remain unchanged.
Preflight GO, publication, ownership journals, keyring, retention and cleanup are
unchanged. No database, configuration, Agent or deployment migration is needed.

## Intermittent 409

The supplied production 409 has no recorded reason. It cannot establish a storage
or provider defect. Existing policy can refuse unavailable storage, object/binding
mismatch, expiration, or local keyring recovery; concurrency saturation uses 429.
A controlled identity/storage failure returns 409 `storage-unavailable`, retains
the Ready job, and a subsequent explicit authorization succeeds. The regression
also covers exact owner refusal, invalid/expired sessions and expired exports.
Capture only HTTP status and the allowlisted `reason` for the next rejection;
never share cookies, signed URLs, raw responses or object/provider identities.

## Local acceptance

Use pinned pnpm and Node 24.22.1. These commands use synthetic disposable data:

```sh
pnpm --filter @plutonhq/core-backend test --runInBand ManagedExportService spaFallback
node --experimental-strip-types --test frontend/__tests__/*.test.ts
pnpm --filter @plutonhq/core-frontend build
node scripts/validate-reliable-browser.mjs
```

The browser runner requires local Chrome/Chromium. Windows defaults to the standard
Chrome installation; Linux defaults to `/usr/bin/chromium`. Set `CHROME_PATH` to
another installed Chromium binary. It launches its own headless process/profile,
binds the fixture to random loopback only, blocks external hostname resolution,
uses an isolated SQLite journal and generated fixture session, and removes its
own resources. It does not start Pluton against existing data. The storage adapter
is synthetic; this browser boundary test is not a real HCP compatibility probe.
Encryption and provider protocol tests independently cover that boundary.

The runner checks the actual production `frontend/dist/sw.js`, not a hand-written
replacement worker. UI fixture bundling uses the real Ready component, floating
tracker, manager, provider and missing-page component. It checks a real browser
saved file, navigation redirect chain, HEAD, Range/resume, If-Range, 416, refresh,
duplicate clicks, 409 reasons, expiry, session/permission errors, rate limiting,
HTML, ingress redirects and a native GET failure after successful HEAD. No export,
inventory or provider preflight POST is permitted by the acceptance assertions.
`--expect-baseline-failure` is only for a deliberately supplied old frontend build:
it requires a controlled navigation to return React 404 without hitting the API.

The full frontend ESLint command has an existing config-loader failure: the string
`eslint-config-prettier` in `tseslint.config()` is rejected. Record it separately;
do not disable rules. Changed UI runtime files are additionally checked with the
same rules using a temporary loader adapter resolving that installed config object.

Local results for this patch:

| Check | Result |
| --- | --- |
| Complete serial Windows backend | 220 suites; 4,581 pass, four inherited skips |
| Complete frontend | 425 pass |
| Linux export/security/routing (read-only, non-root, two CPUs / 4 GiB) | 13 suites; 410 pass, no skips |
| Actual Chrome with production Workbox | PASS, repeated; includes public assets extracted from the final built image |
| Deployment/release/Compose guards | 24 pass |
| Disposable Linux deployment acceptance | 19 pass: upgrade, reapply, explicit/automatic rollback, SQLite and mount preservation |
| Backend lint and both backend/frontend type checks | PASS |
| Changed frontend runtime files under existing lint rules | PASS; separate full-lint baseline above |
| Production frontend/backend source image build | PASS |
| Non-root read-only final runtime artifact inspection | PASS, 1,841 entries; no test fixtures or local state |

Hosted CI, production ingress behavior and a real HCP download remain unverified
until the operator publishes and performs approved UAT. Browser fixtures establish
the application/service-worker boundary, not a live provider or WAF verdict.

## Operator UAT, only after approved rollout

1. Publish/review the local commit and run hosted CI. Deploy only through the
   normal approved immutable-image process, retaining the previous digest.
2. Confirm the new service worker is active. Existing tabs may still be controlled
   by an old worker until its update/reload completes; close and reopen old Pluton
   tabs if necessary. Check Application -> Service Workers and Network locally.
   Do not disable the WAF, TLS, authentication or service-worker security.
3. Sign in normally and use the tracker to rediscover the existing owner-bound
   Ready export by GET. If still valid, it requires no new export or preflight.
   If genuinely expired, stop: creating a replacement is a separate explicit UAT
   action subject to the unchanged readiness/security contract.
4. Click Download Verified TAR once. For the updated button expect one
   authorization POST, a same-origin HEAD and a native GET `/content`. For a
   direct existing `/link`, expect 303 to the exact same-origin content route.
   No API document should be served from the service-worker app-shell cache.
5. Check full response 200, TAR Content-Type, attachment disposition, byte length,
   Accept-Ranges and download completion in the browser. Compare completed file
   length and SHA-256 to the existing verified summary. For example, locally:
   `Get-FileHash -LiteralPath 'C:\UAT\backup-example.tar' -Algorithm SHA256`.
6. Test resume explicitly with the existing authorized Range mechanism. Expect
   206 and correct Content-Range/length; invalid ranges remain 416. Refreshing the
   app must retain the server Ready job; it does not resume a browser transfer by
   itself. Never treat server Ready or HEAD success as browser completion.
7. On refusal, retain only sanitized status/reason and whether the failing request
   was authorization, HEAD or GET. No blind retries, new preflight, object deletion
   or namespace/IAM changes. A gateway redirect/HTML needs operator routing/session
   investigation; a mismatched object stays fail-closed.

Rollback uses the normal approved previous compatible image and existing rollback
procedure. Retain the application volume, export journal, private keyring and CA.
Do not restore an older SQLite snapshot, delete objects, edit ownership evidence
or re-run preflight as rollback. The earlier image may reintroduce this PWA bug;
Standard Download retains its existing independent behavior.

## Files changed

- `frontend/vite.config.ts`
- `frontend/src/utils/reliableDownload.ts`
- `frontend/src/components/Plan/Backups/ReliableDownload.tsx`
- `frontend/__tests__/pwaNavigation.test.ts`
- `frontend/__tests__/reliableDownload.test.ts`
- `frontend/__tests__/downloadPreparation.test.ts`
- `frontend/__tests__/downloadProgressUI.test.ts`
- `backend/__tests__/services/ManagedExportService.test.ts`
- `scripts/validate-reliable-browser.mjs`
- `docs/RELIABLE_BROWSER_DELIVERY.md`
