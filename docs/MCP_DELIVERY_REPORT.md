# API audit and MCP delivery report

Date: 2026-10-23. Branch: `codex/api-mcp-administration`. Base: latest fetched `origin/main`, `5126fb7` (scheduler timezone fix included). Work is local only; no push, PR, merge, deployment, production configuration change, real storage access or Agent restart occurred.

Delivered scope: authenticated **read-only MCP MVP**, scoped REST reads, administrator dashboard, route audit, tests and documentation. The requested fallback for advanced write operations was used: write requests/approvals are unavailable. This is not a declaration of production readiness or uniform standardization of every legacy API.

## 1. Full API coverage matrix

[API_COVERAGE_MATRIX.md](API_COVERAGE_MATRIX.md) inventories **160 explicit method/path contracts**, including all 15 mounted existing route modules, custom inline handlers, expanded persistent-restore lifecycle operations and the new integration contracts. [api-inventory.json](api-inventory.json) is the machine-readable source artifact. The AST inventory and drift test run without application startup.

Every row records feature/classification, HTTP method/path, actual controller/service, authentication/authorization, request/schema evidence, response contract, pagination, errors, external availability, relevant test references and security implications. Legacy contracts frequently have no runtime output schema or common pagination; these are recorded as gaps with implementation links. Test-module references are not presented as proof of endpoint-level assertion coverage.

[API_SECURITY_AUDIT.md](API_SECURITY_AUDIT.md) includes a business-capability matrix for plans, exclusions, managed sources, database/hook configuration, Agent protocol/Source Access, receipts, replication, recovery, storage, notifications, self-backup, legacy repositories and administration. It distinguishes fully supported, internal-only, partial, missing and intentionally prohibited capabilities.

## 2. Existing gaps and resolution

- Added secure external read contracts for operational records instead of broadening the legacy API key over rich editor responses.
- Added exact subject/client resource grants because the existing application has one local administrator and no tenant/user ownership model.
- Added strict input schemas, runtime-validated versioned output, bounded SQL pagination, stable errors, local grant expiration/revocation, tool restriction enforcement and durable sanitized audit.
- Reused one read service for REST and MCP over existing stored application evidence. Existing editor/orchestration services are deliberately not invoked because they hydrate secrets or perform live storage operations. No new backup orchestration implementation exists.
- Recorded unresolved legacy API-key mounted-path behavior, mixed error/response contracts, incomplete pagination and sensitive internal editor DTOs. These are not claimed fixed globally, and legacy routes were not silently opened to external clients.
- Kept MCP write/approval operations, live repository traversal/export, arbitrary API/SQL/shell/file tools and credential access unavailable.

## 3. Exact new endpoints

| Boundary | Endpoints |
|---|---|
| MCP | `POST /mcp`; authenticated `GET /mcp` and `DELETE /mcp` return 405 in stateless mode; validated `OPTIONS /mcp` preflight |
| Discovery | `GET /.well-known/oauth-protected-resource/mcp` (no operational data; only when enabled and transport valid) |
| Plan reads | `GET /api/v1/operations/plans`, `GET /api/v1/operations/plans/:id` |
| Agent reads | `GET /api/v1/operations/agents`, `GET /api/v1/operations/agents/:id`, `GET /api/v1/operations/agents/:id/source-access` |
| Backup reads | `GET /api/v1/operations/plans/:planId/backups`, `GET /api/v1/operations/backups/:id` |
| Storage reads | `GET /api/v1/operations/storages` |
| Replication reads | `GET /api/v1/operations/plans/:planId/replications`, `GET /api/v1/operations/replications/:id` |
| Recovery reads | `GET /api/v1/operations/plans/:planId/recovery-tests`, `GET /api/v1/operations/recovery-tests/:id` |
| Administrator reads | `GET /api/mcp-admin/overview`, `/tools`, `/clients`, `/activity` |
| Administrator mutations | `PUT /api/mcp-admin/policy`, `POST /api/mcp-admin/clients`, `PUT /api/mcp-admin/clients/:id`, `POST /api/mcp-admin/clients/:id/revoke` |

