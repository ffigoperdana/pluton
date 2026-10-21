# Deterministic Agent integrity and operator documentation audit

Base: `c187e2c3a830544d5c44663046519807c2ebc982`, verified against the fork's
remote main before starting. Branch: `codex/deterministic-agent-integrity-operations-docs`.
This report records source/synthetic evidence, not production acceptance.

## Proven defect and focused correction

`installers/install-agent.sh::verified_tree_digest` serialized a validated
runtime/bin/app tree after `find ... -print0 | sort -z`. Sorting inherited the
caller's collation. `upgrade-agent.sh` invokes it before executing private Node;
Node's later `productionContext` uses a clean `LANG=C` environment, which does
not fix that earlier shell gate. `source_fingerprint` had the same ambient-sort
dependency. Source/install metadata could therefore differ on unchanged bytes.

The fix exports `LC_ALL=C` inside each calculation subshell, covering sort,
character classification and record serialization without touching the caller,
global locale or Agent service. It overrides both LC_ALL and LC_COLLATE precedence.
No record format/version, SHA-256, field, mode/owner/symlink check or timeout is
changed. Existing correctly recorded format=1 C digests remain compatible. There
is no alternate-locale fallback, force switch or automatic provenance rewrite.
Genuine content/mode/link mismatches remain failures; non-C provenance needs
separate exact review, never silent adoption or re-enrollment.

## Linux evidence and limits

A disposable non-root Debian/Linux container reproduced the old defect with a
real privately generated `en_US.UTF-8` locale. The same synthetic tree matched
the independent legacy C-order oracle under C/C.UTF-8 and mismatched under
en_US.UTF-8. With the fix, all three locales and LANG/LC_ALL/LC_COLLATE precedence
combinations match that oracle. Caller locale variables remain unchanged.

Fixtures cover nested directories, hidden/Unicode/mixed-case/space/punctuation
names, valid symlinks, source fingerprinting and the actual upgrade digest helper.
Read-only digest-plus-record comparison uses the same gate as the shell upgrader.
Contents, valid changed modes, unsafe writable modes, directory modes and symlink
target changes are rejected without rewriting metadata; its inode/mtime/content
and original fixture artifacts are preserved. Existing upgrade safety tests
exercise preservation, lock/fence, failure/rollback, preflight and health models.

Local Linux results:

| Check                                                             | Actual result                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Original algorithm locale regression                              | FAIL reproduced under real en_US.UTF-8; C/C.UTF-8 pass                                 |
| Fixed locale tests                                                | 5 PASS, 0 SKIP                                                                         |
| Full upgrade/provenance/locale harness                            | 62 PASS, 0 FAIL, 0 SKIP                                                                |
| Existing synthetic first-install/reuse/rollback installer harness | PASS                                                                                   |
| Bash syntax and upgrader help/invalid-option refusal              | PASS                                                                                   |
| Many-file provenance compatibility benchmark                      | 4,097 files, 597 directories, 1 link, 202,375,168 bytes; all expected digests equal    |
| Benchmark complete scan times                                     | 10,632 ms and 10,282 ms on the disposable two-CPU fixture; not production measurements |

The test environment has read-only allowlisted source, no network/ports, dropped
capabilities and tmpfs-owned disposable installations. It never mounts an existing
Agent or host systemd. Locales and utilities were installed only in a disposable
test image derived from immutable Node 22.18.0 image
`node@sha256:0d130e2ee18e88e1561375276daced6bff032539200173f2daf48c2e33f38ff5`.
An initial installer run hit a noexec tmpfs after locale tests passed; only the
fixture tmpfs was made executable for the final run, with assertions unchanged.

CI keeps existing checks/permissions and adds private `localedef --no-archive`
data under runner temp. `PLUTON_REQUIRE_LOCALE_TESTS=1` refuses to skip en_US;
missing locale tooling fails the check. It changes neither service nor host
locale configuration. The production five-minute provenance bound is unchanged.
Full root/systemd `upgrade-agent.sh --check`, installed-Agent startup and a real
production retry were **not executed**. Synthetic verifier/preflight/rollback
proof is not a substitute for those separately authorized operator checks.

## Documentation audit findings and consolidation

