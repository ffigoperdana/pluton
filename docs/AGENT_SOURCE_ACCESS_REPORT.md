# Agent Source Access implementation review

Candidate branch: `codex/agent-source-access`.
Base commit: `461ef3211b61424db610b25f18811c3734c1ccd2`.
Status: **dual-mode candidate prepared for one authorized local commit; no push/PR/deployment authorized**.

## Dual-mode extension and final review

The extension preserves the Host-Approved baseline and adds Server-Managed host
delegation. Static/older Agents default to strict mode. Neither enrollment radio
buttons nor a server administrator's session can turn on delegation by themselves.

Server-Managed uses multiple canonical prefixes approved by the host once. Inside
them, an administrator validates paths, reviews canonical/access results and
explicitly applies the enabled set in the UI without recurring SSH approval.
Outside paths remain refused. Host-Approved retains Pending Host Approval, copied
local approval and explicit Apply. Both retain Linux permissions, signed leased
commands, stale/replay/version checks and durable selection publication.

The one-time transition uses a signed setup receipt after server-side drain checks
and a local shared activity fence. It binds the exact Agent, request, host revision,
scope and expiry; the root CLI consumes it before changing the host maximum.
Mode setup never re-enrolls or rotates identity. Delegation-only roots lose access
on strict-mode reversion. Returning to a broader mode requires explicit selection
again, not replay of an old approval. Receipts are not a general privileged API.

First enrollment uses the existing installer, then guides the selected one-time
setup on the ONLINE Agent; it does not emit unimplemented installer flags. Existing
Agents use the same setup after the reviewed configuration-preserving upgrade.
Scope and pending/current mode remain visible. Technical counters are under
Advanced details so ordinary operators do not need to manage them manually.

See the final validation addendum and exact inventory below. The original
baseline test results are preserved as historical local evidence; they are not
automatically evidence for every new dual-mode behavior. Production/Linux runtime
and hosted CI remain separate prerequisites.

## A. Root cause and previous behavior

The old Agent resolved the source against static `PLUTON_AGENT_ALLOWED_ROOTS`.
A valid application directory was still refused when its canonical target was
outside that set. An alias could fail `source-symlink-escape`, while requesting
the target directly failed `source-policy-violation`. Existence and a healthy
heartbeat did not grant access. The host operator had to change configuration
and restart the Agent. Those containment protections remain in place.

## B. Implemented authorization architecture

- Host maximum: original static canonical roots plus an identity-bound, root-owned
  local additional-approval file. The narrow local CLI approves/revokes only exact
  canonical paths; no server command edits host configuration, permissions or ACLs.
- Pluton selection: authenticated administrative requests contain the entire
  enabled set, expected selection version and host revision. SQLite migration
  **0019** adds separate state/request tables without rewriting old tables/state.
- Agent enforcement: strict signed/leased `SOURCE_ACCESS_VALIDATE` and
  `SOURCE_ACCESS_APPLY` commands, canonical directory/identity/read checks and
  local maximum containment. Static roots are initially enabled; new host grants
  remain disabled until an explicit Pluton selection.
- Durability: exclusive pending marker, initialization anchor, atomic selection
  replacement, file/parent fsync and monotonic version. Identical explicit requests
  are idempotent; stale versions, changed maximum, missing initialized state,
  expired leases and uncertain publication fail closed. Local recovery can confirm
  only an exact already-persisted transaction; it cannot create authorization.
- Independent root grant epochs prevent revoke/reapprove from silently reviving
  an old enabled selection. The UI requires explicit review and Apply again.
  Missing unused approvals do not disable other healthy sources.
- Removal requires exact affected-plan confirmation, paused plans and no related
  queued/running backups, checked again before delivery. Queue/materialization
  checks refuse a source pending removal. Host revocation remains a deliberate
  operator action and must be drained separately.
- Reconciliation records terminal request outcomes only; it never synthesizes an
  APPLY or increments a selection. Expired commands do not leave the interface
  permanently blocked by an open request.

Only the existing administrative browser-session model may use the new UI/API;
the project does not implement a separate multi-user RBAC model. Agent HMAC,
generic API keys and unauthenticated callers do not authorize administrative
enumeration. Existing same-origin write/session protections remain unchanged.
Signed callbacks retain nonce, timestamp, identity, exact body, lease and event
sequence checks. Requests and safe audit events record outcomes without raw
credential/provider text; ordinary application log retention still applies.

Inputs are bounded at 32 roots and 1024 characters per path. The Agent-only JSON
transport is capped at 512 KiB to fit maximum UTF-8 report/validation repetition;
unrelated routes retain 100 KiB and database restores retain 8 KiB. Local policy
documents are capped at 256 KiB to include duplicated epoch-map path keys.

## C–F. User workflow and enrollment

