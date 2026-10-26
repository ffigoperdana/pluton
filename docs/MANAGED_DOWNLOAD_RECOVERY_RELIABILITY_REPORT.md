# Managed Download, Recovery and Snapshot Browser Reliability

Date: 2026-10-26. Base: `2919d08af25fc86b8f41b9511cf70189c8fae26a` (freshly fetched `origin/main`). Branch: `codex/managed-download-recovery-reliability`.

## Acceptance boundary

**Local candidate; production acceptance is pending.** No production connection, repository, Agent installation, service, permission, source policy, proxy configuration or database was changed. No push, merge or deployment was performed. Production plan/source identifiers and inventories are intentionally excluded from this public report. The operator must privately map the two reported failures to Case A and Case B below.

The confirmed filename validation defects are fixed. Regular-file/directory fixtures, including literal POSIX punctuation, now pass complete download and recovery with matching hashes. Complete exports containing symlinks or special nodes remain explicitly refused. A successful backup, preflight response, preview or Save As dialog is not treated as recovery acceptance.

## A. Confirmed causes and remaining production questions

### Case A: `unsupported-snapshot-file`

Code and real Restic 0.19.1 fixtures proved that `ManagedSnapshotIndex.assertSafe()` rejected **any colon anywhere in a path**, in addition to every node other than `file` and `dir`. A regular Linux file named `job:2026.txt` therefore produced the same generic error as a FIFO or symlink. This is a validation false positive, independent of logical snapshot size. It now downloads and restores on Linux with its original name and SHA-256 content.

