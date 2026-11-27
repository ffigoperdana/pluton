# Browsing MinIO objects in a snapshot (design)

Status: implemented on branch `claude/minio-object-browse`. Server and UI only;
the Managed Agent is unchanged.

A Managed Agent plan can back up the data folder of a MinIO server (for example
the Docker volume `/var/lib/docker/volumes/example-minio/_data`) together with
database dumps and other files. A full restore of that folder already works.
What is missing is getting **one object back as its original file** without
restoring the whole folder (often hundreds of GiB) and starting MinIO on it.

On disk, MinIO in single-drive mode (`xl-single`) does not keep plain files:

```
<data>/.minio.sys/format.json                  {"format":"xl-single", ...}
<data>/<bucket>/<key>/xl.meta                  versioned msgpack metadata, small objects inline
<data>/<bucket>/<key>/<data-dir-uuid>/part.N   object data with a 32-byte bitrot hash per 1 MiB block
<data>/<bucket>/<prefix>__XLDIR__/xl.meta      the "directory object" <prefix>/
```

## Options

| | (a) Parse `xl.meta`, read part files | (b) Restore a subset, run MinIO read-only |
| --- | --- | --- |
| Reads for a listing | every `xl.meta` of one bucket | every `xl.meta` plus `.minio.sys` |
| Reads for one object | its `xl.meta` and its own part files | the same files, restored to disk first |
| Extra software on the server | none | a MinIO binary or image matching the writer's release (AGPL-3.0; Docker Hub no longer serves `minio/minio`) |
| Read-only | yes | no: MinIO writes `.minio.sys/tmp`, `multipart`, metacache, healing and usage data and refuses a read-only drive |
| Disk on the server | metadata of one bucket, then nothing | metadata plus the full data of each object read |
| Unsupported layouts | detected and refused per object with a reason | MinIO may heal, rewrite or hide versions instead of failing |
| Failure surface | our parser (bounded, tested against real MinIO output, end-to-end MD5) | process lifecycle, ports, credentials, version skew |

**Decision: (a).** It reads only what a request needs, writes nothing to the
repository or the source, and adds no server process or binary. The cost is
owning a small parser for a documented-by-code on-disk format, so the parser
accepts exactly the layouts it was tested against and refuses everything
else. Content is verified end to end (below), so a parser mistake can fail a
download but cannot deliver wrong bytes.

## Supported layout

| Item | Accepted | Otherwise |
| --- | --- | --- |
| `.minio.sys/format.json` | `format` `xl-single`, one set of one drive | `xl` (erasure across drives), `fs`, others: the data folder is listed as unsupported with the reason |
| `xl.meta` container | `XL2 ` header, major 1, minor 0–3; minor ≥ 2 CRC (low 32 bits of xxHash64) must match | unknown header/version, bad CRC, trailing bytes: object `metadata-invalid` |
| Version header/meta versions | ≤ 3 | `metadata-invalid` |
| Version type | object (1), delete marker (2) | legacy V1 (3): `legacy-version` |
| Erasure | `EcAlgo` 1, `EcM` 1, `EcN` 0, `EcIndex` 1, `CSumAlgo` 1 (streaming HighwayHash, 32-byte hash per shard) | `erasure-multi-drive`, `unknown-layout` |
| Encryption | none | any `X-Minio-Internal-Server-Side-Encryption-*` or `encrypted-multipart` key: `encrypted` |
| Tiering | data local | `transition-status: complete`: `transitioned`; free (tier) versions are hidden like MinIO does |
| Compression | none, `klauspost/compress/s2`, `golang/snappy/LZ77` (S2 or Snappy framing) | other values: `unknown-compression` |
| ETag | `<md5>` or `<md5>-<parts>` with the matching part count | `etag-unverifiable` (not downloadable) |
| Legacy `xl.json` objects (pre-2020) | listed | `legacy-format` (not downloadable) |

Keys are the path below the bucket folder; a `__XLDIR__` suffix becomes a
trailing `/`. Versions are ordered newest first; the newest one decides
whether the object is current or deleted. Data of inline versions is the
`xl.meta` inline map entry keyed by the version ID (`null` when unversioned);
other versions read `<key>/<DDir>/part.<n>` for every part number.

## Reading

Server side, through `RemoteRepositoryRecoveryService.withSnapshotFiles`: the
verified snapshot index and the allowlisted repository session (`--no-lock`,
read-only), with the snapshot identity and ownership verified before and after.
The plan's primary repository is read, as for Browse.

1. **Detection** (`GET /api/backups/:id/minio`). Waits for the existing snapshot
   index (answers `202` while it builds) and looks for `.minio.sys/format.json`
   files (at most 8) in the index alone, so a snapshot without MinIO data costs
   no file reads. Only when one exists is each read (at most 64 KiB) and are the
   bucket folders listed with their number of `xl.meta` files and bytes. Cached
   per snapshot. `GET /api/backups/:id/details` reports `minioObjects: true` for
   completed Managed Agent snapshots; Browse then asks and shows the
   **MinIO objects** tab when a data folder was found.
