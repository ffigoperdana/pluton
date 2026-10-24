# MCP v2 delivery report

Review date: 2026-10-24. Implementation is local on `codex/mcp-v2-native-tokens` in an isolated managed worktree. Implementation commit: **152396f786031f342ab115d13982767604966307**. The subsequent report commit changes documentation only; the final chat response identifies that delivery commit. Baseline was fetched `origin/main` **0c0b29e7f312aeb37a8ed5f6ede099f5c953d668**, which already contained MCP v1. The original checkout/branch remains unchanged. Nothing was pushed, merged, deployed or started against real application data.

## 1. Architecture and authentication

Native Pluton bearer tokens are an explicit optional authentication mode, separate from preserved external OAuth verification and browser-administrator sessions. Only native tokens can request writes. OAuth continues to use its existing scopes, identity/resource binding and JWT verification, with read-only access. Native-only configuration advertises no fake OAuth server/discovery. Agent enrollment secrets, device credentials, browser tokens, provider keys and the old universal API key are not MCP credentials.

`NativeTokenStore` generates a random 96-bit public identifier and 256-bit secret, stores SHA-256 verification material, compares digests with constant-time work, and applies current expiry/revocation/disable/permission revision checks. Tokens are returned only during create/rotate. The copy-once dialog uses component memory, not persistent browser/query/mutation storage. Tokens have 1–2160-hour TTL, default 168 hours. Rotation replaces and revokes atomically. Every tool call checks live policy/tool/resource grants again; the action service independently enforces write admission.

Reads use explicit stored-evidence projections. Approved writes enter the existing plan, backup/cancellation and recovery services, preserving their queues, admission, Source Access and capacity policy. There is no second backup orchestrator, generic API proxy or new Agent protocol. Repository inspection/mutation and legacy adoption boundaries remain unchanged.

## 2. Database migration

Additive migration `backend/drizzle/0021_mcp_native_tokens_actions.sql` is registered after 0020. `mcp_tokens` stores verifier, grants, issuer, timestamps, disabled/revoked state and revision. `mcp_actions` stores immutable exact arguments, canonical hash, resource hash, token revision, idempotency key, TTL, decisions, dispatch/result and terminal-observation metadata. Unique indexes prevent duplicate token/key requests and overlapping active actions per plan. A trigger rejects payload updates. No plaintext credential, repository content or production inventory is introduced.

Disposable tests cover v1 upgrade preservation and migrator re-run. Rollback retains additive tables/history/journal; physical schema downgrade is deliberately not automated.

## 3. Tool and permission matrix

