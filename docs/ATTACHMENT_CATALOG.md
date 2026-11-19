# Attachment catalog (Odoo filestore names)

Some applications store uploaded files under a content hash and keep the original
name only in their database. Odoo is the first: its filestore holds
`<data_dir>/filestore/<db>/<2 hex>/<40 hex>` files, and `ir_attachment` maps each
`store_fname` to a name, MIME type, size and owning record. Browsing such a
filestore snapshot shows thousands of hash names. The attachment catalog pairs
the filestore plan with the plan that dumps the application database and shows
the files under their original names, in the existing Browse dialog.

## Settings

A Managed Agent backup plan may carry `settings.attachmentCatalog`:

```json
{ "version": 1, "adapter": "odoo", "databasePlanId": "<plan>", "databaseId": "db_…", "filestoreRoot": "/srv/example-app/filestore/example_db" }
```

- `databasePlanId` names another Managed Agent plan whose database settings
  (`remoteLifecycle` version 2) have a PostgreSQL entry `databaseId`.
- `filestoreRoot` is optional; it defaults to the plan's single source path. It
  is the snapshot folder that holds the two-character hash folders.
- `null` switches the catalog off. Unrelated plan edits keep it; a value equal to
  the stored one is not revalidated, so a later problem with the paired plan
  never blocks other edits. A changed value is validated
  (`utils/attachmentCatalog/config.ts`): strict shape, a Managed Agent backup
  plan, a different existing database plan with that PostgreSQL entry, and an
  absolute snapshot path.

## Building a catalog

`AttachmentCatalogService` builds one catalog per pair of snapshots, on first
request from `GET /api/backups/:id/attachments`:

1. **Pairing.** Among at most 8 completed backups of the database plan on either
   side of the filestore backup (`BackupStore.completedNear`), the nearest one
   whose recorded lifecycle artifacts hold `/pluton/database/<dumpFilename>` for
   that `databaseId`.
2. **Database dump.** The dump is read through `RemoteRepositoryRecoveryService.downloadItem`
   (the verified single-item stream used by Browse downloads) into
   `PgCopyTableReader` (`utils/attachmentCatalog/pgCopyParser.ts`). The reader
   finds `COPY public.ir_attachment (…) FROM stdin;` in the plain-format dump
   that Managed Agents produce, keeps only the needed columns (each at most
   4 KiB), skips other tables' data with native newline searches and never takes
   a line inside another COPY block for a statement. The stream is stopped as
   soon as the table ends, so only the part of the dump up to `ir_attachment`
   is read.
3. **Mapping.** `odooAttachmentFromRow` keeps binary attachments with a
   filestore path (`store_fname` matching a relative, non-traversing pattern),
   prefers Odoo 12's `datas_fname` over `name`, removes control characters, and
   counts database-stored and URL attachments separately.
4. **Matching.** Under a lease on the verified filestore snapshot index
   (`withSnapshotIndex`), each attachment is marked present when
   `<filestoreRoot>/<store_fname>` is a file in the snapshot.

The catalog is a SQLite file under `<data>/attachment-catalogs/catalog-<random>`
(journal off, `max_page_count` capped). Requests while it builds answer
`202` with `Retry-After: 2` and the phase (`database-dump`, `filestore-index`,
`matching`) with byte and row counts.

| Limit | Value |
| --- | --- |
| Attachments per catalog | 2,000,000 (413 above) |
| Catalog database | 512 MiB page cap; 192 MiB free disk to start (128 MiB plus a 64 MiB reserve), growing while space remains; `SQLITE_FULL` is a 507 |
| Catalogs kept | 3, least recently used evicted; 12 h idle; removed on restart |
| Concurrent builds | 1 (others wait in phase `waiting`) |
| Kept field size | 4 KiB per column, longer values truncated |
| Page size | 50 by default, at most 200 |

## API

- `GET /api/backups/:id/attachments?search=&model=&status=all|present|missing&sort=name|created|size&order=asc|desc&offset=&limit=&retry=true`
  returns the page, the pairing (database plan, database backup and time), the
  counts and the 50 most frequent models. `search` is a literal substring
  (LIKE wildcards escaped). A failed build stays failed until `retry=true`.
- `GET|HEAD /api/backups/:id/attachments/:attachmentId/download` streams one
  present attachment through the same verified item download, with
  `Content-Disposition: attachment; filename="<ASCII>"; filename*=UTF-8''<name>`.
- `GET /api/backups/:id/details` reports `attachmentCatalog: { adapter }` when the
  plan has a catalog, which shows the **Odoo attachments** tab in Browse.

## Boundaries

- Read-only: no repository write, staging restore or lock beyond the existing
  verified read paths.
- The catalog stores names, types, sizes, models, record IDs, field names,
  creation times and hash paths only, never attachment contents
  (`db_datas`) or extracted text (`index_content`).
- Errors are server-written messages: a dump without `ir_attachment` (422), a
  truncated or malformed dump (422), no paired backup with the dump (409), an
  unconfigured plan (404).
- Restoring an application still needs the database and the filestore restored
  together; the catalog is for finding and downloading individual files.

## Adding an application

An adapter is a `PgCopyTarget` (table names, columns, required columns) plus a
row mapper to `CatalogAttachment`. Applications with the same pattern, such as
Moodle (`filedir/<2>/<2>/<sha1>` and `mdl_files`), need a new adapter value and
mapper; the reader, cache, API and Browse tab stay the same.

## Tests

- `backend/__tests__/utils/attachmentCatalog/pgCopyParser.test.ts` parses
  `odoo-ir-attachment.pg12.sql`, real `pg_dump --format=plain` output of
  PostgreSQL 12.22 from the synthetic schema in `odoo-ir-attachment.source.sql`
  (generated in a disposable `postgres:12-alpine` container), at chunk sizes from
  1 byte up, with names holding tabs, newlines, backslashes and non-ASCII text, a
  bytea value and a decoy table that sorts first.
- `backend/__tests__/services/AttachmentCatalogService.test.ts`,
  `backend/__tests__/services/PlanService.test.ts` (settings),
  `backend/__tests__/routes/backups.test.ts` (routes) and
  `frontend/__tests__/attachmentCatalog.test.ts`.

To regenerate the fixture:

```sh
docker run -d --name pg12-fixture -e POSTGRES_PASSWORD=fixture -e POSTGRES_DB=example_odoo postgres:12-alpine
docker exec -i pg12-fixture psql -v ON_ERROR_STOP=1 -U postgres -d example_odoo < backend/__tests__/fixtures/attachmentCatalog/odoo-ir-attachment.source.sql
docker exec pg12-fixture pg_dump --format=plain --no-owner -U postgres -d example_odoo > backend/__tests__/fixtures/attachmentCatalog/odoo-ir-attachment.pg12.sql
docker rm -f pg12-fixture
```
