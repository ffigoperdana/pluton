# Replica readback probe

## Root cause (confirmed 12 Nov 2026)

The Assisted Replica Recovery "archive stall" is a Restic retry loop caused by HCP returning a
gzip-encoded body for a Range read that Rclone requested with `Accept-Encoding: gzip`.

Production evidence, same pack and range (`bytes=2605056-2619015`, the last 13,960 bytes of the
replica's 2,619,016-byte data pack), read through the same pinned Rclone 1.75.1 `serve restic` path
Restic uses:

| Rclone setting | Result | HCP response |
| --- | --- | --- |
| default (`Accept-Encoding: gzip` sent) | 0/3 correct; every time 206, stream cut after 2,875 bytes, bytes start with the gzip magic | `206`, `Content-Encoding: gzip`, `Content-Length: 13983`, `Content-Range: bytes 2605056-2619015/2619016` |
| `use_accept_encoding_gzip = false` | 3/3 correct | identity body |

Rclone 1.75.1 sends `Accept-Encoding: gzip` for provider `Other` and passes a gzip body through
undecoded (`--s3-decompress` off). Restic therefore receives bytes that are not the requested range,
rejects the load and retries with backoff; Pluton's inactivity watchdog stops it after ten minutes and
reports `archive-output-idle`. The stored objects are intact (all hashes match), DNS and connections
were healthy during the stall, and the watchdog, timeouts and consumer are not the cause.

Not determined: why HCP compresses this range and not the other 169 ranges, the full object or the
other tail ranges. Any Range read could be affected, so the fix must not depend on particular offsets.

Fix direction (separate change, not part of this branch): stop requesting gzip on every Rclone S3
session Pluton builds for managed S3/HCP storage (`use_accept_encoding_gzip = false` in
`storageRcloneOptions`), covering replica recovery, replication artifact verification and HCP storage
operations, with regression tests including a gzip fault in the recovery lab.

A read-only diagnostic for the Assisted Replica Recovery stall described in
[ASSISTED_RECOVERY_TIMEOUT_PROGRESS.md](ASSISTED_RECOVERY_TIMEOUT_PROGRESS.md). It reads every
object of one S3 replica repository directly, outside Restic and outside Pluton's watchdog, and
reports which object, if any, cannot be read back. No application code, image or migration changes.

## Evidence so far

Two separate production jobs for the same snapshot stopped at exactly 2,232,832 raw TAR bytes
(4,361 TAR blocks). In both, Restic was still running, stdout was open, no consumer write was
pending and there was no backpressure. The last sampled 5-second window showed zero `rchar`,
`wchar` and CPU ticks for both Restic and Rclone.

**Proven from code (this review):**

1. The sampled counters are `rchar` and `wchar` (`archiveProcessObservation.ts`). They count
   socket and pipe traffic, not only disk. Zero deltas mean neither process received or sent a
   single byte or used CPU in that window: both were waiting.
2. A stop at the same byte count twice is data-dependent. `restic dump` walks the tree in a fixed
   order, so the blob it needs next is the same on every run. Random network or HCP load would not
   stop twice at the same byte.
3. Restic 0.19.1 talks to Rclone through a bare `http2.Transport` with no stuck-request watchdog
   ([rclone backend](https://github.com/restic/restic/blob/v0.19.1/internal/backend/rclone/backend.go)),
   so Restic waits for Rclone indefinitely.
4. Pluton passes no `rclone.args` for replica sessions (`ManagedSftpRepositorySession.ts`), so Rclone
   runs with its defaults: 5-minute I/O idle timeout and 10 low-level retries. A held S3 response can
   be retried quietly for longer than Pluton's 10-minute inactivity watchdog.
5. Pluton discards the archive subprocess stderr (`child.stderr?.on('data', () => undefined)`). That
   stream is where Restic reports `Load(<data/...>) returned error, retrying` and Rclone reports its
   errors, including which pack failed.
6. Replication verifies only the SQL artifacts by dumping them from the replica
   (`ManagedReplicationExecutor.verifyArtifacts`). The rest of the replica's data has never been
   read back before these recovery attempts.
7. In `internal/dump/common.go` (Restic 0.19.1), blob loaders are short-lived and write to buffered
   channels, so no internal wait cycle was found. A hang needs a blob load that never returns, which
   means an Rclone request that never completes. This point comes from reading the code, not from a test.

**Hypotheses, most likely first:**

| | Hypothesis | Fits evidence | Decisive test |
| --- | --- | --- | --- |
| H1 | One replica object cannot be read back: HCP, or something on the network path, holds the response | Yes, all points | This probe: `STALLED-OR-CUT`, `READ-FAILED` or `HASH-MISMATCH` on a specific object |
| H2 | Restic and Rclone `serve restic` misbehave on this blob layout | Yes, deterministic | Probe all OK, plus the same backup downloads fine from the primary |
| H3 | Snapshot content (a special file) breaks `dump` | Partly | Normal TAR download of the same backup from the primary also stops |

## Production result (12 Nov 2026)

**Probe: every replica object is intact and readable.** The probe ran in a temporary container
from the production image with host networking (reason below). 29/29 objects passed: `config`,
one key, 22 snapshots, two index files and three data packs (2.50 MiB in total; one 2.50 MiB pack
holds this snapshot's data). Every SHA-256 matched its object name and every Range read matched.
The listing took 6 s and the first object 8.3 s to first byte; every later object took 0.2 to
0.3 s. The cause of the two slow starts was not measured. **H1 is ruled out** for sequential reads
over the host network.

**New evidence: the container's name resolution fails from time to time.** Inside the Pluton
container the tenant S3 hostname did not resolve at 17:33 and 17:38 UTC (`ENOTFOUND` from both the
system resolver and a direct DNS query), while the host resolved it to four HCP node addresses and
the container resolved it again later. The container forwards DNS to the host resolver, which
lists one internal DNS server and two public resolvers on the same interface. Failures were
observed outside the two stall windows; whether they coincide with a stall is not yet measured.

**Why such a failure would look like a silent stall (from code).** Restic 0.19.1 retries a failed
load with exponential backoff starting at one second and doubling
([retry backend](https://github.com/restic/restic/blob/v0.19.1/internal/backend/retry/backend_retry.go)),
and reports each retry only on stderr, which Pluton discards. Between attempts both processes sleep,
which matches zero I/O and CPU in the sampled window.

Updated hypotheses after the probe:

| | Hypothesis | Decisive observation with the stall watcher |
| --- | --- | --- |
| H4 | From the container's bridge network, a new connection or its DNS lookup fails during the archive | Rclone has no open HCP connection, or one in `SYN_SENT`, and DNS failures appear around the stall |
| H5 | HCP, or the path to one node, holds one response | Rclone keeps an `ESTABLISHED` connection with `rx0` and no reads for minutes |
| H2 | Restic or Rclone stops reading although data arrived | An `ESTABLISHED` connection with a growing receive queue (`rx` above 0) while Rclone reads nothing |

## Stall watcher

`scripts/diagnostics/archive-stall-watch.mjs` runs inside the Pluton container next to a real
recovery attempt. Every 5 seconds it records, for each `restic ... dump --archive` process and its
Rclone child: I/O and CPU deltas, process state, and every Rclone TCP connection (remote node label
or address, state, send and receive queue, retransmissions). It also resolves the S3 hostname
through the container's DNS each interval. It only reads `/proc` and sends DNS queries; it never
signals or attaches to a process. Start it first; it waits for the dump process.

```sh
docker exec -i <pluton-container> sh -c 'cat > /tmp/archive-stall-watch.mjs' < /tmp/archive-stall-watch.mjs
docker exec -it <pluton-container> node /tmp/archive-stall-watch.mjs --duration 900 --show-ips
```

The hostname defaults to the host of `MANAGED_EXPORT_ENDPOINT`; use `--host <name>` otherwise.
`--show-ips` prints node addresses, which the storage team needs; mask them before sharing publicly.
Then run one replica recovery of the same snapshot in the UI and let it reach the stall.

Local validation (`scripts/diagnostics/test/archive-stall-watch.harness.sh`): a real Restic dump
over Rclone and loopback S3, with one data pack held by a proxy. The watcher showed Restic and Rclone
at zero I/O and CPU in `futex_wait_queue`, two `ESTABLISHED` Rclone connections with `rx0 tx0`, and
a DNS failure for an unresolvable name on every sample.

## Watcher result (12 Nov 2026): a retry loop, not a silent wait

One replica recovery of a different snapshot ran with the watcher inside the Pluton container. The
archive started about 95 s into the watch and its TAR output had already stopped by the first
5-second sample. Until Pluton stopped it about 600 s later:

- Restic made 12 attempts, spaced about 5, 10, 25, 40, 80, 60, 60, 65, 80, 55 and 65 s apart, which
  is Restic's exponential retry backoff capped near one minute. Each attempt: Restic wrote about
  370 bytes to Rclone and read about 15.4 KB back; Rclone read about 25.9 KB and wrote about 16.2 KB
  (7.4 KB more read when it had to open a new TLS connection). No TAR output in between. Both
  processes were otherwise idle.
- Rclone always held an `ESTABLISHED` connection to an HCP node with empty queues and no
  retransmissions. Idle connections closed after about a minute and later attempts used other
  nodes; over the run, all four nodes were used and every attempt behaved the same.
- DNS: 142 samples, no failures.

**Proven:** the stall is a retry loop on one read. HCP answered every attempt.

**From code, not yet observed:** in Restic 0.19.1 a backoff retry of a load happens only for a
transfer-level failure: a status other than 200/206, a `Content-Length` different from the
requested length, or a body shorter than requested
([REST backend](https://github.com/restic/restic/blob/v0.19.1/internal/backend/rest/rest.go),
[ReadAt](https://github.com/restic/restic/blob/v0.19.1/internal/backend/readerat.go)). Data that
arrives complete but fails decryption is not retried this way; with `--no-cache` the command ends.
Which failure and which pack range is printed on Restic's stderr, which Pluton discards.

H4 (DNS) and H5 (a held response) do not explain this run. Remaining: a range request on the
`rclone serve restic` path that returns an error or a short or mismatched response (H6), or a
Restic-side condition that makes it request such a range (H2).

## Serve-restic range sweep

`scripts/diagnostics/serve-restic-range-sweep.mjs` reproduces the path Restic uses: it starts a
private `rclone serve restic` on loopback (random basic-auth password, GET and HEAD only) in front
of the replica, then:

1. compares the pack size from listing (LIST) with the size from `HEAD`;
2. reads the pack directly and checks it against its SHA-256 name, as the reference;
3. reads the full pack through `serve restic`;
4. sweeps Range reads of 24 KiB every 16 KiB across the whole pack, plus ranges ending at the last
   byte, and compares status, `Content-Length`, length and bytes with the reference.

It needs no Restic password. Run it like the probe (inside the container with
`--credentials managed-export`, or in a temporary `--network host` container with typed keys):

```sh
docker exec -it <pluton-container> node /tmp/serve-restic-range-sweep.mjs --credentials managed-export --path <bucket>/<replica-prefix>
```

A failed range prints its offset, status, `Content-Length`, bytes received and whether the received
prefix matches the stored bytes. If every range passes, the remaining step is a sanitized capture of
Restic's stderr for archive operations, which needs a code change and a deploy.

Local validation (`scripts/diagnostics/test/serve-restic-range-sweep.harness.sh`): a healthy loopback
S3 passed every check (exit 0). A proxy reporting the pack 8 KiB smaller on `HEAD` was flagged
(`LIST` and `HEAD` sizes differ, full GET through `serve restic` returned fewer bytes, exit 2).
Rclone 1.75.1 did not shorten Range responses to the `HEAD` size in that fixture.

**Production sweep (12 Nov 2026).** `LIST` and `HEAD` sizes matched (2,619,016 bytes) and the full
GET through `serve restic` was correct. 169 of 170 Range reads passed. One failed every time it was
tried in that run: `bytes=2605056-2619015`, the last 13,960 bytes of the pack. Status 206, the stream
ended after 2,875 bytes, and those bytes did not match the stored object. Tail ranges of 1, 16, 512,
4,096, 8,192, 15,360, 16,384, 24,576, 32,768 and 65,536 bytes passed.

**Leading hypothesis (H7), from code and a fixture, not yet confirmed in production.** For provider
`Other`, Rclone 1.75.1 sends `Accept-Encoding: gzip` on every GET, including Range GETs
(`use_accept_encoding_gzip` defaults to true), and does not decompress a `Content-Encoding: gzip`
body (`--s3-decompress` is off). It passes the compressed bytes on as if they were the requested range
([s3 backend](https://github.com/rclone/rclone/blob/v1.75.1/backend/s3/s3.go)). If HCP gzip-encodes
some Range responses, Restic receives wrong or short data, rejects it, and retries indefinitely. A
fixture that gzips Range responses carrying `Accept-Encoding: gzip` reproduces the production
signature (206, stream cut after 3,210 bytes, wrong bytes with the gzip magic), and the same range
passes with `--accept-gzip off`.

Decisive production check, read-only:

```sh
docker exec -it <pluton-container> node /tmp/serve-restic-range-sweep.mjs --credentials managed-export --path <bucket>/<replica-prefix> --range 2605056:13960 --repeat 3
docker exec -it <pluton-container> node /tmp/serve-restic-range-sweep.mjs --credentials managed-export --path <bucket>/<replica-prefix> --range 2605056:13960 --repeat 3 --accept-gzip off
```

A failed range is read once more directly with header dumps. The output shows the request's
`Accept-Encoding` and the response status, `Content-Length`, `Content-Range`, `Content-Encoding` and
`Content-Type`, plus whether the received bytes start with the gzip magic. H7 is confirmed if the
first command fails with `Content-Encoding: gzip` and the second passes. The fix would then be a
scoped Rclone option for HCP-mode S3 sessions (`use_accept_encoding_gzip = false`), as a separate
code change with tests.

## What the probe does

1. Lists the replica prefix (`rclone lsjson`).
2. Reads each object in full, one at a time (`rclone cat`), with a 60-second I/O timeout and one
   low-level retry, so a hold surfaces in about a minute instead of after five.
3. Checks the byte count against the listing and the SHA-256 against the object name. Restic names
   `keys/`, `snapshots/`, `index/` and `data/` objects by the SHA-256 of their content, so this is a
   complete storage-level integrity check that does not need the Restic password.
4. For `data/` and `index/` objects, repeats three Range reads (start, middle, end) and compares the
   bytes, because Restic reads blobs with Range requests.
5. On any anomaly, reads that object once more with Rclone header dumps. It keeps only the method,
   status, `Content-Length`, `Content-Range` and timing, which shows whether HCP never answered or
   answered and then stopped the body.

It writes a JSON report to `/tmp/pluton-replica-probe-<time>.json`. The report and console output
contain no keys, endpoint, bucket or prefix. Object keys are content hashes.

## Running on production (operator)

Use a quiet window. The probe reads the whole replica once (the listing prints the total first).
Do not start a recovery job at the same time.

1. Copy `scripts/diagnostics/replica-readback-probe.mjs` from this branch to the Pluton host, for
   example to `/tmp/replica-readback-probe.mjs`.
2. Put it into the container's `/tmp` tmpfs (the root filesystem is read-only):

   ```sh
   docker exec -i <pluton-container> sh -c 'cat > /tmp/replica-readback-probe.mjs' < /tmp/replica-readback-probe.mjs
   ```

3. Run it. `--path` is the replica storage path from the plan's replication settings, in
   `<bucket>/<prefix>` form. The access key and secret are asked with hidden input:

   ```sh
   docker exec -it <pluton-container> node /tmp/replica-readback-probe.mjs \
     --endpoint https://<hcp-s3-endpoint> --path <bucket>/<replica-prefix>
   ```

   Add `--region <name>` if the storage has a region. If the replica uses the same key pair as
   Reliable Download exports, `--credentials managed-export` reads it from the container environment
   instead of prompting. A private CA is taken from `PLUTON_STORAGE_CA_FILE` when set, or `--ca <file>`.

4. Copy the report out and share the console summary or the report:

   ```sh
   docker exec <pluton-container> sh -c 'cat /tmp/pluton-replica-probe-*.json' > replica-probe.json
   ```

5. Remove the files: `docker exec <pluton-container> sh -c 'rm -f /tmp/replica-readback-probe.mjs /tmp/pluton-replica-probe-*.json'`.
   A container restart also clears the tmpfs.

## Reading the result

| Result | Meaning | Next step |
| --- | --- | --- |
| All `OK`, ranges OK | HCP returns every byte of every object, in full and by Range | H1 is unlikely. Download the same backup from the primary (H3), then capture sanitized Restic stderr during a replica job (H2) |
| `STALLED-OR-CUT`, trace `GET` status 200 with `contentLength` | HCP, or the path, sent headers and then stopped the body for this object | Give the storage team the object key, the UTC time and bytes received; ask for that GET in their logs |
| `READ-FAILED`, trace status `no-response-headers` | The request got no response at all | Same escalation, with the timing |
| `HASH-MISMATCH` or `SIZE-MISMATCH` | The stored object differs from what Restic wrote | That replica cannot recover this snapshot. Do not repair or delete anything automatically; decide separately |
| `RANGE-FAILED` | Full reads work but a Range read fails or differs | HCP Range handling for this object; same escalation with offset and length |
| Listing `access-denied` | Wrong key pair for this namespace | Rerun with the replica's own keys |

## Validation

`scripts/diagnostics/test/replica-readback-probe.harness.sh` runs inside a disposable local Pluton
image (Restic 0.19.1, Rclone 1.75.1) with network `none`, a synthetic Restic repository and
`rclone serve s3` on loopback:

- Healthy replica: 9/9 objects OK, all Range reads OK, exit 0.
- One flipped byte in a data pack: `HASH-MISMATCH` on exactly that object, exit 2.
- A TCP proxy that holds one GET body after 64 KiB: `STALLED-OR-CUT` after about 65 KiB with a
  `timeout` category; the trace shows HEAD 200 and GET 200 with the full `Content-Length`, exit 2.
- None of the three reports contained the key, secret, endpoint or path.

No backend or frontend code changed, so the backend and frontend suites were not rerun.

## Limitations

- Reads are sequential. Restic uses up to five parallel requests, so a fault that needs concurrency
  may not reproduce.
- It does not identify which pack Restic was reading at the 2,232,832-byte mark. If every object
  passes, the next step is a targeted capture of sanitized Restic stderr for the archive operation.
  That needs a code change and a deploy, and is not part of this branch.
- The 60-second probe timeout differs from Rclone's 5-minute default in Pluton. A response that
  resumes after 60 seconds is reported as a failure here.
- The local harness does not reproduce HCP, TLS inspection or production network behavior.

## Rollback

Nothing is deployed. Remove the two files from the container `/tmp`, or restart the container.