All twelve v1 reads remain available with their original projections. The [complete named read/write matrix](MCP_V2.md#permission-matrix) lists each tool and resource boundary. OAuth requires scope intersection; native reads require read mode, exact tool selection and explicit IDs. Write-only tokens cannot access operational inventory.

| New tool | Permission / resource binding | Risk / approval |
| --- | --- | --- |
| `pluton_request_backup_now` | Native write, exact tool, plan/storage and remote Agent | Operational; always human approval |
| `pluton_request_pause_plan` | Same; active plan | Operational; always human approval |
| `pluton_request_resume_plan` | Same; paused plan | Operational; always human approval |
| `pluton_request_cancel_backup` | Same; in-progress backup belongs to plan | Operational; always human approval |
| `pluton_request_create_plan` | Same; authorized remote filesystem template, no enabled hooks/replication/database lifecycle | Operational; always human approval |
| `pluton_request_update_plan` | Same; title only | Operational; always human approval |
| `pluton_request_update_schedule` | Same; strict interval and explicit IANA timezone | Operational; always human approval |
| `pluton_request_update_exclusions` | Same; remote plan, bounded relative patterns | Operational; always human approval |
| `pluton_request_recovery_test` | Same; successful backup and existing isolated policy/targets | Operational; always human approval |
| `pluton_get_action_status` | Implicit native write-mode exception, own token's action only | Minimal read; no new approval |

Enabled replica destinations also require exact storage grants. Empty resource lists grant nothing. Create uses a granted existing source template and server-generated destination, with `runNow:false`; arbitrary paths are never accepted. Schedule disable/enable uses pause/resume. Destructive/privileged tools, production restore, unrestricted commands, credential changes, retention overrides, legacy writes, prune/forget/unlock and delegated-root changes are unavailable.

## 4. Approval, idempotency and audit

Requests create pending records with a maximum 15-minute TTL, limited to token expiry. Binding includes authenticated token/revision, action, exact resource IDs, canonical argument hash, related resource state and a stable intent key. The browser administrator reviews before/after values and sends the exact hash through the existing session/same-origin guard. There is no machine approval capability; `approved:true`, unknown fields, forged hashes, changed resources/permissions and expired/decided requests are refused.

SQLite persists the execution claim and audit before domain-service entry. Retries, concurrent approvals and restarts do not replay a claimed request. Pending/executing/uncertain actions are bounded to one per plan, ten per token and 100 globally. Domain failure after possible side effects becomes uncertain and requires explicit operator reconciliation. Startup never retries executing records. Reconciliation closes without replay.

Audit correlates request/decision/dispatch/expiry and observed linked-job completion by action ID. Dispatch acceptance is separate from job completion. Terminal status polling records the first observed completion once; no dedicated MCP completion worker is added. Raw credentials/arguments/errors are excluded from invocation audit; exact bounded arguments remain in administrator-only immutable action records.

## 5. UI and endpoint behavior

`/mcp` includes overview/emergency service disable, API token create/edit/disable/revoke/rotate/revoke-all, explicit resource selectors, tool inventory/policy, OAuth grants, pending approvals with exact payload/hash and before/after values, history, safe errors/audit filters and client guides. Issued tokens can be copied once and tested with initialize only. The check omits cookies and refuses redirects; it does not start work or certify provider reachability.

Browser HTML GET `/mcp` reaches the normal SPA. Machine POST uses the SDK; machine GET/DELETE returns405. HTTPS and exact Host/Origin are enforced; cookies/query credentials are refused at the machine boundary. New administrator lifecycle/action routes require the browser session and same-origin JSON. The generated [172-contract inventory](API_COVERAGE_MATRIX.md) and [twelve-read OpenAPI](mcp-openapi.json) identify actual source schemas. Writes are MCP request tools, not an unrestricted REST proxy.

## 6. Validation evidence

Runtime: Node 24.16.0, pinned pnpm 10.20.0, Windows. Dependencies used the unchanged frozen lockfile and local offline store. The worktree reused the existing matching compiled SQLite dependency for tests; it is ignored and not committed. Only synthetic fixtures and disposable databases were used.

| Command | Result |
| --- | --- |
| `pnpm --filter @plutonhq/core-backend test --runInBand --forceExit` | 195 suites passed; 3,855 passed, 4 skipped; Jest still needs forceExit for existing open handles |
| `pnpm --filter @plutonhq/core-backend test:mcp` (equivalent installed tsx command) | 46 tests passed, including v1 OAuth and native official-SDK flows |
| `node --experimental-strip-types --test frontend/__tests__/*.test.ts` | 280 passed |
| `pnpm test:docs` | 15 passed; 98 articles including the live Bahasa Indonesia MCP guide |
| `pnpm test:fumadocs` | 8 passed; real compilation/search/rendering/security contracts |
| `pnpm --filter @plutonhq/core-backend lint` | Passed |
| `pnpm --filter @plutonhq/core-backend build` | TypeScript/templates/minification/frontend copy succeeded |
| `pnpm --filter @plutonhq/core-frontend build` | Passed, including docs build, typecheck and Vite; final UI typecheck/Vite rebuild also passed |
| `pnpm --filter @plutonhq/core-frontend lint` | Blocked by existing configuration error: typescript-eslint rejects string `eslint-config-prettier` in extends; not a passing lint result |
| `node --test scripts/__tests__/apiInventory.test.mjs scripts/__tests__/deployment.test.cjs` | 16 passed |
| `node scripts/api-inventory.mjs --check` | 172 HTTP contracts verified |
| `node backend/node_modules/tsx/dist/cli.mjs backend/scripts/mcp-openapi.ts --check` | 12 read contracts verified |
| `git diff --check` and staged addition review | Passed; no private-key/native-token/common provider-key literal signatures found; expected files only |

MCP tests cover malformed/expired/revoked tokens, disable/rotation, read/write isolation, exact resource grants, native/OAuth namespace separation, TLS/proxy/protocol contracts, immutable hash binding, self/forged approval, idempotency/conflicts/concurrent approvals, pending/restart recovery, TTL/rejection, changed plan/Agent/storage/Source Access/private credential/recovery policy, pending limits, active jobs, domain failure, audit rollback, bounded exclusions/fields, own-status isolation and one-time terminal audit. UI tests verify actual DOM interactions, strict approval payload and copy-once dismissal without browser/query/mutation persistence. The full domain regression suite covers existing backup/restore, Agent, scheduler, lifecycle, replication and legacy code; no existing tests were weakened.

Frontend build warnings remain for bundle size and old Browserslist metadata. No dependency upgrades were made to suppress them. Visual browser inspection was unavailable in the configured local tool environment; DOM and build evidence are not a screenshot claim. No real provider/Agent/storage job or Linux/Docker runtime test is claimed.

## 7. Client compatibility evidence

Official documentation was reviewed on 2026-10-24. The [client matrix and placeholder examples](MCP_V2.md#client-compatibility-evidence-2026-10-24) link primary sources:

- Claude documents fixed Authorization Request headers on custom remote connectors; actual account/plan/workspace UI and egress remain untested.
- Codex CLI/IDE documents an HTTP URL and `bearer_token_env_var`; no real installed-client/account connection was performed.
- ChatGPT uses its supported OAuth flow subject to plan/workspace availability. Manual native bearer entry is unverified and not promised.
- OpenAI Responses API documents the remote MCP `authorization` field. Provider API authentication is separate and stays in the client application. No paid/provider call was made.

The official SDK 1.32.1 local HTTP tests prove protocol initialize/discovery/read/request/separate administrator approval/status/revocation. Supported protocol revisions are 2025-11-25, 2025-06-18 and 2025-03-26. This is not live provider compatibility certification or support for 2026-07-28.

## 8. Configuration, rollout and rollback

New flag: `MCP_NATIVE_TOKENS_ENABLED` defaults false. Existing `MCP_RESOURCE_URL` remains required HTTPS. OAuth optionally retains `MCP_OAUTH_ISSUER` and `MCP_OAUTH_JWKS_URL`. `.env.template` has placeholders only; compose adds one flag passthrough and leaves persistent mounts unchanged. The stored service policy remains an independent explicit switch.

The [operator runbook](MCP_V2.md#staging-rollout-incidents-and-rollback) covers backups of configuration/data, disposable migration validation, disabled-first rollout, narrow read token checks, one approved disposable write, terminal verification, leak response, emergency revocation and rollback. Cloudflare/BunkerWeb guidance preserves Authorization/protocol headers, verified TLS/Host, exact reviewed proxy trust, no-store and scoped WAF rules; no global WAF disable or wildcard privileged CORS is introduced.

Rollback disables MCP, revokes/reconciles native work and returns to the reviewed v1 image under operator control while retaining additive history/schema/journal. Never restore an old whole database over newer backup/Agent state. No production action, restart, migration or proxy change was performed.

## 9. Limits and readiness

Ready for **isolated staging validation**. Production acceptance requires live supported client accounts, external TLS/proxy/WAF/egress checks, Linux/Docker validation, approved disposable Agent/storage/recovery jobs and operator monitoring/reconciliation. Full source tests cannot substitute for these checks.

MCP approval is not a distributed transaction or global resource lock across async domain work, scheduler, storage, Agent and other administrator workflows. The immutable payload and pre-dispatch state recheck prevent request substitution; existing domain admission still owns runtime conflicts. Concurrent domain changes can reject or produce uncertainty rather than a guaranteed atomic multi-system outcome. Backup-job correlation is available only when one new durable job is observed; otherwise progress is unavailable. Completion audit is observation-driven. Conservative state hashing can require a fresh request after relevant changes. No approval-free write policy, general-purpose plan editor or automatic schema downgrade is offered.

No production readiness claim, push, merge or deployment is made. The implementation is independently written against the public fork; upstream license/attribution and proprietary-code boundaries remain intact.
