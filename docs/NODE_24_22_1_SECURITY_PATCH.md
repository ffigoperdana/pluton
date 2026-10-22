# Server Node.js 24.22.1 security maintenance

This patch targets the source-built GHCR Server image and its optional Oracle
MySQL worker. It does not deploy anything or change API contracts, schemas,
environment settings, Agent distribution, application dependencies, pnpm 10.20.0,
or the lockfile. Production acceptance remains an operator responsibility.

## Release and image identity

[Node's official 2026-10-21 security release](https://nodejs.org/en/blog/release/v24.22.1)
is 24.22.1 LTS (Krypton). Relevant changes include stricter TLS IP and DNS name
validation, Brotli decompression hardening, HTTP agent handling, crypto random
cache reset, updated root CAs, OpenSSL 3.5.9 and Undici 7.30.1. Invalid certificates
or noncanonical IP endpoints must be corrected; never disable TLS verification.
Real private S3/HCP/SFTP endpoints and external proxy interoperability are not
proven by synthetic tests.

Official Docker registry manifests were inspected before editing. These are
multi-platform **base image index digests**, not published Pluton image digests:

| Use | Exact new base |
| --- | --- |
| All three `Dockerfile.source` Node stages; disposable native DB fixture | `node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53` |
| Both `Dockerfile.mysql-recovery-worker` stages | `node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205` |

The previous app reference was `node:24.16.0-alpine`; it resolved to Alpine 3.24.
The previous worker was `node:24.16.0-bookworm-slim` at index
`sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203`.
The musl/glibc separation is preserved. Oracle 8.4.11 package identity, hashes,
signed APT metadata and native client verification are unchanged. Final app and
worker build stages explicitly reject a runtime other than `v24.22.1`.

Server CI in `ci-backend.yml`, `container.yml`, `release-assets.yml` and
`release-please.yml` now uses exact `24.22.1` instead of moving major `24`.
The existing required runtime-boundary job checks the actual final-image Node
version, UID/GID 10001 and absence of fixtures/private state. It cannot pass solely
because a builder used the new version. No checks or publish conditions changed.

## Remaining runtime references and scope

- `Dockerfile` consumes prebuilt `pkg` executables on Debian. It is **not** the
  source-built GHCR publishing path. `scripts/build-executables.js` and
  `package.json` select `node24-*`; pkg supplies its own embedded runtime. Updating
  the CI host does not prove that runtime is 24.22.1. Those executables and the
  prebuilt-binary Docker path are **not certified by this patch**. Independently
  inspect the packaged runtime before approving any such release.
- `installers/install-agent.sh` and `test-agent-upgrade.yml` retain the separate
  legacy Agent's private Node 22.18.0 contract. Existing standalone Agents and
  their `AGENT_INSTALL_COMMIT` are not updated by this Server patch.
- `agent/test-fixtures/phase5/Dockerfile` retains its overridable Node 24 Bookworm
  test default. `validate-product-hardening.ps1` retains its Node 20 shell-only
  historical-installer refusal fixture. Neither supplies the production Server.
- `scripts/automatic-recovery-vm-bootstrap.sh` retains its reviewed 24.16.0
  archive/checksum/version check. It is a privileged historical disposable-VM
  launcher, excluded from application images, and was not run or silently
  reapproved. Do not use it as security-release evidence; a future VM rehearsal
  needs a separately reviewed updated launcher.
- The old-version rejection case in `runtimeReleaseBoundaries.test.cjs` is
  intentional. Historical 24.16.0 observations remain unchanged in
  `AUTOMATIC_RECOVERY_CONTAINER_LIFECYCLE.md`, `COMPACT_DASHBOARD_ROW_ACTIONS.md`,
  `DATABASE_RECOVERY_CLIENTS_REPORT.md`, `DELETE_REMOVE_TABLE_UX_REPORT.md`,
  `FUMADOCS_MIGRATION_REPORT.md`, `INTERNAL_DATABASE_RECOVERY_AND_RESTORE_REPORT.md`,
  `MYSQL_INTERNAL_AUTOMATIC_RECOVERY.md`, `MYSQL_RECOVERY_WORKER_REPORT.md`,
  `OPERATIONAL_HARDENING_REPORT.md`, `SELFHOSTED_PRODUCT_HARDENING_REPORT.md`,
  `UI_THEME_SNAPSHOT_PAGINATION.md` and `VERIFIED_PRODUCTION_FIXES.md`.

## Operator deployment and rollback procedure — not executed

Use the existing reviewed host bundle and its approved ordered overlays. The
following is a review checklist, not authorization to operate production:

1. Publish only through the approved GitHub workflow after review and green CI
   on the exact final commit. Verify app/worker provenance, source SHA, platform
   and immutable registry digests. Local test image IDs are not GHCR provenance.
2. Privately record the currently running image digest, mounts, approved overlays
   and deployment state. Secure a consistent SQLite/WAL backup plus existing
   configuration, application keys and offline encryption-key recovery evidence.
   Never print secrets or paste full container/environment inspection output.
3. Drain backups, restores, native imports/cleanup and replication; prevent new
   scheduled work during the window. Reconcile pending Agent/Source Access work
   without applying policy as part of this patch. If work cannot drain, stop.
4. Pull the approved **digest**, then inspect the candidate in isolation before
   changing the running service:

   ```sh
   docker pull 'ghcr.io/example-org/pluton@sha256:<approved-app-digest>'
   docker run --rm --network none --read-only --user 10001:10001 \
     --cap-drop ALL --security-opt no-new-privileges:true --entrypoint node \
     'ghcr.io/example-org/pluton@sha256:<approved-app-digest>' --version
   # Required result: v24.22.1
   ```

5. With separate deployment approval, use the installed, reviewed bundle:

   ```sh
   cd /opt/pluton
   sudo sh ./deploy.sh 'sha256:<approved-app-digest>'
   sudo sh ./status.sh
   ```

   `deploy.sh` validates the effective stack, image and mount contract before
   stopping only Pluton, takes a consistent stopped SQLite copy, and recreates
   only `pluton` with `--no-deps`. Preserve `/data`, `.env`, keys, database/Agent
   identity and repository credentials. Do not run init, rotate secrets, copy a
   checkout over the host bundle, or manually recreate unrelated services.
   If an already-enabled optional worker also needs this runtime patch, review
   its matching immutable image and drain/recreate only that worker separately;
   `deploy.sh` does not update or automatically activate it. Do not enable MySQL
   Internal or alter host operators/resource guards for this maintenance.
6. Verify the actual running app reports `v24.22.1`, immutable image and mounts
   match, and bounded GET `/api/health` plus Docker health pass. Verify login,
   sessions, existing Agent 0.7.0 heartbeat/polling/signatures, source policy,
   queue/schedule status, representative snapshot listing and authorized
   disposable backup/restore checks. Watch sanitized TLS/crypto/storage errors.
   Do not accept success from container startup alone or run destructive tests
   against real repositories. Resume schedules only after acceptance.
7. On health, authentication, Agent, storage, TLS or integrity regression, drain
   again and use the recorded previous immutable image with the same overlays:

   ```sh
   sudo sh /opt/pluton/rollback.sh
   sudo sh /opt/pluton/status.sh
   ```

   The deploy helper automatically attempts verified image rollback on failure.
   Rollback never restores old SQLite or reverses migrations. This patch adds no
   migrations; any concurrent schema changes still require separate review. If
   rollback health cannot be proven, stop and investigate without resetting data.

`AGENT_INSTALL_COMMIT` remains a reviewed standalone Agent **Git commit SHA**,
not an app/worker image digest. No production environment update is required
solely to change the Node base; keep existing Agent distribution settings intact.

## Validation record

Local disposable validation results are recorded below before the local commit.
Hosted CI, published Pluton digests and production acceptance require subsequent
manual publication/review; none are claimed here.

| Check | Local result |
| --- | --- |
| Official private test executable | Windows `node.exe` 24.22.1 verified against official SHA-256 `d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5`; no system Node change |
| Real app and Oracle worker Docker builds | PASS, linux/amd64; both final runtimes report `v24.22.1`, OpenSSL `3.5.9`, Undici `7.30.1`, UID 10001 |
| Final-image release boundary | PASS, 1,670 intended files inspected, no fixture/private-state payload |
| Runtime/package/deployment Node regressions | 34 PASS on Linux; includes pinned archive success and all negative integrity/admission cases |
| Release/enrollment distribution contracts | 13 PASS |
| Backend full Jest suite | 187 suites initially PASS; four harness-limited suites subsequently PASS (35 + 16 focused tests); all 191 suites covered, seven existing skipped tests |
| Frontend | 269 PASS; typecheck PASS |
| Backend/Agent types and backend lint | PASS |
| Production workspace build | PASS under patched Node, frontend/docs/Agent/backend built; existing CSS/chunk warnings remain |
| In-tree Agent compatibility suite | Windows 77 PASS / 80 SKIP; Linux nonroot 121 PASS / 36 SKIP |
| Compiled HTTPS/LAN integration | PASS, real synthetic login/session/logout and cross-origin refusal through local TLS termination |
| Actual immutable deployment/rollback fixture | 17 PASS, SQLite state, secrets, overlays and unrelated service preserved; fixture resources removed |
| Native MariaDB/PostgreSQL imports | PASS, catalog/content/ownership cleanup, malicious psql archive refusal; servers confined to separate fixture |
| Real Oracle MySQL worker | All 12 PASS: TLS/import, wrong password/marker, existing DB, SQL failure, client command, digest/binding, cancellation, restart, bad TLS and unavailable worker |
| Actual final-image crypto/backup | PASS AES-256-GCM and Brotli round trips; encrypted native Restic synthetic file/archived-SQL backup, snapshot listing and byte-identical restore |
| Actual final-image startup/shutdown | PASS bounded GET health, SIGTERM exit 0/stopped, synthetic password/key absent from logs |
| Frontend ESLint | Existing FAIL: typescript-eslint config rejects string `extends` entry `eslint-config-prettier`; unchanged, not suppressed |
| Hosted CI / published app digests / production | NOT TESTED or NOT PUBLISHED; no push, deployment or production access |

The initial Windows backend run was stopped after sandbox file/loopback permission
failures. Linux full-suite harness initially omitted the reviewed root operator
modules, used a UID absent from the builder's passwd database, and owned sticky
`/tmp` with a non-root UID. This correctly triggered module resolution failures,
the Windows ACL test's `userInfo()` failure, and Source Access's ancestor guard.
Only the four affected suites were rerun with read-only operator source mounts,
the builder's existing non-root user and normal root-owned sticky `/tmp`; all
passed without changing code or assertions. Likewise Agent child-process tests
require container `--init` for reaping. No ownership guard was relaxed. Windows
shell adapters could not execute in the sandbox; the Linux 34-test run above is
the authoritative package-install regression result.

Agent skips include fixture-gated real database/SFTP/Restic workflows and
root-only cases, not deleted tests. Real standalone Agent 0.7.0 binaries,
production proxy/CA chains, SFTP servers and SITP/HCP interoperability were not
accessed. Server distribution settings, signed command/heartbeat/lease protocols,
Source Access and replay protections were exercised by existing tests, but this
does not certify every external Agent installation or storage endpoint. No new
full TTL, VM reboot or privileged host recovery rehearsal was performed.

Reproduction commands (pinned pnpm 10.20.0; run Node checks with 24.22.1):

```sh
pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-frontend exec tsc -b
node --experimental-strip-types --test frontend/__tests__/*.test.ts
node --test scripts/__tests__/runtimeReleaseBoundaries.test.cjs scripts/__tests__/mysqlRecoveryWorkerImage.test.cjs scripts/__tests__/deployment.test.cjs
node --test scripts/__tests__/releasePlease.test.cjs scripts/__tests__/agentEnrollmentDistribution.test.cjs
pnpm --filter @plutonhq/pluton-agent typecheck
pnpm --filter @plutonhq/pluton-agent test
pnpm build
git diff --check
```

The existing PowerShell disposable runners used were `validate-deployment.ps1`,
`validate-dual-origin.ps1 -Compiled`, `validate-database-recovery-clients.ps1` and
`validate-mysql-recovery-worker.ps1`, with unique local patched images supplied
explicitly. Each owns randomized synthetic resources and removes only those
resources. No global Docker configuration, existing service or real repository
was modified. Local images/build cache are retained; no broad Docker prune ran.
