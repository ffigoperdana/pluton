# Managed snapshot metadata and streaming downloads

Managed remote Download now uses bounded asynchronous preparation: POST returns
202 plus a preparation identity, the authenticated status endpoint reports work,
and GET requires a ready preparation with the same live index generation. GET
does not rebuild an evicted index. See the [async timeout fix report](MANAGED_ASYNC_DOWNLOAD_TIMEOUT_FIX_REPORT.md)
for endpoint details, expiry/restart semantics, first-byte limits and pending
native/production acceptance. The historical audit below describes earlier phases.

## Audit and implementation decision

The managed SFTP session previously collected `restic ls --long --json` stdout
in a string, stopped at 32 MiB, split that string into lines, and returned an
array. `RemoteRepositoryRecoveryService.boundFiles()` created a second array and
a duplicate-path set. Its consumers were browse, prepareDownload, download,
preview, staged restore preparation/execution, recovery-test metadata/restore,
and selected database artifact restore. Thus download failed before TAR execution.
The authenticated backup controller also converted browse errors to HTTP 500.
The frontend fetched all records, then built an IndexedDB/Dexie copy; virtual rows
and progressive directory discovery did not bound the metadata transfer.

Control commands have a 32 MiB stdout limit and 60 second timeout. Restore has a
separate bounded timeout; TAR uses a 10 minute inactivity timeout and Node stream
backpressure. TAR stdout is already streamed without a temporary archive and HTTP
ends only after a successful process exit and credential cleanup. Preserve this.
Recovery selection and restored-file verification previously retained complete
manifests and used repeated full-array scans, adding memory and quadratic work.
The old JSON file response had no application pagination or response-size bound;
the general Express JSON request-body parser does not limit response size. The
new GET page API accepts only validated query fields, not a client manifest body.

The pinned server Restic is 0.19.1 (`scripts/build-executables.js`). Its
[versioned JSON printer](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_ls.go)
emits one snapshot header followed by newline-delimited node records, with both
`message_type` and deprecated `struct_type`. File sizes are mandatory for files;
directory sizes are omitted. No Restic sort option is needed for streaming.

Use a private disposable SQLite index with the existing better-sqlite3 dependency.
Parse stdout incrementally, validate every record, store nodes with a unique path
constraint, and publish only after successful exit and a final identity check.
Keep small control output bounded. Page directory contents on the server, reuse
verified immutable metadata briefly, and consume full manifests through bounded
iteration or indexed lookup for recovery. Never use a browse page as a manifest.
No application schema migration, new environment variable, external cache, or
standalone Agent change is required. Existing Agent 0.7.1 receipts remain valid.

## Runtime contract and limits

`ManagedSftpRepositorySession.streamFiles()` consumes stdout through an async
iterator. The parser retains at most one 256 KiB record plus a stream chunk,
handles split UTF-8/JSON and CRLF, rejects malformed UTF-8/JSON, missing headers,
wrong full IDs, missing file sizes, inconsistent record discriminators, unknown
node types and EOF inside a record. It yields to the event loop every 256 records.
The process must exit zero before the index can be published. A process failure,
timeout, cancellation or invalid last record invalidates the entire construction.
Raw stderr is drained and discarded, and raw environment/provider errors never
become API responses. Control responses retain their separate 32 MiB/60 second
bounds; the listing no longer uses that whole-output limit.

| Resource | Fixed default |
| --- | --- |
| Simultaneous metadata constructions | 1 per server process |
| Managed recovery repository sessions | 2 per server process, including archive/restore sessions |
| Completed/building/failed cache reservations | 2, at most 512 MiB of index files combined |
| One index | 256 MiB SQLite page limit; 500,000 nodes |
| Listing record / complete input | 256 KiB / 1 GiB; exceeding either fails closed |
| Listing construction process deadline | 15 minutes |
| SQLite page cache | 8 MiB per index; prepared indexed scans avoid full result sorts |
| Free disk before construction | At least 320 MiB (256 MiB reservation + 64 MiB reserve) |
| Idle cache lifetime | 15 minutes, swept every minute and on requests |
| Page size | 200 by default; maximum 500 |
| Offset / filename search | 0–500,000 / at most 128 characters |
| Unpaginated compatibility response | At most 5,000 entries |
| Preview/result displayed paths | At most 5,000, explicitly marked truncated; totals remain complete |
| Granular restore | Existing 1,024 regular-file/include limits; additionally 8,192 selected nodes/ancestors |
| Archive timeout | Existing 10 minute inactivity bound; no total archive size cap |

