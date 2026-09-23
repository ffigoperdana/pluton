# Legacy Restic repository adapter — Phase 1

Status: implemented for local filesystem repositories only. This adapter uses only
the public Pluton source and documented Restic interfaces. It does not inspect a
real user repository during tests and does not certify a Restic-version or
repository-format compatibility matrix.

## Adoption contract

An operator can register an already-existing local Restic repository with a display
name, an absolute path on the Pluton server, and its own repository password. The
registration is a separate domain from managed plans, backups, schedules, storage
definitions, and retention.

The adapter is mandatory read-only. The UI displays this state but provides no
control to change it. Removing a registration deletes only Pluton's local record;
it never deletes or changes repository contents. The original backup tooling keeps
ownership of scheduling, retention, maintenance, and credentials.

Phase 1 provides connection validation, basic safe statistics, snapshot metadata,
and exact tag/path/host filters. It does not browse snapshot contents or restore
data. Those remain future work.

## Stored local registration

The [legacy repository schema](../backend/src/db/schema/legacyRepositories.ts)
creates a dedicated `legacy_repositories` table through migration
[`0003_luxuriant_fat_cobra.sql`](../backend/drizzle/0003_luxuriant_fat_cobra.sql).
It is not related to managed plans or backups.

| Field | Meaning |
| --- | --- |
| `id`, `displayName` | Local registration identity and UI label. |
| `repositoryPath` | Existing, validated absolute local path. |
| `backend` | Fixed to `local` in Phase 1. Remote/Rclone backend locators are not accepted. |
| `encryptedPassword` | The external repository password encrypted for the local registration with Pluton's configured `SECRET`. It is never sent to the frontend. |
| `isReadOnly` | Always `true`; request payloads cannot opt out and non-read-only stored records are rejected. |
| `validationStatus`, `lastValidatedAt` | Local availability state from the most recent safe inspection. |
| `createdAt`, `updatedAt` | Local registration timestamps. |

The repository password remains independent from Pluton's managed repository
password derivation and `ENCRYPTION_KEY`. `SECRET` protects the stored value; it
does not replace or re-key the external Restic password. The password is placed in
the child process environment only for the inspection and is not logged, returned,
or included in command arguments.

## Read-only execution boundary

[LegacyRepositoryInspector.ts](../backend/src/utils/restic/LegacyRepositoryInspector.ts)
is intentionally independent of the general managed `runResticCommand` helper. It
accepts only the following typed operations:

| Operation | Fixed Restic arguments | Returned data |
| --- | --- | --- |
| Snapshot validation/listing | `--no-lock --no-cache --json --repo <path> snapshots` | Normalized snapshot ID, time, host, tags, paths, and parent metadata. |
| Safe statistics | `--no-lock --no-cache --json --repo <path> stats --mode raw-data` | Snapshot count, sizes, compression ratio, and blob count when the installed Restic supports it. |

The executor builds an argument array, starts the binary with `shell: false`, uses
a bounded timeout and output limit, and discards stderr rather than logging it.
Before spawning it removes inherited `RESTIC_REPOSITORY`, repository-file, and
password-command/file variables. Structured JSON is validated before it becomes an
API response. User-provided filters are applied to returned snapshot metadata, so
they do not become raw CLI arguments.

`--no-lock` is required because Restic reads can otherwise create repository lock
objects. It also means the repository owner must coordinate concurrent maintenance;
this adapter never attempts `unlock` as recovery. A read-only filesystem mount or
read-only backend credential is still recommended as defense in depth. See the
[Restic manual](https://restic.readthedocs.io/en/stable/manual_rest.html) for the
documented `--no-lock`, JSON, snapshot, and stats interfaces.

The runtime allowlist rejects every other operation before process creation. In
particular, these commands are not available through the legacy adapter:

- `backup`
- `forget`
- `prune`
- `unlock`
- `migrate`
- `repair`
- `init`
- `restore`

There are no corresponding routes, jobs, retry handlers, or UI controls. The
adapter also does not use managed plan creation, retention, startup recovery,
replication, repository deletion, or repair/unlock paths.

## API and UI

All legacy routes require the authenticated UI session; the limited machine API-key
allowlist does not include them.

| Endpoint | Local effect |
| --- | --- |
| `GET /api/legacy-repositories` | List safe local registration metadata. |
| `POST /api/legacy-repositories` | Validate with snapshot inspection, then store one read-only registration. |
| `GET /api/legacy-repositories/:id` | View one registration's safe metadata. |
| `POST /api/legacy-repositories/:id/validate` | Recheck access through snapshot inspection. |
| `GET /api/legacy-repositories/:id/snapshots` | List snapshot metadata, with optional exact `tag`, `path`, and `host` filters. |
| `GET /api/legacy-repositories/:id/snapshots/:snapshotId` | View one already-listed snapshot by full 64-character ID. |
| `GET /api/legacy-repositories/:id/stats` | Obtain safe statistics when supported by Restic. |
| `DELETE /api/legacy-repositories/:id` | Delete the local registration only. |

The [Legacy Repositories UI](../frontend/src/routes/LegacyRepositories/) includes a
registration panel, repository list, availability status, basic statistics,
snapshot metadata, filters, and local-registration removal. It explicitly states
that the repository is read-only and that Pluton owns no retention policy. It has
no file browser, restoration path, retention action, or repository-mutation UI.

## Error handling and validation

The service validates a non-empty absolute path and credential before persistence.
It maps wrong-password, unavailable-repository, timeout, malformed JSON, oversized
output, and generic execution failures to safe API messages. Raw stderr, command
environment values, and password text do not cross the service boundary.

Snapshot IDs must be full 64-character hexadecimal values. Tag, host, and path
filters use exact matching against the snapshot list. This deliberately avoids
inventing managed `plan-*` or `backup-*` tags and avoids content searches inside a
snapshot.

## Tests and known boundary

The Phase 1 tests use mocked child processes and generic fixtures rather than a
real repository:

- [LegacyRepositoryInspector.test.ts](../backend/__tests__/utils/restic/LegacyRepositoryInspector.test.ts)
  verifies fixed argument arrays, `shell: false`, inherited-environment clearing,
  JSON parsing, safe statistics, password nondisclosure, and denial of all eight
  forbidden operations before Restic is spawned.
- [LegacyRepositoryService.test.ts](../backend/__tests__/services/LegacyRepositoryService.test.ts)
  verifies valid registration, invalid paths, incorrect credentials, multiple
  workload filters, local-only deletion, encrypted credential storage, and the
  mandatory read-only guard.
- [legacyRepositories.test.ts](../backend/__tests__/routes/legacyRepositories.test.ts)
  verifies the session-only route boundary, safe public list data, and forwarding
  of exact snapshot filters.

These tests establish the application boundary. They do not prove a particular
external repository is mounted read-only or that every Restic version supports
`stats --mode raw-data`. Such support is reported safely at runtime and needs a
separately authorized disposable-fixture compatibility test before expanding the
support matrix.

## Later work

Phase 2 may add snapshot-content browsing and a separately authorized staged
restore design. It must validate an explicit isolated destination, prevent path or
symlink escape, handle cancellation and partial output, and keep imported
repository access read-only. Phase 1 does not add any restoration capability.