Open **Sources → remote machine → Source Access**. Enter multiple absolute Linux
paths, one per line, and choose **Validate paths**. The result shows the canonical
target, approval decision or actionable permission failure without changing access.
**Request access** submits a versioned selection. Paths outside the maximum stay
**Pending host approval** and cannot become a plan's executable source.

Use **Copy host approval command** for the trusted host operator, who reviews
the exact machine, Agent ID, current revision and canonical paths. Refresh the
report after that local approval, select the newly host-approved roots and click
**Apply enabled roots**. No policy-only restart/reinstall is needed. Unreadable
selected paths stay recorded until explicitly removed; canonical child roots can
also be disabled. Offline, stale, rejected, pending and synchronization states are
distinct. Queued/pending requests can be cancelled through the normal API.

Create/Edit Plan shows effective roots and can validate an explicit source. New
sources use the canonical result only after approval; pending drafts cannot be
saved as executable sources. Existing plan source identity remains fixed. Editing
other settings preserves nested database credentials, hooks, destination and
replication configuration. Old Agents retain manual static source entry.

Enrollment now accepts multiple roots and emits repeated `--allowed-root` flags
using the existing installer contract. The UI explains one Agent per host for
several applications, separate database permissions, canonical host validation and
later additions without reinstall. No filesystem-wide discovery is performed.

## G. Existing installation compatibility

Deploy the compatible server/migration 0019 first; new server plus old static
Agent is supported. Agent 0.6.0 advertises Source Access v1. Old server plus new
Agent inventory is deliberately refused by the old strict schema, so upgrading
the Agent first is unsupported. Never strip the new contract to force admission.

Identity files, enrollment, secret/CA/mTLS, devices, old source plans, SFTP primary,
Database & Hooks executors and repository credentials are not rewritten. Original filesystem containment and lifecycle enforcement remain intact; the backup builder adds mandatory delegated-mode private-directory exclusions. Protected migrations 0015/0016/0018, root
operators, Resume sequence, resource guards, CI and lockfile remain unchanged.
The installer itself remains unchanged and must not be blindly rerun over an
existing custom EnvironmentFile; see the configuration-preserving upgrade plan.

Canonical static roots remain the expected contract. A hand-written alias used
as a static maximum is refused as a selected source rather than becoming a moving
authorization boundary. Host operators must review/canonicalize such a
configuration before upgrading. Broad historical roots are displayed with a
warning and can only be narrowed through deliberate host review; the new workflow
does not grant new broad/system roots.

## H. Original Host-Approved baseline verification (before dual-mode extension)

Existing installed package binaries were used directly: the pinned pnpm 10.20.0
launcher attempted an unavailable registry download. No dependency, global tool,
lockfile or test threshold was changed. Sandbox loopback/subprocess restrictions
were lifted only for approved bounded local synthetic tests/builds. No app was
started against real data.

| Check | Actual result |
| --- | --- |
| Agent compile and complete local Agent tests | **66 PASS, 76 SKIPPED**, 0 failures |
| New Agent policy model regressions (included above) | **20 PASS** |
| Source Access backend + JSON/HMAC/size tests | **46 PASS** |
| AgentService, RemoteBackupService, migration regressions | **56 PASS** |
| AgentStore, DeviceService, PlanService, real control-plane and origin compatibility | **127 PASS** |
| Complete local frontend tests, including documentation validation | **227 PASS** |
| Fumadocs compiler/rendering/document boundary tests | **8 PASS** |
| Agent/backend/frontend/documentation TypeScript | **PASS** |
| Backend production compiler/templates/minifier build | **PASS** |
| Frontend Vite production build | **PASS**, existing chunk-size/caniuse-age warnings |
| Fumadocs production build and copy into frontend bundle | **PASS**, chunk-size warning |
| Changed backend-source ESLint | **PASS** |
| Standard frontend ESLint | **BLOCKED by existing configuration**: `tseslint.config()` cannot initialize the string `eslint-config-prettier` extension; configuration unchanged |
| Whitespace/diff, intended inventory and privacy exclusions | **PASS**, final manifest under ignored task `tmp/` |
| Production/real Linux service-user ownership and fsync/ACL runtime | **NOT TESTED** |
| Physical crash, production upgrade/rollback, hosted CI, human visual UAT | **NOT TESTED** |

The 76 skips are Linux/process/filesystem execution cases unavailable on this
Windows host, including the new real unprivileged Linux source-policy runtime
test. Modelled permission/TOCTOU/fsync failures are useful regression evidence,
not physical crash or Linux permission proof. The backend integration tests use
synthetic SQLite and bounded loopback endpoints; the new parser's transport tests
use a mock store, while the separate Source Access suite exercises real SQLite
transactions and authenticated command completion.

