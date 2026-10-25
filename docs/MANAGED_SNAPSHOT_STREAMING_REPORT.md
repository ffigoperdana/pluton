# Managed snapshot streaming delivery report

Validated 2026-10-25. Branch `codex/managed-snapshot-streaming-fix` starts from
freshly fetched `origin/main` at `5cfaa3cf2bbebe1853ad75ddca57596012643dc7`.
This is local implementation/validation only: no push, PR creation, merge,
deployment, service restart, production repository or live credential access.

## Root cause and implementation

`ManagedSftpRepositorySession.run()` limited complete stdout to 32 MiB.
`files()` used that buffered path for `restic ls`, and `boundFiles()` converted the
result into another complete array plus a duplicate-path set. Browse, prepare
download, archive prevalidation, restore preview/preparation/execution, recovery
testing and database artifact checks all inherited the limit. The browser also
indexed every returned record in Dexie. HTTPS/proxy changes could not fix this
metadata architecture.

Managed listings now use bounded NDJSON parsing and a private disposable SQLite
index. A successful complete process, metadata/path/type/duplicate/ancestor checks,
exact historical snapshot/tag proof and current binding validation are required
before publication. Paginated browse and restore-wizard selection return bounded
pages. Full recovery uses iteration/index lookup; granular recovery is separately
bounded. Display previews/results are explicitly capped without changing validated
totals or execution. TAR remains a direct backpressured stream, with validation
before headers, explicit exit verification, cancellation and scoped cleanup.

The [architecture and operator runbook](MANAGED_SNAPSHOT_STREAMING.md) contains
the exact API, errors, resource limits, troubleshooting, compatibility, production
acceptance checklist, nine deployment steps and five rollback steps.

## Validation results

| Check | Result |
| --- | --- |
| `pnpm --filter @plutonhq/core-backend test --runInBand --silent --verbose=false` | 198 suites passed; 3,986 tests passed, four Windows/platform cases skipped; 199.219 seconds |
| `node --experimental-strip-types --test frontend/__tests__/*.test.ts` | 302 passed, zero failures/skips |
| `pnpm --filter @plutonhq/core-backend test:mcp` | 46 passed |
| `node --test scripts/__tests__/apiInventory.test.mjs` | Passed; 173 HTTP contracts, new endpoint remains administrator-session-only |
| Backend `tsc --noEmit -p tsconfig.json` and frontend `tsc -b` | Passed |
| `pnpm --filter @plutonhq/core-backend lint` | Passed |
| `pnpm build` | All three build tasks passed, including frontend/docs and backend |
| `docker build -f Dockerfile.source -t pluton-managed-snapshot-validation:local .` | Passed; final image built locally, no application/production deployment |
| `pwsh -NoProfile -File scripts/validate-managed-snapshots.ps1` | All generated sizes and both real SFTP fixtures passed |
| `pwsh -NoProfile -File scripts/validate-phase6.ps1 -Modes phase6-mixed` | Native MariaDB/PostgreSQL SQL-only staging, SQL SHA-256, imports, full filesystem verification and cleanup passed; repository/source unchanged |
| Linux disposable snapshot/recovery Jest suites | Five suites passed, 194 tests passed, one conditional platform case skipped; private permissions, symlink/staging, native client ownership and metadata/download/recovery checks exercised |
| `git diff --check` | Passed |
| `pnpm --filter @plutonhq/core-frontend lint` | Pre-existing configuration failure before file linting: `typescript-eslint.config()` rejects string `eslint-config-prettier` in `extends`; config unchanged from main |

Four full-suite Windows skips concern symlink artifact/staging escape, recovery
client executable ownership, native client preflight and Linux mount discovery.
Native fixtures exercise Linux staging, private permissions, complete restored
manifests and database clients. The unchanged generic Linux mount-discovery case
is outside this fix. Build output also retains existing Fumadocs CSS/browser-module,
large-bundle, Browserslist and experimental-loader warnings; these do not fail
the production builds. No failing backend/frontend test was waived or weakened.

The existing lockfile and dependencies are unchanged. Local checks used pinned
pnpm 10.20.0 and Node 24.16.0; the source production image verifies its pinned
Node 24.22.1 runtime. Test data, configs and generated artifacts are private and
excluded from the commit.

## Measured load evidence

The runbook records fresh-process generated results for 22, 5,000 and 100,000
files under a 128 MiB JS heap cap. For 100,000 files: 49,888,890 bytes of fragmented
NDJSON, 83,200,000,000 logical content bytes, 1,896 ms indexing, 175,640,576 bytes of
SQLite disk, 123,588,608 peak Node RSS bytes, 19,469,560 sampled heap bytes, and
28.69/31.77 ms p50/p95 page-query latency. Module/runtime baseline RSS was
95,404,032 bytes. Logical content is metadata only in this generated test.

Final real-binary fixture with a concurrent independent disposable backup:

| Measurement | Observed value |
| --- | ---: |
| Regular files in selected historical snapshot | 100,000 |
| Actual Restic metadata stream bytes | 52,357,757 |
| Initial indexing and concurrent fixture backup completion | 38,880 ms |
| Cached authenticated/SFTP page request | 917 ms |
| Download validation until headers ready | 1,648 ms |
| Download/complete TAR parsing and final checks | 5,576 ms |
| TAR files verified / bytes streamed | 100,000 / 102,403,072 |
| Disposable index disk | 247,898,112 bytes |
| Peak Node RSS | 296,259,584 bytes |
| Whole isolated container peak | 1,223,643,136 bytes, under its 2 GiB limit |
| Temporary TAR disk | 0 bytes |