Admission is serialized with at most 16 pending admissions. An idle completed or
failed index is evicted in least-recently-used order when slots or free space are
needed. Readers and unfinished builds remain pinned. Native SQLite handles close
before generated files are removed; failed cleanup retains its reservation.
These are safety limits, not a promise that every 500,000-entry snapshot fits the
disk limit. Long names and paths make indexes larger. Resource exhaustion returns
a precise closed error, never an incomplete listing. Hard entry/database limits
are HTTP 413 and are not fixed by repeatedly polling. Recovery still needs enough
disk for its selected restored content plus the existing 512 MiB reserve and its
own job limits; full recovery writes content, unlike browse/download.

The cache is `<application-data>/managed-snapshot-indexes`, using private 0700
directories and 0600 SQLite files on Linux. It contains paths, sizes, timestamps,
types and permissions, with no decrypted SQL/data or repository credentials. Six
directory/sort indexes support both directions without an unbounded Node result
array or an in-memory SQLite sort. File modification sorting uses parsed time,
including time-zone offsets, while preserving the original display timestamp.
Windows inherits the data directory's ACL; chmod is not an ACL substitute.

Each cache key hashes backup, plan, storage, managed repository ID/path, exact
snapshot ID, source paths and the current access configuration. Access credentials
are only hashed in memory and used by private scoped Rclone sessions, never saved
in index rows. Construction checks ownership tags before/after listing and
rechecks the current stored binding before publication. Every cache read rechecks
the stored binding and the repository's exact snapshot/tags; changed credentials,
bindings or snapshot identity cannot reuse the old index. No `latest` fallback is
permitted. Primary SFTP remains the only supported managed repository here.

Incomplete databases are process-private and unavailable to readers. Unique path
constraints detect duplicates on disk. Logical path normalization, basename and
safe numeric validation apply to every record. An on-disk ancestor table rejects
children under file/symlink/special nodes even when records arrive out of order.
Known special nodes can be inspected as metadata; full archive/restore validation
rejects them. Selected recovery also rejects any selected special node, unsafe
colon/wildcard path or unsafe ancestor. No unsafe record is silently dropped.

Simultaneous requests for one snapshot share one construction. Request cancellation
detaches its waiter; the last cancelled waiter aborts a foreground-only build.
A build started by paginated browsing has its own bounded background lifetime so
closing the browser does not cancel another user's work. Cancelled/failed builds
close SQLite and remove their exact generated directory after processes stop;
the next explicit operation can build again. A failed page poll stops and exposes
the current error until explicit `retry=true` or expiry. Retry clears the old
attempt before examining its replacement; it never throws an error saved before
cleanup. Leases protect indexes used by restores/downloads from expiry and LRU
eviction. Retry/expiry/admission cleanup is serialized. Shutdown aborts owned builds,
waits for active consumers, and closes
indexes. Startup discards only exact generated cache-directory names, never trusts
old index files and never touches the application DB or restore content.

Run one Pluton server process per data directory. The in-memory concurrency and
cache ownership contract does not support multiple independent server processes
sharing this cache. Cache cleanup failure is fail-closed and may require operator
filesystem/permission repair. No external DB/cache or persistent queue is added.

## Authenticated browsing API and UI