Review found and fixed final-fsync fence loss across polling objects,
revoke/reapprove reactivation, a missing unused maximum disabling other sources,
concurrent host-writer conflicts, and maximum-size UTF-8 payload/state mismatches.
Each has a focused regression. No historical acceptance failures or other release
gate statuses have been changed.

Local evidence/logs: `tmp/agent-source-access/`. Its private target appendix and
generated audit files are ignored and excluded from the intended source inventory.
No screenshot or live-browser visual approval is claimed.

## Final dual-mode validation addendum

The final source review covered the actual Agent policy/backup execution, signed
command and root CLI paths, SQLite request transactions, server drain checks,
administrative routes and UI/plan integration. No unresolved blocking defect was
identified for this local source candidate. This is not production acceptance or
an independent human approval.

The review fixed and tested unconfirmed-mode selection advancement, transient
host-policy errors falsely changing mode metadata, premature setup unfreezing,
normal plan Resume during setup, same-receipt deadline renewal, boot/wall-clock
expiry boundaries, activity-fence final-fsync failure and direct backup payloads
targeting private credential subdirectories. Consumed receipts cannot recreate
authority after interruption; a new host change needs a new explicit request.

| Final check | Actual result |
| --- | --- |
| Complete Agent suite | **74 PASS, 76 SKIPPED**, 150 total, 0 failures |
| Source Access, RemoteBackupService, Agent JSON transport and migrations | **77 PASS** on final source |
| Above suites plus AgentService, AgentStore, DeviceService, PlanService, control-plane and origin compatibility | **236 PASS** across 10 suites; final focused 77 rerun after last source guard |
| Complete frontend suite | **243 PASS**, including 39 Source Access tests and 13 docs/identity tests |
| Final Source Access frontend rerun after warning text correction | **39 PASS** |
| Final article/identity validation and Fumadocs tests | **13 PASS** (frontend subset), **8 PASS** (documentation) |
| Agent/backend/frontend/documentation TypeScript | **PASS** |
| Backend production build, frontend Vite/PWA build, documentation build/copy | **PASS**; existing bundle-size, CSS/browser-data warnings |
| Full backend-source ESLint | **PASS** |
| Standard frontend ESLint | **BLOCKED by unchanged existing configuration** (`eslint-config-prettier` string extension cannot initialize) |
| Source inventory, protected paths, privacy and diff checks | **PASS**; exact manifest under ignored `tmp/agent-source-access/` |
| Real Linux service-account permissions/ownership/fsync, physical crash, hosted CI and human visual UAT | **NOT TESTED** |

The existing Linux environment inventory contained only Docker Desktop's internal
distribution. It was not used or altered. No new Linux/VM/container fixture was
created. The 76 Linux skips remain skips; deterministic filesystem/clock/crash
models do not turn them into physical runtime proof.

Validation used the existing installed Node/package binaries directly, without
changing dependencies or the pinned pnpm 10.20.0/lockfile. Relevant command forms:
`tsc -p agent/tsconfig.json`, `node --test agent/dist/*.test.js`, backend Jest
`--runInBand --runTestsByPath` for the named affected suites, backend `tsc --noEmit`
and ESLint, `node --experimental-strip-types --test frontend/__tests__/*.test.ts`,
frontend `tsc -b`/Vite, documentation tests/typecheck/Vite, and
`node scripts/copy-docs-build.mjs`. Logs are private ignored task evidence.

Migration **0019** adds only Source Access state/request tables and indexes,
including mode-setup kind, requested mode and setup expiry. It preserves existing
Agent identity, command, plan, lease and retention data. It is the uncommitted
feature migration; no previously released migration was rewritten. Protected
0015/0016/0018, root operators, resource guards, installer, CI and lockfile remain
unchanged. The reviewed candidate contains **58 intended files**.

## I–J. Upgrade and rollback preparation

The exact generic operator commands and failure triggers are in
[AGENT_SOURCE_ACCESS_UPGRADE.md](AGENT_SOURCE_ACCESS_UPGRADE.md). A private ignored
`tmp/agent-source-access/PRIVATE_TARGET_UPGRADE.md` maps the user-supplied existing
roots and three requested additions to read-only operator preflight commands.
Those host facts remain unverified; none were copied into public source/docs.

The rollout drains operations, preserves protected stopped backups, replaces only
the reviewed application artifact and leaves configuration, identities and tools
intact. New canonical paths require either an existing host delegation or separate
host approval, followed by explicit UI enable. A separately authorized synthetic SFTP backup/browse/restore precedes real
workloads. Existing external backup cron and repositories remain untouched.

Rollback drains first and retains current identity/command receipts. Before
downgrading to an Agent unaware of managed selections, effective roots must match
the old static maximum; otherwise downgrade could widen access and is blocked
pending host review. Do not restore old state over current authorization or delete
pending markers to force a reset. A root-writer lock left after an interrupted
host operation requires exact ownership/process review, not automatic removal.

