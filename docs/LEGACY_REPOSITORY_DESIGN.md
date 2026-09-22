# Legacy Restic repository adapter — design only

Status: proposed, not implemented. Phase 0 adds no endpoints, schema migrations,
configuration options, jobs, or Restic operations. The design uses only public
Pluton source and documented Restic/Rclone interfaces.

## Purpose and initial adoption contract

Allow Pluton to register a repository created and maintained outside Pluton without
assuming ownership of its backup schedule, credentials, retention, or maintenance.
Phase 1 should start with an existing local filesystem path; additional backend
locators require a tested compatibility decision, not an assumption that every
Restic/Rclone backend is supported.

Initial adoption must provide:

- An existing repository path and an independently configured repository password.
- Read-only repository access enabled by default and mandatory for this initial adapter.
- Snapshot listing, metadata inspection, and filters by path, tag, and host.
- Snapshot content browsing and selected-file/directory restore in Phase 2, with
  restore restricted to an explicitly selected staging directory.
- No backup writes, retention execution, prune, unlock, repair, or repository
  migration. Registration must not initialize an absent repository or alter tags,
  keys, format, snapshots, indexes, packs, or lock objects.

The original backup tooling remains responsible for repository maintenance. Removing
a registration removes Pluton's local record/cache only, never repository contents.

## Separate domain and credentials

Use a proposed `LegacyRepository` record and dedicated service/adapter, separate
from managed `plans`, `backups`, and their job lifecycle. These names are design
labels, not existing database tables or application APIs.

