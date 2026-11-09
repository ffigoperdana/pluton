# Snapshot recovery UAT fixes

This patch targets the Managed Agent SFTP snapshot browser. It adds no schema migration, repository mutation, Agent upgrade, failover policy or HCP security exception.

## Verified findings

- **Database:** Restore Database previously appeared for every completed managed snapshot. It now requires a recorded database artifact receipt. The backend also rejects a snapshot with no database artifacts before probing targets or workers. Historical artifacts remain eligible after current-plan DB removal. Filesystem Recovery Test stays available.
- **MCP:** the native-token flag alone never enabled the service. The existing contract also requires canonical HTTPS MCP_RESOURCE_URL with path /mcp, valid authentication configuration, and explicit administrator service activation. Invalid configuration previously made the effective native-token capability look false without explaining why. Authenticated admin diagnostics now separate the requested flag from usable configuration, returning only fixed setup reasons. They never return rejected URLs or environment values.
- **Replication:** copying and exact repository/tree verification are separate from primary backup success. Only a completed verified receipt establishes replica protection. Pending, failed and uncertain copies do not. **Automatic recovery failover is not implemented.** Managed file/database recovery currently requires the primary SFTP repository. Mirror status alone cannot authorize a different repository, snapshot or provider. Do not rewrite plan storage to force a fallback; replica recovery needs a separately reviewed operator workflow.
- **Selected download:** Actions previously exposed Restore only. Download confirms one exact item, verifies authenticated HEAD metadata, then asks the native browser to GET it. Files retain their raw format; directories stream a canonical TAR of descendants. No whole-file browser buffering, plaintext staging restore, Agent call or export admission occurs. Standalone symlinks/special files are refused; folder links retain the existing safe target/graph rules. Temporary SQLite metadata uses the existing proof budget; at most two selected transfers are admitted. TAR completeness, entry hashes and links are checked before the footer. Native read-only dump retains deadlines, backpressure and cancellation. Standard selected transfers have no resume; full-snapshot Standard/Reliable Download keep their existing contracts.
- **Comparison:** there is no 1 GiB content-size cutoff. Comparison indexes bounded metadata and uses exact restic diff --metadata without archive reads. A synthetic 8 GiB file succeeded through actual Restic 0.19.1/read-only SFTP on 2 CPU / 4 GiB Linux: comparison 10.115 s, two changed files, no archive reads; cgroup peak approximately 391 MiB. This does not establish the production failure's cause. Fixed categories now distinguish deadline, capacity, invalid metadata, identity mismatch, unavailable snapshot and repository access. No raw provider text is returned, and late callbacks after the deadline cannot become Ready.

Existing comparison limits remain: 200 rows/page, 1,000,000 combined entries, 128 MiB SQLite, one running comparison, two cached jobs and a 15-minute deadline. Large logical size alone is insufficient evidence for raising limits or blaming storage throughput.

## Operator UAT

Use synthetic/non-sensitive snapshots first. The coding agent did not perform these steps on production.

1. Check a filesystem-only snapshot: Restore Database is absent; Browse, Download and filesystem Recovery Test remain. Check a database snapshot and its historical artifact after current-plan DB removal.
2. Privately configure MCP_RESOURCE_URL=https://backup.example.internal/mcp with the actual externally reachable HTTPS host and MCP_NATIVE_TOKENS_ENABLED=true. The hostname here is synthetic. Never put credentials or query data in the URL. Leave OAuth fields absent unless configuring a complete OAuth setup. Follow [the approved image/configuration reapply procedure](SNAPSHOT_REVIEW_RELEASE.md): editing .env alone does not change a running container, and recreation interrupts active work. Refresh MCP, confirm configuration ready, then explicitly Enable service. Review token grants before issuance; never share tokens.
3. Browse a historical snapshot on desktop/mobile. Download a regular file; verify its known fixture hash in browser Downloads. Download a directory and verify only the selected subtree appears in its TAR. Verify special files/symlinks are not followed. Cancel a browser transfer and check that its server native process/session exits. Recheck staging Restore and full Standard/Reliable Download, including authorized Range/resume.
4. Compare two small and two large snapshots. On failure press F12, open Network -> Fetch/XHR, filter comparison, then retry once. Select GET /api/backups/<backup-id>/comparison. Record only HTTP status and safe fields: state, phase, failureCode, failureCategory, processedEntries, totalEntries, elapsedMs, reason. Do not export HAR files or share request headers, cookies, tokens, snapshot paths or provider bodies. Use category/phase to investigate capacity, deadline or protocol constraints.
5. Inspect per-snapshot replica receipts. Expect incomplete redundancy while any required copy is pending, failed or uncertain. Test primary unavailability only in an authorized disposable environment: recovery must fail safely without pretending a replica was used. Automatic failover needs a separate implementation and acceptance plan.

## Local validation and limitations

Local validation completed:

- Linux serial backend: 221 suites passed, 4,615 tests passed, 7 pre-existing skips unchanged (310.484 s). The latest additional concurrency test is also checked separately through the full recovery-service suite on Windows/Linux.
- Frontend: 430 passed. MCP authorization/security integration: 47 passed.
- Backend lint and backend/frontend TypeScript checks: passed.
- Production workspace build (all three tasks) and source Docker image: passed.
- Native small/8 GiB Restic fixtures: passed; authenticated selected-file HEAD/GET and directory TAR also passed.
- Chrome native download, service-worker routing, exact job rediscovery, failure paths and Range/resume: passed.
- Linux Docker deployment acceptance: 19 scenarios passed, including host-bundle upgrade/reapply/rollback and mount preservation. Node deployment/Compose checks: 19 passed. POSIX policy/CA/keyring/fixture checks: 46 passed on Linux; Windows lacks the required POSIX ownership semantics.

An unchanged PlanService logger teardown hit its existing 5-second hook limit during an earlier contended run; the complete isolated repeat passed without altering logger code or test timeouts. Frontend lint still fails while loading its unchanged configuration, before linting files (typescript-eslint rejects the eslint-config-prettier string in extends). Hosted CI has not run and requires operator publication/verification.

The native fixture is backend/**tests**/integration/snapshotReview.lab.ts with argument small. Set PLUTON_COMPARE_LARGE_FIXTURE=1 for the sparse 8 GiB input, only in its constrained disposable Linux runner. Sparse data tests logical-size handling, not representative network throughput or production dataset complexity. It creates its own fresh repository and never accepts an external repository.

An initial local backend runner lacked the deploy/operator fixtures and used Docker's default noexec temporary mount. That invalid harness was rerun with complete read-only source/fixtures and an explicitly executable, isolated test tmpfs. A nonroot attempt could not resolve Corepack's uncached package manager with external networking disabled; the final backend runner uses its existing pinned cache. The separate native SFTP tests run as UID 1000. Frontend lint has an unchanged baseline configuration-loading error involving typescript-eslint and the string eslint-config-prettier entry; do not mistake that for a passed lint check.

## Rollback

Use the previous approved immutable image and the existing rollback procedure. There is no database migration or persistent export-job format change. Preserve .env, encryption key/keyring, volumes, export journals, cleanup state and replica receipts. No HCP probe, preflight, storage mutation or unknown-object deletion is part of this patch.
