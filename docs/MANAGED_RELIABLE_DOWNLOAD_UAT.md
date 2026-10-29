# Reliable Download: controlled production UAT

This is an operator procedure, not an automatic deployment. Reliable Download is
disabled in both committed environment examples and the production Compose base.
PR #54 delivered the export service; this follow-up wires deployment and adds a
standalone destination preflight. No production endpoint or HCP acceptance has
been tested by the coding session. Publish the local commit, open a follow-up PR
(#54 is already merged), and wait for **all Container Image jobs on that commit**
before approving a production image digest. A local build is not hosted CI PASS.

The explicitly selected shared-namespace workflow below supersedes the original
separate-bucket requirement **only when** `MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE`
is exactly `true`. It uses the existing namespace and currently authorized
credentials. All other installations keep strict bucket/credential separation.

## Activation checklist

- [ ] Hosted CI and runtime image checks completed on the published commit.
- [ ] Record the approved new image digest, previous digest, current host-bundle
  approval/backup, project name, named `/data` volume and all existing overlays.
- [ ] Arrange a maintenance window for application recreation. Let active backups,
  restores and exports finish; do not interrupt them to enable this feature.
- [ ] Storage operator reviews the selected destination contract: strict isolation
  by default, or the explicit shared-namespace procedure below. Record authorized
  namespace, reserved prefix and credential scope privately.
- [ ] HTTPS endpoint, signing region, DNS, client reachability, certificate chain,
  clock synchronization, SSE-S3 AES256, the applicable versioned/write-once identity,
  cleanup contract and storage quota approved. No mandatory property is bypassed.
- [ ] Install the reviewed host bundle and new image with export disabled. Preserve
  `.env`, local overlays, database, export-job metadata and existing data mounts.
- [ ] If needed, complete the explicit public-CA file mount procedure below.
- [ ] Set the eleven settings below privately and explicitly enable the feature;
  recreate only the application using the approved deployment procedure.
- [ ] Private comparison of effective Compose and running container reports all eleven
  environment fields equal; authenticated application configuration is valid.
- [ ] Standalone preflight reports `productionReadiness:GO`, the observed provider
  mode, every applicable capability and no cleanup pending.
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
| `MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE` | `false`; exact `true` enables the reviewed shared-prefix contract below |
| `MANAGED_EXPORT_ENDPOINT` | Approved `https://` S3 API origin, no embedded credentials/path/query |
| `MANAGED_EXPORT_REGION` | Provider's actual signing region; default `us-east-1` |
| `MANAGED_EXPORT_BUCKET` | Approved private destination; existing `backup` in the shared workflow below |
| `MANAGED_EXPORT_PREFIX` | `pluton-temporary-exports`, optionally followed by `/` and 1–64 letters, digits, `_` or `-` |
| `MANAGED_EXPORT_ACCESS_KEY_ID` | Approved protected identity; shared credentials permitted only in explicit shared mode |
| `MANAGED_EXPORT_SECRET_ACCESS_KEY` | Its protected secret |
| `MANAGED_EXPORT_SESSION_TOKEN` | Optional matching session token; otherwise empty |
| `MANAGED_EXPORT_CA_FILE` | Empty for system trust; overlay fixes it to `/run/secrets/pluton-managed-export-ca.pem` |
| `MANAGED_EXPORT_TTL_SECONDS` | Default `259200` (72 hours); allowed 3600–604800 |

`MANAGED_EXPORT_CA_HOST_FILE` is an **overlay-only host path**, never an application
setting. `.env` alone does not inject container variables; the base Compose now
forwards every runtime setting above explicitly. Review how Compose quotes values
containing `$`, `#` or whitespace, using a private effective-config file.

Storage policy needs bucket versioning inspection (or an observed unsupported API
for the explicit nonversioned contract); prefix-scoped listing of objects and,
for versioned mode, versions; prefix-scoped get/get-version/put/delete/delete-version and object ACL
inspection; multipart create/upload/complete/abort/list-parts; and bucket multipart
enumeration. Review provider-specific IAM action mappings (AWS maps multipart
creation/completion and object ACL inspection to its respective S3 actions). Deny
all unrelated access where provider policy permits. Shared mode's application
boundaries do not remove existing backup/replication permissions from a shared key.
The app neither creates buckets nor enables encryption/versioning nor edits policy.
Inspect existing settings before preflight; never change namespace-wide settings
just for UAT. Strict application admission rejects reuse of a registered
repository/replica bucket or access-key ID. Explicit shared admission instead
reserves and checks the exact disjoint prefix in both directions. That comparison
does not replace the storage operator's IAM review or attest that a provider alias
represents a different underlying account.

Use approved finite free capacity. UAT needs at least 512 MiB free for one 120 MB
archive, probes and versions; allow additional headroom for concurrent retained
exports. Existing hard bounds remain one worker, four admitted/uncleaned jobs,
128 GiB per archive, 256 GiB aggregate reservations, 64 metadata records, and one
16 MiB upload part in flight. **These are admission caps, not a guarantee that the
VM or bucket can sustain that workload.** Inspect provider lifecycle/retention,
including noncurrent versions and abandoned uploads. This feature changes none
of those settings. Do not alter shared namespace lifecycle, retention or pruning
for exports. Existing jobs must retain their
destination and credentials until cleanup finishes.

## BATII HCP 9.7 — Nonversioned Write-Once Reliable Download

This is the current activation procedure for the existing namespace `backup`,
reserved prefix `pluton-temporary-exports/`, and currently authorized credentials.
No new tenant, namespace, bucket, key, Agent, backup configuration or storage policy
is required. Keep **S3 overwrite OFF**, HTTPS/authenticated access ON, cloud protocol
optimization ON, Deletion Allowed/Enterprise retention unchanged, and the existing
30-day incomplete-upload policy unchanged. Do not enable versioning automatically.

There are two independently tested modes. A versioning API result `Enabled` selects
`versioned`, preserving exact VersionId, conditional 412 publication, version-bound
Range/presigned requests and version-specific cleanup. Missing/disabled versioning
or HTTP 501 selects a **candidate** `hcp-write-once` mode only when shared namespace
opt-in is explicit. Suspended versioning, access denial, TLS failures and ambiguous
responses are refused. A candidate is never permission to read real backup data.

### Evidence and provider limits

The official [HCP 9.7 completion documentation](https://docs.hitachivantara.com/r/en-us/mk-95hcph001-20/using-the-hitachi-api-for-amazon-s3/working-with-multipart-uploads/completing-a-multipart-upload?contentId=lynj7qhRyB9IJQpFPhwHog)
documents optional `If-Match`, VersionId only with enabled versioning, a multipart
ETag that is not a content MD5, and possible errors inside an HTTP 200 response.
The [9.7 S3 error table](https://docs.hitachivantara.com/r/en-us/mk-95hcph002-19/using-the-hitachi-api-for-amazon-s3/requests-and-responses/error-codes)
also distinguishes status and body error codes. Therefore neither a resolved SDK
call nor an ETag alone establishes integrity. This mode omits `If-None-Match` from
publication and requires namespace-enforced collision rejection instead.

The 9.7 manual links [same-name multipart behavior](https://docs.hitachivantara.com/r/en-us/mk-95hcph001-20/using-the-hitachi-api-for-amazon-s3/working-with-multipart-uploads/about-multipart-uploads/considerations-for-working-with-multipart-uploads/multiple-multipart-uploads-for-objects-with-the-same-name?contentId=b9Bo6WroKtMj_jLYpDqgPg)
and [overwrite policy](https://docs.hitachivantara.com/r/en-us/mk-95hcph001-20/managing-a-tenant-and-its-namespaces/managing-namespaces/configuring-a-namespace/allowing-object-overwrites?contentId=5tJaHHek2ma3znoDM5iD7A).
Those two individual 9.7 pages could not be retrieved in this coding session;
the similarly titled supplied overwrite link is explicitly **9.6.x**, and newer
search results explicitly **10.x**. Neither substitutes for 9.7.3.14 evidence.
The operator's console observation is a prerequisite, not an API certification.
Actual 409 first-writer-wins, conditional reads, SSE, retention/cleanup and private
access on this HCP endpoint must pass the runtime probes below. An incompatible
status or unchanged mandatory capability remains NO-GO without policy changes.

### Publication, identity and transport

Before each archive, a distinct durable random child probe repeats all applicable
capabilities without reading backup contents. Its keys cannot become archive keys.
The final archive uses one cryptographic UUID key for exactly one job. The uploader
checks absence, records exact multipart IDs, rechecks write-once collision behavior
before streaming and immediately before completion, and journals the publication
attempt **before** sending it. It never retries an uncertain completion or adopts
an existing object. A retry creates a new job/key.

After completion, independent HEAD and streaming full SHA-256 readback verify the
size, ETag, creation timestamp, nonce, job/snapshot binding, AES256 and archive hash.
Durable identity is discriminated: a VersionId in versioned mode; otherwise the
exact key/ETag/length/SHA-256/timestamp/binding/capability proof. No full TAR is staged
on Pluton. One 16 MiB part is in flight, one exporter, with existing queue/quota limits.

Nonversioned delivery is **authenticated Pluton proxy only**. Each Range uses the
expected storage ETag in `If-Match`, checks all identity headers and exact 206,
Content-Range and length, and checks identity again after streaming. Wrong ETag
HEAD/GET behavior is tested before acceptance. A changed/missing object or invalid
Range response invalidates the export; a mismatched `If-Range` cannot silently
become a 200 continuation. Full transfers also count bytes and hash the stream.
The client must verify final archive size and SHA-256, including resumed downloads.

The authorization/link endpoint returns or redirects to the authenticated content
route for this mode. It does not issue an unconditioned storage bearer URL or claim
that a browser can attach a required signed header. Renew the Pluton login/session
as needed; authorization never regenerates an archive. Standard Download retains
its existing streaming behavior. TLS termination/proxy idle limits still apply;
retain Range-capable access to the application and monitor its network throughput.

### Cleanup and shared credential boundary

Only exact generated keys and persisted upload IDs may be cleaned. Before deleting
an unversioned object, the worker requires durable successful-publication proof,
nonce/binding, ETag, timestamp, length, AES256, a full SHA-256 readback and another
matching HEAD. Unknown keys, foreign metadata, changed identities, unrecorded
successful responses, retention and uncertain abort/deletion keep cleanup-pending.
No recursive, bucket-wide, repository, retention or lifecycle operation exists.
An HTTP deletion success is followed by absence and multipart verification; prefix
reservations and metadata remain durable even after successful cleanup or disablement.

Preflight tries a wrong-ETag DELETE **only on its own random synthetic object**.
If the provider returns 412 and preserves it, cleanup uses the verified conditional
ETag. If the header is unsupported or ignored, the report says
`cleanup:exclusive-prefix-bounded`. This mode is permitted only within the explicit
shared-prefix contract: **Pluton is the sole writer/deleter of the reserved prefix**,
and its durable process ownership prevents a competing Pluton exporter.

This bounded model is not atomic compare-and-delete. Another holder of the shared
credentials can bypass application guards, delete/recreate a key after the final
HEAD, or clone its metadata/content; ETag may identify bytes rather than incarnation.
Even conditional ETag deletion cannot defeat an adversarial identical-content
recreation. The application cannot revoke those external privileges. If exclusive
use of the prefix cannot be assured, or any identity check is uncertain, choose
NO-GO/operator review; do not represent this as equivalent to pinned version deletion.
No new credentials are demanded and existing replication rights remain unchanged.

### Enabled production example and deployment order

Placeholders only; edit the existing protected operator `.env`. Keep the existing
endpoint, signing region, credentials, CA and TTL values. This example explicitly
enables the feature; committed configuration remains disabled by default.

```dotenv
MANAGED_EXPORT_ENABLED=true
MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE=true
MANAGED_EXPORT_ENDPOINT=https://tenant.example.internal
MANAGED_EXPORT_REGION=us-east-1
MANAGED_EXPORT_BUCKET=backup
MANAGED_EXPORT_PREFIX=pluton-temporary-exports
MANAGED_EXPORT_ACCESS_KEY_ID=YOUR_CURRENTLY_AUTHORIZED_HCP_ACCESS_KEY
MANAGED_EXPORT_SECRET_ACCESS_KEY=YOUR_CURRENTLY_AUTHORIZED_HCP_SECRET_KEY
MANAGED_EXPORT_SESSION_TOKEN=
MANAGED_EXPORT_TTL_SECONDS=259200
MANAGED_EXPORT_CA_FILE=/run/secrets/pluton-managed-export-ca.pem
MANAGED_EXPORT_CA_HOST_FILE=/etc/pluton/certificates/export-ca.pem
```

For system CA trust, leave `MANAGED_EXPORT_CA_FILE` empty, omit the host-file setting
and CA overlay. Otherwise use the existing read-only single-file CA overlay below.
Do not put private keys or credential values in commands, reports or Git.

1. Operator publishes the reviewed commit and requires all Container Image jobs
   on that exact commit, including the production runtime image checks.
2. Retain the previous image/config, compatible database backup and export metadata.
   Review all repository scopes and the exclusive-prefix assumption privately.
3. Drain active work; recreate only the app using the approved image, same `/data`
   volume, encryption keys, security restrictions and overlays. No Agent changes.
4. Verify health and the private eleven-field environment comparison below.
   Enabled valid configuration starts without a network probe or backup read.
5. Run inventory, then capability preflight using an authenticated operator session.
   Until a fresh GO exists for the exact configured destination **and credentials**,
   real shared-mode export admission is refused before snapshot binding/source access.
   A failed newer preflight, credential change or 15-minute GO expiry requires a
   fresh operator preflight. Each admitted export repeats its own probes too.
6. Run 120 MB UAT first, with full extraction and resume checks. Larger files are
   a separate capacity decision; do not infer production headroom from queue caps.

Run in the logged-in application's browser console; report only safe summaries:

```js
async function exportCheck(kind) {
  const base = '/api/managed-exports/' + kind;
  const started = await fetch(base, { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (started.status !== 202) throw new Error('Check admission refused');
  const id = (await started.json()).result.id;
  for (;;) {
    const response = await fetch(base + '/' + id, { credentials: 'include' });
    if (!response.ok) throw new Error('Check status unavailable');
    const check = (await response.json()).result;
    if (['ready', 'failed', 'cancelled', 'expired'].includes(check.state)) return check;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
const configuration = (await (await fetch('/api/managed-exports/configuration')).json()).result;
if (!configuration.configured || !configuration.sharedNamespaceEnabled) throw new Error('Configuration refused');
const inventory = await exportCheck('inventory-checks');
if (inventory.state !== 'ready' || !inventory.inventory?.exclusive) throw new Error('Inventory NO-GO');
const check = await exportCheck('preflights');
console.log({ id: check.id, readiness: check.productionReadiness, provider: check.provider,
  checks: check.preflightChecks, cleanupPending: check.cleanupPending,
  capability: check.failureCapability, category: check.failureCategory, status: check.failureHttpStatus, probeFailure: check.probeFailure });
if (check.productionReadiness !== 'GO' || check.cleanupPending) throw new Error('Destination NO-GO');
```

GET/DELETE use the returned ID, no configuration overrides:
`GET /api/managed-exports/preflights/:id`;
`DELETE /api/managed-exports/preflights/:id` with `{}` cancels/retries exact cleanup.
Inventory is metadata-only and never cleans unknown objects. An old GO report is
reported NO-GO after credential/destination changes or a newer failed preflight.

| Decision | Required observed evidence |
| --- | --- |
| Versioned GO | Original 15 checks, exact VersionId, conditional collision 412, cleanup complete |
| Nonversioned candidate | Versioning disabled/unavailable, explicit shared opt-in; not yet GO |
| Nonversioned GO | HTTPS/SSE/private ACL/anonymous denial; PUT collision 409; first MP creates, second MP is rejected and first bytes unchanged; separate MP/MP and MP/MP/PUT races each have exactly one winner; full readback; conditional HEAD/GET and exact Range; bounded object/upload enumeration; exact cleanup; exclusive prefix assumption accepted |
| NO-GO | Overwrite succeeds, collision is only a generic/200 embedded error, both race writers succeed, condition ignored, wrong 200 Range, wrong checksum/identity, foreign/ambiguous inventory, retention or uncertain cleanup |
| Production accepted | Applicable destination GO **plus** operator 120 MB checksum/extraction/resume and resource/compatibility UAT; not established by local fixtures |

For nonversioned 120 MB UAT, use the UI Full Download then Regular Files Only on a
disposable managed snapshot. Get the verified job summary and content link. Use an
authenticated client, stop transfers at 10%, 50% and 90%, then continue with Range
and the Pluton `ETag: "sha256-<archive hash>"` as `If-Range`. Require 206 and exact
Content-Range for every continuation; never append a 200 response. Renew the session
and obtain the same content route as necessary. Store any session cookie in a
private mode-0600 client file, not shell arguments/history or this report.
Compare the final byte count and `sha256sum`, extract to a new empty directory and
compare every file/link against the synthetic source. Compare repository object
manifests and use authorized `restic --no-lock check --read-data` before/after.

Monitor 2 vCPU/4 GiB CPU throttling, RSS/cgroup memory, at least 512 MiB RAM reserve,
metadata disk, local client disk, bandwidth, cleanup-pending jobs and exact orphan
objects/parts. Stop the test near 3 GiB VM memory or on degraded backup latency,
swap/OOM, disk pressure or cleanup uncertainty. Extra full readback is streaming but
uses bandwidth, including ownership verification during cleanup. Do not schedule a
large export alongside production backup work without measured headroom.
Nonversioned cleanup has a size-based deadline (one minute plus object bytes at
1 MiB/s, capped by the existing export deadline); idle storage requests still have
their network inactivity bounds. Shutdown aborts that read and retains cleanup
intent/reservations for restart. Versioned cleanup keeps its original 60-second bound.

Rollback: cancel/drain exports with the matching config still enabled; verify
cleanup or retain unresolved records for operator review; set ENABLED=false and
recreate only the app. Preserve export SQLite files and permanent main-database
reservations. Do not roll back to an image that permits unsafe future S3 edits,
clear metadata, delete the prefix or change existing replication/retention.

Local reference gateway tests are explicitly **not HCP emulation/certification**.
They impose a first-writer-wins contract on native MinIO and prove how the client
handles it. Ordinary nonversioned MinIO must be rejected for allowing overwrites.
Hosted CI and all actual HCP properties remain operator-run release gates.

### Nonversioned local verification record (2026-10-30)

These are disposable synthetic tests on this branch, not access to the actual HCP.
The production Compose base, read-only CA overlay, security restrictions, default
disabled flags, existing database and permanent namespace reservation remain intact.
The compiled startup smoke uses generated configuration and a fresh `/data`, UID
10001, read-only root, dropped capabilities and **network none**. It confirms enabled
startup, authenticated configuration, operator inventory/preflight admission and
cancellation, and refusal of a real export before GO. It is not a newly built final
runtime image; hosted Container Image validation remains required.

| Native local fixture | Result and measured export |
| --- | --- |
| Versioned 120 MB, production Compose + CA overlay | PASS, 120,005,632-byte TAR, 17.524 s; all original 15 checks, presigned and proxy resume, restart, Full/Regular Files Only, cancellation/cleanup |
| Write-once reference 120 MB with five replicas | PASS, 120,005,632-byte TAR, 19.504 s; 10/50/90% authenticated Range resume, full extraction, restart, Full/Regular Files Only, uncertain/failure paths and cleanup |
| Write-once reference 3.17 GB / 115,566 source entries | PASS, 3,406,661,632-byte TAR / 115,570 TAR entries, 456.411 s; full SHA256, extraction comparison, resume, historical snapshot, Standard Download and cleanup |
| Write-once reference 4 GB | PASS, 4,000,012,288-byte TAR, 347.546 s; complete SHA256/extraction, Range resume, Standard Download and cleanup |
| Native ordinary nonversioned MinIO, overwrite allowed | Correctly NO-GO at collision rejection; test administrator removes only its exact disposable negative-control keys |

| Final regression check | Result |
| --- | --- |
| Full backend, normal process exit | 207 suites, 4,265 passed, four pre-existing platform skips; 332.914 s |
| Frontend Node suite | 361 passed, no skips |
| Linux native security/recovery/namespace suites | 10 suites, 320 passed, one pre-existing platform skip |
| Focused versioned/write-once/service suites | 80 passed |
| Source/security/worker/Compose Node guards | 150 passed; the focused deployment/Compose invocation also passed all 17 tests |
| Linux deployment, CA and fixture policy / POSIX syntax | 36 passed; all deployment shell scripts parse |
| Backend lint; backend and frontend type checks; production build | PASS; three build tasks successful |
| Compiled enabled-startup UID 10001 / read-only / network-none smoke | PASS, including authenticated operator-check admission/cancellation and real export refusal before GO |
| Frontend lint | Existing ESLint configuration error described below, exit 2; not suppressed or changed |
| Hosted CI / final image build / actual HCP 9.7.3.14 | Not run; operator release gates |

The final native 120 MB repeat also passed after separating MP/MP from the three-way
race: 16.830 s export, 598 ms maximum admission, 390,754,304-byte server Node peak,
1,391,292,416-byte whole fixture peak, zero OOM/orphans and 135,680 metadata bytes.
This repeat includes the native overwrite-allowed negative control and concurrent
backup/replication. The earlier large runs exercise the same archive/identity/Range/
cleanup path; the final additional race was independently exercised at 120 MB.

Both 120 MB modes run a genuine new native Restic backup and Rclone replication to
a separate future-plan prefix while an export upload is held at a deterministic
barrier. This proves actual operation overlap without fixed sleeps. Existing
replicas' keys, version identities, lengths and checksums remain unchanged; native
`restic --no-lock check --read-data` passes afterward. The fifth replica uses another
generated credential; the others share export credentials. Production managed-plan
create/edit/receipt/reservation guards are independently tested with real SQLite,
including two competing connections. No production plan was triggered or edited.

All three successful sizes retain one export worker, a fixed 16 MiB part buffer,
zero local server TAR staging, zero orphan objects/parts and zero OOM events/kills.
The reference 120 MB server Node peak was 388,767,744 bytes; whole fixture peak
1,239,953,408 bytes. For 3.17 GB, server Node peaked at 611,110,912 bytes and metadata
at 326,169,088 bytes; whole fixture cgroup peak was 4,296,482,816 bytes. The 4 GB
server Node peak was 380,657,664 bytes; whole fixture peak 4,295,716,864 bytes.
Fixture client/source processes and page cache are included in the latter figures.
**Both stress cases approach the 4 GiB accounting boundary and exceed the production
UAT stop threshold. They demonstrate integrity, not headroom approval for multi-GB
production transfers or concurrent scheduled backups.**

An exploratory batch reused one namespace for several datasets and failed its later
replica-invariance check. The driver now runs each requested mode in a fresh native
namespace/network/volume; the separately isolated 3.17 GB and 4 GB runs above passed.
Earlier exploratory runtime checks identified the need to use the production ESM
loader and valid same-origin POST headers in the fixture; neither production gate
was weakened. The Linux suite now mounts migrations for its real SQLite guard tests.
An independent multipart-only race supplements the three-way race so a winning PUT
cannot conceal unsafe MP/MP behavior; a violating-provider regression must refuse it.

Run from the repository root with the pinned pnpm and existing disposable native
fixture image (or build it from `scripts/fixtures/managed-resumable/Dockerfile`):

```sh
pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
node --experimental-strip-types --test frontend/__tests__/*.test.ts
pnpm --filter @plutonhq/core-frontend exec tsc -b
pnpm build
node --test scripts/__tests__/*.test.cjs scripts/__tests__/*.test.mjs
python3 scripts/__tests__/deployment_policy_test.py
python3 scripts/__tests__/managed_export_ca_test.py
python3 scripts/__tests__/deployment_fixture_test.py
pwsh -File scripts/validate-managed-resumable-unit.ps1
pwsh -File scripts/validate-managed-export-runtime.ps1
pwsh -File scripts/validate-managed-resumable.ps1 -Modes small -SharedNamespace -ProductionCompose
pwsh -File scripts/validate-managed-resumable.ps1 -Modes small -SharedNamespace -WriteOnceReference
pwsh -File scripts/validate-managed-resumable.ps1 -Modes combined -SharedNamespace -WriteOnceReference
pwsh -File scripts/validate-managed-resumable.ps1 -Modes four -SharedNamespace -WriteOnceReference
git diff --check
```

Native drivers use random internal networks and owned volumes, generated credentials
and certificates, no published port or production input. Their source/runtime tests
remain outside production release artifacts. Source guards also verify the existing
MySQL worker package and diagnostic boundaries. Windows source subprocess checks
initially lacked permitted Bash access; their normal authorized host run passed.
Frontend lint retains the existing `typescript-eslint` configuration error about
the string `eslint-config-prettier` in `extends` (exit 2); frontend tests, type checks
and production build pass. No dependency or unrelated lint configuration is changed.

## BATII HCP 9.7 — Existing Shared Namespace backup

This workflow uses the **existing `backup` namespace**. No new namespace, bucket,
tenant, provider or physical storage is required. The operator-supplied reference
version is HCP 9.7.3.14; the documentation reviewed covers 9.7.x. The existing
`meetingroom` replication and future plans stay in their own canonical repository
prefixes. Those actual paths are resolved privately from application state; neither
the plan title nor an assumed folder name defines ownership. Only
`pluton-temporary-exports/` is reserved for Reliable Download.

### Exact operator settings and preserved deployment

Use a protected installation-local `.env`. Example values below are placeholders;
the bucket and reserved prefix are the explicitly requested namespace contract:

```dotenv
MANAGED_EXPORT_ENABLED=false
MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE=true
MANAGED_EXPORT_ENDPOINT=https://tenant.example.internal
MANAGED_EXPORT_REGION=us-east-1
MANAGED_EXPORT_BUCKET=backup
MANAGED_EXPORT_PREFIX=pluton-temporary-exports
MANAGED_EXPORT_ACCESS_KEY_ID=YOUR_CURRENTLY_AUTHORIZED_HCP_ACCESS_KEY
MANAGED_EXPORT_SECRET_ACCESS_KEY=YOUR_CURRENTLY_AUTHORIZED_HCP_SECRET_KEY
MANAGED_EXPORT_SESSION_TOKEN=
MANAGED_EXPORT_TTL_SECONDS=259200
MANAGED_EXPORT_CA_FILE=/run/secrets/pluton-managed-export-ca.pem
MANAGED_EXPORT_CA_HOST_FILE=/etc/pluton/certificates/export-ca.pem
```

Use the actual approved S3 API origin and signing region. Use the tenant/API
origin without a bucket-qualified hostname: shared export
uses path-style addressing and refuses a host beginning with `backup.` to avoid
an unintended object-key prefix. Repository aliases are still compared canonically.
If system trust suffices, leave `MANAGED_EXPORT_CA_FILE` empty and omit the CA
overlay and host-file setting.
Otherwise apply the reviewed single-file read-only overlay using the unchanged
mount-contract procedure below. Set `MANAGED_EXPORT_ENABLED=true` only in the
approved window to run authenticated inventory/preflight; leave normal users from
starting downloads until the operator reports GO. Every real export independently
repeats the gates before reading source contents. API input cannot select a prefix,
bucket, endpoint, credentials or mode. Both feature flags default to `false` in Git.

Do not change `PLUTON_STORAGE_CA_FILE`, existing storage credentials, plan schedules,
Agent settings, encryption keys, repository locations or overlays to enable this
feature. Operator environment settings supply the export credential separately,
even if its value is the same currently authorized key. Do not extract backup
credentials through a browser/API. Installing an image does not update installed
host scripts; use the existing reviewed host-bundle process first. Preserve `/data`,
its export SQLite files, and the main database containing the new reservations.

After application recreation, compare protected effective Compose JSON with a
protected container inspection using `compose-tools.py export-environment` below.
Require `export-environment-matches-all-11-fields-no-values-emitted`, plus the
authenticated configuration endpoint reporting `sharedNamespaceEnabled:true`.
No values, credential hashes or signed URLs are logged by those checks.

### Bidirectional protection and concurrency

Shared admission installs a permanent main-database reservation under an IMMEDIATE
SQLite transaction. In the same transaction it checks all primary plan scopes,
enabled **and disabled** replica definitions, historical backup/mirror references,
managed/retained repository records, all retained replica destinations regardless
of initialization state, pending/running/uncertain/historical replica jobs, and
self-backup destinations. Legacy registrations currently support local paths only;
an unknown future non-local backend blocks shared admission until understood.
Missing storage, root/inherited paths, ambiguous/encoded components or overlap
fail closed without changing the repository record.

The shared identity code calls the same `canonicalS3Location` normalization as
repository identity: verified HTTPS origins, default ports/trailing hostname dot,
virtual-host bucket forms and AWS regional aliases. It additionally treats **the
same bucket name at any endpoint as a possible alias**. Thus an unknown DNS alias
cannot hide overlap; this conservative rule can reject an unrelated installation
with an identical bucket name. There is no alias allowlist/bypass. Prefix segments
are case-sensitive and parent/child boundary checks are exact; a sibling such as
`pluton-temporary-exports-other` is disjoint.

Plan create/update, backup mirror receipt writes, replica reservation, settings
self-backup writes and storage updates check the durable reservation at backend
transaction boundaries. A plan created tomorrow cannot place a repository at the
root, inside the reserved prefix or over its parent. Disjoint replication and
existing scheduling/retention continue unchanged. The same checks work after
export is disabled and after restart. There is no API to drop a reservation and
cleanup never releases it. At most eight normalized namespace reservations can
be retained; a configuration change cannot silently discard previous ownership.

Storage service edits use a second durable journal spanning the remote rclone
configuration change and final database publication. Remote names are reserved
against conflicting creations, even through a non-S3 type. Once the namespace is
reserved, ordinary edits of an existing storage for that namespace (including a
credential/endpoint change) are refused before remote mutation. **Do not rotate
its shared credentials during active exports or through an ordinary edit after
reservation.** Coordinate rotation as a separately reviewed maintenance action,
drain exports and reconcile all existing backup/replica bindings first. A new
disjoint plan can still use the unchanged storage.

An interrupted/failed storage edit remains marked uncertain; affected exports
are refused rather than assuming the remote config reverted. Operators must
reconcile actual protected rclone configuration with the saved database and review
the exact journal entry before a separate approved recovery. Never clear the
whole journal/reservation table or restore an older database merely to obtain GO.
This patch does not automate that recovery or credential rotation.

Admission, worker execution, source/publication boundaries, authorization/proxy
resume and cleanup reconciliation revalidate the selected contract. Immutable
job destination fingerprints remain unchanged for older jobs; changing endpoint,
region, bucket, prefix or CA refuses their use until the matching config returns.
Ready job metadata is retained, not silently repointed. A provider/credential or
other application with write privilege is outside SQLite's control; the ownership
and conditional-write checks remain mandatory on S3 as well.

### Read-only inventory before disposable writes

In the authenticated browser on the approved origin, request:

```js
const response = await fetch('/api/managed-exports/inventory-checks', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
});
if (response.status !== 202) throw new Error('Inventory admission refused');
const inventoryId = (await response.json()).result.id;
```

Poll `GET /api/managed-exports/inventory-checks/:id` with the same session, using
the bounded polling pattern below. Require `state:ready` and
`inventory:{objects:0,uploads:0,exclusive:true}` on the first empty-prefix setup.
Existing live exports may produce nonzero counts only when their exact object
versions/upload IDs are already recorded and their HEAD proof matches. A cleaned
job cannot adopt a replayed object. Results return counts/state only, not object
names or repository inventory. This job performs versioning inspection and bounded
prefix-scoped version/upload listings, plus HEAD on already recorded owned versions;
it performs **no S3 writes, deletes, aborts, content reads or Restic operations**.
It records only local metadata/reservation. Cancellation uses its owner-bound
DELETE endpoint and never starts storage cleanup for an inventory job.

If any unknown object, foreign version, delete marker, unrecorded multipart upload,
unreadable identity or incomplete/over-limit enumeration exists under the prefix,
return NO-GO and preserve it. Do not claim it, remove it, move a repository or
recursively clean the namespace. This check never inventories repository contents
outside the reserved prefix. Inspection of any other names requires the storage
operator's own authorized read-only procedure. The application will not sweep
backup contents to infer ownership. The listing bound is eight pages of 100 entries
each; exhaustion fails closed.

After inventory succeeds, run `POST /api/managed-exports/preflights` with `{}` and
poll its status as described below. Shared mode repeats inventory before probe
writes and again at authorization/publication boundaries. Only generated random
objects are used; no backup data is read until every capability for the observed
mode passes. The versioned mode retains the original 15 checks.

### HCP console review and capability findings

Review read-only with the storage operator: selected namespace identity, S3 API
and HTTPS availability, verified certificate/host name, signing compatibility,
cloud protocol optimization/multipart support, versioning state, encryption,
private ACLs/anonymous denial, effective authorized access, retention/holds and
delete-version/abort/list permissions. Do not toggle these namespace-wide settings
to force acceptance. Versioning/retention changes can affect existing replication
objects; enabling them is not an export-only action.
The official [9.7 protocol-optimization reference](https://docs.hitachivantara.com/r/en-us/mk-95hcph001-20/administering-hcp/tenant-administration/protocol-optimization)
states that multipart uploads require a cloud-optimized namespace. If the existing
namespace cannot provide multipart, return NO-GO; do not modify its optimization
or enable management privileges through this application.

Versioned mode keeps mandatory version IDs and the exact conditional 412 completion
probe. The separately implemented nonversioned mode above instead proves overwrite
rejection through unconditioned PUT/multipart races, full readback and conditional
reads on the actual destination. Missing AES256, ignored read conditions, invalid
collision behavior or uncertain cleanup remain NO-GO. Random names, HEAD-before-write
or matching metadata alone never authorize publication/adoption. The nonversioned
cleanup boundary is explicitly narrower than version-specific deletion under an
external writer, as explained above; no production HCP acceptance is claimed here.

Shared cleanup requires a recorded upload ID before abort and an exact persisted
version/length/ETag plus ownership metadata before deletion. For preflight versions
these proofs are journaled as requests succeed; archives retain their full SHA256
and snapshot/owner binding. Unknown versions with even a forged matching job marker
are left untouched. A crash between provider success and local persistence leaves
uncertainty and a cleanup blocker, not permission to adopt/delete by name. A
successful delete response is followed by absence verification. No bucket-wide
delete, repository-prefix deletion, Restic unlock/forget/prune, namespace lifecycle
change or management API mutation is performed.

Reusing the currently authorized HCP key is supported in this explicit mode. It
does **not** provide IAM isolation: process/key compromise could permit unrelated
operations using the shared privileges. Provider policy, network restriction and
credential handling remain operator responsibilities. New credentials are not a
prerequisite; never claim application prefix checks revoke the shared key's rights.

### Operator GO / NO-GO, initial test and rollback

1. Publish the local patch and require the hosted validation/build on its exact
   commit; retain previous image/host bundle/configuration and compatible database
   backup. This coding session does not push, deploy or access production.
2. Review current repository/replica scopes privately. Any root, unresolved,
   overlapping, retained or disabled scope is a blocker, never an invitation to
   rename/migrate existing data. Keep the `meetingroom` plan and schedules intact.
3. Install the approved host bundle/image with export disabled and unchanged volume,
   overlays, encryption keys and Agent. Complete CA approval if needed. Set the
   explicit shared flag/configuration privately, then enable export in the approved
   maintenance window and recreate only the app using its approved digest.
4. Require health, the eleven-field private configuration comparison, valid process
   flags, read-only inventory, then all applicable preflight gates plus confirmed cleanup.
   Any missing check, timeout, failed capability, unknown prefix object or cleanup
   uncertainty is **NO-GO**. Keep Standard Download available and make no real export.
5. After GO, run the synthetic 120 MB test below and verify exact SHA256 and
   interrupted 10/50/90% resumes using the same export and renewed short-lived grants.
   Compare existing replication's protected status/object manifest before/after and
   check snapshot/pack/index/config integrity through an authorized read-only
   procedure. Local synthetic evidence is not production full-recovery acceptance.
6. Test admission of a future disjoint Backup Plan and rejection of parent/root/
   export-prefix paths using disposable fixtures; do not create/delete a live plan
   just for a negative test. Monitor existing HCP/SFTP backup, replica, Agent,
   Standard/Full/Regular Files Only download, staging restore and Recovery Test
   status under the resource checklist below. Triggering real operations needs its
   own operator authorization. Do not change Agent or retention.
7. Roll back by cancelling test exports while the matching config is still enabled,
   verifying owned-object/part cleanup, then disabling export and recreating only
   the app on a compatible approved image. Keep `/data`, both export SQLite metadata
   and the main-database namespace reservation. Never remove a reservation to make
   room for a repository. Keep the same destination/credentials for outstanding
   cleanup. Old images predating this guard cannot safely admit new S3 plan/storage
   edits in shared mode; do not use image rollback to bypass that restriction.

GO requires both actual HCP preflight and client-network UAT evidence. If HCP cannot
prove a mandatory feature, report that precise incompatibility and stop Reliable
Download. Do not demand another namespace or change existing backup protection.

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

Require `export-environment-matches-all-11-fields-no-values-emitted`. The tool
compares all eleven settings, including credentials and token, in memory; it reports
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

The following original table applies to **versioned mode**. The nonversioned
mode's actual evidence and decision matrix are in its dedicated section above;
it never reports `versioning` as PASS when versioning is unavailable.

| Mandatory check | Proof |
| --- | --- |
| `destination-isolation` | Strict separate bucket/key, or durable bidirectional prefix reservation plus read-only exclusive inventory in explicit shared mode |
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
| `multipart-completion` | Two parts actually completed conditionally; full random-object SHA256 readback, length/version/AES256/ownership verified |
| `cleanup` | Owned versions removed, abandoned multipart aborted and absence verified |

Safe failures report a capability plus `tls-validation`, `access-denied`,
`unsupported-api`, `unexpected-response`, `network-or-deadline` or `cleanup-failed`,
and an HTTP status when available. No raw provider response, endpoint, environment
values, credentials or signed URL is exposed. Versioning HTTP 501 can enter only
the explicit candidate write-once contract; it is not GO. A rejected certificate reports
`https / tls-validation`. Cleanup failure takes precedence and retains metadata
for reconciliation. Some providers express unsupported APIs as 400; the exact
failing capability and safe status remain visible. Storage operators must inspect
their own protected logs for a more detailed provider diagnosis. Do not grant
additional backup privileges, bypass TLS/SSE or the selected publication contract,
or remove namespace reservations to force a PASS. HCP is unaccepted until these gates
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

## Shared-namespace local validation and release gates

This work continues on `codex/managed-resumable-download`, directly after verified
commit `12d4235da32aeb5efc9cfb534fb5c9093c788f7b`; the earlier implementation was
preserved. Only disposable data and generated identities were used. No push,
production access, HCP credentials, deployment, Agent upgrade or namespace-setting
change was performed. Exact changed files can be reviewed with
`git diff 12d4235..HEAD --name-only` after the local commit.

| Final local regression gate | Result |
| --- | --- |
| Complete backend suite | 206 suites, 4,240 passed, four pre-existing skips; normal exit |
| Frontend state/polling/accessibility/recovery | 360 passed |
| Source/security/Compose/worker contract tests | 150 passed |
| Relevant backend on Linux, 2 CPU / 4 GiB | Nine suites, 195 passed; includes standalone migrations and native SQLite races |
| Linux deployment/CA/shared configuration policies and shell syntax | 36 passed; shell syntax valid |
| Backend lint, backend/frontend type checks, production build | PASS with pinned pnpm 10.20.0 and existing lockfile |
| API inventory | 190 contracts verified |
| Hosted workflow / newly built production runtime image / actual HCP | Not run here; exact published-commit CI and operator preflight remain required |

The new implementation is centered on `NamespaceReservation.ts`, the shared
canonical S3 identity helpers, transactional Plan/Storage/Backup/Settings/replica
store guards, the storage service's durable edit journal, inventory/preflight
service/controller/router and exact version/upload proofs in `S3ExportStorage`.
Compose, both environment examples, private environment comparison and tests
forward/check eleven runtime settings. The new main-database tables are local
ownership metadata; export jobs retain their prior private SQLite location and
backward-compatible JSON. Inventory intent is saved atomically at admission so
a hard restart cannot mistake a read-only inventory for an object-cleanup job.

Reproduce native shared-mode checks on the prepared disposable Linux image:

```powershell
./scripts/validate-managed-resumable.ps1 -Modes small -ProductionCompose -SharedNamespace
./scripts/validate-managed-resumable.ps1 -Modes combined -ProductionCompose -SharedNamespace
```

The small run uses five disjoint synthetic plan/replica scopes and real copied
Restic repositories, with shared credentials and a second generated replica
identity. A replica definition is disabled but still included in admission. The
large run uses one disjoint replica. Both capture a complete repository-object
manifest (names, version IDs, sizes and SHA256) before export and compare it after
all export operations, then run read-only `restic check --read-data` and compare
again. They validate historical snapshot IDs as well. No repository object is
expected to change. These tests prove export non-interference; they do not claim
a production application recovery or execute production schedules.

| Native local check | Result |
| --- | --- |
| 120,000,000-byte source / 120,005,632-byte TAR | PASS; full SHA256, historical contents and symlink-safe extraction |
| Five replica prefixes, shared and different credentials | PASS; all repository manifests unchanged; Restic read-data checks pass |
| Read-only inventory, unknown/forged object preservation, all 15 preflight checks | PASS before any source archive read |
| 10/50/90% interrupted resume, renewed grants, proxy, slow client | PASS on the same archive/version |
| Restart, failed multipart, cancellation, expiry, cleanup retries | PASS; zero orphan objects/uploads and zero temporary server TAR bytes |
| 3,170,000,000-byte source / 3,406,661,632-byte TAR, 115,570 TAR entries | PASS; SHA256, historical identity, resume, unchanged replica, Restic read-data check |

The final small run prepared its TAR in 13.284 seconds, with maximum admission
584 ms, application-server Node peak 349,454,336 bytes and whole fixture cgroup
peak 1,133,600,768 bytes (~1.06 GiB), no OOM events/kills. Before transaction-local
credential resolution, a contended five-replica run reached 3,495 ms admission;
each transaction now derives credentials once per storage, discards that cache
on return, and revalidates later edits. The cache budget/freshness has a regression
test. Different runs have different synthetic archive hashes.

The large stress run prepared its TAR in 265.584 seconds; server Node peak was
662,052,864 bytes (~631 MiB), whole fixture cgroup peak 4,296,314,880 bytes
(approximately the 4 GiB accounting boundary), CPU averaged 80.97% of its two-CPU
allocation, with no OOM events/kills. The fixture includes client/Restic/Rclone and
page cache. **This leaves insufficient demonstrated headroom for concurrent work
on a 4 GiB production VM.** It exceeds the conservative production UAT stop
threshold above: begin with 120 MB only; do not treat this stress pass as approval
for multi-GB production downloads or simultaneous backups. Preserve normal backup
capacity and require operator-observed resource margins before expanding UAT.

Verification also covers actual SQLite transaction/permission boundaries: existing
root/ambiguous scopes, disabled replicas, retained/detached/uncertain ownership,
historical mirror receipts, aliases, future plan/replica/storage/self-backup paths,
two competing database connections, edit/crash journals, restart/disablement,
strict default isolation, auth/owner rejection, metadata forgery, unrecorded upload
IDs, foreign versions/delete markers and incomplete enumeration. No provider-wide
delete or lifecycle mutation is used.

A first full regression run exposed an application-singleton import in the new
store guard; it was fixed by startup-owned dependency injection, preserving
standalone migration tools without environment bootstrapping. The ten original
credential-migration tests then passed unchanged. A Linux-native concurrent-writer
assertion now checks `SQLITE_BUSY` directly instead of matching the native Error
class/message; the two-connection rejection assertion is retained. No CI gate,
security assertion, scenario or timeout was removed/increased to obtain a pass.

Hosted release checklist (operator publishes; this session does not):

- [ ] Publish this branch and open/update the appropriate follow-up PR; PR #54 is merged.
- [ ] Require the Container Image validation and production image build on the
  exact published commit, including all backend/frontend/type/security/deployment
  gates and the existing non-root native recovery-client runtime image checks.
- [ ] Review the full source diff, credential-free configuration examples and
  protected host-bundle digest; approve the exact produced image digest.
- [ ] Run the actual existing HCP namespace inventory, all applicable mode gates,
  120 MB client resume/checksum and normal backup-protection checks above.
- [ ] Record a sanitized operator GO/NO-GO and rollback readiness. Hosted CI and
  production HCP compatibility remain unclaimed until those actual checks finish.

## Earlier deployment follow-up evidence (historical)

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
