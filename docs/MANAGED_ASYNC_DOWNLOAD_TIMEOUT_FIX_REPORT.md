# Managed asynchronous download preparation and timeout fix

Date: 2026-10-28. Base: freshly fetched `origin/main`, `bdf2f5ff4e390e981efcb972ef91c93356a5afc6`. Branch: `codex/managed-async-download-timeout`.

## Acceptance and remaining gates

This is a local implementation candidate, not production acceptance. The synchronous preparation defect is removed and the actual authenticated API/controller/service/cache workflow passes short-gateway tests with preparation lasting over 60 and 125 seconds. The full regression/build results are below. No push, merge, deployment, production access, Agent change, proxy reconfiguration, repository mutation or memory-limit increase was performed.

The initial Docker startup blocker was resolved by the operator, after which native testing resumed without a factory reset or global resource change by this task. Real SFTP 65/126-second delay tests, historical recovery and cancellation/restart controls now pass. The source-backed 3.17 GB / 115,565-file case also passes complete TAR integrity, full/selected restore, Recovery Test, fresh-process download and cleanup. The completed native matrix and compiled-image results are recorded below. The preceding [native recovery report](MANAGED_DOWNLOAD_RECOVERY_RELIABILITY_REPORT.md) remains historical evidence for the base commit, separate from this candidate's results. Production 524 attribution and production acceptance remain pending.

## Confirmed cause and investigation

The previous `POST /api/backups/:id/action/download` called `BackupController.generateBackupDownload` -> `BackupService.generateBackupDownload` -> `RemoteRepositoryRecoveryService.prepareDownload` -> `withIndex` -> `ManagedSnapshotIndexCache.use`. The HTTP request waited for admission, full streamed Restic metadata validation/SQLite construction on a miss, SFTP snapshot verification, current binding checks and the complete-operation safety check. Even a cache hit performed SFTP verification. HTML-safe frontend parsing identified the HTTP failure, but could not make this synchronous request survive a gateway deadline.

The previous authenticated GET called `withIndex` again, allowing a missing/expired/evicted index to rebuild before TAR headers. It then performed another scoped-session snapshot verification. It could therefore time out independently of POST.

The exact production 524 issuer and elapsed timeout remain **UNVERIFIED**: no authorized response headers, proxy request logs or timing trace were supplied. The local gateway deliberately identifies itself as `fixture-gateway`; its 524 is evidence about this local control, not attribution to BunkerWeb or any other production layer.

| Investigation question | Confirmed code behavior / practical limit |
| --- | --- |
| Does Download always rebuild Browse's index? | No. Both hash the same exact context. A live hit reuses the same SQLite manifest. The service regression verifies one build across Browse/preparation reuse. |
| Why can a Browse success precede a slow Download? | Cache hits still contact SFTP. Existing 15-minute idle expiry, two-index LRU, restart, changed credentials/bindings or resource admission can require work. A completed Browse alone does not prove the later request hits the same live entry. |
| Is LRU ordering still fixed? | Yes. The preceding monotonic access ordering remains intact. Polling preparation status never touches index TTL/LRU. |
| What does cancellation do? | Before admission, an already-aborted POST is refused. After admission, the job owns its controller and survives request disconnects. Explicit cancellation aborts that job. A shared Browse-owned background construction may continue for its other consumer; closing the preparation panel does not cancel that separate work. |
| Are polls expensive repository operations? | No. They validate current application binding/credentials and inspect local counters/proof only. They open zero SFTP sessions and cannot start a build. Credential decryption/local store latency still exists. |
| SFTP latency / session contention? | Existing process/session cap remains two and index construction remains one. Warm preparation revalidates through SFTP in the background. Contention is a bounded refusal, not an unlimited wait/queue. Native latency under this candidate is unmeasured because Docker failed. |
| Event loop, CPU and memory? | No production diagnosis can be made from the supplied 524. Existing metadata streaming yields every 256 records. Portable protocol CPU/RSS observations are below; they are not a saturation or cgroup test. |
| Could GET still wait? | It performs bounded remote verification and archive startup, but can no longer reconstruct an index. A slow/unavailable remote fails closed; no verified transfer is claimed. |