2. **Bucket catalog** (`GET /api/backups/:id/minio/objects`). One restic
   restore with the single include `<data>/<bucket>/**/xl.meta` into a private
   workspace under `<data>/minio-catalogs/` (refused when the data folder path
   holds glob characters, when a folder is named `xl.meta`, above 2 GiB of
   metadata, or without that much free disk plus 256 MiB). Each restored file
   must match the size in the index; Restic's `files_restored` also counts the
   folders it creates, so it is not used as proof. (Checked with restic 0.19.1
   on the fixture: the include restores exactly the 11 `xl.meta` files of
   `example-bucket`, no part file.) Each `xl.meta` is parsed into a SQLite
   catalog of versions (key, version ID, size, time, ETag, content type, parts,
   status) and deleted at once; inline object data is never kept. Phases
   `waiting`, `metadata-restore`, `parsing` are reported with counts.
3. **Download** (`GET|HEAD /api/backups/:id/minio/objects/:objectId/download`).
   `HEAD` answers from the catalog. `GET` reads that object's `xl.meta` again
   (exact `restic dump`), requires the version to be unchanged from the catalog,
   checks every part file size in the index (`size + 32 × ⌈size / block⌉`), then
   streams each part with `restic dump`, strips the bitrot hashes, decodes S2
   when compressed and verifies.

### Verification ("never return wrong data")

- Restic verifies every repository blob it reads.
- `xl.meta`: CRC, strict msgpack bounds, header/meta consistency, part counts
  and size sums.
- Part files: exact stored size before reading; decoded bytes per part must
  equal the recorded (actual) part size; S2 chunks carry CRC-32C.
- Content: MD5 of the whole object for `<md5>` ETags, MD5 of each part and the
  MD5 of those digests for `<md5>-<n>` ETags (what S3 multipart uploads use,
  compressed or not, since MinIO hashes the uncompressed data).
- The last chunk is held back until verification succeeds. On a mismatch the
  connection is closed short of `Content-Length`, so a browser never saves a
  complete-looking file.

The 32-byte HighwayHash bitrot hashes are skipped, not checked: the MD5 check
covers the same bytes after decoding, and an implementation would add code
without adding protection.

## Limits

| Limit | Value |
| --- | --- |
| Data folders detected per snapshot | 8 |
| Metadata restored per bucket catalog | 2 GiB, plus 256 MiB free disk |
| Versions per catalog | 2,000,000 (413 above) |
| Catalog database | 512 MiB |
| One `xl.meta` | 64 MiB |
| Catalogs kept | 3, least recently used evicted; 12 h idle; removed on restart |
| Concurrent catalog builds / object downloads | 1 / 2 |
| Page size | 100 by default, at most 500; folders at most 1,000 per level |

The snapshot index bound (1,000,000 entries) applies first: a bucket with
about 300,000 objects in part files fills it.

## Not covered

- Multi-drive erasure sets, SSE (S3, KMS, C), objects moved to a remote tier,
  pre-2020 `xl.json` objects and unknown future formats: listed with the
  reason, never downloaded. Restore the folder (all drives) and use MinIO.
- Restoring an object onto the Agent host: the Agent restores snapshot files
  as they are; decoding there would need an Agent release.
- Very many parts: each part is one `restic dump`, so an object with hundreds of
  parts downloads noticeably slower than a single file of the same size.

## Tests

`backend/__tests__/fixtures/minioObjects/` holds data written by a real MinIO
server (release in `minio-version.txt`) in disposable containers, regenerated
with `generate.sh`: an `xl-single` deployment with inline, single-part,
multi-block, multipart, S2-compressed (inline, part, multipart), SSE-S3,
directory, empty and non-ASCII objects, a versioned bucket with a null
version, several versions and a delete marker, and drive 1 of a four-drive
erasure set. `listing.jsonl` is MinIO's own `mc ls --versions --json`, used as
the oracle for the catalog; `sources.json` holds the MD5/SHA-256 of every
uploaded file, used as the oracle for downloads. Docker Hub no longer serves
`minio/minio`; the script defaults to `cgr.dev/chainguard/minio` and accepts
`MINIO_IMAGE`/`MC_IMAGE` overrides.

- `backend/__tests__/utils/minioObjects/xlMeta.test.ts`: every fixture
  `xl.meta` against MinIO's listing, byte-exact content of all 16 readable
  versions at two chunk sizes, corruption (ETag, truncation, S2 CRC, xl.meta
  CRC, index header), pre-index containers 1.0–1.2 re-sealed from the fixture,
  free/transitioned/unknown-compression versions, S2 repeat codes.
- `backend/__tests__/services/MinioObjectService.test.ts`: a real
  `ManagedSnapshotIndex` over the fixture with a restore that honours the
  include pattern: detection, folders/search/sort/versions, downloads, refusals,
  limits, damaged and `xl.json` objects, retry.
- `backend/__tests__/routes/backups.test.ts`, the new case in
  `RemoteRepositoryRecoveryService.test.ts` and `frontend/__tests__/minioObjects.test.ts`.

Not covered by an automated test: a real Restic repository read through the
SFTP/S3 session and the UI in a browser.
