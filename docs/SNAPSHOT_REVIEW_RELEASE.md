# Snapshot review and controlled deployment handoff

This release changes snapshot inspection and the approved host deployment tools.
It does not upgrade an Agent, introduce a Dataset model, create independent
database snapshots, or change backup scheduling, retention, replication, Standard
Download, Reliable Download, or restore execution. No production deployment or
provider compatibility claim is made by local tests. Publish the local branch,
review the PR, and require all hosted Container Image jobs on its exact commit
before approving an immutable production image.

## Snapshot browser and details

Backup History offers **Browse Snapshot** and **View Details**. Browse opens a
centered explorer (90vw, maximum 1400px, 84dvh); Details is maximum 880px. Narrow
screens use the available viewport, with a collapsible directory panel, independent
scrolling, keyboard focus containment, Escape and focus return. Nested Restore
dialogs take precedence over their parent. Background page scrolling is locked.

Managed browsing retains the lazy classic tree, server-side 200-row pages,
debounced search, sorting and selection across tree pages. Cached browsing does
not start another full-tree load. Indexing reports actual processed entries and
elapsed time, with no fabricated percentage or completion total. Closing the
dialog leaves bounded indexing/comparison work available for reopening.

**Compare with previous** is an explicit asynchronous metadata operation. The
server selects at most 32 earlier completed candidates in the same plan, source,
storage and repository path, then requires compatible recorded source paths,
repository identity, two full snapshot IDs and each snapshot's plan/backup tags.
It revalidates identity before serving cached results. Callers cannot supply an
alternative repository, predecessor ID, credentials or source scope.