| Proposed field                        | Meaning                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`, `displayName`                   | Local registration identity and a user-facing label.                                                                       |
| `repositoryPath`                      | Validated existing absolute path for the initial local adapter. Do not manufacture a Pluton storage path or initialize it. |
| `passwordSecretRef`                   | Opaque reference to independently configured secret material, never a plaintext API response or checked-in value.          |
| `accessMode`                          | `read-only`; omitted input defaults to this value, and writable modes are rejected during initial adoption.                |
| `repositoryIdentity`, `formatVersion` | Values observed through supported read operations, used to detect path reuse/replacement and unsupported formats.          |
| `lastInspectedAt`, `status`           | Local inspection state, including unavailable/unsupported/authentication failures, with redacted diagnostics.              |

Keep the repository decryption password independent from Pluton's `ENCRYPTION_KEY`
and from any future storage-transport credentials. Changing an application secret
must not re-key or replace the external repository password. Reuse an appropriate
local secret-protection primitive only after review; an application encryption key
may protect a stored secret without becoming the Restic password itself. Resolve
the secret for the child process only, avoid command-line secret values, redact
process environment/error output, and never return secrets to the frontend.

Snapshot references must pair this registration/repository identity with a full
Restic snapshot ID. Do not invent managed backup records or require `plan-*`/
`backup-*` tags. Missing optional metadata or tags must be handled explicitly;
hostnames, tags, filenames, and errors from snapshots are untrusted and potentially
sensitive data, not safe public fixtures.

## Registration and inspection flow

1. Authenticate/authorize registration and filesystem access. Validate the locator
   and secret reference without logging secret material or embedded credentials.
2. Inspect the supported Restic binary/version and existing repository identity
   through the read-only command boundary. Reject absent repositories, wrong
   passwords, unsupported formats/backends, and unsafe access conditions.
3. Save a local registration only after validation. Do not invoke
   `BaseBackupManager.createBackup`, create a normal plan, or install schedules.
4. List snapshots and inspect metadata by full snapshot ID. Normalize documented
   JSON with bounded memory, timeouts, cancellation, and explicit error handling.
5. Apply validated path/tag/host filters without adding Pluton tags. Define filter
   combination semantics in the API and tests; snapshot path filtering concerns
   recorded source paths and is distinct from searching files inside a snapshot.

The public [Restic repository guide](https://restic.readthedocs.io/en/stable/045_working_with_repos.html)
describes snapshot filtering and `ls` JSON output. Its command surface is an input
to compatibility tests, not evidence that this proposed integration is working.

## Operation boundary

Provide typed methods such as registration validation, snapshot listing, metadata
inspection, and later content listing/staged restore. A central backend policy must
build arguments from validated values and deny every unrecognized operation or
flag. Do not accept arbitrary command strings, password commands, backend program
overrides, or raw Restic arguments from the UI.

| Operation class              | Candidate public interface                                                                                            | Allowed effects                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Repository inspection        | `version`, narrowly scoped `cat config`, `snapshots --json`, `cat snapshot <id>`                                      | Read repository data; write only explicitly scoped Pluton metadata/cache. No repository lock writes.                                 |
| Content inspection (Phase 2) | `ls --json <id>` with validated snapshot paths                                                                        | Read repository data; no filesystem extraction.                                                                                      |
| Staged restore (Phase 2)     | `restore <id>` with a required validated `--target` and supported selection/overwrite controls                        | Read the repository and write only the selected staging destination. This is a destination mutation, not a metadata-only operation.  |
| Repository mutation          | `init`, `backup`, `forget`, `prune`, `unlock`, `migrate`, `repair`, `tag`, key changes, and copying into a repository | Always rejected for initial adoption, including retries and error recovery. All other commands are denied until explicitly reviewed. |

Audit the exact invocation, environment, backend options, and effects for each
supported Restic version before enabling a candidate interface. No executable
examples or runtime changes are introduced here.

### Read-only access includes locks

Reading snapshot data does not by itself guarantee zero writes: Restic can create
repository locks. The [public Restic manual](https://restic.readthedocs.io/en/stable/manual_rest.html)
documents `--no-lock` for supported operations on read-only repositories. The
future adapter must use and test that behavior for each allowed command, with a
read-only filesystem mount or read-only backend credentials as defense in depth.
If an operation cannot satisfy the no-write contract, reject it; never retry with
write access, silently initialize, or remove locks.

Skipping locks also removes coordination with external maintenance. Inspection or
restore must use a stable read-only view, or a maintenance window in which the
repository owner prevents concurrent destructive maintenance. A preliminary lock
check alone cannot eliminate this race. If data disappears during an operation,
report failure/partial output and leave the repository untouched. No automatic
`forget`, `prune`, or `unlock` is permitted.

Application cache files must live outside the repository, be bounded and private,
and be invalidated when repository identity changes. This limited local state does
not weaken the prohibition on repository writes.

## Safe staged restore (Phase 2)

The [public restore documentation](https://restic.readthedocs.io/en/stable/050_restore.html)
states that the default restore behavior can overwrite destination files. The
adapter therefore needs stronger destination rules than simply forwarding a target:

- Require the user to select a dedicated staging directory and review the exact
  snapshot ID, selected paths, and resolved destination before starting.
- Require a new or empty staging directory within an authorized staging root;
  reject filesystem roots, live source directories, the repository, application
  data, and ancestor/descendant overlap with protected locations.
- Canonicalize paths and validate containment, including Windows drive/UNC rules,
  symlinks, junctions, and traversal. Recheck immediately before execution and
  isolate destination access to prevent path-swap races and link-based escapes.
- Use supported no-overwrite controls, never `--delete` or in-place restore.
  Check required flag support first and reject unsupported versions instead of
  silently falling back to destructive defaults.
- Resolve selections to an immutable full snapshot ID; never execute against an
  ambiguous prefix or a moving `latest` selection. Validate include/path semantics
  with tests so a granular selection cannot unexpectedly become a full restore.
- Apply time, space, and output limits; record partial/cancelled results without
  claiming success. Clean up only adapter-owned staging artifacts, never arbitrary
  user directories. Do not automatically promote staged data into live locations.

Restoring may expose sensitive content and metadata even with read-only repository
access. Keep authorization on the backend and staging permissions appropriately
restricted. Restored filenames/links must be treated as untrusted input.

## Integration with the current codebase

Managed creation currently initializes repositories; backup handling can unlock
stale locks; retention runs `forget --prune`; managed snapshot lookup relies on
application tags/passwords. See [ARCHITECTURE.md](ARCHITECTURE.md).

Do not subclass a managed lifecycle and assume a boolean makes it safe. Legacy
registrations must be absent from managed plan scheduling, retention, replication,
startup recovery, repository deletion, and repair/unlock endpoints. Enforce that
separation on request dispatch as well as job dispatch so forged IDs cannot cross
the boundary.

The existing `runResticCommand` injects global Restic/Rclone settings and uses a
shared application cache; it is not a policy boundary. Reuse requires a scoped
execution context, explicit per-repository secrets, reviewed environment options,
and the allowlist above, while preserving existing callers. Otherwise use a
dedicated independent executor. Reuse public parsing/UI components only where they
do not assume managed plan/backup records or introduce mutation hooks.

## Compatibility questions and future acceptance tests

Before implementing Phase 1, decide the supported Restic versions/formats, local
filesystem scope, secret-store integration, filter semantics, and JSON/output limits.
Rclone and remote backends need separate credential and no-write verification.
This design is not a certification of a live legacy environment.

Future tests must use disposable, synthetic repositories and mocked process runners:

- Correct/incorrect independent passwords; absent/corrupt/unsupported repositories;
  path reuse, unavailable storage, empty repositories, and snapshots without Pluton tags.
- Every allowlisted command/flag, argument-injection attempts, and denial of every
  mutation path, including API calls, retries, scheduler dispatch, and recovery.
- A repository exposed read-only: compare contents before/after and observe backend
  write attempts, including transient lock creation/deletion, rather than relying
  only on a final checksum. Fixture setup may write only to disposable test storage
  in a separately scoped implementation task; Phase 0 runs no Restic commands.
- JSON parsing limits, metadata filtering, cancellation, credential redaction, and
  changes caused by external maintenance.
- Phase 2 adds staging containment, symlink/junction races, no-overwrite behavior,
  granular selection, permission errors, insufficient space, and partial restore tests.

No new environment variables or configuration examples are needed before these
decisions. Generic design values may use `app-01`, `/srv/example-restic`, and
`/srv/example-restore-staging`; they do not identify any actual deployment.