The existing 96-article inventory, headings, route manifest and internal links
were inspected; focused operational articles and technical contracts were
cross-checked against current code. Existing URLs and all 15 categories remain.
The portal now has 97 articles. This is a coherent operator workflow audit, not
a claim that every historic implementation/acceptance report is a current release
approval. Historic failures/results were preserved.

| Finding                                                                | Resolution                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| No authoritative server-to-recovery sequence                           | New 15-step Complete Backup Setup; linked from README, home, sidebar, getting-started and quick-start                                  |
| Quick-start skipped current source validation/apply                    | Uses authenticated effective roots/current Source Access labels; legacy manual path remains explicit                                   |
| Agent update article still offered reinstall sequence                  | Removed routine reinstall recipe; points to app-only upgrader, server-first compatibility, hold/drain and exact rollback               |
| Locale mismatch absent from diagnostics                                | Scoped canonical C algorithm, old-format compatibility, no rewrite/bypass and persistent-mismatch escalation documented                |
| HCP guide did not explain tenant/namespace/protocol/keys deeply enough | Storage HCP is authoritative vendor-prerequisite reference; replica HCP links it and focuses on acceptance                             |
| TLS/anonymous response ambiguity                                       | Certificate SAN, tenant versus namespace hostname, path-style, CA contract and unsigned HEAD 403/405 limitations explicit              |
| Copy versus recovery evidence easily confused                          | Separate configured/primary/pending/incomplete/completed/recovery states; no direct managed-mirror restore invented                    |
| Destination edits could be read as migration                           | New prefix is not historical migration; retain old data until accepted copy and recovery plan                                          |
| Configuration-only DB badge could imply success                        | Configured, dumped, included/hash-verified, imported and app-validated remain distinct                                                 |
| API history missing from reference                                     | Additive admin-only bounded cursor GET documented, not a mutation/authorization mechanism                                              |
| Troubleshooting fragmented                                             | Main diagnosis hub has symptom/code, cause/read-only checks, supported remediation, prohibited shortcuts and escalation by owner       |
| Periodic operations incomplete                                         | Daily/weekly/periodic evidence, capacity/failure-domain, drift/rotation and restore drills linked to existing DR/cutover authorities   |
| Duplicated operational guidance                                        | One complete journey; feature pages own detail; technical Agent upgrade and migration/cutover runbooks retain their distinct authority |

Large existing detail references were kept instead of replaced wholesale. No
legacy URL, proprietary material, screenshot with private data or additional
runtime documentation service is introduced. The architecture diagram is a
supported text fence; no executable Mermaid/MDX/remote image dependency is added.

## Current-source evidence map

| Workflow                                                    | Reviewed source/contract                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First server deployment, persistent state, upgrade/rollback | `deploy/install.sh`, `lib.sh`, `compose.yml`, `.env.example`, `deploy.sh`, `rollback.sh`, `healthcheck.cjs`; `docs/DEPLOYMENT_OVERLAY_AND_HEALTHCHECK_FIX.md` |
| Web auth/origin/health                                      | `backend/src/middlewares/authMiddleware.ts`, `utils/webOrigins.ts`, `routes/health.ts`; Setup/Login UI and current deployment articles                        |
| Agent enrollment/toolchain                                  | `installers/install-agent.sh`, `agent/src/identity.ts`, `runtime.ts`, `inventory.ts`; enrollment UI                                                           |
| Upgrade/provenance/rollback                                 | `installers/upgrade-agent.sh`, `lib/upgrade-agent.cjs`, `upgrade-diagnostics.cjs`; `docs/AGENT_UPGRADE.md`                                                    |
| Host scope, validated/applied roots and request history     | `agent/src/filesystemPolicy.ts`, `sourceAccessPolicy.ts`, `backend/src/services/AgentSourceAccessService.ts`, Store/routes, SourceAccess UI                   |
| SFTP/S3/HCP configuration                                   | `backend/src/utils/providers.ts`, `providers/_s3Options.ts`, `storageSecurity.ts`, `services/StorageService.ts`                                               |
| Remote plan, versioned exclusions/history                   | `backend/src/services/RemoteBackupService.ts`, `agent/src/backupFilesystem.ts`, `backupExclusions.ts`, PlanBackupExclusions and RemoteSourcePicker UI         |
| Database/hooks/artifacts                                    | `agent/src/backupLifecycle.ts`, `backupFilesystem.ts`, lifecycle helpers, Database & Hooks UI; Phase 5 contract                                               |
| Replica scope/status/retry/retention                        | `backend/src/services/ManagedReplicationService.ts`, replica executor/store and Mirror UI; `docs/MANAGED_AGENT_REPLICATION.md`                                |
| Native/persistent recovery                                  | RecoveryTestService/DatabaseRestoreService, restore UI and Phase 6/Internal/persistent contracts                                                              |
| Shadow, security, retention and DR                          | Existing migration, security, deployment persistence, operations and limitations articles, preserved roadmap phase boundaries                                 |