`GET /api/backups/:id/files/page` uses the existing administrator session middleware.
The only query fields are `path`, `search`, `offset`, `limit`, `sort`, `order`,
`directoriesOnly` and `retry`. The last two accept only `true` or `false`.
`directoriesOnly=true` filters direct child directories on the server; `retry=true`
is sent once by an explicit retry action, not by every poll.
`path` is an absolute logical snapshot directory, with empty string for snapshot
root. Search is a literal filename substring in the current directory, not a glob,
regular expression, filesystem command or recursive repository operation. Sort is
`name`, `size` or `modifiedAt`; order is `asc` or `desc`. Directories come first,
with stable path tie-breaking. All parameters are bounded and validated; unknown,
duplicate, nested, traversal or alternate-storage arguments are refused. Index
queries also enforce their own size/offset bounds.

During construction the response is HTTP 202 with
`{success:true,result:{status:"indexing",retryAfterMs:1000}}`, no file rows, and
`Retry-After: 1`. A ready HTTP 200 response contains `files`, `total` (matching
directory entries), `entries` (complete snapshot nodes), `offset`, `limit`,
`nextOffset` and the full `snapshotId`. Both use `Cache-Control: private, no-store`.
Indexes are complete before any ready page is returned. Pagination is for display,
not evidence that a partial manifest is safe.

Managed Browse restores the classic left directory tree and right file table,
including indentation, expand/collapse, selected-folder highlighting, Last Modified,
Size and Restore actions. Root folders and expanded children load lazily in pages
of 200, with independent previous/next folder controls. Empty directories and
loading/retry states remain visible. Mobile uses a Folders toggle and sort controls;
the desktop keeps the familiar proportions and theme. Filename search applies only
to the current right-hand directory, and file pages remain server-sorted.
Only the active file page is retained by the query cache (`gcTime: 0`). Directory
state is separately bounded to 4,096 nodes, 512 branch pages/expanded paths and
eight pending requests, plus bounded selected-ancestor rows (at most 512). A selected
table folder outside the sidebar's current page stays highlighted through this
ancestry projection without loading all sibling pages. Inactive pages are evicted; reopening a missing page reloads
it. If the selected ancestry itself fills the tree budget, a clear retry/collapse
message is shown. Collapsing cancels pending children; completed pages and expansion
choices are reused while within budget. No whole managed tree is transferred to
Dexie. Historical backup IDs remain the selection
unit. Managed restore-wizard selection uses the same pages, retains at most 1,024
include/exclude paths, and preserves the complete-snapshot selection option. It
does not invoke the old complete-list hook. A capped preview explicitly says that
its totals and execution still cover the complete validated selection.

The old `/files` array API remains usable for small managed snapshots up to 5,000
entries; larger managed snapshots get HTTP 409 `pagination-required`. Local/sync
and legacy repository browsers retain their existing APIs. Direct callers of the
bounded session `files()` compatibility helper also stop at 5,000 nodes. New
managed runtime consumers use `streamFiles()`/the index. Older large-list clients
must upgrade with the server; deploy matching frontend and backend assets.

## Download and recovery boundaries

Generate Download waits for a complete verified index and safe regular-file/
directory validation. It never stages content. GET Download reacquires the same
index, rechecks ownership and the current repository binding, then commits headers
and invokes only fixed `restic dump --archive tar <full-id> /`. A Node pipeline
propagates HTTP backpressure to Restic/Rclone. There is no complete TAR buffer or
temporary TAR file: a logically large archive does not require that much server
temporary disk. HTTP ends only after successful archive process exit and scoped
credential cleanup. Nonzero exit, failed destination, cancellation, disconnect or
inactivity timeout terminates the process tree; a started response is destroyed,
never completed with appended JSON. Clients must discard interrupted downloads.
There is no resume/range support; retry starts a new stream. Failures are logged
using closed codes and metadata-validation/repository-read/archive-stream stages.

Full staged restores and recovery tests hold an index lease and iterate the entire
manifest; they do not materialize its records in a Node array. Selected recovery
uses indexed lookup plus complete scans to establish membership, exclusions and
safe recursive include filters; selected metadata is separately bounded. Restored
filesystem verification walks directories with `opendir` and checks indexed
membership/type/size and complete counts, without a full expected/seen path set.
Source-tree checks, staging containment, no overwrite/delete, free-capacity tests,
historical selection and recovery-test limits remain enforced. Display truncation
does not truncate restore execution or manifest validation.