`restic --no-lock --no-cache --json ... diff --metadata PREVIOUS CURRENT` supplies
authoritative change records and an exact-identity completion record. Listing
both snapshots supplies paged display metadata. Added/deleted paths must agree
with both lists; common paths are Unchanged only after complete diff evidence.
Content, type and metadata changes become Modified, including content changes
with equal size and mtime. Symlink target changes use Restic metadata evidence.
Only Restic's proven directory display suffix is removed; API/restore path
validation and literal Unicode/percent characters retain their existing policy.
Unknown modifiers, duplicate/missing evidence, unsafe paths, mismatched identity
or resource limits leave the comparison unavailable. Ordinary browsing continues.
No content download, archive, source scan, repository lock or repository mutation
is used. See [Restic JSON diff documentation](https://github.com/restic/restic/blob/master/doc/075_scripting.rst).

All/Added/Modified/Unchanged filters show current-snapshot metadata. Deleted is
an explicit historical view bound to the predecessor, with no Restore, current
directory navigation or extension actions. **Browse previous snapshot** switches
to that exact backup before ordinary Restore can be offered. Unsupported adapters
(including the existing local browser), absent source history and missing
predecessors display Not compared; size/time equality is never substituted.

Details projects whitelisted backup completion fields: full IDs, plan, recorded
times in the plan timezone, duration, source/storage, file/directory counts,
logical bytes, new/changed/unmodified counts and newly added packed/unpacked
repository bytes. Physical repository usage and deleted counts are not inferred
from logical bytes. Missing fields display **Not recorded**, including old rows.
Database engine/reference/path/size/hash come only from completed snapshot dump
receipts; missing dump timestamps are explicit. Latest Recovery Test status is
bound to the exact plan/backup/snapshot. Primary completion, recovery validation,
replica receipts and lifecycle warning codes are shown separately. Comparison
totals and paged Added/Modified/Deleted lists are verified results of the separate
comparison job. No credential/configuration object or provider output is returned.
Comparison count/byte summaries describe regular files; directory and symlink
changes remain visible with their verified statuses in the paged file lists.

Limits: one comparison builder, at most two cached comparisons, 15-minute TTL and
deadline, 1,000,000 processed entries across the two inputs, 128 MiB SQLite per
comparison, 2 MiB SQLite page cache, disposable files 0600/directories 0700,
160 MiB free-space admission floor and 200-row result ceiling. Existing snapshot
index limits still apply (two indexes, one builder, 500k nodes/256 MiB per index).
Cancel aborts subprocess/index work; retry replaces failed/cancelled work. Expired
and abandoned generated comparison directories are removed. Resource failures
remain Not compared; they never invent zero changes. Other cached comparisons
can be evicted; no export-job records are removed.

## Approved host bundle and application recreation

Use a maintenance window after scheduled backups, restores, replication and export
jobs have finished. Record the existing immutable digest, project, named data
volume, approved ordered overlays and host-bundle backup privately. Have sufficient
disk space for a consistent stopped SQLite copy including WAL/SHM. On a 2 CPU /
4 GiB VM run one inspection/comparison or export preparation at a time; monitor
`docker stats --no-stream`, `df -h /opt/pluton`, free memory, I/O and network.
Application recreation interrupts active sessions; do not start it during work.

Stage the reviewed release bundle at `/opt/pluton-reviewed/deploy` using the
existing release procedure. No automatic download of a moving branch is approved.
The following placeholders must be replaced with independently reviewed digests:

```sh
APPROVED_BUNDLE='sha256:REPLACE_WITH_REVIEWED_HOST_BUNDLE_DIGEST'
APPROVED_IMAGE='sha256:REPLACE_WITH_APPROVED_IMMUTABLE_IMAGE_DIGEST'
sudo sh /opt/pluton-reviewed/deploy/upgrade-host.sh --print-digest
# Compare the printed digest with APPROVED_BUNDLE before continuing.
sudo sh /opt/pluton-reviewed/deploy/upgrade-host.sh /opt/pluton \
  --approve-bundle "$APPROVED_BUNDLE"
```

The bundle upgrader preserves `/opt/pluton/.env`, encryption key, deployment/image
history, volumes, overlays, runtime container and SQLite. It retains a protected
`.bundle-backups` copy and does not deploy. Known public older Compose bases are
recognized. An unknown/customized base is refused: reconcile its settings/mounts
into approved overlays, review its exact SHA-256 separately, then use the existing
`--accept-existing-compose 'sha256:REVIEWED_EXISTING_COMPOSE_HASH'` argument on
the upgrade command. Do not overwrite a customized base or bypass mount approval.
For an optional private CA, follow the existing explicit
[read-only CA mount approval](MANAGED_RELIABLE_DOWNLOAD_UAT.md); do not relax TLS,
filesystem, non-root, capabilities or no-new-privileges restrictions.

The current Compose base already forwards all eleven `MANAGED_EXPORT_*` settings:
`ENABLED`, `ALLOW_SHARED_NAMESPACE`, `ENDPOINT`, `REGION`, `BUCKET`, `PREFIX`,
`ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `SESSION_TOKEN`, `CA_FILE`, `TTL_SECONDS`.
No duplicate settings are needed. Committed defaults remain disabled. Edit only
the intended settings privately using `sudoedit /opt/pluton/.env`; preserve
`ENCRYPTION_KEY`, other settings and all export-job metadata.

For the first deployment of the new approved image:

```sh
sudo sh /opt/pluton/deploy.sh "$APPROVED_IMAGE"
sudo sh /opt/pluton/status.sh
```

For configuration changes while the **currently running image digest is unchanged**:

```sh
sudo sh /opt/pluton/deploy.sh "$APPROVED_IMAGE" \
  --reapply-config --approve-bundle "$APPROVED_BUNDLE"
sudo sh /opt/pluton/status.sh
```

Reapply refuses a different image digest, missing/mismatched bundle approval,
changed encryption key, unsafe mounts/overlays or failed image validation. It
freezes the approved Compose stack, captures the previous running environment
privately, stops only Pluton, copies `/data/db` consistently, and recreates only
Pluton with `--no-deps`. The data volume, security settings and other services
remain bound to their recorded contract. Success requires actual GET health,
immutable image, UID/GID, mount and eleven-field environment verification. Image
rollback history is preserved for configuration-only changes.

Ordinary identical-digest deployment remains idempotent. If the running export
environment differs, it fails without recreating anything and directs the operator
to the explicitly approved reapply path. Never use `down -v`, print `.env`, full
inspect/config output, or issue a manual Compose bypass.

## Effective configuration and HCP admission

`status.sh` compares effective Compose to the actual running container in memory,
including endpoint, region, bucket, prefix, access key, secret, token and CA. It
emits only success or a mismatching variable name. The authenticated browser on
the approved application origin can inspect safe configuration flags:

```js
const response = await fetch('/api/managed-exports/configuration');
if (!response.ok) throw new Error('Configuration inspection refused');
console.table((await response.json()).result);
```

Require enabled/configured and all required `*Configured` flags, expected shared
namespace/CA/token flags, TTL and the destination fingerprint. Do not print
credentials, cookies, presigned URLs or environment values. A configured flag is
not a provider compatibility PASS.

Keep the authorized existing namespace and reserved temporary prefix, shared
namespace opt-in and HCP nonversioned write-once mode. Do not change existing
backup/replication storage settings or require new credentials. The storage's
blank Region is left alone. Existing export code/Compose defaults a blank signing
region to `us-east-1`; that is a **code default**, not a verified provider setting.
Only the authorized API Inventory Check and HCP Preflight can prove compatibility
of this real endpoint, signing behavior and temporary prefix.

1. In authenticated Settings, perform Inventory Check (or POST `{}` to
   `/api/managed-exports/inventory-checks`, then poll its returned ID). Require
   ready/exclusive and no unknown objects/uploads. Do not delete unknown objects.
2. Perform HCP Preflight (POST `{}` to `/api/managed-exports/preflights`, then poll
   its returned ID). Use only disposable generated objects. Require ready/GO for
   TLS, anonymous denial, SSE-S3, applicable immutable identity/write-once proof,
   multipart/conditional completion, Range/resume, presigning and owner cleanup.
3. Any incompatibility is NO-GO. Never disable encryption, TLS, identity, shared
   prefix reservation, conditional completion or cleanup checks to force acceptance.
4. Follow the [full UAT runbook](MANAGED_RELIABLE_DOWNLOAD_UAT.md) for the initial
   authorized 120 MB export, interrupted/resumed transfer, final TAR SHA-256,
   owner-bound expiration/cleanup and abandoned multipart cleanup. Check CPU/RAM,
   free storage, temporary-cache usage and network throughout. Do not start real
   backup downloads until all mandatory checks pass.

## Rollback

A failed reapply automatically recreates the previous running environment with
the same immutable image and approved mounts, then checks health and identity.
Docker unset-key markers are treated as absent values, not credential values.
The failed command remains nonzero. Operator `.env` and overlays are preserved:
they may still describe the failed desired configuration. Review/revert the
intended edits privately before the next `status.sh` or deployment; do not claim
desired and running configuration match until verification passes. Temporary
expanded configuration and credential-bearing rollback files are removed when
the transaction exits. Stopped SQLite backups remain private under `backups/`.

After a successful reapply, to undo the configuration change, restore the operator's
previous reviewed settings/overlays privately and run the same approved reapply
command. For image rollback use `sudo sh /opt/pluton/rollback.sh`; config-only
reapply retains that earlier image target. For host-script rollback use the
existing `upgrade-host.sh --restore /opt/pluton BACKUP_ID --approve-backup DIGEST`
procedure and the private bundle-backup manifest. Database restoration is a
separately reviewed recovery action; these helpers never automatically overwrite
SQLite or reverse migrations.

## Local evidence and release gates

Windows validation: 209 backend suites / 4,281 passed / four inherited skips;
365 frontend tests; 150 source/worker/security checks; backend lint, both type
checks and production build passed. Linux: 88 focused backend tests and 38
deployment/bundle/CA policy tests passed. Real local deployment acceptance passed
19 scenarios, including old-bundle upgrade, app-only same-digest recreation,
stopped SQLite backup, environment rollback, image rollback history and preserved
unrelated services. No tests or gates were disabled for this release.

Headless browser checks used only synthetic data and isolated profiles. Verified
dialog dimensions were 1400×840 on a 1600×1000 desktop, 922×756 on a 1024×900
tablet, 374×828 on a 390×844 mobile viewport, and 880×840 for Details. There was
no page-level horizontal overflow; Details and file panes scroll independently.

The real native fixture compared 100,008 entries through read-only SFTP/Restic
under 2 CPU / 4 GiB / zero swap: 111 ms admission, 27.9 s comparison, 1.54 GiB
whole-fixture cgroup peak, no archives, one diff, repository/source byte-tree
equality, and `restic --no-lock check --read-data` success. The generated metadata
unit fixture paged 100,005 files at offsets including 400 with at most 200 rows.
These are synthetic measurements, not a production latency or capacity promise.
The native fixture also includes fixture creation and source-hash verification;
its Node peak includes those test-only full-tree hashes, absent from the service.

Run the commands in [ARCHITECTURE.md](ARCHITECTURE.md), the frontend suite,
deployment policy tests and `scripts/validate-deployment.ps1` on Windows/Docker
Desktop (or `scripts/validate-deployment.py` on Linux). The native comparison
fixture is `backend/__tests__/integration/snapshotReview.lab.ts`, with existing
native image requirements and 2 CPU/4 GiB/no-swap guards. It accepts only fresh
generated fixtures; `small` selects a small diagnostic fixture.

Frontend ESLint currently fails to load the inherited configuration because
`tseslint.config()` rejects a string `extends` entry for `eslint-config-prettier`.
This release does not suppress it. Local tests/build do not establish hosted CI
PASS. Operator publication, hosted CI, immutable-image approval and authorized
real HCP Inventory/Preflight/UAT remain mandatory before production enablement.
