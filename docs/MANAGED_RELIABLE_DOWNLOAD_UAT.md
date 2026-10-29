# Reliable Download: controlled production UAT

This is an operator procedure, not an automatic deployment. Reliable Download is
disabled in both committed environment examples and the production Compose base.
PR #54 delivered the export service; this follow-up wires deployment and adds a
standalone destination preflight. No production endpoint or HCP acceptance has
been tested by the coding session. Publish the local commit, open a follow-up PR
(#54 is already merged), and wait for **all Container Image jobs on that commit**
before approving a production image digest. A local build is not hosted CI PASS.

## Activation checklist

- [ ] Hosted CI and runtime image checks completed on the published commit.
- [ ] Record the approved new image digest, previous digest, current host-bundle
  approval/backup, project name, named `/data` volume and all existing overlays.
- [ ] Arrange a maintenance window for application recreation. Let active backups,
  restores and exports finish; do not interrupt them to enable this feature.
- [ ] Storage operator approves a **new private temporary bucket and dedicated
  identity**, separate from every backup/replica bucket and identity. Review policy
  and network access without copying backup credentials into export settings.
- [ ] HTTPS endpoint, signing region, DNS, client reachability, certificate chain,
  clock synchronization, SSE-S3 AES256, versioning, cleanup permissions and storage
  quota approved. HCP must pass the same checks; there is no compatibility bypass.
- [ ] Install the reviewed host bundle and new image with export disabled. Preserve
  `.env`, local overlays, database, export-job metadata and existing data mounts.
- [ ] If needed, complete the explicit public-CA file mount procedure below.
- [ ] Set the ten settings below privately and explicitly enable the feature;
  recreate only the application using the approved deployment procedure.
- [ ] Private comparison of effective Compose and running container reports all ten
  environment fields equal; authenticated application configuration is valid.
- [ ] Standalone preflight reaches `ready` with all 15 checks and no cleanup pending.
  **No backup content is admitted before this passes.**
- [ ] Synthetic 120 MB UAT, interrupted/resumed transfer, checksum, cleanup and
  existing backup/restore/Agent/replication checks pass within resource limits.
- [ ] Record sanitized results and owner approval before using real backup contents.

## Independent storage and settings

Only edit the installation's protected `.env` (operator-owned, mode 0600) using a
private editor. Never put credentials in shell history, command arguments, chat,
screenshots, Git, HTTP requests to the preflight API, or expanded configuration
logs. The application accepts no endpoint, credential or path overrides from API
callers. Do not change repository, replication, Restic, Agent or backup settings.

| Container setting | Operator value / default |
| --- | --- |
| `MANAGED_EXPORT_ENABLED` | `false`; set **exactly `true`** only for approved UAT |
| `MANAGED_EXPORT_ENDPOINT` | Approved `https://` S3 API origin, no embedded credentials/path/query |
| `MANAGED_EXPORT_REGION` | Provider's actual signing region; default `us-east-1` |
| `MANAGED_EXPORT_BUCKET` | New private temporary bucket, never a repository/replica bucket |
| `MANAGED_EXPORT_PREFIX` | `pluton-temporary-exports`, optionally followed by `/` and 1–64 letters, digits, `_` or `-` |
| `MANAGED_EXPORT_ACCESS_KEY_ID` | Dedicated least-privilege export identity |
| `MANAGED_EXPORT_SECRET_ACCESS_KEY` | Its protected secret |
| `MANAGED_EXPORT_SESSION_TOKEN` | Optional matching session token; otherwise empty |
| `MANAGED_EXPORT_CA_FILE` | Empty for system trust; overlay fixes it to `/run/secrets/pluton-managed-export-ca.pem` |
| `MANAGED_EXPORT_TTL_SECONDS` | Default `259200` (72 hours); allowed 3600–604800 |

`MANAGED_EXPORT_CA_HOST_FILE` is an **overlay-only host path**, never an application
setting. `.env` alone does not inject container variables; the base Compose now
forwards every runtime setting above explicitly. Review how Compose quotes values
containing `$`, `#` or whitespace, using a private effective-config file.

Storage policy needs bucket versioning inspection; prefix-scoped listing of
versions; prefix-scoped get/get-version/put/delete/delete-version and object ACL
inspection; multipart create/upload/complete/abort/list-parts; and bucket multipart
enumeration. Review provider-specific IAM action mappings (AWS maps multipart
creation/completion and object ACL inspection to its respective S3 actions). Deny
all access to backup/replication buckets and writes outside the export prefix.
The app neither creates buckets nor enables encryption/versioning nor edits policy.
Configure those out of band before preflight. Application admission also rejects
reuse of a registered repository/replica bucket or access-key ID. That comparison
does not replace the storage operator's IAM review or attest that a provider alias
represents a different underlying account.

Use a separate finite storage quota. UAT needs at least 512 MiB free for one 120 MB
archive, probes and versions; allow additional headroom for concurrent retained
exports. Existing hard bounds remain one worker, four admitted/uncleaned jobs,
128 GiB per archive, 256 GiB aggregate reservations, 64 metadata records, and one
16 MiB upload part in flight. **These are admission caps, not a guarantee that the
VM or bucket can sustain that workload.** Configure provider lifecycle expiration
of current/noncurrent export versions and abandoned multipart uploads as a safety
net, with retention no shorter than the approved application TTL. Do not apply a
bucket lifecycle policy to any backup repository. Existing jobs must retain their
destination and credentials until cleanup finishes.

## Optional private CA without weakening the container

Use only an approved public CA PEM chain (no private key), <=256 KiB, regular file,
absolute path, no symlink, root/operator ownership, non-writable by group/others.
For example, store a reviewed public CA at `/etc/pluton/certificates/export-ca.pem`,
mode 0644, with non-writable parent directories and read/traverse access for the
container's UID 10001. Do not mount its containing directory. The optional
`deploy/compose.managed-export-ca.yml` adds one fixed read-only bind with
`create_host_path: false`; missing files fail. System certificate and hostname
validation remain enabled. Never set a TLS verification bypass.

Install/update the **reviewed host bundle**, not just the image. Follow
[the host-bundle upgrade procedure](DEPLOYMENT_OVERLAY_AND_HEALTHCHECK_FIX.md#8-a--one-time-host-script-upgrade)
using the bundle digest printed by `upgrade-host.sh --print-digest`. The bundle now
includes the CA overlay and narrow approval tool. Unknown existing Compose bases
still require the existing explicit hash/reconciliation approval. The upgrade
does not start containers, change `.env` or automatically select the new overlay.

For a fresh installation, add `compose.managed-export-ca.yml` to the protected
`compose.overlays` list before the first deployment. Preserve the existing overlay
order and defaults. For an **existing** installation, the deployment contract
deliberately refuses a new mount. Do not delete or rewrite the contract to get
past that gate. The following narrow procedure reviews exactly one new CA mount
while preserving the same already deployed image and every existing mount:

1. First deploy the approved new image **with the current mount set and export
   disabled**, using normal `deploy.sh`. Confirm healthy and record its digest.
2. Save protected copies of `.env`, `compose.overlays`, `.deploy-state`,
   `.deploy-contract.json` and `.deploy-compose-files.json`. Append only
   `compose.managed-export-ca.yml` to `compose.overlays`, preserving prior entries.
   Set `MANAGED_EXPORT_CA_HOST_FILE` to the approved certificate. Leave export
   disabled during this mount-only change; leave the image digest unchanged.
3. As the installation operator, prepare private effective metadata. In these
   examples `/opt/pluton` is the approved installation directory, not a new project:

   ```sh
   umask 077
   work=$(mktemp -d /opt/pluton/.export-review.XXXXXX)
   python3 /opt/pluton/compose-tools.py snapshot /opt/pluton "$work"
   python3 /opt/pluton/compose-tools.py compose /opt/pluton "$work" config --format json > "$work/effective.json" 2> "$work/compose-errors"
   python3 /opt/pluton/approve-managed-export-ca.py /opt/pluton "$work/effective.json"
   ```

   Require `export-ca-change-reviewed-no-write`. This checks the complete desired
   security policy, exact old mounts/project and unchanged last successful image.
   The JSON and error files can contain secrets: never print or upload them.
4. Only after operator review, recreate the application with that exact snapshot;
   no `down`, volume deletion, unrelated service startup or image upgrade:

   ```sh
   python3 /opt/pluton/compose-tools.py compose /opt/pluton "$work" up -d --no-deps --force-recreate pluton > "$work/recreate-output" 2>&1
   python3 /opt/pluton/compose-tools.py compose /opt/pluton "$work" ps -q --all pluton > "$work/container-id"
   docker inspect "$(cat "$work/container-id")" > "$work/inspect.json"
   python3 /opt/pluton/approve-managed-export-ca.py /opt/pluton "$work/effective.json" "$work/inspect.json"
   ```

   Wait for healthy, recapture inspect, then require
   `export-ca-contract-approved-existing-mounts-preserved`. The tool refuses an
   unhealthy container, changed image, project, data mount or writable CA. It takes
   the deployment lock and saves 0600 `*.before-export-ca` contract/file-list copies
   before recording approval. It never starts containers itself. Do not run a
   concurrent deployment. If interrupted between recording files, stop and use the
   protected copies for operator recovery; no automatic contract reset is allowed.
5. Keep the review files private for verification, then remove only that known
   temporary review directory according to local secret-file handling policy.
   Preserve rollback copies. Normal deployment/status/rollback now use the
   approved overlay and mount contract. Existing restrictions (`read_only`,
   non-root, `cap_drop: ALL`, `no-new-privileges`, existing data volume and health
   check) remain mandatory.

## Enable and verify the actual application configuration

With no active operations, set the settings privately and explicitly set
`MANAGED_EXPORT_ENABLED=true`. Apply the **same approved image digest** with
`deploy.sh`; this recreates only the application and retains `/data`. Preserve
all existing overlays. Review and retain the usual sanitized status/health result.

Create another private snapshot/effective config as above. Capture the application
container ID with `compose ... ps -q --all pluton` and `docker inspect` into private
files, then run:

```sh
python3 /opt/pluton/compose-tools.py export-environment "$work/effective.json" "$work/inspect.json"
```

Require `export-environment-matches-all-10-fields-no-values-emitted`. The tool
compares all ten settings, including credentials and token, in memory; it reports
only a fixed success or the mismatching variable's **name**. It checks the actual
container identity/user/mount set too. Never run `docker inspect`, `docker compose
config` or `env` to the terminal as a substitute.

In the authenticated Pluton browser on the approved application origin, use the
browser console (no password/token export):

```js
const configResponse = await fetch('/api/managed-exports/configuration');
const configStatus = await configResponse.json();
console.table(configStatus.result);
```

Require HTTP 200, `enabled`, `configured`, `endpointConfigured`, `regionConfigured`,
`bucketConfigured`, `prefixConfigured`, `credentialsConfigured` all true and the
expected private-CA/token booleans and TTL. The destination fingerprint identifies
the normalized endpoint/region/bucket/prefix/CA without exposing their values.
It deliberately excludes credentials. Successful preflight authenticates the
running app to the intended destination; the private environment comparison above
checks that it received the operator-selected credentials. A restart is required
after changing configuration. A valid configuration is not a preflight PASS.

## Preflight before reading backup contents

The authenticated same-origin endpoints accept **no configuration overrides**:

- `POST /api/managed-exports/preflights` with `{}` returns 202 and an owner-bound ID.
- `GET /api/managed-exports/preflights/:id` returns its durable status.
- `DELETE /api/managed-exports/preflights/:id` with `{}` cancels it or retries exact
  owned-probe cleanup, including after automatic cleanup retries are exhausted.
- `GET /api/managed-exports/configuration` returns only safe process-configuration flags.

For example, in that authenticated browser console:

```js
const start = await fetch('/api/managed-exports/preflights', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
});
if (start.status !== 202) throw new Error('Preflight admission refused');
let check = (await start.json()).result;
const preflightId = check.id;
for (let n = 0; n < 90 && ['queued', 'validating'].includes(check.state); n++) {
  await new Promise(resolve => setTimeout(resolve, 2000));
  const response = await fetch(`/api/managed-exports/preflights/${preflightId}`);
  if (!response.ok) throw new Error('Preflight status unavailable');
  check = (await response.json()).result;
}
console.log({ id: preflightId, state: check.state, checks: check.preflightChecks,
  cleanupPending: check.cleanupPending, capability: check.failureCapability,
  category: check.failureCategory, httpStatus: check.failureHttpStatus });
```

Require `ready`, all checks below and `cleanupPending:false`. Polling exhaustion,
queued/validating, 409, failed, cancelled, expired or any missing check is **not
PASS**. Retain the safe ID/report, resolve failures, then run a fresh preflight.
Do not start a real export or disable a check to work around a provider mismatch.
The worker has a 60-second preflight deadline plus bounded cleanup. Requests use
only random disposable objects, one ~5 MiB multipart part plus a 32-byte final
part, and tiny version/Range probes. This route does not call Restic, Agent or
backup-content preparation and needs no backup ID. Jobs share existing queue,
record, resource, ownership and crash-recovery limits. Status survives restart;
an interrupted preflight fails and its owned probes are reconciled for cleanup.

| Mandatory check | Proof |
| --- | --- |
| `destination-isolation` | Independent bucket and access-key ID vs registered repositories/replicas |
| `https` | Successful verified HTTPS request using system/approved CA and hostname validation |
| `versioning` | Versioning enabled, not suspended |
| `sse-s3` | Random object's HEAD reports AES256 and expected ownership metadata |
| `private-acl` | Only canonical private grants |
| `anonymous-denial` | Anonymous version GET and bucket/prefix listing denied |
| `immutable-version` | Earlier random version remains addressable |
| `range-resume` | Exact 206, Content-Range, length and byte content |
| `version-enumeration` | Both known random versions listed |
| `presigned-get` | Two independent Range GETs reconstruct the same tiny version via a short-lived signed URL |
| `multipart-upload` | Real owned multipart creation and part upload |
| `multipart-enumeration` | Real pending upload discoverable for crash cleanup |
| `conditional-completion` | Completing against an existing key with If-None-Match `*` returns 412 |
| `multipart-completion` | Two parts actually completed conditionally; length/version/AES256/ownership verified |
| `cleanup` | Owned versions removed, abandoned multipart aborted and absence verified |

Safe failures report a capability plus `tls-validation`, `access-denied`,
`unsupported-api`, `unexpected-response`, `network-or-deadline` or `cleanup-failed`,
and an HTTP status when available. No raw provider response, endpoint, environment
values, credentials or signed URL is exposed. For example, HCP versioning HTTP 501
reports `versioning / unsupported-api / 501`; a rejected certificate reports
`https / tls-validation`. Cleanup failure takes precedence and retains metadata
for reconciliation. Some providers express unsupported APIs as 400; the exact
failing capability and safe status remain visible. Storage operators must inspect
their own protected logs for a more detailed provider diagnosis. Do not grant
backup credentials, bypass TLS, disable versioning/SSE/conditional completion, or
switch to a repository bucket to force a PASS. HCP is unaccepted until these gates
and the real client-network test pass.

If cleanup remains pending, correct the permission/connectivity problem without
changing the recorded destination, then use that preflight's DELETE endpoint and
poll its status until `cleanupPending:false`. Only its owner can request this;
no arbitrary key, upload ID or prefix is accepted. Retain the failure report.

## 120 MB test and interrupted/resumed transfer

After preflight passes, use an **operator-created synthetic managed snapshot** of
120,000,000 random bytes, a nested directory, an empty file and an approved symlink
fixture. Use a disposable test source and destination, never an existing live path.
Record the payload SHA256 before the test. Creating its plan/backup is a separately
controlled operator action; do not change scheduled production plans or retention.
Retain its original historical snapshot for the comparison. The large-download
code remains streaming; it does not stage the archive on the Pluton VM.

1. In its snapshot UI, select Full Download and **Reliable Download**. Record the
   export ID, full snapshot identity, bytes and archive SHA256 from Ready status.
   Full/Regular Files Only is a separate content choice. Standard remains available.
2. Obtain a fresh authorization for that **same export ID**, using the authenticated
   UI or `POST /api/backups/:backupId/exports/:exportId/authorization` with `{}`.
   The returned `result.url` is a bearer secret (<=300 seconds): put it only in a
   protected curl config, never CLI arguments/history/logs. A sample private config:

   ```text
   url = "<paste-fresh-authorization-URL-in-private-editor>"
   output = "/approved-client-staging/export.tar.partial"
   proto = "=https"
   ```

   Use system TLS trust or an approved public CA with `cacert`; never `insecure`.
   The client staging path is an example: select a validated empty destination
   with enough space and no overlap with live sources or repositories. Avoid curl
   verbose/trace output. Signed URLs must be reachable from the client's network.
3. Start `curl --config /approved-private-location/export.curl --fail --silent
   --show-error --limit-rate 2M --max-time 6`. A timeout/nonzero exit is expected for
   this intentional interruption. Confirm a nonempty partial file shorter than the
   expected archive, record its byte count, then resume:

   ```sh
   curl --config /approved-private-location/export.curl --fail --silent --show-error --continue-at -
   ```

   Inspect HTTP status/Content-Range in a **protected** header file if needed.
   It must be 206 starting at exactly the saved partial length. Do not append a 200
   response. Require the completed length and SHA256 to match Ready metadata; a
   multipart ETag is not the archive checksum. List/extract only in isolated staging
   and compare the payload hash, expected tree, symlinks and historical contents.
4. Repeat with interruptions near 50% and 90%, using new partial destination files.
   Renew an expired URL for the **same Ready export** and resume without rebuilding
   it. This proves grant renewal, not reuse of an expired bearer token. Test that the
   old URL is denied after its expiry. If the provider's signed Range fails, stop UAT;
   do not declare success based only on the authenticated proxy fallback.
5. Verify authenticated proxy content with Range via
   `/api/backups/:backupId/exports/:exportId/content` if that delivery is intended.
   Authentication is required; keep cookies in a private client store. Test Standard
   Download separately: its verified stream explicitly does not support resume.
6. Cancel the Ready test export (`DELETE /api/backups/:backupId/exports/:exportId`,
   empty body, same owner), poll until cleanup is no longer pending, and have the
   storage operator verify no owned versions or multipart uploads remain for that
   random export key. Check expiry cleanup with a separate UAT export and approved
   TTL (minimum one hour); do not change the host clock or lower production bounds.
   Do not delete whole prefixes/buckets or sweep other jobs to clean this test.

## 2 vCPU / 4 GiB VM and non-interference checks

Capture a quiet baseline and monitor during preparation, upload, download, resume
and cleanup. Use a sanitized container resource view (`docker stats --no-stream`
for the single application container, CPU and memory fields only), host `free -m`,
load/IO wait, free space/inodes on the filesystem holding the named volume, and
network byte-rate counters. Do not print process command lines or full inspect.

- One UAT export at a time. Do not start during backup/restore peaks. Confirm one
  export worker and no more than one Restic source read; bounded 16 MiB parts do
  not bound total process/cache/database memory. Stop admission if the host swaps,
  sustained memory exceeds ~3 GiB, free RAM falls below ~512 MiB, IO wait or network
  saturation delays normal operations, or OOM/health errors appear. These are
  conservative UAT stop thresholds, not new application limits.
- Preserve at least 1 GiB plus the site's normal metadata/cache headroom on the VM
  volume and monitor inode growth. Export metadata/index growth is expected; a
  growing local TAR is not. The client needs archive-size staging space; the
  temporary bucket needs the quota/retention headroom described above.
- Account for source-to-server traffic, server-to-S3 upload **and full S3 readback**
  before Ready, then S3-to-client download. Proxy delivery also uses VM network/CPU.
  Confirm the test does not starve the existing backup or replication path.
- Compare existing plan schedule, last/next runs, retention settings and ordinary
  backup results before/after. Confirm normal SFTP repository browsing/download,
  Standard Download, a separately approved restore into empty staging, current
  Agent heartbeat/version and S3 backup replication state. Read-only status review
  comes first; triggering a real backup/restore is an operator action. Do not upgrade
  Agent, change a repository/replication setting or write to legacy repositories.
- Verify export-job metadata survives application recreation and historical
  archive identity/checksum stays fixed. Confirm cancellation, expired-job cleanup,
  object versions, abandoned parts, retry status and quota return to baseline.
  Unresolved cleanup is a UAT failure. Grant expiry alone does not delete an object.

## Rollback and retained metadata

Before disabling or rotating destination credentials, cancel UAT exports while the
feature is **still enabled**, let automatic cleanup complete, and verify the storage
side. Turning it off prevents storage reconciliation until the matching config is
restored. Do not hide pending cleanup by disabling the feature or deleting metadata.
Cancel any queued/running preflights through their owner-bound DELETE endpoint too;
do not carry unfinished new job types into an older image.

Set `MANAGED_EXPORT_ENABLED=false` in the protected `.env`, recreate the application
with its approved mount set/image and verify healthy plus normal backup/Agent/
replication status. Retain the temporary destination and credentials until all
recorded objects/parts are gone. Keep `/data` and the export job SQLite files intact;
there is no database migration or metadata rewrite in this patch. Ready exports
remain recorded across rollout, but need the same destination to be used/cleaned.

Use normal image rollback only with the recorded compatible image digest and
unchanged data. Removing the optional CA is another explicit mount change: while
export is disabled and no operation is active, restore the protected pre-CA env
and overlay list, recreate **only** the same-image application using that reviewed
configuration, verify healthy and exact pre-CA mounts, then restore **both**
`.deploy-contract.json.before-export-ca` and
`.deploy-compose-files.json.before-export-ca` as protected records. Keep the saved
post-CA state for recovery. Never use `down -v`, remove the named data volume, reset
the deployment contract, restore an old database over current metadata, or remove
unrelated overlays as a shortcut.

## Local evidence and remaining release gates

The follow-up builds on merged main `12e5fd7753eb27fe61225fda07faeefe690c591b`.
The confirmed deployment gap was that `.env` export settings were never forwarded
by the production Compose base, and no safe optional certificate mount existed.
The destination probe also needed actual successful two-part completion and
presigned resume checks before any source read; those now use disposable data.
Use pinned pnpm 10.20.0 and the lockfile. Relevant reproducible commands:

```sh
pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend exec tsc --noEmit
pnpm --filter @plutonhq/core-backend lint
node --experimental-strip-types --test frontend/__tests__/*.test.ts
pnpm --filter @plutonhq/core-frontend exec tsc -b
pnpm build
node --test scripts/__tests__/*.test.cjs scripts/__tests__/*.test.mjs
python3 -m unittest discover -s scripts/__tests__ -p 'deployment*_test.py'
python3 scripts/__tests__/managed_export_ca_test.py
pwsh -File scripts/validate-managed-resumable.ps1 -Modes small -ProductionCompose
```

The native fixture requires the existing disposable test image described in
[the implementation report](MANAGED_RESUMABLE_DOWNLOAD_REPORT.md). It uses isolated
internal Docker networking, generated credentials and TLS, a dedicated MinIO
bucket, real Restic/SFTP/curl and random files. The production Compose base and
actual CA overlay are used with a fixture-only image/user, test-source mounts and
2 CPU/4 GiB limits; it is not a production deployment. Configuration fingerprint,
actual authenticated preflight, source-read count zero before the gate, resume,
immutable historical snapshot, standard stream, restart, slow client, privacy
failure and cleanup are asserted. Python ownership/mount policy tests run on Linux.
The recovery image source guard was corrected to recognize verification after a
shell `&&`, while still requiring its execution as the non-root user; countertests
reject root verification and a mere echoed command. No worker runtime code changed.

Local validation on 2026-10-29: the initial backend run reported 205 suites /
4,199 assertions passed (four existing skips), frontend 360 passed, source/security guards 150 passed, Linux policy tests
35 passed, focused Linux source/package/Compose guards 21 passed, and worker
package/readiness boundary command 19 passed in each of three repeats. The latest
focused export suites passed 47 tests after the final diagnostic/cleanup cases.
Backend lint, both type checks, API inventory (187 contracts) and production build
passed. A restricted Windows shell initially prevented synthetic package adapters
from executing; rerunning with the installed POSIX shell passed all source guards.
An exploratory generic Linux image lacked repository development dependencies;
the focused Linux guards and the prepared native integration image passed.

After committing, the full backend suite reported **205 suites / 4,202 assertions
passed, four existing skips**, both normally and with `--detectOpenHandles`.
However, the Windows processes remained alive after reporting the results.
Diagnostic output identified `STREAM_END_OF_STREAM` at
`mysqlPersistentDatabaseImporter.test.ts:57` and `mysqlRecoveryWorker.test.ts:124`,
plus `WORKER,MESSAGEPORT` from Pino in `src/utils/logger.ts:78` via the shared test
setup. These files are unchanged by this patch. The 47 changed export tests exit
normally, including with handle detection. The two completed full-suite runners
were stopped after preserving their reports; **their process termination is not
reported as PASS**. No `forceExit`, timeout increase, skipped assertion or CI gate
change was introduced. A clean hosted Linux backend completion remains a release
gate; do not infer it from local assertion counts.

An isolated Compose run completed a 120,005,632-byte TAR in 11.366 seconds,
matched SHA256, resumed at 10/50/90%, verified all 15 preflight gates before source
reads, retained historical identity and Standard Download behavior, exercised
restart/cancel/expiry/slow-client cases, and left zero owned objects/parts. Overall
fixture cgroup peak was 1,385,066,496 bytes (~1.29 GiB), application-server Node peak
386,879,488 bytes (~369 MiB), CPU averaged 59.14% of its two-CPU allocation, no OOM
events/kills, and zero server temporary TAR bytes. Metadata used 82,432 bytes.
These fixture timings/resources include synthetic SFTP and client work and do not
predict production throughput. All generated credentials/data remained disposable.
The post-commit Compose repeat also passed all gates, resume, checksum and cleanup
(15.196-second export while other regression checks ran, no OOM or orphaned parts/
objects). Post-commit frontend, source guards, Linux policies, lint, both type
checks, API inventory and production build completed successfully.

Hosted CI and controlled HCP/client-network UAT remain operator gates. Record the
published commit, successful workflow URL, image digest, sanitized preflight ID/
capability list, archive checksum, resource peaks and cleanup evidence in the UAT
record. Do not include private configuration, signed URLs or credentials.