HCP descriptions cite primary Hitachi documentation in the HCP article. API/version
settings still require the actual storage owner; those citations do not establish
real appliance interoperability, universal region behavior or Object Lock support.

## End-to-end coverage and support checklist

| Step                 | Covered, with explicit verification and boundary                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 architecture       | Source, server/Agent hosts, primary/replica, SQL and recovery flow                                                                                         |
| 2 server             | Immutable artifact/bundle, new-install intentional stop, private env/volume/keys, TLS/login/GET health and existing-install boundary                       |
| 3 Agent              | Supported Linux/private pinned tools, secure prompt enrollment, service/ONLINE/version/capability and first install versus update                          |
| 4 Source Access      | Host delegation, receipt-bound one-time UI command, canonical Validate/Apply/effective scope, ACL/readability and history                                  |
| 5 storage            | Primary capability matrix, SFTP dedicated scope/chroot/connectivity/rotation, logical versus physical independence                                         |
| 6 plan               | Exact UI steps, unique repo, schedule, no assumed managed prune, initial Backup Now                                                                        |
| 7 database           | Engines/clients, secret fields, dump ordering/options/consistency, hooks and separate artifact evidence                                                    |
| 8 exclusions         | Tested grammar/case/anchoring/limits, directory pruning, generated-artifact scope, invalid/old-Agent refusals                                              |
| 9 first verification | Exact snapshot/time/receipt/status, counts/duration/coverage, file restore/hash and SQL metadata                                                           |
| 10 replication       | S3 limit/server sequential copy, add/confirm/save, per-mirror evidence/retry, Redundancy incomplete, prefix changes and unsupported direct mirror recovery |
| 11 HCP               | Tenant/namespace/S3 protocol/ACL, API versus console, endpoint/path-style/region/TLS, key scope, quotas/WORM/DPL/vendor caveats                            |
| 12 recovery          | Staging, artifact-only/import NOT TESTED, required isolated import, application checks, cleanup and persistent lifecycle/resource guards                   |
| 13 operations        | Schedules, measured capacity, bandwidth, daily/weekly/periodic checks, source drift, rotation, retention and notification outcomes                         |
| 14 upgrades          | Server-first/CI/backup/drain, app-only preflight, locale compatibility, preservation/rollback and downgrade limits                                         |
| 15 adoption          | Independent shadow repositories, scheduled cycles, coverage/RPO/RTO/owner acceptance and no automatic legacy cutover                                       |

## Remaining validation and release boundary

Current build/test/privacy results and the exact changed-file inventory follow.
No source/database/recovery guard is changed
outside the two hash functions. No migration, new dependency or Agent protocol
version change is required. Service config and private state are preserved.

Publish manually, review hosted Linux CI on the exact commit, then separately
authorize any real Agent preflight/controlled upgrade and application backup/
recovery drill. HCP interoperability, production capacity, real systemd upgrade,
replica recovery runbook and production cutover remain unverified here.

This documentation does not close Phase 6, Docker hash discrepancy, independent
review or production-readiness gates. It does not access or modify production,
legacy jobs, host policies or historical transaction records.

## Final local validation

Commands below use the existing lockfile and private, pinned pnpm 10.20.0 where
applicable. Linux tests ran against an allowlisted disposable source copy,
without an existing installation or host service. Logs and manifests stay in
Git-ignored `tmp/integrity-docs/`, never in the public commit.