Database metadata validation scans all indexed database files and compares the
authenticated receipt's exact artifact paths and sizes. SQL-only staging keeps its
exact include filter. Existing SHA-256 verification, native SQL import validation
and database/workspace cleanup remain mandatory and unchanged. No source-agent
restore, production-source write, replication failover, HCP job change, repository
unlock/prune/mutation, encryption change or standalone Agent protocol change is
introduced.

## Errors and safe diagnosis

| Code/status | Meaning and operator action |
| --- | --- |
| `indexing` / 202 | Metadata is being validated; allow polling or reopen later. |
| `pagination-required` / 409 | Upgrade the client/use the page endpoint. |
| `index-resource-limit`, `reason=cache-active` / 429 | Both slots are consumed by active readers; finish/cancel those operations and retry. Idle indexes are evicted automatically. |
| `index-resource-limit`, `reason=build-busy` / 429 | One metadata build is already running; retry after it completes. |
| `index-resource-limit`, `reason=admission-busy` / 429 | The bounded admission queue is full; retry shortly. Busy index responses include `Retry-After: 2`. |
| `index-resource-limit`, `reason=disk-capacity` / 507 | Fewer than 320 MiB remain after safe idle eviction. Check available cache filesystem capacity. |
| `index-resource-limit`, `reason=database-size` / 413 | SQLite reached its 256 MiB hard page limit. Repeating unchanged indexing does not help. |
| `index-resource-limit`, `reason=storage-full` / 507 | SQLite reported FULL without sufficient evidence to attribute it to the configured page cap. Inspect filesystem capacity/quota; do not assume snapshot corruption or a full disk. |
| `index-resource-limit`, `reason=entry-count` / 413 | More than 500,000 metadata nodes. No partial manifest is published. |
| `repository-busy` / 429 | Two recovery repository sessions already active; retry after one finishes. |
| `index-unavailable`, `reason=unavailable` or `cleanup-failed` / 503 | Private cache unavailable or cleanup failed; check disk/ownership and explicitly retry. |
| `index-unavailable`, `reason=timeout` / 504 | Indexing deadline expired. Inspect storage latency and explicitly retry. |
| `metadata-invalid` / 422 | Unsafe, duplicate, inconsistent path/size/time metadata; investigate the snapshot, never skip the record. |
| `unsupported-snapshot-file` / 409 | Archive/full restore contains symlinks or special/unsafe entries; select safe regular paths for staged recovery if appropriate. |
| `credentials-unavailable` / 502 | Stored credentials cannot be resolved; verify existing configuration privately. |
| `wrong-password` / 502 | Repository password rejected; verify the binding and original credentials, never re-key/init. |
| `repository-unavailable` / 502 | Restic reports missing repository; verify the existing primary path privately. |
| `execution-failed` / 502 | Binary/startup/transport failure, including inaccessible SFTP; verify reachability and bundled tools. |
| `invalid-output` / 502 | Malformed/unsupported Restic record, missing header/size or truncated listing. |
| `output-limit` / 502 | A record/input/control safety bound was exceeded; identify which stage, not the old large-list buffer. |
| `timeout` / 502 | Control/listing deadline or archive inactivity timeout; investigate storage/network latency. |
| `archive-failed` / 502 | Nonzero archive execution; discard any partial TAR and retry after resolving storage/content errors. |
| `stream-interrupted`, `cancelled` | Failed destination/client cancellation; an already-started HTTP response is destroyed, without a JSON error body. |
| `cleanup-failed` / 502 | Scoped credential cleanup failed; repair private temp filesystem permissions/capacity. |

Known application client/resource statuses survive the controller; unknown process
errors are sanitized. A nonzero SFTP transport failure may be `execution-failed`:
raw SSH/provider diagnostics are deliberately not retained or returned to classify
it more finely. Never copy passwords, environment dumps, raw configs, production
hostnames, usernames, paths, inventories or unreviewed logs into public issues.

