# Managed symlink Download and Restore

Branch: `codex/managed-symlink-download-restore`.
Base: `cd08fafd8092c4694d1ecb30d4f89d9ab627b100` (`origin/main` when this worktree was created).
All implementation and validation use a separate worktree. No production repository,
Agent, backup schedule, replication configuration, or parallel transport checkout was changed.
This branch is local only; no push, merge, deployment, or hosted CI result is claimed.

## Confirmed cause and native evidence

The index correctly classified symbolic links but could not learn their target text
from Restic's JSON listing. Its strict `assertSafe()` therefore refused every link.
The filesystem verifier also refused links and counted all non-files as directories.
These were application compatibility boundaries, not proof that a completed backup
was corrupt or independently restorable.

The disposable research probe used actual Restic **0.19.1** on Linux. The listing
omitted target text; `dump --archive tar` preserved eight link entries and their
stored targets. An independent Restic restore reconstructed those links, including
broken links and cycles, without reading their targets. Changing a source link
after backup did not change the historical snapshot. A FIFO was indexed but omitted
by Restic's TAR dump. The live Unix socket was not indexed by Restic backup at all.
Consequently TAR exit success alone cannot prove snapshot entry completeness.

This agrees with Restic's primary sources: [TAR writer](https://raw.githubusercontent.com/restic/restic/v0.19.1/internal/dump/tar.go),
[listing implementation](https://raw.githubusercontent.com/restic/restic/v0.19.1/cmd/restic/cmd_ls.go),
[node model](https://raw.githubusercontent.com/restic/restic/v0.19.1/internal/data/node.go),
[restorer](https://raw.githubusercontent.com/restic/restic/v0.19.1/internal/restorer/restorer.go),
and [restore documentation](https://restic.readthedocs.io/en/v0.19.1/050_restore.html).
Application acceptance below is based on executed fixtures, not solely these sources.

Four boundaries remain distinct:

1. Read link text from archive metadata without opening its target.
2. Never turn a link into a regular file or follow it during export.
3. Reconstruct approved links only in an owned, initially empty staging directory.
4. Validate restored links with `lstat` and `readlink`; never descend through them.

## Supported subset and refusal policy

| Entry or target                                                                 | Full Download                                                                       | Existing staged Restore                         |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| Regular files, explicit/empty directories, safe literal `%`, `:`, Unicode paths | Included and verified                                                               | Supported subject to host path/permission rules |
| Relative link to a file or directory within the archive staging root            | Preserve exact link text                                                            | Reconstruct and check exact link text on POSIX  |
| Internal broken link                                                            | Preserve as link metadata                                                           | Reconstruct; no target existence requirement    |
| Closed harmless cycle                                                           | Preserve as link metadata                                                           | Reconstruct; never traverse the cycle           |
| Parent-relative link contained within the staging root                          | Supported after metadata graph validation                                           | Same policy                                     |
| Target passing through another link                                             | Resolve using stored metadata only; reject escape                                   | Same policy before writes                       |
| Absolute or escaping target                                                     | Refused, including absolute targets that happen to point inside the original source | Refused before Restic restore                   |
| Backslash, control/invalid Unicode or over-4096-byte link target                | Refused                                                                             | Refused                                         |
| More than 40 link follows / 4096 graph component steps                          | Refused with bounded graph-limit reason                                             | Refused                                         |
| FIFO, device, socket or other unsupported indexed node                          | Refuse complete export, even when Restic TAR omits it                               | Refuse full restoration                         |
| TAR hardlink, sparse/global/unknown extension                                   | Refused; no alternate extraction interpretation                                     | No new archive extraction path                  |
| Link reconstruction on Windows                                                  | TAR metadata can be downloaded                                                      | Refused with POSIX-staging requirement          |

The staging root is the root of the entire snapshot layout, not necessarily an
individual backed-up source directory. No claims are made about following a restored
link later, extracting into an existing directory, universal filesystem metadata
fidelity, hardlink identity, or recovering source entries Restic never stored.
Absolute/external links remain deliberately unsupported. A production snapshot with
such entries still fails closed; this report does not claim either reported incident
has passed without independently examining its authorized snapshot.

## Full Download security and resource model

The unchanged strict `assertSafe()` remains available to its existing consumers.
A separate structural policy admits supported entries only when followed by a
complete, exact-snapshot TAR verification. Preparation reads the native TAR into a
discarding sink while producing a canonical TAR digest and metadata proof. Transfer
reads the exact snapshot again and checks every selected entry's metadata and file
SHA-256 against that proof. Restic must exit successfully, every required entry must
be present once, padding/footer must be valid, and the canonical digest/length must
match before the stream operation reports success. A transfer failure terminates
the HTTP stream; JSON or provider diagnostics are never appended to archive bytes.
Consumers must treat normal stream completion as required, not infer success from
HTTP 200 or the first archive entries.

The reader validates USTAR/GNU magic/version, checksum, numeric encodings, exact
indexed path/type/size, duplicates, padding, two zero footer blocks, and bounded
zero tail. An index ancestor cannot be a non-directory. It accepts bounded PAX `x`
and GNU `L`/`K` records, with at most three records and 64 KiB aggregate extension
payload for an entry. It rejects ambiguous/duplicate records, traversal overrides,
hardlinks, sparse records and unknown extension keys. Allowed metadata is regenerated
with `tar-stream`; raw extended headers never reach the recipient. Permissions,
owner fields and standard timestamps are retained where representable; PAX prevents
silent wide-owner, Unicode-owner or post-2038 truncation. Safe user xattrs and POSIX
ACL metadata are allowlisted; privileged/unknown xattr namespaces are refused.

The production parser retains one 512-byte header, bounded extensions and stream
buffers under backpressure. It never opens archive paths, extracts an archive, holds
a full TAR Buffer, or writes a temporary TAR. SHA-256 is incremental.

The existing index stays capped at **500,000 entries, 256 MiB per index, two indexes**;
Browse still uses 200-row server pages. A separate private metadata-only SQLite
sidecar is capped at **128 MiB per index**, shares its generation/lease/eviction
lifecycle, and stores common immutable ordinary entries once across modes. Maximum
main/proof database allocation is therefore 768 MiB for two fully allocated pairs,
plus bounded SQLite caches/journal and private session metadata. Proof inserts batch
at 256 rows or about 1 MiB encoded metadata (plus one bounded entry); duplicate
cursors flush at 256 paths. No transaction spans an `await`. Capacity exhaustion
fails closed. The original index cap was not enlarged to fit proofs.

Authentication, managed repository ownership, exact historical snapshot tags/IDs,
current context rechecks, one preparation worker/four admitted jobs/32 statuses,
cancellation, explicit retry, original deadlines and two-minute ready TTL remain.
The job key includes export mode. Eviction or process restart invalidates admission
proofs. Full and partial proof identities cannot authorize one another.

## Download Regular Files Only and UI

`regular-files` includes **every** indexed regular file and directory, including
empty directories, and excludes links and unsupported special types. It never
dereferences an excluded target. Every emitted TAR record still has to match its
indexed type. A mode-specific complete scan proves ordinary-file completeness;
counts include entries Restic omits from TAR, such as FIFO. Unknown/malformed TAR
metadata remains a refusal, not a filtering fallback.

The deterministic authenticated JSONL manifest contains version/exact binding/mode,
path-sorted included entries (canonical metadata, file SHA-256 or link text), and
included/excluded counts by type. Its digest and the canonical TAR digest/length
are returned in ready status. It contains authorized snapshot paths, not repository
credentials, provider output, session paths or secret environment values.

The existing preparation panel has exactly two radio options, Full Download
(Recommended) and Download Regular Files Only. It shows the selected mode, actual
status/indexed/verified counts, type counts, a manifest link, existing retry/cancel,
and native browser TAR download. Switching modes cancels active old-mode work first.
There is no fabricated percentage or transfer-completed claim. Existing themed
tokens and focus/accessibility behavior are retained. The partial warning is:

> This is a partial export. Symbolic links and special filesystem entries are excluded. It may not be sufficient to restore the application completely.

There is no new Restore option, mode, button or location.

## Restore and Recovery Test

Both real Restic restore paths are tested independently of TAR download. If a
selection contains links, the full supported snapshot link graph and content proof
must pass before Restic writes into staging. Granular selection does not bypass an
unsafe wider snapshot proof. Existing include/exclude limits and literal matching
remain. The workspace and empty isolated destination are checked again after
preparation and immediately before restore.

Post-restore verification checks the complete selected structure, regular-file
sizes/SHA-256, and exact link target text. Link validation never calls `realpath`,
opens or descends through the link. Regular files are opened with `O_NOFOLLOW` and
their opened identity/size checked before hashing. Completion counters count actual
regular files and bytes; directories and links are checked separately. Database
artifact hashes, historical binding, import/security controls, cleanup and
cancellation remain. An unreadable restored file/unsupported host condition fails
verification; permissions are not silently widened as a workaround.

## Executed validation

| Check                                                                                                                                        | Result                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full Linux backend: Jest with repository config, `--runInBand --silent --verbose=false`                                                      | **202 suites, 4,129 passed**, seven existing conditional skips; 355.491 s                                                                        |
| Windows recovery service: `pnpm --filter @plutonhq/core-backend test --runInBand __tests__/services/RemoteRepositoryRecoveryService.test.ts` | **120 passed**, 236.720 s; includes the complete 100,000-file index/proof case                                                                   |
| Archive security: `pnpm --filter @plutonhq/core-backend test --runInBand __tests__/utils/restic/ManagedTarExport.test.ts`                    | **33 passed**, 2.326 s; also included in full Linux suite                                                                                        |
| HTTP authorization/modes and BackupService routing                                                                                           | **95 passed** across the two focused suites; also included in full Linux suite                                                                   |
| Frontend: `node --experimental-strip-types --test frontend/__tests__/*.test.ts`                                                              | **340 passed**, no skips; 14.235 s                                                                                                               |
| Final panel/request rerun                                                                                                                    | **16 passed**, 3.574 s                                                                                                                           |
| Existing worker startup/image boundary tests                                                                                                 | **19 passed on Linux**; the Windows security batch including these and internal/runtime boundaries had **31 passed**                             |
| Backend lint, backend `tsc --noEmit`, frontend `tsc -b`, `git diff --check`                                                                  | PASS                                                                                                                                             |
| `pnpm build`                                                                                                                                 | PASS, all three workspace build tasks; final backend rebuild also PASS                                                                           |
| `pnpm --filter @plutonhq/core-frontend lint`                                                                                                 | Existing ESLint configuration fails to load: typescript-eslint rejects the string `eslint-config-prettier` in `extends`; configuration unchanged |

The Linux full Jest runtime used Node 24.22.1, 2 CPUs and 6 GiB for test compilation,
with disposable writable test directories and source mounted read-only. That is
separate from the native **4 GiB** application fixture. Windows/native fixture Node
was 24.16.0; the native tools were Restic 0.19.1 and Rclone 1.75.1. pnpm was the
repository-pinned 10.20.0, installed with the unchanged frozen lockfile.

The full suite initially exposed two Linux-only assertions expecting unconditional
symlink refusal. They now explicitly assert the new POSIX target-verification
boundary, retain the Windows refusal, and cover four special-node selections before
native restore writes. No security assertion or CI gate was removed. An initial
Linux worker-test invocation lacked its required fixture files/writable outputs;
mounting the existing inputs and disposable output directories produced the passing
result above, without changing worker code.

The portable authenticated gateway fixture also passed with **65,000 ms and
126,000 ms** synthetic repository delays against a 5,000 ms gateway. Admission was
75/89 ms and maximum status response 82/91 ms; complete preparation took
65,815/126,823 ms. It uses valid synthetic TAR and verifies the returned canonical
digest/footer, not native SFTP evidence.

The native runner builds only a disposable local fixture image with GNU tar, based
on the existing native test image. Application/Restic/SFTP/extraction run as UID
1000 with no capabilities or privilege escalation, a read-only root filesystem,
no published ports, **2 CPUs / 4 GiB memory / zero swap**, and private disposable
volumes. The root-only setup step changes ownership of the fresh empty test volume.
It never mounts the Docker socket into the container or modifies global settings.
This cgroup also contains source/client fixture work and page cache. It is **not a
full production VM measurement**.
Large ordinary payloads are written using `crypto.randomFillSync` in bounded 4 MiB
chunks, not sparse holes or repeated zero buffers. The combined fixture adds
115,552 small long-name files. Repository traffic is real encrypted SFTP over
container loopback; WAN latency, production storage throughput and a complete
production VM workload still need separate acceptance.
Authentication, router/controller/service, disk index and native repository path
are real; disposable in-memory domain-store adapters supply the synthetic plan,
backup and restore rows. This is not a fully wired deployment/database/UI smoke
test and does not replace that operator acceptance gate.

Reproduction:

```powershell
docker build -t pluton-symlink-native:local -f scripts/fixtures/managed-symlinks/Dockerfile .
./scripts/validate-managed-symlinks.ps1 -Modes small,large,combined,four
```

The fixture asserts exact historical ID, source-time inventories, canonical archive
hash/size/footer, streamed manifest checksum/row counts, GNU tar extraction,
ordinary-set filtering, seven safe links, nine excluded links plus a FIFO in the
latest partial snapshot, source/repository immutability, concurrent Browse,
cross-mode refusal, actual LRU eviction and explicit reprepare, full/selected
Restore, independent Recovery Test and zero OOM events. Small also cancels an active
native archive read, retries and starts an actual fresh application process.
TAR unit tests cover malicious paths/headers and device-like metadata without
creating privileged host devices. Test-only inventories may be large; production
exports use the capped disk proof, not these in-memory fixture inventories.

The final small rerun passed with 21 indexed entries / 64,061 ordinary bytes,
83,456-byte Full TAR and 78,848-byte partial TAR. Admission/status maxima were
127/99 ms. Main/proof databases were 61,440/24,576 bytes. Peak RSS was 327,634,944
bytes for Node, 92,164,096 for Restic and 69,861,376 for Rclone; cgroup peak including
the fixture was 590,127,104 bytes, with zero OOM events. Cancellation/retry, actual
LRU eviction/reprepare and a fresh process all passed. Two Restic processes were
observed at peak during the concurrent/cancellation fixture; one preparation worker
does not mean authorization/Browse/native shutdown can never overlap.

Completed native matrix records:

| Dataset                   | Indexed entries | Ordinary bytes |      Full / partial TAR bytes | Node peak RSS |  Restic / Rclone peak RSS | Admission / status maxima |
| ------------------------- | --------------: | -------------: | ----------------------------: | ------------: | ------------------------: | ------------------------: |
| Small (final rerun)       |              21 |         64,061 |               83,456 / 78,848 |   327,634,944 |   92,164,096 / 69,861,376 |               127 / 99 ms |
| Large                     |              25 |  1,230,000,061 | 1,230,021,632 / 1,230,017,024 |   343,642,112 | 237,383,680 / 241,319,936 |               81 / 177 ms |
| Combined large + metadata |         115,584 |  3,170,924,477 | 3,406,675,968 / 3,406,671,360 |   931,569,664 | 421,265,408 / 240,996,352 |               83 / 336 ms |

The separate 4 GB random-data fixture also passed: 35 indexed entries and
4,000,000,061 ordinary bytes; Full/partial TAR sizes were 4,000,026,624/4,000,022,016
bytes. Admission/status maxima were 72/228 ms. Node/Restic/Rclone peak RSS was
376,610,816/256,262,144/238,436,352 bytes. Main/proof databases were 94,208/28,672
bytes. Its cgroup peak was 4,296,830,976 bytes with zero OOM events. Full archive
SHA-256 was `6786a9f3f7cf4221d31d4c1af64c4d0c0d4502a3dfb3082d36afe6f4d59f962c`;
partial archive SHA-256 was
`bbfcc67e62e2610ed1b9a0b01935d81a3fef933fafd78afebdc24a47871cbff1`.

Every row and the 4 GB fixture passed Full Download, partial export, full/selected Restore, independent
Recovery Test, repository/source immutability, actual cache eviction and explicit
reprepare, and zero OOM assertions. Large, combined and 4 GB fixtures each used seven
archive reads across preparation/reprepare/transfers/restore proofs. There was no
server TAR staging. Kernel-reported cgroup peaks were 4,295,675,904 and 4,296,249,344
bytes for large/combined, close to the configured 4 GiB ceiling (including accounting
overshoot, page cache and fixture work), with `oom=0` and `oom_kill=0`. These are not
claims of a comfortable production VM memory margin. Node peak includes the lab's
large source/client inventory maps, unlike the bounded production proof design.
All four matrix cases completed with exit zero. An additional small run exercised
the final validator and evidence instrumentation. Containers and labeled
fixture volumes were confirmed absent after cleanup. Earlier small research/end-to-end
runs also passed; intermediate failed experiments are described separately below.

Two intermediate experiments were not counted as native passes: putting proof rows
inside the original index hit its unchanged 256 MiB cap, so proof metadata moved
into the separately capped sidecar; another combined run completed verified Full
extraction but requested its manifest after the unchanged two-minute ready expiry.
The fixture now fetches the manifest while ready and checks actual LRU eviction
independently. The production expiry was not extended or suppressed. The completed
combined record above includes the entire corrected acceptance sequence.

Representative independently checked small-fixture digests (synthetic data only):

| Artifact              | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Source-time inventory | `9c8c32dc48781cd1e46f0107ea9374ceb2388e6c4b9b91c03a402e4c10a978f6` |
| Full canonical TAR    | `1b5443933c74414cc3977581835da205d8fad1a4bfb8f9f779c5beefc1818488` |
| Full manifest         | `50c304bb60d316bffd32596553486459532b0d4f280bc96e0a8a44edadd00eac` |
| Partial canonical TAR | `f4525d878c180c588e7543653114327ff2c0729b528e56490126e9c582812d6b` |
| Partial manifest      | `e5e5e8682402e17aea6caf67ccf18776ad6366a3e1fe2e465e5dda75522f9848` |

Every extracted regular file and preserved link was compared with the source-time
inventory. Full/selected Restore and Recovery Test had their own complete structure,
content hash and link-text comparisons. Archive and manifest hashes are different
artifacts; neither substitutes for the per-file/source inventory checks. New
fixtures use random private roots and snapshot bindings, so their manifest/TAR
digests are not expected to equal this recorded fixture's digests.

## Integration contract for the parallel download transport branch

This branch adds no S3 temporary export, HTTP Range, resumability, durable export
job or transfer telemetry implementation. Do not merge another branch as part of
this task. The transport owner can consume:

- `ManagedExportBinding`: exact `{backupId, repositoryId, snapshotId}`. Authorization
  and current owner/context checks remain in the recovery service, not client input.
- `ManagedExportMode`: closed `full | regular-files`; include it in every durable
  job/object key, dedup key, preparation request, lookup and proof identity.
- `prepareManagedExport(index, session, proof, signal)`: complete scan into a bounded
  sink, returning an immutable `ManagedExportSummary` for this binding/mode.
- `streamManagedExport(index, session, proof, destination, signal)`: verified,
  backpressured canonical stream. Consumers cannot disable proof comparison. It
  resolves only after native success, structural completeness, entry hashes and
  final digest/byte checks; any rejection/abort means an incomplete/untrusted export.
- `ManagedExportSummary`: version, binding, mode, included/excluded counts/by-type,
  manifest SHA-256, archive SHA-256 and archive byte length. Export manifest ordering
  is versioned and deterministic for that snapshot/binding/mode.
- `ManagedArchiveDownload`: safe filename, required summary and `streamTo` descriptor.
  Keep the index lease, generation check and exact snapshot/context checks around it.
- Closed `managed-export-refused` reasons distinguish unsupported node/target/graph,
  invalid or unsupported TAR, incompleteness/mismatch, capacity and missing proof.
  Never surface raw subprocess output or credentials as diagnostics.

Future durable exporters must keep an object private/unpublished until verified
stream completion, persist the exact summary, discard incomplete output on abort,
and independently enforce ownership. This branch's proof is intentionally ephemeral;
it is not a durable/resumable object claim. Preparation and transfer currently read
the archive twice; account for that cost when integrating a verified durable sink.
The existing two-minute ready TTL continues to apply to starting new requests;
an active leased transfer is not invalidated merely because a long transfer crosses
that deadline. Fetch a manifest while preparation is ready or explicitly prepare
again. Manifest availability does not imply a client finished downloading its TAR.

Minimal shared-file changes are the appended mode argument and verified descriptor
in BackupService/recovery service, preparation summary/status, strict controller
query handling/new manifest route, frontend request/native URL mode, and existing
panel options. The portable async gateway fixture now supplies valid synthetic TAR
and expects the additional proof read; its timeout behavior is unchanged.

## Remaining gates and rollback

Before production adoption, an operator must publish/review this local branch,
reconcile the documented shared interfaces with the transport branch and run hosted
CI. Validate authorized real historical snapshots in independent empty Linux staging,
including any unsupported absolute/external links, xattrs/ACLs, permissions and
application recovery. Verify destination ownership/capacity and extraction-tool
behavior. Download success alone is not Restore or application-recovery success.
Check actual VM memory/disk/quota and concurrent workload limits; the local cgroup
does not establish production capacity. No production acceptance or deployment is
performed here.

Rollback is a normal revert of this focused commit and rebuild/restart through the
operator's deployment process. There is no schema/repository-format migration to
undo and no snapshot mutation. Disposable proof/index caches may be removed only
through the existing owned-cache lifecycle with active work stopped; reverting
restores the previous conservative link refusal. Existing staged files and completed
browser downloads are user data and must not be deleted by rollback.

## Exact changed files

- `backend/src/utils/restic/ManagedExportPolicy.ts`
- `backend/src/utils/restic/ManagedExportProof.ts`
- `backend/src/utils/restic/ManagedTarExport.ts`
- `backend/src/utils/restic/ManagedSnapshotIndex.ts`
- `backend/src/utils/recoveryValidation.ts`
- `backend/src/types/recoveryTests.ts`
- `backend/src/services/RemoteRepositoryRecoveryService.ts`
- `backend/src/services/ManagedDownloadPreparation.ts`
- `backend/src/services/BackupServices.ts`
- `backend/src/controllers/BackupController.ts`
- `backend/src/routes/backups.ts`
- `frontend/src/components/Plan/Backups/DownloadPreparation.tsx`
- `frontend/src/components/Plan/Backups/DownloadPreparation.module.scss`
- `frontend/src/utils/downloadPreparation.ts`
- `frontend/src/utils/backupDownload.ts`
- `backend/__tests__/utils/restic/ManagedTarExport.test.ts`
- `backend/__tests__/utils/recoveryValidation.test.ts`
- `backend/__tests__/services/RemoteRepositoryRecoveryService.test.ts`
- `backend/__tests__/services/BackupServices.test.ts`
- `backend/__tests__/routes/backups.test.ts`
- `frontend/__tests__/downloadPreparation.test.ts`
- `backend/__tests__/integration/managedSymlinkRestic.probe.mjs`
- `backend/__tests__/integration/managedSymlinkRecovery.runtime.ts`
- `backend/__tests__/integration/managedSymlinkRecovery.lab.ts`
- `backend/__tests__/integration/managedSymlinkRecovery.restart.ts`
- `backend/__tests__/integration/managedAsyncDownload.protocol.ts`
- `scripts/validate-managed-symlinks.ps1`
- `scripts/fixtures/managed-symlinks/Dockerfile`
- `docs/MANAGED_SYMLINK_DOWNLOAD_RESTORE_REPORT.md`