## Backend contract

- Remote POST validates the persisted completed backup, plan/source/Agent identity, full snapshot ID, original repository/storage binding and credentials locally. A nonempty managed selection body or alternate replica is rejected before admitting work. It returns HTTP **202** with `{ success: true, result: { streaming: true, preparation: { id, state, ... } } }`. A 202 confirms a job identity, not completion or a downloaded archive. Local desktop/mirror behavior stays on its existing path.
- Authenticated `GET /api/backups/:id/download-preparations/:jobId` returns the current job. Authenticated DELETE on the same route cancels it. Both reject caller options, return private/no-store responses and recheck the exact current context. A job from another context is not disclosed. Unknown IDs after restart reconcile to `expired` without repository work.
- Explicit states are `queued`, `indexing`, `validating`, `ready`, `failed`, `cancelled`, `expired`. Counts come from the existing index's appended records. `validatedEntries` is populated only after complete validation. There is no invented total, percentage or byte-transfer progress. A failed job exposes only the existing sanitized category/reason and safe message.
- `ManagedDownloadPreparation` admits at most **four nonterminal jobs**, executes **one worker**, retains at most **32 statuses**, and deduplicates an exact context. Work begins off the HTTP admission stack. An explicit new POST can retry a failed construction; polling cannot. Busy admission fails promptly. There is no additional index/cache or unbounded worker pool.
- A queued/running job has a 30-minute absolute lifetime. A ready proof is valid for two minutes; retained terminal statuses expire after 15 minutes. Ready status is invalidated when its required index generation disappears, expires or is replaced. Neither polling nor a waiting ready job holds a reader lease. Queue cancellation/expiry drops its captured context; completed workers also release that closure.
- Job metadata is intentionally **not durable**. It describes disposable work, no recovery artifact. Persisting a ready flag across restart would misrepresent a cache the server does not trust. Restart produces `expired`; an explicit POST reconstructs/revalidates under existing limits. No migration or new environment setting is required. The same rule applies across multiple server processes: this design requires the existing single owning server process; it is not a distributed job service.
- `ManagedSnapshotIndexCache.inspect` provides read-only counts/generation. `useReady` atomically leases only that exact live generation; it cannot admit/build/retry anything. GET without a ready preparation ID, after eviction, or after restart returns a prompt 409. A new explicit preparation is required. The lease is held only for an active verified transfer, where pinning its required index is necessary.
- GET rechecks current local context, acquires that exact cache generation, checks whole-operation safety, verifies the full snapshot and ownership tags in a fresh allowlisted read-only session, and rechecks local binding before TAR headers. Remote preflight has a **15-second** cancellation deadline. Archive startup has a separate **15-second first-data** limit, followed by the existing **10-minute inactivity** limit. These are fail-fast bounds, not a promise that an arbitrarily slow repository will become downloadable. Cold/slow real-SFTP first-byte behavior must be measured before acceptance. A pre-data stream failure can close the HTTP connection; it is never padded with JSON or called complete.

The existing full-ID/tag verification, `--no-lock --no-cache`, private scoped credentials, two-session cap, shell-free commands, POSIX `%`/`:`/Unicode handling, duplicate/ancestor validation, symlink/special-node refusal, staged restore safety and repository read-only contract are preserved. No fallback to latest, alternate repository, arbitrary file selection, archive staging or frontend blob buffering is added. TAR still streams with backpressure and HTTP completion requires successful Restic exit and credential cleanup.