Read-only local checks (adapt the data directory to the installation; these do not
open a repository or need credentials):

```sh
restic version
rclone version
df -h /var/lib/pluton
du -sh /var/lib/pluton/managed-snapshot-indexes
```

The `snapshot_index` JSON log event includes only closed stage/reason values and
numeric index/build/reader counts, metadata entries, database bytes, last observed
available filesystem bytes and duration milliseconds. It includes no snapshot
paths, cache key, connection configuration or provider output. For Compose,
project just this event before sharing diagnostics:

```sh
docker compose logs --no-log-prefix --tail 200 pluton | jq -Rc 'fromjson? | select(.event == "snapshot_index") | {stage,reason,indexes,builds,readers,entries,databaseBytes,availableBytes,durationMs}'
docker compose exec -T pluton node -e 'const d=require("fs").statfsSync("/data/managed-snapshot-indexes");console.log(JSON.stringify({availableBytes:d.bavail*d.bsize,totalBytes:d.blocks*d.bsize}))'
```

These are operator instructions, not commands executed against production by
this task. `availableBytes` is an observation, not a disk reservation or proof that
a per-user/container filesystem quota permits a write. SQLite FULL may roll a
transaction back; the cache preserves bounded allocation samples and reports a
proven page-cap failure separately from an ambiguous storage/quota failure.

Use the authenticated browser network panel to record the HTTP status and closed
code, and whether failure was before headers or during TAR transfer. Compare the
saved full snapshot ID and ownership privately; never replace it with `latest`.
For safe reproduction use the disposable driver below, not production storage.
Do not run `init`, `unlock`, `forget`, `prune`, repair or migration to address a
browse failure. Cache entries expire automatically. If manual cache removal is
necessary, first drain/stop Pluton, verify the absolute cache root is exactly its
private `managed-snapshot-indexes` directory, and remove only disposable generated
index directories. Never remove restored data, credentials, config or the DB.

## Validation and measured resources

`scripts/validate-managed-snapshots.ps1` uses the existing disposable
`pluton-phase5-real-db:local` test image (fixture source:
`agent/test-fixtures/phase5/RealDatabase.Dockerfile`). It mounts only backend source
and tests read-only, disables external networking, uses disposable tmpfs data,
runs as a non-root user, and limits the container to 2 GiB. It requires Docker and
the existing test image; it does not build/publish/deploy production services.

```powershell
pwsh -NoProfile -File scripts/validate-managed-snapshots.ps1
pwsh -NoProfile -File scripts/validate-phase6.ps1 -Modes phase6-mixed
```

Generated NDJSON load tests run each size in a fresh Linux Node 24 process with a
128 MiB JavaScript heap cap. Values measured on this workstation's Docker engine
on 2026-10-25; timings are observations, not production throughput guarantees:

| Files | Input bytes | Index milliseconds | Index disk bytes | Peak Node RSS bytes | Sampled peak heap bytes | Page p50/p95 milliseconds |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 22 | 10,902 | 34 | 61,440 | 98,041,856 | 9,455,144 | 0.16 / 0.30 |
| 5,000 | 2,488,890 | 129 | 8,798,208 | 112,955,392 | 12,274,632 | 3.00 / 3.61 |
| 100,000 | 49,888,890 | 1,896 | 175,640,576 | 123,588,608 | 19,469,560 | 28.69 / 31.77 |

The large generated manifest represents 83,200,000,000 logical bytes, without
allocating that content. It verifies split records and complete totals. Node RSS
includes module/runtime overhead; sampled heap is not an absolute heap peak. Page
timings here measure SQLite queries, not SFTP/authentication overhead. The resource
cap and 100,000-record execution provide bounded-work evidence rather than an
assertion based only on small snapshots.