| Command/check                                                         | Actual result                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash installers/tests/install-agent.test.sh`                         | PASS, existing isolated installer harness                                                                                                                                                            |
| `bash installers/tests/upgrade-agent.test.sh`                         | 62 PASS, 0 FAIL, 0 SKIP, including real C/C.UTF-8/en_US.UTF-8                                                                                                                                        |
| `pnpm --filter @plutonhq/pluton-agent test`                           | Linux: 122 PASS, 35 SKIP, 0 FAIL; existing Phase 5 tests require unavailable `PLUTON_PHASE5_TEST_TOOLS`                                                                                              |
| `pnpm --filter @plutonhq/pluton-agent build`                          | PASS, TypeScript/application build; no production Agent execution                                                                                                                                    |
| Bash syntax and Node syntax checks                                    | PASS for affected installer scripts and new locale regression                                                                                                                                        |
| `node --experimental-strip-types --test frontend/__tests__/*.test.ts` | 264 PASS, 0 FAIL, 0 SKIP                                                                                                                                                                             |
| `pnpm --filter @plutonhq/core-frontend build`                         | PASS: 15 article/identity tests, 8 Fumadocs tests, docs/frontend typecheck, compiler/Vite/PWA/static docs copy                                                                                       |
| `pnpm --filter @plutonhq/core-backend exec tsc --noEmit`              | PASS                                                                                                                                                                                                 |
| `pnpm --filter @plutonhq/core-backend build`                          | PASS, including frontend/docs copy                                                                                                                                                                   |
| Internal links/navigation                                             | PASS through all 97 articles; 77 original URLs and 15 categories preserved                                                                                                                           |
| Focused formatting                                                    | PASS for new locale test, complete setup article, this report and workflow; inherited App/manifest/docs-test files already fail whole-file Prettier at base, so unrelated formatting was not applied |
| `pnpm --filter @plutonhq/core-frontend lint`                          | BLOCKED at unchanged existing ESLint configuration load: string `eslint-config-prettier` in typescript-eslint `extends`; no lint success claimed                                                     |
| Candidate privacy review                                              | No real secrets/production infrastructure found in the 29 intended text files; local pattern scan plus manual review; no dedicated secret scanner installed                                          |
| `git diff --check`                                                    | PASS                                                                                                                                                                                                 |
| Exact disposable teardown                                             | Owner-labelled containers absent; exact task image digest verified and its tag/image removed; no Docker prune or existing service changes                                                            |

The privacy scan's existing synthetic credential-URL negative policy test was
reviewed as intentionally invalid fixture data.
No credentials, screenshots, OCI archives, logs, generated builds, local tools,
fixtures, VM/SSH state or `tmp/` files enter the commit. Build warnings for
generated CSS/chunk size and old Browserslist data remain reported; no global
dependency/configuration changes were made to hide them. Hosted CI was not run
because publication is reserved to the user.

## Exact intended file inventory (29)

New files:

- `docs/DETERMINISTIC_AGENT_INTEGRITY_AND_OPERATIONS_AUDIT.md`
- `frontend/src/docs/articles/getting-started/complete-backup-setup.md`
- `installers/tests/install-agent.locale.test.cjs`

Modified runtime, CI and navigation/tests:

- `.github/workflows/test-agent-upgrade.yml`
- `documentation/src/App.tsx`
- `frontend/__tests__/docs.test.ts`
- `frontend/src/docs/manifest.ts`
- `installers/install-agent.sh`
- `installers/tests/upgrade-agent.test.sh`

Modified documentation:

- `readme.md`
- `docs/AGENT_UPGRADE.md`
- `docs/ARCHITECTURE.md`
- `frontend/src/docs/articles/architecture.md`
- `frontend/src/docs/articles/backup-plans/managed-agent.md`
- `frontend/src/docs/articles/changelog.md`
- `frontend/src/docs/articles/database-backup/artifacts.md`
- `frontend/src/docs/articles/deployment/rollback.md`
- `frontend/src/docs/articles/getting-started.md`
- `frontend/src/docs/articles/getting-started/quick-start.md`
- `frontend/src/docs/articles/operations.md`
- `frontend/src/docs/articles/reference/api.md`
- `frontend/src/docs/articles/remote-agent/troubleshooting.md`
- `frontend/src/docs/articles/remote-agent/updates.md`
- `frontend/src/docs/articles/replication/hcp.md`
- `frontend/src/docs/articles/replication/managed-agent.md`
- `frontend/src/docs/articles/storage/hcp.md`
- `frontend/src/docs/articles/storage/sftp.md`
- `frontend/src/docs/articles/troubleshooting.md`
- `frontend/src/docs/articles/troubleshooting/source.md`
