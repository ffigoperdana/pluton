# Snapshot comparison: database workspace compatibility

Base: local main 6c93262 (includes PR #68). This patch changes read-only comparison and diagnostics, not backup, Agent, restore, replication or repository mutation behavior.

## Confirmed defect and limits of the evidence

The Agent creates a private `jobs/job-XXXXXX` workspace per lifecycle backup and invokes Restic with a relative `pluton/database/<name>.sql` input from that workspace. Actual Restic 0.19.1 records its absolute input workspace in `snapshot.paths`, while `restic ls` exposes the dump at `/pluton/database/<name>.sql`.

The previous comparison guard required sorted raw root paths to be exactly equal. Two successful backups with identical recorded filesystem sources and the same canonical database artifact therefore failed before `SnapshotComparison.populate()`. The same guard also rejected an adapter without diff support using the same generic 409. The generic classifier labelled every 409 as binding-mismatch.

An isolated native SFTP/Restic/HTTP reproduction on the original main source returned `failed / preparing-409 / binding-mismatch / processedEntries=0`, elapsed 6,333 ms, with zero diff/archive calls. Only the synthetic SQL workspace changed. This confirms an implementation defect that reproduces the production-style evidence. Actual production metadata was not accessed; operator UAT must establish whether each affected production pair has this cause. Neither elapsed time alone nor database content size establishes a timeout or throughput bottleneck.

After the fix, the same pair reached Ready in 8,750 ms with 14 indexed entries and accurate SQL Modified evidence. These timings are individual observations, not a speed comparison. A changed 8 GiB sparse SQL fixture also reached Ready in 8,836 ms. Sparse inputs test logical-size correctness, not realistic compression/network throughput.

## Compatibility contract

All existing ownership and recovery boundaries remain. Admission verifies the managed plan/source/Agent/storage binding and full snapshot IDs. Exact snapshot IDs and unique expected plan/backup ownership tags are checked against the repository. Recorded filesystem sources must be nonempty, canonical, unique and equal between the two backup records; present-day plan configuration is never substituted for missing historical scope.

1. Identical raw root sets keep the strict existing path contract. Each recorded source must also exist as a matching snapshot root and a regular file/directory in its exact index. Historical missing DB receipts need no alias inference when roots are identical.
2. Different root sets are accepted only through an independently proven database-artifact policy for each snapshot. Every extra root must be the exact canonical artifact or an Agent-layout `.../jobs/job-<bounded-token>` alias of one recorded `/pluton/database/*.sql` artifact.
3. Alias recognition requires a valid completion receipt with canonical path, positive size within the existing 100 GiB receipt limit and recorded SHA-256; an exact regular-file index entry with the same size; one private workspace per snapshot; no overlap with filesystem sources; no duplicate/unaccounted roots; and complete indexed-tree coverage by the sources, artifacts and directory ancestors. The job token uses the existing Agent parent-verification alphabet, bounded to 160 characters, including current mkdtemp and historical tokens. A matching suffix alone grants nothing.
4. Artifact sets can differ independently: database added/removed, renamed dump and multiple databases remain actual Added/Deleted/Modified entries. No SQL entry is filtered out and no changed content is fabricated as Unchanged.
5. Comparison uses authoritative Restic diff content/metadata evidence and exact summary identities. It does not read/decrypt the SQL contents or establish database recoverability. Recorded SHA-256 is immutable receipt evidence here; mandatory readback/hash/import checks in recovery are unchanged.

Unsupported historical workspace shapes, absent receipt evidence when roots differ, malformed receipts, extra roots/tree entries, wrong sizes/types and genuine source changes fail closed. There is no administrator override or live repository repair in this patch.

## Pair selection, cache and retry

BackupStore already filters same plan/source/type/storage/path and successful completed history, orders by ended -> started -> created time with a deterministic ID tie-breaker, and limits candidates to 32. Tests now exercise the real migrated SQLite query. Before admission, incompatible recorded scopes/invalid or incomplete candidate identities can be skipped in that bounded list. The response includes the actual selected pair and skipped-candidate count.

Once admitted, the pair is pinned for its active/cache lifetime, including explicit retry. Polling never chooses a newly nearer predecessor, creates a job, starts a backup/restore, or reads archives. There is no silent fallback after the chosen pair fails root/ownership/index verification. A changed repository/context or receipt fingerprint prevents reuse of Ready results. Final revalidation detects changes during diff. A preparing job stays pinned while an expired deadline is being cleaned up, rather than becoming a second admission.

Ready results/pages recheck repository availability, exact snapshot ownership and immutable evidence. Failed-job diagnostics remain inspectable when the remote predecessor is missing. Ordinary current-snapshot browsing is independent of comparison failure. All original page, cache, worker, metadata, disk and 15-minute deadline limits remain unchanged.

## Safe diagnostic contract

The existing `failureCode` phase/status format is retained for jobs. Generic 409 no longer asserts a repository-binding cause. New fixed `failureDetail`, `failureStage`, `validationStage` and compatibility mode/counts provide bounded evidence. They contain no credentials, raw exceptions, connection strings, private workspace roots, artifact hashes or provider bodies.

| Origin                                        | Safe detail / stage                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| Managed binding changed/unavailable           | repository-binding-changed / pair-selection or active index stage           |
| Historical scope mismatch                     | historical-source-scope-mismatch / pair-selection or root-validation        |
| Unproven raw-root difference                  | snapshot-root-path-incompatible / root-validation                           |
| Ownership/tag mismatch                        | snapshot-ownership-mismatch / current-index, previous-index or verification |
| Missing/ambiguous recorded identity           | snapshot-identity-missing / pair-selection                                  |
| Missing selected predecessor                  | previous-snapshot-unavailable / previous-index                              |
| Unprovable historical artifact/source receipt | historical-metadata-incomplete / pair-selection or root-validation          |
| Adapter lacks diff                            | restic-diff-unavailable / snapshot-verification                             |
| Invalid/unavailable index                     | snapshot-index-verification / current-index or previous-index               |
| Changed admitted evidence/cache context       | comparison-context-changed / pair-selection or final-revalidation           |
| Diff summary IDs disagree                     | diff-identity-mismatch / restic-diff                                        |
| Capacity, transport or deadline               | existing bounded categories plus the actual job stage                       |

API-request errors outside a job use stage `request` rather than inventing an internal operation. Known Restic/index error codes remain closed-category values. UI messages use fixed allowlists and never reflect arbitrary returned codes/messages. Snapshot IDs needed to review the selected pair remain visible only through the existing authenticated application API/UI.

Example of a safely refused extra-root fixture:

```json
{
  "state": "failed",
  "failureCode": "preparing-409",
  "failureCategory": "snapshot-root-incompatible",
  "failureDetail": "snapshot-root-path-incompatible",
  "failureStage": "root-validation",
  "processedEntries": 0
}
```

## Changed files

- `backend/__tests__/integration/managedSymlinkRecovery.runtime.ts`
- `backend/__tests__/integration/snapshotDatabaseComparison.lab.ts`
- `backend/__tests__/services/SnapshotComparisonService.test.ts`
- `backend/__tests__/stores/BackupStoreComparison.test.ts`
- `backend/__tests__/utils/restic/SnapshotComparison.test.ts`
- `backend/__tests__/utils/restic/SnapshotComparisonPolicy.test.ts`
- `backend/src/controllers/BackupController.ts`
- `backend/src/services/RemoteRepositoryRecoveryService.ts`
- `backend/src/utils/restic/SnapshotComparison.ts`
- `backend/src/utils/restic/SnapshotComparisonPolicy.ts`
- `docs/SNAPSHOT_COMPARE_DATABASE_COMPATIBILITY.md`
- `frontend/__tests__/snapshotReview.test.ts`
- `frontend/src/components/Plan/Backups/SnapshotDetails.tsx`
- `frontend/src/components/Plan/SnapshotViewer/ManagedSnapshotViewer.tsx`
- `frontend/src/utils/snapshotReview.ts`

## Validation

New tests cover the policy, full service/index lifecycle, migrated SQLite selection query and frontend SQL diagnostics. The native lab covers filesystem-only snapshots; SQL content change; DB added, renamed and removed; a canonical historical receipt; exact pair selection; Ready; and one-row paginated results. Optional sparse 8 GiB SQL verifies bounded metadata handling. Permission/identity, incomplete receipts, arbitrary aliases, extra tree nodes, stale caches, concurrent/repeated admission, missing previous snapshots and final revalidation are tested separately through real comparison indexes.

The native lab is `backend/__tests__/integration/snapshotDatabaseComparison.lab.ts`. It creates its own random disposable repository; it accepts no external repository/endpoint. Run with UID 1000, network none (loopback only), read-only filesystem/source mounts, 2 CPUs, 4 GiB memory/no swap, 128 PIDs, writable private /lab and /tmp tmpfs, and Docker `--init` as already used by production Compose. Set `PLUTON_COMPARE_LARGE_FIXTURE=1` for the 8 GiB SQL cases. Use a source runtime image with the pinned Restic/Rclone/dependencies and mount only test/source directories; never mount real configuration or storage. `PLUTON_EXPECT_COMPARE_FAILURE=1` is solely for the original baseline source, to assert the exact old failure tuple.

Seven native comparisons completed with zero archive reads, PID-limit events zero, and full-fixture cgroup peak 404,000,768 bytes (~385 MiB). An initial runner without init exhausted its PID budget (`pids.events max 21`, execution-failed during pagination). Adding the same init behavior already present in Compose fixed that harness defect without raising the PID limit or retrying failed requests. No deployment setting was changed.

Final local results:

- Complete Linux serial backend: 224/224 suites, 4,658 passed, 7 existing skips unchanged, 336.83 seconds. Command: pnpm --filter @plutonhq/core-backend test --runInBand, CI=true, isolated 2 CPU / 4 GiB runner with init and complete read-only fixtures.
- Windows recovery/BackupServices/comparison: 177 passed; focused policy/cache/deadline/race: 38 passed; controller/routes/real history query: 107 passed.
- Complete frontend: 432 passed; final focused review/navigation: 19 passed.
- Native read-only SFTP/Restic comparison: seven successful comparisons, including MariaDB receipts, a legacy receipt and sparse 8 GiB SQL; auth/override refusal, accurate pair/result pagination, repository/source hashes unchanged, no restore jobs or archive reads.
- Backend lint, backend/frontend type checks, production workspace build (all three tasks), final source Docker image and Chrome delivery/Range/resume regression: passed.
- Linux Docker deployment: 19 scenarios passed, including host-bundle upgrade, config reapply, rollback, unrelated-service and mount/data preservation. Node deployment/Compose policy: 19 passed.

Targeted frontend lint was attempted with the unchanged repository configuration and fails before examining files: typescript-eslint rejects the eslint-config-prettier string in extends. This baseline configuration and lockfile were not modified. During an earlier contended full run the unchanged PlanService logger teardown hit its existing 5-second hook limit; the final isolated full run passed without changing logging code, timeouts or assertions. Hosted CI has not run and requires operator publication and verification; no hosted PASS is claimed.

## Read-only operator UAT

Use existing completed snapshots. Do not create new backups, restore data, download contents, run provider preflights, edit storage/namespace settings or change credentials for this UAT. Comparison POST creates only local application comparison metadata and reads the repository with the existing no-lock/no-cache contract.

1. Choose the filesystem-only baseline plan. Open an existing Snapshot Details, record its current Backup ID privately, compare, and verify the displayed previous snapshot and Added/Modified/Deleted/Unchanged result against known historical changes.
2. Choose the modest-size MariaDB plan that reported preparing-409. Use its actual Backup ID from Details, not the Plan ID from the route. Before starting, GET may return HTTP 200/state missing; this is normal. Click Compare with previous once. Confirm the selected pair, preparation stage, Ready, and SQL entry under `/pluton/database`. When roots differ and receipt evidence is complete, expect compatibility mode verified-database-roots. Keep the exact pair fixed when reviewing changes.
3. Repeat for the large database plan. Watch phase, processedEntries, totalEntries, elapsedMs, process count, CPU/RAM/cache capacity through existing read-only monitoring. Verified Ready and paginated results establish completion; size/progress alone does not. No new SQL contents or signed download URLs need to be inspected.
4. If unavailable/failed, do not repeatedly POST. Review the specific safe detail/stage. Unknown historical evidence remains refused. An explicit retry repeats validation for the same admitted pair; it does not bypass checks or select another result.
5. In browser F12 -> Network -> Fetch/XHR, filter comparison. Select GET `/api/backups/<actual-backup-id>/comparison`. Collect only HTTP status and `state`, `phase`, `failureCode`, `failureCategory`, `failureDetail`, `failureStage`, `validationStage`, counters/timings and compatibility mode/counts. Verify pair IDs privately in the authenticated UI. Do not export HAR, copy Headers/cookies/tokens, SQL, raw provider data, workspace paths or production inventories into public reports.

An HTTP 200 status response can describe a failed job. An HTTP 404 from using a Plan ID as a Backup ID is an invalid request, not evidence of this defect. A deadline diagnosis requires actual deadline evidence; a 14-second elapsed value is insufficient.

## Rollback and remaining limitations

Use the previous approved immutable application image and existing deployment rollback procedure. There is no schema migration, backup rewrite or persistent export-job format change. Preserve .env, application encryption/keyring, data volumes, journals and replica receipts. Comparison caches remain disposable; a refresh/restart only rediscovers or reports missing cache state and never admits a comparison automatically.

Production retesting remains necessary. Unprovable historical aliases intentionally remain unavailable, and a failed chosen pair does not silently compare with a different historical snapshot. A successful comparison proves verified metadata/content-change evidence, not successful database recovery.