The native load fixture creates 100,000 real tiny files, uses pinned Restic 0.19.1
and Rclone 1.75.1, serves the repository through read-only SFTP, validates metadata
larger than 32 MiB, consumes pages, checks complete preview totals, and parses every
file in a streamed TAR. It also runs a separate fixture backup concurrently with
indexing, then proves browse/download did not change the resulting repository.
It does not allocate or transfer 77 GiB of content. Native resource/timing results
and full command outcomes are recorded in the
[delivery report](MANAGED_SNAPSHOT_STREAMING_REPORT.md).
The [classic browser and cache reliability follow-up](CLASSIC_SNAPSHOT_BROWSER_RELIABILITY_REPORT.md)
adds 79,300-file measurements, actual three-snapshot switching, classic desktop/
mobile screenshots, new regression results and deployment acceptance limits.

Unit/component tests cover malformed and fragmented records, unsupported types,
duplicates/traversal/ancestors, full-ID/ownership/storage mismatch, process timeout
and cancellation, archive backpressure/disconnect/nonzero exits, partial-build
failure and retry, disk/entry/session/build limits, concurrent same-snapshot reads,
expiry/cleanup races, complete recovery validation beyond the displayed page,
authentication/parameter boundaries, historical UI paths, selection, indexing and
retry. Existing DB/recovery/replication/security suites remain part of validation.

## Production acceptance, deployment and rollback

This change has no application database migration, lockfile/dependency update or
new environment variable. Keep the current primary SFTP settings, encryption
secrets, data volume and Agent 0.7.1 configuration unchanged. Existing snapshots
are inspected in place; there is no initialization, migration or repository write.

Operator deployment steps (not executed by this task):

1. Publish the local fix branch through GitHub Desktop, open/review the PR and run
   CI. Verify the exact reviewed commit, license/attribution and secret scan.
2. Build frontend/backend together from that commit using Node/pnpm versions
   required by the deployment. For Docker, build `Dockerfile.source` and record
   the resulting immutable image digest. Retain the previous digest/artifacts.
3. Rehearse on a disposable/staging instance. Verify bundled Restic 0.19.1 and
   Rclone 1.75.1; run the load/native/DB checks above and the normal test/build gates.
4. Record the existing deployment identity and take the normal consistent private
   application-state backup. Confirm at least 512 MiB for cache capacity plus
   normal operational headroom, and service-owned data/temp directories.
5. Arrange the normal maintenance window. Drain active recovery/download sessions
   and backups, then replace/restart only the Pluton server using the existing
   deployment workflow and unchanged configuration/volume. No Agent upgrade.
6. Load matching frontend assets (refresh any old app tab). Browse a small and an
   approximately 80,000-file historical snapshot: observe 202 → 200, bounded pages,
   navigation/search/time/size sorting, and the expected exact historical contents.
7. Generate Download, confirm headers/start without a staged TAR, cancel once to
   check cleanup, then complete a representative download and verify its archive.
   Monitor RSS, child processes, cache/temp disk, latency and storage/network load.
8. Rehearse selected staging recovery and the existing SQL/hash/native recovery
   checks against explicitly disposable targets. Confirm no source overwrite,
   repository mutation, automatic failover or replication-job changes.
9. Review sanitized error behavior and transient retry. Validate the real large
   archive through the actual proxy/network path before accepting completion
   performance. Keep network/proxy timeouts compatible with expected throughput.

Rollback steps:

1. Drain/stop active downloads and recovery jobs through the normal operator
   workflow; started streams are interrupted and must be retried.
2. Restore the previously recorded server image digest or matched application
   artifacts with the same data volume, settings and secrets. Restart normally.
3. Refresh browser assets and verify existing backup plans, historical snapshots,
   scheduling and replication status. No DB downgrade or repository rollback is
   necessary because this change introduces no application migration or write.
4. Disposable cache directories may remain unused by the older binary. If needed,
   remove only that exact private cache while the server is stopped, using the
   path-verification procedure above. Retain real staging/recovery data normally.
5. The old large-list `output-limit` defect returns on rollback; small snapshots
   retain their previous behavior. Do not work around it by weakening limits or
   switching to a replica. Reapply a reviewed fix after investigating.