Symlinks are a distinct compatibility boundary. The pinned [Restic listing implementation](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_ls.go) does not expose link targets. The [TAR dumper](https://github.com/restic/restic/blob/v0.19.1/internal/dump/tar.go) preserves them. The lab independently backed up an internal relative link, a broken link and an external absolute link: native TAR contained all three, including the external target. That TAR was inspected, **not extracted**.

Consequently the existing listing cannot prove safe link preservation. This patch does not follow links, guess their targets, rewrite them, add unbounded tree traversal or silently omit them. Complete operations return `symlink-target-unverified`, explaining that targets cannot be verified. Device/FIFO/socket entries return `unsupported-node-type`. Their metadata remains browsable; an explicitly selected ordinary file can still be staged independently. Full Download never substitutes that limited operation.

**Production pending:** the actual Case A trigger may be a colon, symlink, special node or another unsafe record. No production listing was available, so this report does not identify an actual offending filename or claim that the affected snapshot is repaired.

### Case B: `metadata-invalid`

The managed index reused `normalizeLegacySnapshotPath()`, whose stricter input policy rejects every `%`. A real Restic backup of `100%complete/%2e%2e:文件.txt` was valid but failed indexing with `metadata-invalid`. The managed listing is decoded JSON, not a URL. Treating literal percent characters as another encoding layer was incorrect.

A separate managed path policy now preserves exact decoded strings, without URL decoding or normalization. JSON/query transport performs its usual single encode/decode; `%2e%2e` remains a literal filename component, whereas an actual `..` component is refused. The lab extracted the literal name inside a private Linux destination, compared its hash, and staged that exact selected filename. Unicode and a nested path longer than traditional TAR header fields also passed.

Duplicate paths, ancestor conflicts, mismatched basenames, invalid timestamps/sizes, malformed schemas, wrong snapshot headers, truncated records and invalid UTF-8 remain failures. Index construction remains atomic; invalid partial indexes are not published. Safe diagnostic categories now distinguish `unsafe-path`, `invalid-node-name`, `duplicate-entry`, `invalid-timestamp`, `ancestor-conflict`, `invalid-size`, `metadata-schema-invalid` and `repository-output-invalid`. Arbitrary provider reasons are projected to closed categories rather than logged.

**Production pending:** a percent filename reproduces this error class; it is not proof of the actual Case B cause. Real corruption, transport errors and identity failures must still be distinguished using the actual snapshot.

### Agent installation/version differences

The traced monorepo Agent resolves and validates approved roots, checks state overlap, anchors v4 exclusions to the canonical source and invokes the private Restic binary without a shell. v4 performs bounded source scans; earlier payloads have different preflight coverage. Scans are capped at 10,000 entries/five seconds and explicitly report partial coverage. Nested symlinks are deliberately archived without traversing them. Thus backup completion can coexist with the older complete-export refusal; a newer installer does not establish a different Restic metadata schema or full source coverage.

Source Access uses durable effective-root/version bindings and canonical-directory checks. Backup exclusions and private-directory exclusions remain unchanged. Separately staged database artifacts use their receipt-bound paths. Multiple-root/SQL source mapping and exact snapshot receipts remain covered by existing recovery tests.

No authorized live Agent inventory or source-to-plan mapping was supplied. Installer generation, actual binary versions, service UID, allowed roots, bind mounts, upgrade history and effective selection on the reported machines are **not verified**. No plan was assigned to a reported host by inference. The local Agent source was compiled/tested; no installed or standalone Agent was upgraded.

### Browse reliability and stream diagnostics

The browser directly called `response.json()`, so an HTML 429/502/503/504 response produced the reported parser failure. File and directory panels also had separate indexing poll loops. The new bounded transport sanitizes non-JSON errors, shares one indexing probe and per-backup `Retry-After` cooldown, stops automatic retries on errors, and cancels waits/body handling on unmount. Aborts before a response or while reading JSON retain cancellation semantics and cannot publish a page or poison another panel with a synthetic server error. It retains no metadata pages and bounds coordination state to 64 backups. JSON bodies are capped at 8 MiB before parsing; server page limits remain 200 rows by default, 500 maximum. Focus/reconnect cannot restart failed file polling automatically.

A further cache defect was reproduced by the final regression run: LRU ordering used millisecond wall-clock timestamps. Equal timestamps could evict an index that had just been reused; backwards clock movement had the same problem. A frozen-clock baseline sequence `A -> B -> A -> C` incorrectly evicted A. The fix uses a monotonic access sequence for LRU while preserving wall time for TTL. The same probe now retains A and evicts B, and explicit equal/backwards-clock tests cover it. Healthy completed indexes were also reused across three repeated native browse operations without another metadata build. Rebuilds after the existing two-index LRU, 15-minute idle expiry, explicit failed-build retry or server restart remain intentional. No cache lifetime, disk limit or admission setting was raised.

A stream failure destroys HTTP, which itself aborts the request signal. The previous diagnostic ordering could relabel the original archive failure as client cancellation. Known process/timeout/index failures now retain their category; regression tests cover that secondary abort.

Generate Download had a separate unconditional JSON parse. It now uses the existing mutation-response contract: HTML 429/502/503/504 failures are sanitized, exact backup/replica identities are encoded, redirects and automatic replay are refused, and an accepted-but-unconfirmed response cannot trigger the native download. The existing managed UI says “Download started” and excludes the local blob-download path; it does not claim completed delivery.

## B. End-to-end contract and implementation

The verified path is: disposable source filesystem -> real Restic backup -> immutable full snapshot -> loopback read-only SFTP -> scoped Restic/Rclone session -> streamed NDJSON -> private SQLite manifest -> POST Generate Download -> authenticated GET -> streaming TAR -> client completion -> structural validation -> unprivileged Linux extraction -> inventory/hash comparison -> independent staged restores.

Production changes are limited to:

- `backend/src/utils/managedSnapshotPath.ts`: exact managed POSIX paths and separate Windows materialization checks.
- `backend/src/utils/restic/ManagedSnapshotIndex.ts`: managed path use, specific closed diagnostics, operation-specific host checks and clock-independent LRU ordering.
- `backend/src/utils/restic/ManagedSftpRepositorySession.ts`: classify schema rejection without exposing records or stderr.
- `backend/src/services/RemoteRepositoryRecoveryService.ts`: exact punctuation through recovery; retain known stream failure diagnoses after HTTP closes.
- `backend/src/controllers/BackupController.ts`: validate managed directory query paths under the same policy.
- `frontend/src/utils/managedSnapshotBrowse.ts`: bounded JSON, sanitized proxy failures, coordinated probes/cooldowns and cancellation.
- `frontend/src/services/backups.ts`: safe Generate Download response parsing and exact encoded identities, without automatic mutation retries.
- `ManagedSnapshotViewer.tsx` and `ManagedSnapshotDirectories.tsx`: honor indexing retry intervals and stop focus/reconnect refetches after errors. Classic layout, mobile navigation, selection and pagination remain intact.

Regression changes are in the existing controller/service/index/cache/session test files, `backend/__tests__/utils/managedSnapshotPath.test.ts`, `frontend/__tests__/managedSnapshotTransport.test.ts`, `frontend/__tests__/deleteClients.test.ts` (actual exported download client), and the `managedDownloadRecovery.{lab,helpers,restart}.ts` native fixtures. `scripts/validate-managed-download-recovery.ps1` provisions, checks evidence records and removes only its own generated containers/volumes. `scripts/build-managed-recovery-lab.mjs` bundles only fixture code for production-image verification; application imports resolve to the image's compiled modules and the fixture asserts the real UID 10001.

No dependency, lockfile, database schema, `.env` convention, Agent source, backup format, scheduler, retention, replication or Legacy runtime was changed. Authentication, ownership, repository/source binding, full IDs and snapshot tags are rechecked. No fallback snapshot, alternate repository, mirror, shell command or repository mutation was added. Repository reads retain `--no-lock --no-cache`.

Complete TARs stream from Restic to HTTP with backpressure. There is no full archive buffer or server-side temporary TAR. The test's `client.tar` belongs to the simulated recipient, outside server staging. The frontend still uses browser-owned native downloads. HTTP ends only after successful process completion and credential cleanup; failed partial TARs cannot be completed with appended JSON.

Linux archives preserve literal POSIX names. Windows staging refuses drive/ADS/reserved/trailing-dot or space aliases and directs the operator to a POSIX destination. Legacy paths and caller-selected staging subfolders keep their stricter policy. Existing limits on path length, controls, backslashes and ambiguous/lossy encoding remain documented compatibility boundaries.

## C. Before/after measured results

Times are actual single-run wall times, not promises about production. Random non-sparse bytes exercise I/O and compression; they are not sparse files. The 3.16 fixture is **GiB**, the 4.00 fixture is decimal **GB**. All source-byte figures also include a 28-byte selected file. Metadata-heavy content is highly deduplicated and deliberately stresses metadata rather than logical data volume.

| Fixture | Logical/physical source bytes | Files | TAR bytes | Preparation ms before -> after | Complete transfer s before -> after | Full restore/hash s before -> after |
|---|---:|---:|---:|---:|---:|---:|
| 120 MB | 120,000,028 | 2 | 120,005,120 | 2,484 -> 2,608 | 5.024 -> 5.061 | 3.795 -> 3.731 |
| 1.23 GB | 1,230,000,028 | 6 | 1,230,007,296 | 2,498 -> 2,681 | 23.677 -> 27.140 | 12.445 -> 14.566 |
| 3.16 GiB | 3,393,024,192 | 14 | 3,393,035,776 | 2,601 -> 1,895 | 58.645 -> 65.097 | 28.647 -> 29.387 |
| 4.00 GB, matched-harness repeat | 4,000,000,028 | 16 | 4,000,012,288 | 2,336 -> 2,510 | 70.243 -> 72.574 | 33.741 -> 38.447 |
| Metadata pressure | 640,028 | 80,001 | 163,844,608 | 7,842 -> 8,044 | 4.437 -> 4.771 | 41.455 -> 46.721 |

The 4 GB pair transferred at 54.31 -> 52.56 MiB/s; time to first byte was 1.587 -> 1.778 s. Its compressed repository occupied approximately 4.001 GB. The metadata fixture's repository occupied about 0.65 MB, whereas its TAR occupied 163.8 MB because of archive headers. Logical bytes, repository storage and transfer size are not interchangeable.

| Resource (MiB unless stated) | 4 GB before | 4 GB after | Metadata before | Metadata after |
|---|---:|---:|---:|---:|
| Parent Node peak RSS | 366.6 | 373.1 | 715.2 | 701.7 |
| Fresh server Node peak RSS | 334.2 | 333.9 | 565.4 | 578.7 |
| Sampled Restic peak RSS | 236.1 | 225.4 | 287.3 | 266.3 |
| Sampled Rclone peak RSS | 230.6 | 233.1 | 68.5 | 70.1 |
| Cgroup peak, including filesystem cache | 4,097.3 | 4,097.1 | 2,997.0 | 2,960.8 |
| Two completed SQLite indexes | 0.0703 | 0.0703 | 328.34 | 331.09 |
| OOM / OOM-kill events | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

Cgroup `memory.peak` can briefly exceed the 4,096 MiB configured charge limit during reclaim; the configured limit was not raised. Larger fixtures generated substantial page-cache reclaim (`memory.events.max`), without an OOM. Index allocation varied with timestamp/key layout; each metadata index remained below the unchanged 256 MiB limit. Earlier small baselines sampled one post-restart index; matched comparisons above sample two before shutdown and avoid reporting that instrumentation change as a doubled application cache.

The matched 4 GB whole-lab CPU totals were 516.317 -> 582.300 CPU-seconds; cgroup read/write I/O was 46.432/24.002 -> 46.569/24.002 GB. Those totals include fixture generation, three backups, hashing, transfer, restore, eviction and a fresh process. Other validation work ran on the shared laptop. The observed ~12.8% CPU increase and latency variation are reported, **not attributed to the fix or claimed as an optimization**. Further production profiling is an acceptance gate. No product resource cap was raised to obtain a pass.

There were at most two active repository sessions and two Restic children in the concurrent Download/Browse case; sequential fixtures had one. Repeated navigation added zero builds. Historical switching deliberately caused three LRU rebuilds and a new server process caused one additional build. There were no automatic container restarts. Every successful fixture removed its scratch tree and scoped credentials with zero active sessions.

### Streaming faults

- Slow recipient plus concurrent Browse: completed TAR, unchanged hashes, no new index build, at most two sessions.
- Browser cancellation: actual HTTP body was aborted and backend credentials/processes were cleaned.
- Restic termination: transfer failed after 512 bytes; it was never reported as a complete TAR.
- SFTP server termination: an initial 90-second client guard was insufficient and is not counted as server failure acceptance. The final probe waited for the existing policy: upstream retries ended after **230.724 s**, HTTP failed without client cancellation, and credentials/processes were cleaned. No production timeout was changed. Long retry occupancy remains an operator-visible limitation; pinned [Restic retry behavior](https://github.com/restic/restic/blob/v0.19.1/internal/backend/retry/backend_retry.go) explains why connection loss need not fail immediately.
- Real loopback proxy closure: PASS. A separate HTTP proxy destroyed both ends after the first TAR chunk; downstream failed, upstream cancellation settled, and scoped credentials were cleaned.
- Source/destination interruption, failed process exit, blocked writes including EOF, cancellation and inactivity cleanup retain existing deterministic session/controller coverage.
- Exact historical access after LRU eviction and a fresh OS server process completed successfully; no fallback to latest. A separate `history` fixture changes the selected source after each of three backups: the requested snapshot contains 28 bytes while the live file contains different 35-byte content. After eviction, a direct authenticated GET without another preparation POST and a fresh server process both returned the original complete TAR SHA-256. Extracted/restored files matched the original snapshot inventory, and the current source retained its newer content. Hashing is incremental; no full archive buffer was introduced.

## D. Docker Desktop laboratory and fidelity

Host: Windows 11 Pro, 16 logical CPUs, approximately 31.6 GiB physical RAM. Docker Desktop Linux Engine 29.7.2, Compose 5.4.0, `desktop-linux`; Docker VM reports 16 CPUs and about 15.4 GiB RAM. WSL inventory contained the Docker Desktop distribution. No `.wslconfig` or global setting was modified. Initial host free disk was about 149 GiB and the lab also checked at least 32 GiB free in its Linux filesystem.

Every filesystem fixture used one unprivileged UID-1000 container, read-only image, no network outside loopback, no host data/config/Docker socket, 2 CPUs, **4 GiB memory including its Node/Restic/Rclone/SFTP processes and page cache**, no swap, and a 192-process limit. `/tmp` and `/data` were bounded tmpfs mounts. Its generated labelled volume was removed after the run. The maximum 4 GB fixture working set is bounded by six data copies plus overhead (about 24 decimal GB); the runner checks disk headroom. This is a fixture budget, not a Docker block-device quota. It does not fill the laptop disk or modify global storage settings.

This is **not equivalent to a complete 4-GiB VM**. Docker/WSL kernel/daemon overhead and independent test containers are outside that cgroup. Client-side archive/extraction and fixture generation are inside it, making it a deliberately different workload from the application alone. Process RSS is sampled every 100 ms; cgroup peak includes setup and caches. Background laptop work prevents precise causal CPU comparisons.

Database source/target fixtures were separate, disposable, bounded Linux tests. The larger *test framework* also needs more memory than the running application: a full Jest attempt was OOM-killed at 2 GiB; Windows Jest peaked near 4.9 GB. A separate 6-GiB runner with 256 PIDs reached OS-thread/process limits in persistence subprocess tests. Those artificial test-runner limits do not describe the 4-GiB native application fixtures. The final full CI-matched run passed 200 suites / 4,057 tests with seven existing conditional skips and a clean exit; its separate test-framework budget was 6 GiB / 512 PIDs. No runtime/server limit was increased.

## E. Recovery capability matrix

`BLOCKED` means complete operation securely refused, not a silently incomplete success. Database rows describe separate tiny SQL fixtures, not databases embedded in the 1-4 GB filesystem datasets.

| Operation | Small | 1-4 GB | Metadata-heavy | Symlink/FIFO fixture |
|---|---|---|---|---|
| Generate Download | PASS | PASS | PASS | BLOCKED |
| Complete TAR transfer | PASS | PASS | PASS | BLOCKED |
| TAR structure/termination and extracted SHA-256 | PASS | PASS | PASS | BLOCKED |
| Full staged filesystem restore | PASS | PASS | PASS | BLOCKED |
| Exact selected file restore | PASS | PASS | PASS | PASS |
| Full restore preview | PASS | PASS | PASS | BLOCKED |
| Recovery Test filesystem validation | PASS | PASS | PASS | BLOCKED |
| Database recovery | PASS (separate fixtures) | NOT TESTED | NOT TESTED | NOT TESTED |

TAR acceptance requires complete HTTP delivery, correct headers, 512-byte alignment and two final zero blocks, parser completion, safe entry structure and successful unprivileged extraction. SHA-256 inventories, directory structure and ordinary permission bits were compared. Source file contents, structure and ordinary permissions, and all repository objects/lock inventories, were hashed before/after read operations and remained unchanged. Access-time changes caused by ordinary reads are not treated as content mutations. No unrelated destination was overwritten. Custom restore destinations remain private validated staging subfolders; no in-place production restore is enabled.

Real Agent -> MariaDB/PostgreSQL private dumps -> SFTP/Restic -> staged filesystem and SQL-only artifact restore -> disposable database import passed. The source databases were stopped before recovery. Receipt hashes, restored table content, source trees, repository immutability and workspace/database cleanup passed. Genuine Oracle MySQL worker verification passed all 12 TLS/import/error/cancel/restart scenarios against a separate disposable target. That worker check is **not claimed as a fresh complete MySQL source-Agent-to-snapshot pipeline** or as validation of a production MySQL database.

## F. Validation and reproducibility

Use Node 24 and pinned pnpm 10.20.0; keep the existing lockfile. No tests, assertions, CI steps or production guards were disabled. Existing conditional platform/native-fixture skips are reported explicitly.

```powershell
./scripts/validate-managed-download-recovery.ps1 -Baseline -BaselineRef 2919d08af25fc86b8f41b9511cf70189c8fae26a
./scripts/validate-managed-download-recovery.ps1
node --experimental-strip-types --test frontend/__tests__/*.test.ts
pnpm --filter @plutonhq/core-backend test --runInBand --silent --verbose=false
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-frontend exec tsc -b
pnpm --filter @plutonhq/pluton-agent typecheck
pnpm build
docker build -f Dockerfile.source --target production -t pluton-managed-download-reliability:local .
./scripts/validate-managed-download-recovery.ps1 -PackagedRuntime -Modes proxy,history,colon,percent
```

The lab image must provide the existing native fixture dependencies and pinned Restic 0.19.1/Rclone 1.75.1 (`agent/test-fixtures/phase5/RealDatabase.Dockerfile`). Native source-backed acceptance ran on Node 24.16.0; CI-matched frontend/backend regressions and the production image use Node 24.22.1. The HTTP fixture uses the real authenticated router, controller, BackupService, recovery service, session, binaries and SQLite index. Disposable in-memory domain stores replace production plan/backup/Agent persistence; the full application bootstrap and real proxy infrastructure are not implied by this fixture. Existing application route/auth/CSRF suites remain in the backend regression run.

Current recorded checks:

- Windows backend: 200 suites, 4,056 assertions passed, four existing conditional skips. Later diagnostic-order and frozen/backwards-clock regressions add four cases, covered in the final Linux run and Windows focused suite. The Windows process remained open on pre-existing resource handles; `--detectOpenHandles` traced unchanged MySQL importer fixture sockets and logger workers. The identified completed runner was stopped after recording results; no `--forceExit` was used.
- Linux focused backend: nine suites, 359 tests passed, no skips; the final Windows focused suite passed all 269 tests across six suites, including the added diagnostic and clock cases.
- Final frontend: 324 passed on each of Windows and CI-matched Linux Node 24.22.1, no skips. Final full Linux backend: 200 suites, 4,057 passed, seven existing platform/native-fixture skips, exit 0. Test-only runner memory/PID limits were 6 GiB/512 after the measured framework resource failures; application-fixture limits stayed at 4 GiB/192.
- Unchanged Agent on unprivileged Linux: 121 passed, 36 existing opt-in/native-fixture skips. Actual native Agent/DB behavior was additionally exercised by the MariaDB/PostgreSQL integration cases.
- Backend lint and both type checks passed. The full frontend lint command remains blocked before source analysis by the existing `typescript-eslint.config()` string `eslint-config-prettier` configuration error. The three changed Browse sources pass the same rule set using a local resolved-config copy. The existing backup service has 42 errors/one warning under that configuration, compared with 44 errors/one warning in its baseline; no new diagnostic points to the changed preparation logic. No tracked lint configuration or rule was weakened.
- Root production build passed (three tasks). Final source production Docker image compiles backend/frontend and validates its native clients as the runtime UID. The final image was rebuilt after the application changes, and its compiled backend passed the UID-10001 fixture cases.

A Linux cancellation test exposed a one-millisecond fixture assumption; its cancellation phase now freezes the clock to assert the actual waiting state, rather than relying on a sleep or enlarged deadline. Initial incomplete harness executions after a local encoding-write failure were discarded. A repaired UTF-8 fixture and explicit required result/cleanup records prevent an empty script or bare exit code from counting as acceptance. Real failure categories, rather than assertion removal or timeout increases, drive the regression changes.

## G. Minimal production evidence procedure (operator only; pending)

1. Privately map each affected **backup ID -> plan -> persisted source ID -> registered Agent ID -> original repository binding** using authorized application metadata. Do not infer mapping from a machine address, plan title or installer age. Record the full completion snapshot ID and compare privately with the exact repository snapshot; do not publish IDs or inventories here.
2. Record existing Agent version/deployment generation, negotiated payload/diagnostic version, service UID, effective policy/root version, canonical-root validation result, saved selection/exclusions and pinned Restic/Rclone versions. Use existing inventory and read-only local inspection; do not reinstall, restart, reenroll, change permissions/policy or recursively scan on page load. Bounded preflight and partial-scan semantics are documented in [SOURCE_ACCESS_DIAGNOSTICS.md](SOURCE_ACCESS_DIAGNOSTICS.md). Its generic example paths must be replaced privately with already authorized selections, not used to authorize a new source.
3. Inspect each exact snapshot through the approved original SFTP read-only path with `--no-lock --no-cache`. Stream rather than save/share raw `ls --json --long` output. Privately classify node-type counts, literal punctuation/encoding flags, duplicate/ancestor/name/time/size failures, header identity and source-root mapping. Return only closed categories, aggregate counts and booleans; no filenames, repository credentials, SQL, raw stdout/stderr or directory inventories. If the read-only contract cannot be met, stop; never unlock or fall back to write credentials.
4. After an independently approved candidate deployment, repeat authenticated Generate Download for the exact historical backup. Collect its safe `code`/`reason`, request outcome and preparation time. A continued symlink/special-node refusal is a known complete-operation boundary, not corruption and not evidence that regular data was omitted.
5. Independently verify full TAR completion/extraction and hashes through the actual proxy, using an independent trusted inventory captured at backup time when available. The current live source may have changed and must not be invented as a historical reference. Then verify full/selected staging and receipt-bound database recovery into disposable authorized targets. Collect 429/502/503/504 counts, valid `Retry-After`, indexing build counts, session occupancy, CPU/RSS/cache/disk measurements and server restart behavior. Do not change BunkerWeb limits based solely on these synthetic results.

The actual Case A/Case B failure condition, source-host mapping, installation differences and real download/restore outcomes remain **PENDING**. A production GO requires those checks and operator acceptance.

## H. Controlled deployment and rollback plan (not executed)

- Publish/review the branch and CI manually. Build an immutable candidate image and record its digest; retain the currently deployed image digest and approved configuration. Do not use a moving tag as rollback identity.
- Obtain a consistent SQLite backup using its backup mechanism, preserve encryption keys/Agent identities, and back up private application configuration and existing storage/restore mounts securely. Do not copy only a live database file while ignoring WAL consistency; do not place these backups in Git or this report.
- Use the existing approved maintenance/deployment procedure, preserving `/data`, keys, original repository bindings and storage mounts. No schema migration or backup-format change is introduced. No production Compose, proxy, resource cap or Agent upgrade is part of this patch.
- Verify health/auth/CSRF, then the operator procedure above on the two exact historical snapshots. Keep recovered output isolated. Cancelled/failed transfers must not leave repository processes or scoped credentials; observe index reuse and genuine resource headroom.
- Roll back by selecting the saved previous immutable application image with the same data/config/key mounts. Do not delete/reinitialize/rekey any repository or application SQLite state. Stop active operations before cache maintenance. Disposable metadata indexes may rebuild under the existing bounds; never delete completed restore workspaces or main application data as cache cleanup.

## Final verification

The final LRU-corrected 4 GB native run also passed every transfer/hash/restore/restart check: 2,788 ms preparation, 71,154 ms transfer (53.61 MiB/s), 1,951 ms first byte, 37,259 ms full restore/hash, 365.3 MiB parent Node peak RSS and zero OOM events. No synthetic result changes the production-retention/Agent boundaries above. The packaged backend was exercised as UID 10001 with compiled production imports (not source overlays): the 120 MB/proxy, colon and percent/Unicode/long-path fixtures passed complete HTTP/TAR/hash validation, full and selected restore, Recovery Test and a fresh server process.

After the final Generate Download response fix, the production image and native client gate were rebuilt successfully. Its historical-content fixture passed again: 2,503 ms preparation, 1,991 ms transfer, 2,617 ms restore/hash, matching complete TAR SHA-256 after eviction and a fresh process, zero OOM events and complete cleanup. The local image manifest-list digest is `sha256:79a1fb437f3681e39d90dc2bd8d4f33ce55bfdd9901aaca521dcc333b9372576`; it was not pushed. Five UI/transport repetitions passed 130 cases; five complete cache-lifecycle repetitions passed 95 cases. Both frontend platforms passed all 324 tests. Backend lint, both type checks, focused Browse lint and the final three-task production build passed; the existing frontend configuration/service lint limitations are recorded above.

- DOWNLOAD: PASS for supported regular-file/directory Linux fixtures; BLOCKED for complete symlink/special-node exports.
- TAR INTEGRITY: PASS for completed supported fixture transfers.
- FILE RESTORE: PASS for supported full and exact selected staged recovery; complete unsupported-node recovery remains BLOCKED.
- DATABASE RECOVERY: PASS for disposable MariaDB/PostgreSQL pipelines and independent Oracle MySQL worker scenarios; full fresh MySQL source pipeline NOT TESTED.
- BROWSE FILES: PASS locally, including deterministic LRU ordering, bounded requests, desktop/mobile selection and proxy-response handling.
- 4 GiB RESOURCE TEST: PASS for the constrained filesystem fixture cgroup; full VM-equivalent acceptance BLOCKED by lab fidelity and pending production profiling.
- PRODUCTION SNAPSHOT RETEST: PENDING. **No production GO recommendation.**
