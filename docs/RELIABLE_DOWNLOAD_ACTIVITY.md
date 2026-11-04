# Reliable Download admission, readiness and background activity

Base: fetched main `407b1ba` (including PR #64).
Branch: `codex/reliable-download-global-activity`.

## Confirmed cause and scope

The existing configuration endpoint reports static configuration, including
enabled/configured, shared namespace, application encryption and keyring presence.
Those flags do not prove a fresh capability preflight GO.

For shared destinations, `ManagedExportService.admit()` checks local isolation
and then `proven()` before snapshot/source access or durable admission.
The most recent matching preflight must be Ready, cleaned, unexpired, bound to
the current destination/credentials/CA/keyring capability, contain provider
evidence and the mandatory cleanup/encryption/authenticated-readback checks.
A newer failed preflight supersedes an earlier successful one. These conditions
are preserved through the extracted `exportProofValid()` predicate.

Failure throws `TemporaryExportError('security-capability-missing')`.
The actual controller returns HTTP **409**, `success:false` and that reason.
The previous frontend converted it to a plain Error, discarded status/retry
classification and treated every error as transport failure. Its hook scheduled
another poll; without a job ID, that poll repeated **POST** admission. Its panel
showed reconnecting and zero counters despite there being no admitted export.
The previous navigation hints lived in a module Map and disappeared on reload.

The deterministic controller reproduction uses an application-encrypted shared
configuration with a configured keyring and no GO. It verifies HTTP 409, no job
creation, no source read and no provider call. A fresh synthetic GO permits
admission; duplicate requests return the same durable identity. Expiry, including
the journal's Expired state, supersession and binding changes refuse admission.
This establishes the implementation cause. It does **not** establish which GO
condition failed on a particular live installation; the new read-only summary
provides that evidence. No production request, HCP probe or throughput measurement
was performed. Throughput is not a diagnosis for a request denied before admission.

## API and state architecture

Two additive administrator-cookie GET routes use `exportOwner()` and reject
query/body overrides:

| Route | Data and effects |
| --- | --- |
| `GET /api/managed-exports/readiness` | Parse configured settings/keyring and project existing local preflight journal evidence only |
| `GET /api/managed-exports/activity` | Same readiness plus at most 64 retained archive jobs belonging to the authenticated owner, with backup/mode and existing safe progress/proof projection |

Neither route invokes the provider factory, source binding resolution, inventory,
preflight, cleanup, admission, worker scheduling or namespace reservation.
The old isolation callback can reserve a local namespace, so the GET routes do
not call it. The response explicitly says `isolation:rechecked-at-admission`.
The stored preflight GO is evidence of that completed probe, not a promise that
a future admission succeeds. The existing admission and download/cancellation
endpoints retain all fresh isolation, binding, identity and authorization checks.
An owner can inspect their historical job even if its backup is now unavailable;
this does not grant access to download or delete it.

Readiness distinguishes missing, expired, superseded or running preflight,
pending cleanup, failed checks, destination/capability mismatch and configuration
failure when journal evidence permits. Only the requesting owner's latest
preflight ID/diagnostics are projected. Failure categories, operations and HTTP
status are allowlisted; credentials, provider bodies, endpoints, object keys,
ETags, private manifests/key material and signed URLs are excluded.
Global readiness can reflect a destination's operator GO without exposing
another owner's preflight identity or archive inventory.

`ExportActivityProvider` lives inside authenticated `ProtectedLayout`, around
the application and outside route-specific modals. Its manager is independent
of any selected page/modal. It starts by fetching the owner-authorized activity
list, including after Ctrl+R and re-login. It stores no persistent job cache,
credentials, proofs or links. Existing bounded tab-local navigation hints only
select an ID already present in the server-authorized list.

The bottom-right Exports button opens a compact list of queued/active, ready,
failed, expired/cancelled and cleanup-pending records. Selecting a row opens the
correct backup/mode/job. Its label refers to server archive preparation, not a
browser transfer. Closing/navigating never sends cancellation. Ready means the
server archive is verified, not that a laptop received the file.

Only the explicit **Prepare Reliable Download** action may POST admission.
Opening a panel, restoring a row, focusing, refreshing or reconnecting performs
GET discovery. Before deliberate admission the manager rechecks existing jobs
and readiness. A local pending-action guard prevents double clicks. The existing
transactional server admission prevents duplicate active/ready jobs when tabs race.
A lost POST response triggers GET reconciliation and never automatic POST replay.
If the first GET arrives before the server commits, up to 30 seconds of bounded
GET reconciliation can discover the new identity. Uncertainty itself never adds
a job or running progress; polling stops when confirmed or that window expires.
Creating a new export after expiry/failure remains deliberate.

Polling has one outstanding discovery read per app manager, a 30-second read
deadline, and timers scheduled after completion. Active/cleanup records poll
every two seconds; failures use exponential backoff capped at 30 seconds and
honor bounded Retry-After (up to one day). Terminal jobs without cleanup stop
polling; Ready records schedule one expiry refresh. Manual focus, cross-tab
invalidation and explicit status checks remain GET-only. Revision/epoch guards
discard reads that predate confirmed actions or an authentication lifecycle change.
Cancellation/authorization are explicit and never automatically retried.

Cross-tab messages contain only `refresh` or `session-changed`, never job data,
owner IDs or secrets. They invalidate local state and re-read the server; they
cannot inject a job or establish ownership. Login/logout resets the manager;
401/403 clears owner data and stops retries. Without BroadcastChannel, focus
rediscovery and active polling still work.
Focus/tab invalidations also invalidate any older in-flight GET: its result is
discarded and a fresh GET follows. A delayed Ready response cannot undo another
tab's confirmed cancellation or suppress its rediscovery until export expiry.

## Error behavior and progress

| Response | UI / retry |
| --- | --- |
| Known preflight/configuration/isolation/identity/quota/queue policy reason | Actionable refusal; no automatic admission retry, even for a 503/429 policy response |
| 401 | Session expired; clear owner activity and sign in again |
| 403 | Permission/access-gateway problem; clear owner activity, no automatic retry |
| 405 | Method/route/gateway problem; show HTTP status, no automatic retry |
| 429 without a known policy reason | Rate limiting; GET backoff and Retry-After |
| Network interruption, timeout, transient 5xx | Retain confirmed job evidence and retry GET with bounded backoff |
| Invalid successful JSON/identity/proof | Protocol error; fail closed and require explicit status check |
| Non-JSON/WAF response | Preserve safe HTTP classification, discard raw body; never display provider HTML |

A denied/unadmitted export has a readiness view with **no progress bar, zero-byte
counters, elapsed-running clock or fake job**. The view differentiates configured
settings from preflight GO and explains operator action. Once admitted, preparation
is indeterminate until a verified total exists. Upload percentage remains at most
99 until Ready with verified integrity. Existing AES-256-GCM, authenticated
manifests, exact ownership/readback/SHA-256, HCP write-once publication and
authorized Range delivery remain unchanged.

## Safe operator recovery and UAT

These are operator instructions, not actions performed by the coding agent.

1. Publish/review the branch and require hosted Backend Test and Container Image
   workflows to complete. Preserve the existing approved image digest, app
   volume/export journal and full private keyring. This patch adds no database
   migration, environment variable or Compose change.
2. Deploy only the approved immutable image using the existing
   `sh deploy.sh sha256:<approved-digest>` procedure. Avoid restarting a live
   export unnecessarily. Ready records and keys must be retained.
3. Sign in as the original owner. Open Reliable Download on the selected
   completed backup. With no valid GO, confirm configured settings are distinct
   from NO-GO, an actionable reason appears, and no running bar is shown.
   In the browser Network panel, opening/refreshing/reconnecting must perform
   GET activity checks and no admission/preflight/inventory POST.
4. Read `GET /api/managed-exports/readiness` and the original owner's
   `GET /api/managed-exports/preflights/<existing-id>` first. These read only
   local evidence. Keep screenshots/logs free of cookies and private identifiers.
   A configured=true response alone is not authorization to export.
5. If needed, an operator may explicitly authorize the existing terminal
   preflight's read-only provider diagnostic endpoint. Follow
   [the cleanup diagnostic procedure](HCP_PREFLIGHT_CLEANUP_DIAGNOSTICS.md) and
   [versioning diagnosis](HCP_CLEANUP_VERSIONING_DIAGNOSTICS.md).
   That optional GET can inspect HCP metadata but does not establish GO or
   ownership. The activity manager never invokes it automatically.
6. Resolve uncertain cleanup with the established owner-bound recovery procedure.
   A matching key/HEAD is never deletion authority. Do not delete prefixes,
   adopt unknown objects, clear journals or alter versioning, overwrite, retention,
   namespace, TLS, encryption or IAM settings merely to obtain GO.
7. Only after reviewing isolation and cleanup may the operator explicitly approve
   an inventory check and disposable capability preflight through the existing
   operator endpoints:
   `POST /api/managed-exports/inventory-checks`, then, when safe,
   `POST /api/managed-exports/preflights`, each with the existing empty JSON
   body and same-origin authenticated session. Inventory is read-only remotely;
   capability preflight writes random disposable objects and verifies cleanup.
   Poll their specific GET status routes. Every mandatory gate must pass and
   cleanup must be verified before treating the resulting destination-bound,
   unexpired, most-recent result as GO. No real backup is uploaded by these probes.
8. Click **Check readiness and existing jobs**. Once fresh GO is reported,
   deliberately prepare an approximately 120-MB archive. Close its modal and
   navigate to another page: Exports should retain the admitted job. Refresh,
   open another tab, and sign out/in: GET rediscovery must recover only the
   currently authenticated owner's existing rows. Double-click Prepare and
   simultaneous tabs must not create duplicate active jobs for the same binding.
9. Briefly interrupt only the browser connection. Counters remain at the last
   confirmed value and GET retries back off. On 401/403, the UI must show an access
   problem and clear owner data. Do not disrupt the server's HCP/repository path.
10. When Ready, download and verify TAR size and SHA-256. Test interrupted/resumed
    browser/client delivery using the existing authenticated Range mechanisms.
    Refreshing the browser does not cancel server preparation, and resuming the
    browser transfer never regenerates an export. Ready still requires server
    authorization, object identity and expiry checks on every download.
11. Test cancellation separately: opening the confirmation or choosing Keep export
    sends no DELETE. Explicit confirmation sends one cancellation request.
    A failed request remains actionable; it is never retried automatically.
    Pending cleanup stays visible and keeps polling until verified clear.
12. Verify Standard Download, staged Restore, scheduled backup, Agent and replication
    through their normal checks. This patch changes none of their storage protocols
    or configuration.

Rollback uses the existing `sh rollback.sh` to the recorded format-v1-capable
image. Keep the app volume, jobs.sqlite, private manifests and all retained
keyring slots. Never restore an older SQLite file or disable exports to make a
rollback look successful. Rolling back the frontend also restores its old
recovery/error UX; server jobs remain in the journal.

## Validation and limitations

Local validation (2026-11-04, Node 24, pinned pnpm 10.20.0):

| Check | Result |
| --- | --- |
| Complete serial backend | 219 suites, 4,559 passing, four inherited platform skips; exit 0 |
| Final readiness/admission/authorization regression | 36 passing, including no-GO 409, fresh encrypted GO, expiry/supersession, duplicate identity and restart recovery |
| Linux HCP/security/recovery suite | 16 suites, 581 passing, one inherited platform skip; 2 CPUs / 4 GiB, no external network |
| Complete frontend | 403 passing; no skips |
| Final activity/lifecycle regressions | 36 passing, including no fake job/bar, delayed durable admission after a lost response, navigation, owner reset/re-login, stale responses, cross-tab invalidation during an older GET, transient backoff and Retry-After |
| Backend lint | Pass |
| Backend and frontend type checks | Pass |
| API inventory / deployment / Compose / release guards | 25 passing |
| Linux deployment policy | 46 passing |
| Production image | Frontend/docs/backend build passes; read-only non-root release check passes for 1,837 entries |
| Disposable Linux deployment acceptance | All 19 scenarios pass; fixture resources removed |

Relevant commands:

```sh
pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend test --runInBand ManagedExportService
node --experimental-strip-types --test frontend/__tests__/*.test.ts
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-frontend exec tsc -b
node --test scripts/__tests__/apiInventory.test.mjs scripts/__tests__/deployment.test.cjs scripts/__tests__/managedExportCompose.test.cjs scripts/__tests__/runtimeReleaseBoundaries.test.cjs
```

Windows-native backend tests and disposable Linux tests use only synthetic local
fixtures. `scripts/validate-managed-resumable-unit.ps1` runs the Linux suite using
the existing native fixture image. The production build used
`docker build -f Dockerfile.source -t pluton-export-activity:local --build-arg APP_VERSION=export-activity-validation --build-arg VCS_REF=407b1ba .`.
`scripts/validate-deployment.ps1 -Image pluton-export-activity:local` verified real
application/SQLite startup, idempotency, host-bundle upgrade, config reapply,
explicit/automatic rollback and mount/data preservation. It did not deploy to
production. The final authentication-service edit retains main's existing
formatting and adds only session invalidation calls.

The original frontend lint command remains blocked before scanning files:
`tseslint.config()` rejects the existing string `eslint-config-prettier` in
`extends`. Resolving that string to its installed config object in a temporary,
removed adapter verifies the new/changed activity runtime files without errors
or warnings. Two existing integration files (router and auth service) retain
eight `no-explicit-any` errors independently reproduced from main; their new
changes add no any casts. This is not a full-frontend lint pass. No rule, CI
gate or assertion was weakened, and no existing test was newly skipped. The initial Docker build
attempt lost its engine connection (BuildKit RPC EOF); rebuilding succeeded.

Hosted CI and browser visual/assistive-technology inspection have not run.
The component tests exercise real React DOM/JSDOM, modal keyboard semantics and
reduced-motion CSS; they do not constitute a full browser visual measurement.
Native encryption/Range/cleanup regressions ran; this task does not repeat a
live HCP performance test or attribute the admission failure to throughput.
No production deployment, live HCP probe, push or hosted CI run is part of this
local change. Local protocol fixture success is not HCP certification. Actual
GO status must be determined from the operator's current authorized response.

## Exact changed files

| Files | Purpose |
| --- | --- |
| `backend/src/utils/managedExport/ExportReadiness.ts` | Existing proof predicate and safe local-journal readiness classification |
| `backend/src/services/ManagedExportService.ts` | Read-only owner activity and readiness projections |
| `backend/src/controllers/ManagedExportController.ts`, `backend/src/routes/managedExportPreflight.ts` | Authenticated GET endpoints and no-override/cache boundaries |
| `backend/__tests__/services/ManagedExportService.test.ts` | Real controller 409/GO, cookie ownership, durable discovery, expiry, supersession and no-provider/reservation effects |
| `frontend/src/utils/downloadFailure.ts`, `frontend/src/utils/reliableDownload.ts` | Typed safe policy/auth/transport failures, bounded response parsing and shared proof validation |
| `frontend/src/utils/exportActivity.ts` | Authenticated global GET discovery, admission/cancel guards, backoff and stale-response handling |
| `frontend/src/utils/exportSession.ts`, `frontend/src/services/users.ts` | Secret-free login/logout invalidation |
| `frontend/src/context/ExportActivityContext.tsx`, `frontend/src/hooks/useExportActivity.ts`, `frontend/src/router.tsx` | Manager lifetime above route modals, session/focus/tab invalidation and authenticated mounting |
| `frontend/src/components/App/ExportActivity/ExportActivity.tsx`, `frontend/src/components/App/ExportActivity/ExportActivity.module.scss` | Floating accessible activity list and exact job detail recovery |
| `frontend/src/components/Plan/Backups/ReliableDownload.tsx`, `frontend/src/hooks/useDownloadJob.ts` | Actionable NO-GO view, explicit admission and retained verified progress; typed permanent-error guard |
| `frontend/__tests__/downloadActivityFixture.mjs`, `frontend/__tests__/exportActivity.test.ts`, `frontend/__tests__/downloadProgressUI.test.ts`, `frontend/__tests__/downloadPreparation.test.ts` | Global-provider, request/security, lifecycle and existing download regressions |
| `docs/api-inventory.json`, `docs/API_COVERAGE_MATRIX.md` | Generated inventory of the two new read-only routes |
| `docs/RELIABLE_DOWNLOAD_ACTIVITY.md` | Root cause, architecture, evidence, operator recovery, rollout, rollback and UAT |