## K–L. Limits and next approvals

- No arbitrary remote shell, file browser, permission/ACL editor or remote host
  approval is implemented; these would violate the host maximum boundary.
- No Linux runtime, real production access, deployment, root CLI execution,
  service restart, host permission change or real backup was performed.
- A storage failure that also prevents restoration of its exact transaction fence
  leaves the running Agent latched closed. Do not restart to bypass this; repair
  and operator recovery are required. Physical failure behavior needs disposable
  Linux validation. Filesystem calls can still wait on unavailable host mounts;
  the UI reports a disconnected/stale Agent without granting access.
- The UI is covered by React/jsdom tests and compiled successfully. Independent
  human visual review is still needed before rollout; no screenshot was fabricated.
- This task authorizes one reviewed local commit only. Feature branch push and
  hosted CI are not performed here. Production access/preflight, synthetic pilot scope,
  host approval and production installation/restart remain separate approvals.

Stop after the authorized local commit if final dual-mode checks pass; otherwise stop without committing. This candidate does not change Phase 6 production
NO-GO or any prior acceptance ledger.

## Exact intended file inventory

The following list defines the reviewed local feature commit allowlist, including
this report. Private task evidence, credentials and generated artifacts are excluded.

- `agent/src/backupFilesystem.ts`
- `agent/src/config.ts`
- `agent/src/errors.test.ts`
- `agent/src/errors.ts`
- `agent/src/index.ts`
- `agent/src/inventory.ts`
- `agent/src/runtime.ts`
- `agent/src/sourceAccessPolicy.test.ts`
- `agent/src/sourceAccessPolicy.ts`
- `agent/src/sourceAccessRuntime.test.ts`
- `agent/src/types.ts`
- `backend/__tests__/agentSourceAccess.test.ts`
- `backend/__tests__/db/AgentMigrations.test.ts`
- `backend/__tests__/middlewares/agentJson.test.ts`
- `backend/__tests__/services/RemoteBackupService.test.ts`
- `backend/drizzle/0019_agent_source_access.sql`
- `backend/drizzle/meta/_journal.json`
- `backend/src/controllers/AgentAdminController.ts`
- `backend/src/controllers/AgentController.ts`
- `backend/src/createApp.ts`
- `backend/src/db/index.ts`
- `backend/src/db/schema/agentSourceAccess.ts`
- `backend/src/db/schema/agents.ts`
- `backend/src/middlewares/agentJson.ts`
- `backend/src/routes/agentAdmin.ts`
- `backend/src/services/AgentService.ts`
- `backend/src/services/AgentSourceAccessService.ts`
- `backend/src/services/RemoteBackupService.ts`
- `backend/src/stores/AgentSourceAccessStore.ts`
- `backend/src/types/agentSourceAccess.ts`
- `backend/src/types/agents.ts`
- `backend/src/utils/agentSourceAccess.ts`
- `docs/AGENT_SOURCE_ACCESS.md`
- `docs/AGENT_SOURCE_ACCESS_REPORT.md`
- `docs/AGENT_SOURCE_ACCESS_UPGRADE.md`
- `frontend/__tests__/agentSourceAccess.test.ts`
- `frontend/__tests__/agentSourceAccessClient.test.ts`
- `frontend/__tests__/agentSourceAccessUi.test.ts`
- `frontend/src/@types/agentSourceAccess.ts`
- `frontend/src/@types/devices.ts`
- `frontend/src/@types/index.ts`
- `frontend/src/components/Device/AgentEnrollment/AgentEnrollment.module.scss`
- `frontend/src/components/Device/AgentEnrollment/AgentEnrollment.tsx`
- `frontend/src/components/Device/SourceAccess/SourceAccess.module.scss`
- `frontend/src/components/Device/SourceAccess/SourceAccess.tsx`
- `frontend/src/components/Device/SourceAccess/SourceAuthorizationSetup.tsx`
- `frontend/src/components/Plan/PlanForm/PlanForm.tsx`
- `frontend/src/components/Plan/PlanSettings/PlanSourceSettings.tsx`
- `frontend/src/components/Plan/PlanSettings/RemoteSourcePicker.tsx`
- `frontend/src/docs/articles/backup-plans/managed-agent.md`
- `frontend/src/docs/articles/remote-agent/enrollment.md`
- `frontend/src/docs/articles/remote-agent/permissions.md`
- `frontend/src/docs/articles/remote-agent/updates.md`
- `frontend/src/routes/DeviceSingle/DeviceSingle.tsx`
- `frontend/src/services/agentSourceAccess.ts`
- `frontend/src/services/index.ts`
- `frontend/src/utils/agentSourceAccess.ts`
- `frontend/src/utils/clipboard.ts`

Total: **58 files**.