Sanitized `download_stage` timings cover snapshot verification and metadata streaming; `download_preparation` records total duration and actual entries. Records contain a closed stage and numbers, without paths, identities, credentials, raw stdout/stderr or per-file inventories. There is no per-entry/poll log flood. Missing logging infrastructure cannot change preparation success. Existing cache lifecycle diagnostics retain build/refusal/eviction and size/count information.

### Native cancellation finding

The resumed native cancellation/immediate-retry probe exposed a further race: a cancelled index consumer released the preparation worker before its owned construction had finished process/config/index cleanup. The next job could attach to that retired construction and inherit its failure. `ManagedSnapshotIndexCache.use` now waits for its own aborted construction to settle before returning to the worker. It does not abort or wait for independent Browse-owned work or another reader. HTTP cancellation/status remains immediate; the next bounded job stays queued during cleanup. A deterministic gated-cleanup regression and repeated real SFTP cancellation/retry/restart checks cover the change. No sleep, retry loop, cap increase or assertion suppression was used to hide the race.

## Frontend behavior

Managed Generate Download opens **Preparing Snapshot** in the existing modal/action style. It displays the actual state, elapsed time, indexed entries, safe failure and cancellation controls. It waits 1–5 seconds between status requests based on the backend interval and checks ready status every five seconds while open so eviction/expiry can remove the Download button. There is one outstanding request per panel; no automatic mutation retry. Errors stop polling. Explicit retry reconnects to a known job; terminal expiry/failure can start another preparation. Duplicate POSTs deduplicate on the server, including a lost initial response or React remount.

HTML 429/502/503/504/524, invalid/oversized JSON and missing/mismatched job identities fail safely. Status JSON is capped at 64 KiB. Retry honors numeric/date `Retry-After`. Closing/unmounting cancels the panel's request/timer; an admitted backend job remains independently bounded. The known job state is not replaced by the generic uncertain-mutation toast.

Only **Download TAR** starts the authenticated native browser download with the exact backup and preparation ID. The panel says the download was requested and directs the operator to the browser download manager. It does not observe browser-native transferred bytes, Save As success, final completion or checksum verification; it does not claim any of them. Client-side integrity remains a separate test/operator gate. Existing Browse layout/mobile navigation, lazy directory loading, 200-row pages, bounded query cache and restore behavior remain unchanged. Browse indexing responses reuse the cache's actual `indexedEntries` telemetry.

## Measured timeout comparison

`managedAsyncDownload.protocol.ts` runs real Express routing, cookie authentication, BackupController, BackupService, RemoteRepositoryRecoveryService and SQLite indexing behind a **five-second** local HTTP gateway. Its repository provider is explicitly **synthetic**; its final test stream is not a TAR and is not counted as recovery integrity. The synchronous control reconstructs the previous `context -> withIndex -> assertSafe` POST contract using the same production methods. It is a contract control, not an old production-image benchmark.

| Injected repository delay | Synchronous control | New job admission | Largest status response | Actual preparation to verified test stream | Index builds |
| --- | --- | ---: | ---: | ---: | ---: |
| 65 seconds | HTTP 524 at 5,028 ms | HTTP 202 in 65 ms | 54 ms (64 polls) | 65,874 ms | 1 |
| 126 seconds | HTTP 524 at 5,011 ms | HTTP 202 in 35 ms | 81 ms (122 polls) | 126,360 ms | 1 |

Duplicate creation returned the same job identity. Before download, every status poll together still accounted for only two repository-provider sessions: construction and validation. The authenticated download added one session and used the prepared index. CPU readings were cumulative process totals (user/system): 3.218/1.125 s after the first case and 7.515/1.859 s after the second. Sampled end-of-case Node RSS was 123,068,416 and 125,919,232 bytes. These are not peak RSS or process-isolated CPU comparisons. The protocol ran on Windows with Node 24.16.0, concurrently with other verification work. No cgroup/OOM measurement exists for it. Earlier incomplete probe executions exposed uninitialized timing-logger failure; that implementation defect was fixed and has a regression test. Only completed structured probe records above are counted.