The isolated container peak includes fixture source files/tmpfs, Node, Restic,
Rclone, the index and concurrent backup work. The native fixture uses tiny files,
not 77 GiB of content. The 38.9 second cold run overlaps the fixture backup and
workstation validation activity; its timer includes awaiting that backup before
measurement completes. It must not be interpreted as a production indexing SLO.
An earlier native run without concurrent backup took 10,509 ms to index, illustrating
why measured workload context matters. Large real-network archive completion and
the actual operator snapshot remain production acceptance work, not claimed here.

## Preserved security and compatibility

The administrator boundary, plan/backup/source/storage/repository ownership,
full snapshot ID and required tags are retained and rechecked on cache hits.
Credentials remain scoped, redacted, absent from argv/API/index rows, with child
process cleanup after close. Sessions still allow only no-lock/no-cache inspection,
fixed full TAR dump and staging restore with overwrite never. Invalid metadata,
duplicate/traversal paths, unsafe ancestors and selected special nodes fail closed.
No partial index/preview page becomes restore evidence. SQL receipt validation,
size/hash/native import checks, staging containment and capacity limits remain.

No database migration, new environment variable, dependency, standalone Agent
change or protocol upgrade is required. Agent 0.7.1 and existing stored snapshots
remain compatible. Deploy matching frontend/backend assets: old managed clients
requesting arrays above 5,000 entries receive `pagination-required` and must use
the new endpoint. Local, sync and legacy access are unchanged. Primary storage,
secrets, managed backup/retention and HCP replication semantics remain unchanged;
no replica browsing/failover was added.

Known bounds: two 256 MiB index slots, one construction, two recovery repository
sessions and 15-minute idle expiry; very long paths can reach disk bounds before
the 500,000-node limit. One server process owns a data directory. Idle expiry is
extended by active reads and leases. Search remains within the current directory.
No TAR resume/range support; interruptions require retry. Foreground-only indexing
is cancelled when its last waiter cancels; browse-started indexing continues under
its own deadline. Windows ACLs depend on its private data-directory permissions.
Frontend lint needs a separate configuration repair; no unrelated config change
was bundled to hide that failure.

## Changed files

Runtime:

- `backend/src/utils/restic/ManagedSnapshotIndex.ts` — disposable index/cache, leases, pages, limits and closed failures.
- `backend/src/utils/restic/ManagedSftpRepositorySession.ts` — incremental parser, streaming session, process/session bounds and archive diagnostics.
- `backend/src/services/RemoteRepositoryRecoveryService.ts` — complete indexed browse/download/recovery/database validation and bounded previews.
- `backend/src/services/BackupServices.ts` — paginated managed dispatch.
- `backend/src/controllers/BackupController.ts` — strict page validation, indexing responses, safe codes/statuses.
- `backend/src/routes/backups.ts` — authenticated page endpoint.
- `backend/src/utils/recoveryValidation.ts` — bounded filesystem walk and indexed complete-manifest verification.
- `backend/src/createApp.ts` — owned metadata shutdown cleanup.
- `frontend/src/utils/managedSnapshotBrowse.ts` — authenticated cancellable page client.
- `frontend/src/components/Plan/SnapshotViewer/ManagedSnapshotViewer.tsx` — paginated browse/selection with retry and indexing status.
- `frontend/src/components/Plan/SnapshotViewer/SnapshotViewer.tsx` — managed viewer dispatch, keeping the existing local viewer.
- `frontend/src/components/Plan/SnapshotViewer/SnapshotViewerFile.tsx` — selection mode action support.
- `frontend/src/components/Plan/Backups/Backups.tsx` — opens managed browse without loading all files.
- `frontend/src/services/backups.ts` — disables whole-list queries for managed restore selection.
- `frontend/src/components/Restore/RestoreWizard/RestoreWizard.tsx` — paginated managed selection.
- `frontend/src/components/Restore/RestoreWizard/RestorePreviewStep.tsx` — explicit preview truncation.
- `frontend/src/components/Restore/RestoreWizard/RestoreConfirmStep.tsx` — complete validated selection count wording.

Regression/load validation:

- `backend/__tests__/utils/restic/ManagedSnapshotIndex.test.ts`
- `backend/__tests__/utils/restic/ManagedSftpRepositorySession.test.ts`
- `backend/__tests__/services/RemoteRepositoryRecoveryService.test.ts`
- `backend/__tests__/controllers/BackupController.test.ts`
- `backend/__tests__/routes/backups.test.ts`
- `backend/__tests__/integration/managedSnapshotIndex.load.ts`
- `backend/__tests__/integration/managedSnapshotStreaming.smoke.ts`
- `backend/__tests__/integration/managedSftpRecovery.smoke.ts`
- `frontend/__tests__/managedSnapshotBrowse.test.ts`
- `scripts/validate-managed-snapshots.ps1`

Documentation:

- `docs/MANAGED_SNAPSHOT_STREAMING.md`
- `docs/MANAGED_SNAPSHOT_STREAMING_REPORT.md`
- `docs/ARCHITECTURE.md`
- `docs/API_COVERAGE_MATRIX.md`
- `docs/api-inventory.json`