[mcp-openapi.json](mcp-openapi.json) contains OpenAPI 3.1 input/output schemas for the twelve external reads, generated from the real tool catalog. Administrator request bodies/error conventions are documented in [MCP.md](MCP.md#exact-rest-endpoints).

## 4. MCP architecture and protocol

HTTPS transport validation → existing external OAuth issuer/JWKS verification → local subject/client grant and scope intersection → explicit tool/resource admission → shared `OperationalReadService` → existing SQLite records. Audit/client activity are separate additive SQLite tables. No repository/storage operations are performed.

Official SDK: `@modelcontextprotocol/sdk@1.32.1`; JWT verifier: `jose@6.1.3`. Streamable HTTP is stateless with JSON responses and no persistent sessions. Supported HTTP revisions: **2025-11-25, 2025-06-18, 2025-03-26**. Pre-Streamable revisions are refused; future initialization revisions can negotiate down through the SDK. The published 2026-07-28 revision was reviewed but is not implemented/claimed by this SDK integration. JSON-RPC batches are refused to preserve rate/audit bounds.

OAuth authorization code/PKCE, registration, consent and token issuance belong to a separately reviewed existing IdP. Pluton implements resource metadata and access-token verification, not a partial authorization server. Tokens must be resource-bound RFC 9068 JWTs with correct issuer/audience/type/client/subject/scope/expiry, RS256 or ES256 and a maximum one-hour age/lifetime. No universal administrator key or Agent identity is reused.

## 5. Tool catalog

`pluton_list_plans`, `pluton_get_plan`, `pluton_list_agents`, `pluton_get_agent_status`, `pluton_get_source_access_status`, `pluton_list_backups`, `pluton_get_backup_status`, `pluton_list_storages`, `pluton_list_replications`, `pluton_get_replication_status`, `pluton_list_recovery_tests`, `pluton_get_recovery_status`.

All are read-only stored evidence. Snapshot IDs are historical receipts. Database artifact/import validation is separate. Storage health is explicitly unmeasured. Primary completion, replica verification, source authorization and recovery test results are not conflated.

## 6. Per-tool security matrix

The complete [tool/scope/resource/evidence matrix](MCP.md#tool-and-authorization-matrix) documents every tool. Six enforceable scopes exist: `plans:read`, `agents:read`, `backups:read`, `storages:read`, `replication:read`, `recovery:read`.

Every invocation requires service/tool enabled, valid JWT, active local grant, matching scope in both JWT and grant, and exact resource IDs. Backup/replication/recovery records are filtered by their plan in SQL; Agents/storages use independent explicit ID lists. No wildcard or default global grant exists. Unknown/unauthorized detail resources share `not_found`. Current local policy is rechecked at execution. Every accepted invocation requires durable audit before dispatch. Responses omit names/configuration/paths/secrets/raw errors and are bounded, including text/structured duplication. Administrator controls accept only the existing local administrator's signed browser cookie and same-origin JSON.

## 7. UI implementation

Added `/mcp` and an accessible MCP sidebar entry. The page reuses existing PageHeader, Modal, React Query, typography and theme variables. It provides service/configuration overview, endpoint copy, registered clients, explicit subject/client/scope/resource authorization, optional expiration, permission edits, confirmed revocation, client-specific instructions, backend-enforced tool switches and bounded/filterable audit pagination. It has explicit loading/error/empty states and responsive grid/table containers.

Client labels are declared, never cryptographic model identification. Never-used/authorized/recently-active/expired/revoked states are based on actual timestamps and authorization state. No conversation access, permanent Online status, fake success or decorative approval controls are claimed. Writes/approvals are clearly unavailable. Registration stores no model-provider key or newly minted credential.

## 8. Claude/Codex/Grok verification

Official MCP, SDK, Claude remote-connector, Codex CLI/IDE and xAI Remote MCP documentation was opened and reviewed on the delivery date. Sanitized instructions and primary-source links are in [MCP.md](MCP.md#clients-and-compatibility). Codex supports URL/bearer-environment configuration or the IdP's supported OAuth login. Claude uses its documented custom connector flow and requires cloud reachability/compatible IdP registration. xAI's documented API Remote MCP fields are supplied; a consumer Grok custom-connector flow was not verified or invented.

The official SDK client initialized, discovered tools and called the real gateway against disposable fixtures, then was denied after revocation. **No live provider-account connection was tested.** Protocol tests do not prove Claude/Codex/Grok connectivity. No model-provider key is needed to expose Pluton; separate inference APIs may require the user's own provider authentication.

## 9. Agent distribution recommendations

Retained `.env` authority and immutable reviewed full SHA/version/repository configuration. Existing validation runs before enrollment token creation; missing/invalid configuration returns actionable 503. Compose already passes the pin through, and the installer verifies checkout/version. The server does not fetch/attest remote commit contents merely by validating configuration syntax. Existing installed Agents are unaffected.

No release-management UI/database override or auto-update was added. Use the documented private operator approval/staging/previous-pin rollback procedure. There is no secure existing persistent release configuration layer to justify introducing competing authority in this subsection.

## 10. Files changed

```text
.env.template
backend/package.json
pnpm-lock.yaml
backend/drizzle/0020_mcp_authorizations.sql
backend/drizzle/meta/_journal.json
backend/src/createApp.ts
backend/src/services/ConfigService.ts
backend/src/mcp/authorization.ts
backend/src/mcp/browserAdministrator.ts
backend/src/mcp/contracts.ts
backend/src/mcp/gateway.ts
backend/src/mcp/McpStore.ts
backend/src/mcp/OperationalReadService.ts
backend/__tests__/mcp/gateway.integration.ts
backend/__tests__/routes/mcpAdministration.test.ts
backend/scripts/mcp-openapi.ts
deploy/compose.yml
frontend/src/router.tsx
frontend/src/components/App/SideNav/SideNav.tsx
frontend/src/routes/Mcp/Mcp.tsx
frontend/src/routes/Mcp/Mcp.module.scss
frontend/src/services/mcp.ts
frontend/src/utils/mcp.ts
frontend/__tests__/mcp.test.ts
scripts/api-inventory.mjs
scripts/__tests__/apiInventory.test.mjs
docs/ARCHITECTURE.md
docs/API_COVERAGE_MATRIX.md
docs/api-inventory.json
docs/API_SECURITY_AUDIT.md
docs/mcp-openapi.json
docs/MCP.md
docs/MCP_DELIVERY_REPORT.md
```

Tracked and untracked changes were reviewed before local commits. Targeted credential-pattern scanning found no matches in the implementation/documentation set. Fixtures contain synthetic data or ephemeral generated keys. Generated build output/local test logs are not committed. Licensing and attribution remain intact.

## 11. Commands and results

Validation host: Windows, Node.js **24.16.0**, pnpm **10.20.0** (the repository pin). Deployment/CI Node.js 24.22.1 configuration was preserved; that exact runtime was not exercised locally.

| Command | Result |
|---|---|
| `pnpm --filter @plutonhq/core-backend test --runInBand` | 195 suites passed; 3,855 tests passed, four skipped. Assertions completed, but existing async handles prevented exit; only this task's completed Jest process was stopped. |
| `pnpm --filter @plutonhq/core-backend test --runInBand --forceExit` | **Exit 0**; 195 suites / 3,855 passed, four skipped. Explicit Jest exit does not change assertions or resolve the existing handle cleanup debt. |
| `pnpm --filter @plutonhq/core-backend test:mcp` | **11/11 passed**, exit 0, including actual migrated schemas, official SDK, JWT/transport/scopes/resource isolation, expiry/revocation/permission edits, negotiation/errors, denied writes/batches, rate/response bounds, audit sanitization/failure and administrator contracts. |
| Focused Jest `mcpAdministration` and `authMiddleware` suites | **9/9 passed**; actual signed browser cookies, local administrator role, origin binding and CSRF checks included. |
| `node --experimental-strip-types --test frontend/__tests__/*.test.ts` | **279/279 passed** after correcting the new page's theme token. |
| `node --experimental-strip-types --test frontend/__tests__/mcp.test.ts` | **6/6 passed**, including interactive registration, permission edits, revoke confirmation/tool toggle, states/status evidence, instructions and HTML/WAF error handling; rerun after final test expansion. |
| `node --test scripts/__tests__/apiInventory.test.mjs` | Passed; all mounted route modules, explicit dynamic routes, custom features, uniqueness and generated artifact drift checked. |
| `node scripts/api-inventory.mjs --check` | Passed: 160 contracts. |
| `pnpm --filter @plutonhq/core-backend exec tsx scripts/mcp-openapi.ts --check` | Passed: twelve catalog-derived read contracts. |
| Backend `tsc --noEmit -p tsconfig.json`; frontend `tsc -b` | Passed. |
| `pnpm --filter @plutonhq/core-backend lint` | Passed. |
| `pnpm --filter @plutonhq/core-frontend lint` | **Blocked by existing configuration**: `typescript-eslint.config()` rejects string `eslint-config-prettier` in `extends`. The unchanged global lint configuration was not weakened. |
| `pnpm build` | Passed twice: frontend/docs, Agent and backend, three tasks successful. Documentation tests/build and generated frontend copying completed. |
| Final `pnpm --filter @plutonhq/core-backend package` | Passed after final transport/error/negotiation hardening. |
| `git diff --check` | Passed. |

Initial sandbox runs could not connect to loopback; integration tests were rerun with permitted local test networking. No real application server, credentials or repositories were used. Browser visual inspection was attempted but unavailable because **local browser use is disabled in Work settings**. Interactive DOM/theme tests passed; desktop/mobile screenshot and target-browser accessibility review remain unverified.

## 12. Deployment and migration

No deployment was performed. The additive migration creates only MCP policy, authorization and audit tables/index; initial policy is disabled. It does not rewrite plans/backups, alter retention or run repository operations. Use the normal reviewed state-backup/migration process if deploying later.

Provision and review an existing IdP, configure canonical HTTPS resource/issuer/JWKS URLs, register exact subjects/clients/scopes/resource IDs, verify staging authentication and proxy behavior, then explicitly enable MCP. Environment remains authoritative for IdP/endpoint configuration; SQLite is authoritative for MCP permissions/exposure. If replacing an issuer/resource deployment identity later, disable MCP and revoke/review its grants before enabling the replacement. No general user RBAC, OAuth issuer, token minting or approval migration is included.

## 13. WAF/reverse proxy requirements

Preserve exact Host, trusted TLS termination, correct narrowly configured `TRUST_PROXY`, Bearer and MCP protocol headers, JSON POST and documented Accept content types. Do not expose the backend port or widen firewall/WAF rules automatically. Allow the discovery path and only the selected MCP/v1 paths. Current stateless JSON transport needs no sticky session or long-lived SSE exception. Distinguish application JSON errors from WAF HTML/redirects by status and Content-Type. Rate limits are per process; multi-instance deployments need an edge policy. BunkerWeb/client network behavior is documented but not live-tested. Never disable WAF security globally.

## 14. Known limitations / production review

No real provider login, external IdP PKCE/resource issuance/revocation/key rotation, production TLS/WAF/firewall, exact deployed Node runtime, or target-browser layout was tested. JWTs are not introspected on every call: IdP-side revocation may wait until expiry (maximum one hour), whereas local grant revocation denies subsequent requests immediately. Audit storage has no automated retention/deletion policy. Local rate limits reset on restart and are not distributed. Synchronous SQLite execution is bounded but cannot be interrupted by a JavaScript deadline.

No write requests or approval lifecycle exists; replay/parameter-substitution execution is unavailable rather than partially implemented. No live snapshot inventory/content, source-path export, system/storage probes, arbitrary API proxy, restore/export, credential or legacy repository MCP tools exist. Managed replication tools represent durable managed jobs, not every historical/local mirror model. Rich receipts/source coverage and uniform legacy API schemas/pagination remain follow-up work. Full tenant RBAC is not added. An independently reviewed IdP/proxy/client staging assessment is required before any production-readiness claim.

## 15. Local commits

- `55f7069d8d17f7473f5419b93d0e449fe00c1314` — `feat(mcp): add scoped read-only OAuth resource server`
- `839ffdfc20be829c3daa02803de80eff624579d1` — `feat(mcp): add administrator client and audit dashboard`
- The final documentation/audit/report commit is recorded in the accompanying chat and `git log -3 --oneline`; a commit cannot contain its own final SHA.

All work remains on `codex/api-mcp-administration` for local review and publication through GitHub Desktop.