### Real SFTP timeout comparison after Docker restoration

The source-backed runner used real Restic 0.19.1, Rclone 1.75.1, read-only loopback SFTP and the same five-second gateway. The exact base commit's controller/recovery/session/index/router files were overlaid only inside the disposable baseline container. This attributes the local 524 to the fixture gateway and compares the actual previous synchronous contract, rather than inferring production topology.

| Injected delay | Exact-base synchronous POST | Async preparation duration | Maximum job admission | Maximum status response | Complete verified TAR transfer |
| --- | --- | ---: | ---: | ---: | ---: |
| 65 s | 524 at 5,008 ms | 67,591 ms | 50 ms | 51 ms | 1,305 ms |
| 126 s | 524 at 5,007 ms | 128,827 ms | 52 ms | 55 ms | 1,255 ms |

Both delayed cases completed full and selected staged restore, Recovery Test, fresh-process download, source/repository immutability and cleanup, with zero OOM/OOM-kill events. The hold delays the real metadata session, not the HTTP response or an invented progress counter.

## Native fixture and integrity gates

The existing disposable native runner was adapted for 202 creation/status polling, duplicate clicks, a real five-second HTTP gateway, cache-only GET refusal after eviction, explicit re-preparation and historical TAR hash comparison. After a fresh OS process, old job IDs must be expired and GET must refuse before explicit new preparation. Fixtures still check complete TAR delivery/termination/parser/extraction, source-time SHA-256, independent full/selected staging and Recovery Test, repository/source immutability, read-only native SFTP, cancellation, broken stream propagation and cleanup.

The runner retains 2 CPU / 4 GiB memory-and-swap-equal / 192 PID limits, unprivileged extraction, read-only image, private task volume, loopback-only networking and 32 GiB free-disk guards. No Docker socket/production data is mounted. A cgroup cap does not model a complete 4-GiB VM. New `delay` and `combined` modes and `-PreparationDelaySeconds` support 65/126-second native delays and a decimal 3.17 GB data fixture with about 115,000 metadata files. The combined fixture adds 115,552 eight-byte files to its data files; reported logical bytes include that content and the selected historical file. Other fixture sizes remain explicitly decimal/GiB as documented in the previous report.

Completed control fixtures verify: cancellation followed immediately by retry; graceful OS-process restart with a real metadata stream paused after its first indexed node; old-ID reconciliation to expired; refusal to download a partial/expired index; and a new fully verified download after restart. Separate SFTP-unavailable preparation failed safely after about 11.7 seconds while status polling stayed responsive, then an explicit retry succeeded after restoring the disposable SFTP server. These controls were repeated successfully. A real disposable Restic backup also ran while preparation was deliberately held in flight; old repository objects remained unchanged and only that fixture writer's new objects were admitted into the subsequent immutability inventory. This is not a production Agent lifecycle or simultaneous heavy-I/O stress benchmark.

One fault probe also exposed a test-gateway defect: `response.pipe(res)` did not propagate an aborted upstream response, leaving the failed connection open for 301,840 ms. By the next independent fault, the preparation proof had correctly expired and GET returned 409, so an assertion expecting a broken TAR stream was testing the wrong state. The fixture now forwards upstream abort/error/premature-close events and requires prompt process-interruption propagation plus an explicitly ready preparation before each separate streaming fault. Those unsuccessful probes are not counted as archive acceptance; completed independent large-fixture records remain valid. No production timeout was enlarged or failure assertion removed.

The corrected 120 MB streaming-fault run passed: slow recipient plus concurrent Browse used at most two sessions/Restic processes; forced Restic termination propagated in 1,244 ms after 512 bytes; and SFTP loss produced a failed partial response after 215,293 ms without client cancellation. The fault hook was confirmed to enter a 200 TAR response, and the received bytes were fewer than the complete archive. Credentials/processes were cleaned, SFTP was restored, and explicit preparation/recovery continued successfully. The 215-second native retry occupancy is a measured limitation, not a timeout increase; pinned [Restic retry behavior](https://github.com/restic/restic/blob/v0.19.1/internal/backend/retry/backend_retry.go) uses bounded backoff. The separate real HTTP proxy-cut case also passed. Complete symlink/FIFO exports remained refused with their specific safe reasons, and selected ordinary-file staging still passed.

The final compiled image also completed the 126-second hold: 128,916 ms preparation, maximum admission/status 52 / 67 ms, complete TAR/hash/restore/restart and cleanup. Its extended controls passed cancellation/immediate retry, unavailable-SFTP retry, a fixture backup during held preparation and indexing-time process restart. Four extended controls executions (three source-backed, one compiled) passed, in addition to earlier basic source/compiled cancellation/restart cases.

All successful supported native archive runs validate complete received TAR structure/termination, unprivileged extraction, source-time SHA-256 inventories, independently staged recovery and cleanup. Completed measurements are listed below; no partial TAR or browser initiation counts as success. Malformed records, path and unsupported-node guards remain covered by backend regressions and the native safety cases.

<!-- native-matrix-start -->
### Completed native archive and recovery measurements

Source-backed Linux fixtures use real native binaries and actual API code; compiled-image verification is listed separately. All completed rows below passed complete TAR/extraction hashes, full and selected staging, Recovery Test, historical switching, fresh-process download and cleanup. Source bytes include the selected historical file and metadata-file contents. TAR headers explain the larger transfer sizes.

| Fixture | Source bytes / files | TAR bytes | Preparation ms | Transfer ms | Full restore/hash ms | Max admission / status ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 120 MB | 120,000,028 / 2 | 120,005,120 | 3,260 | 3,855 | 3,456 | 74 / 45 |
| 1.23 GB | 1,230,000,028 / 6 | 1,230,007,296 | 3,317 | 25,765 | 12,533 | 72 / 91 |
| 3.17 GB + metadata | 3,170,924,444 / 115,565 | 3,406,661,632 | 16,744 | 89,368 | 126,763 | 91 / 181 |
| 4 GB | 4,000,000,028 / 16 | 4,000,012,288 | 4,446 | 89,644 | 38,662 | 106 / 90 |
| 80k metadata | 640,028 / 80,001 | 163,844,608 | 7,524 | 3,921 | 40,399 | 78 / 69 |

| Fixture | Parent Node peak MiB | Restic / Rclone peak MiB | Cgroup peak MiB | Two index files MiB | Whole-lab CPU s | OOM / OOM-kill |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 120 MB | 361.4 | 156.8 / 210.6 | 1315.2 | 0.07 | 70.615 | 0 / 0 |
| 1.23 GB | 344.4 | 225.9 / 220.2 | 4096.3 | 0.07 | 209.329 | 0 / 0 |
| 3.17 GB + metadata | 796.9 | 383.6 / 222.1 | 4096.9 | 473.29 | 1194.071 | 0 / 0 |
| 4 GB | 367.9 | 230.2 / 235.8 | 4097.8 | 0.07 | 621.392 | 0 / 0 |
| 80k metadata | 723.3 | 269.2 / 68.8 | 2928.7 | 328.65 | 339.286 | 0 / 0 |

The 3.17 GB fixture returned its first TAR byte in 2,348 ms; the 4 GB fixture took 1,444 ms. The 3.17 GB case had 439,013 memory-limit/reclaim events and the 4 GB case had 529,111, with zero OOM events: this exercises memory pressure without raising the 4-GiB cap. Kernel `memory.peak` may briefly exceed the configured charge limit during reclaim; the limit stayed 4 GiB and swap stayed disabled. Each index remained under 256 MiB, with at most two indexes/512 MiB reserved. Reopening/navigation reused the healthy index; four parent builds count the initial construction plus intentional historical switching, with a separate fresh-process rebuild.

CPU totals include fixture generation, three backups, complete hash inventories, transfers, extraction, two independent recovery paths and restart. Parent Node RSS includes the integrated test server, client and inventory work. Other isolated validation containers ran concurrently on the shared laptop. These are constrained-run observations, not a claim of reduced production CPU or a simulation of a complete 4-GiB VM. Native source-backed tests use Node 24.16.0; the production image and Linux regression runner use 24.22.1.

The final compiled production image ran as UID 10001 without source overlays. Its 3.17 GB / 115,565-file case passed the same archive/recovery contract: 9,835 ms preparation, 82,105 ms transfer, 138,805 ms full restore/hash, 1,328 ms first byte, 97 / 103 ms maximum admission/status, 717.2 MiB parent Node peak, 4096.6 MiB cgroup peak and zero OOM/OOM-kill events. Its controls, 120 MB proxy-cut, colon, percent/Unicode/long-path and safe symlink/FIFO refusal cases also passed. The local production image/native-client build gate passed, using manifest-list digest `sha256:d6f91b698814a619fc5d143030d079726344418529d28b91f2d7eaabc6a6914d`; no image was pushed.

<!-- native-matrix-end -->

Reproducible isolated native checks:

```powershell
./scripts/validate-managed-download-recovery.ps1 -Modes delay -PreparationDelaySeconds 65
./scripts/validate-managed-download-recovery.ps1 -Modes delay -PreparationDelaySeconds 126
./scripts/validate-managed-download-recovery.ps1 -Modes controls,small,medium,combined,four,metadata,history,proxy,colon,percent,symlink,fifo
docker build -f Dockerfile.source --target production -t pluton-managed-download-reliability:local .
./scripts/validate-managed-download-recovery.ps1 -PackagedRuntime -Modes history,proxy,combined
```

## Regression results and changed areas

- Full frontend utility/component suite: **332 passed, no skips** on Windows Node 24.16.0 and Linux Node 24.22.1. The actual new panel is exercised through queued/indexing/validating/ready and stale/proxy failure with controlled timers, exact native handoff and no invented percentage. Linux rerun completed after Docker restoration.
- Windows full backend run before the resumed cleanup regression: **201 suites / 4,082 tests**, four existing conditional skips, 156.202 s. An earlier full run passed 4,079 cases and exited cleanly. The final Windows runner retained a handle after all assertions; focused handle detection on the four changed suites passed **226 tests** and exited cleanly. Separate detection traced an existing `STREAM_END_OF_STREAM` handle to the unchanged MySQL importer fixture at its loopback server `listen`; its 19 assertions passed. The completed full-suite runner was identified and stopped without `--forceExit` or test/assertion suppression. Earlier focused API/controller/service/session coverage passed 288 cases before the final additions.
- Linux backend: **201 suites / 4,081 passed / seven existing conditional skips**, 227.52 s, clean exit. The first Linux attempt missed a deployment fixture mount and a subprocess scratch directory; those runner configuration errors were corrected without changing tests. Its separate framework budget remains 6 GiB / 512 PIDs; application fixtures remain 4 GiB / 192 PIDs. Windows cancellation/index/recovery follow-up passed 174 assertions across three suites.
- Backend lint, backend/frontend TypeScript checks and final root production build passed (three tasks; 14.234 s in the resumed build). New frontend utility/panel pass the existing rule set through the same local resolved-config workaround documented in the base report. Full frontend lint still fails before source analysis on the existing string `eslint-config-prettier` configuration error; no lint rule/config was weakened.
- API inventory/security check passes: **175 contracts**, including both new authenticated job endpoints. A final route run passed **54 cases**, adding explicit same-origin positive/negative checks for bodyless preparation creation and cancellation after the full backend run. The generated inventory/matrix is refreshed. No new MCP proxy/export or external write capability is introduced.

The resumed production change is limited to waiting for owned cancellation cleanup in `ManagedSnapshotIndexCache.use`; the additional changes extend the native fixture/runner, add its gated regression and update this report.

Production code changes: new `backend/src/services/ManagedDownloadPreparation.ts`; the existing remote recovery service, index cache, managed session, BackupServices, BackupController and backup router; new frontend `utils/downloadPreparation.ts` and `Plan/Backups/DownloadPreparation.tsx`, existing Backups integration, backup service client and native-download helper. Regression changes are in job/service/session/controller-route/client/panel tests, the portable protocol probe, native fixture/helpers and runner. Generated `docs/api-inventory.json` and `API_COVERAGE_MATRIX.md` reflect the new routes. No dependencies, lockfile, production configuration, Agent code, schema or backup format changed.

## Split and resumable decision

Keep whole-snapshot Restic TAR streaming as the default. It retains the existing exact-snapshot completeness/integrity contract with bounded memory and no server archive staging. Async preparation addresses request duration without altering archive contents.

Independently verifiable parts would need a durable exact-snapshot partition manifest, disjoint canonical selections, handling of ancestors/empty directories/link boundaries, complete coverage accounting and per-part checksums/receipts. A successful part cannot prove the whole snapshot recovered. That larger export protocol is not implemented or proven here.

True byte-range resume needs stable seekable archive bytes or immutable stored chunks with durable offsets/checksums. A fresh non-seekable Restic TAR stream cannot safely satisfy arbitrary Range requests. This candidate adds no fake 206/Range support and does not stage a 77 GB archive on the server. If whole-stream completion remains impractical through the actual network, an independently reviewed bounded external chunk/export design is a future task, not a workaround for synchronous preparation.

## Production-only evidence and controlled release

1. Privately bind the affected historical backup to its full snapshot, plan/source/Agent and original repository using authorized records. Do not publish production identifiers, source paths or inventories. Record source generation, native versions and binding privately; do not reinstall Agents or change policies.
2. Obtain the exact failing response's status, sanitized gateway headers and request start/end timestamps, and correlate the authorized proxy/server request logs. Establish each actual proxy hop; do not infer topology from 524 alone. Collect only closed stage timings, counts and resource measurements. No credential/raw Restic listing or SQL output belongs in logs or this repository.
3. Complete the native matrix above and review CPU/RSS/cgroup/OOM, admission/status latency, real SFTP verification/first-byte time, cache reuse and cleanup. Test restart while indexing, contention, expiry, cancellation and historical switching through the actual candidate image. First-byte/preflight deadline failures are failures needing diagnosis, not recovery acceptance.
4. Publish/review/CI only under separate operator control. Build an immutable candidate digest and retain the current immutable image/config. Take a consistent SQLite backup including WAL semantics, preserve encryption keys/Agent identities and existing storage/data/restore mounts privately. No schema migration is introduced.
5. After independently approved deployment, prepare the exact historical snapshot, complete the browser download through the actual gateway, validate the entire TAR/extraction against a trusted source-time inventory, independently restore into validated isolated staging and verify cleanup. Current live data is not a substitute for a historical inventory. Browser initiation and job `ready` are not this acceptance.
6. Roll back to the recorded previous image with the same data/config/key/storage mounts. Stop active work first. In-flight ephemeral jobs expire; after restart, initiate preparation again. Do not delete/reinitialize repositories, SQLite application state, identities, keys or completed restore workspaces. Do not alter WAF/timeouts/memory/concurrency to turn an unverified test into a pass.

**P0 local acceptance:** PASS for asynchronous preparation and genuinely verified supported native archives/recovery, including 3.17 GB / 115,565 files and 4 GB under the 2-CPU/4-GiB application cgroup. Full symlink/special-node operations remain securely BLOCKED by the existing compatibility contract. Whole-VM equivalence, deliberate OOM-kill injection, actual production-proxy topology and production snapshot retest remain unverified; the production retest is **PENDING**. No production GO is recommended before the operator checks.
