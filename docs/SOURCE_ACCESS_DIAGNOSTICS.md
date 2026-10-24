# Backup source diagnostics

This change needs the Server patch and the separately reviewed standalone Agent
0.7.1 patch. It does not change managed retention, Legacy access, source approval,
database/hooks, replication, scheduler or MCP behavior. No production validation
or rollout was performed.

## Audit and root cause

The standalone Agent is authoritative for remote filesystem observations. The
Server cannot reconstruct an unreported remote filename.

| Boundary | Previous behavior | Delivered behavior |
| --- | --- | --- |
| Root validation | Realpath/approved-root containment and service read/traverse checks; generic errors | Same checks; failures from entry permission checks can carry a relative root marker `.` and observed OS category |
| v4 exclusion scan | Two existing bounded checks, before preparation and before Restic; stop on first inaccessible included entry | Same traversal limits and exclusions; negotiated diagnostics collect problem observations within the existing budget, then fail |
| Exclusions | Relative v1 matcher before entry lstat/access/traversal; Restic arguments anchored to canonical source | Same semantics; excluded entries never enter diagnostics; UI warns about copied source-root prefixes and offers a local pattern preview |
| Symlinks | Selected source resolves within approved roots; nested links archived without scanning targets | Same policy, no additional symlink traversal |
| Restic output | JSON source record reduced to a failure code, discarding `item`; raw provider text deliberately discarded | Bounded JSON-only classifier preserves a safe relative name and OS category; both stdout and stderr records, fragmented lines and final unterminated lines handled |
| Error wrapping | `SourceAccessError` becomes stage/code only | Private diagnostics survive wrapping; journal/error strings remain generic |
| Signed completion | Strict closed stage/code schema, durable Agent completion receipt | Optional `sourceDiagnostics` only after signed command opt-in; HMAC/nonce/lease/sequence/TLS rules unchanged |
| Server terminal state | Generic error persisted; completion dispatched through existing failure handler | Diagnostics and failure state saved together in existing SQLite `backups.progress_stats.sourceFailure`; no migration or new command type |
| Events API | Durable latest-state projection replaced the saved failure with another generic sentence | Rebuild safe explanatory text from closed saved stage/code metadata; historical provider text is still discarded |
| Operator UI | Error Details showed a string; Events did not recognize remote `TASK_FAILED` as failed | Shared expandable error details, observed relative entries, safe copy, explicit historical limitation; failed remote events render as failed |

The scan uses metadata/readability checks, not file contents. `EACCES` and `EPERM`
are permission categories; `ENOENT` identifies a missing/disappeared entry and does
not prove a permission defect. Restic does not reliably supply entry type, so its
entries display **Not reported**, rather than guessing File from a filename.
Unrecognized provider output remains a generic backup failure. A source error
record cannot make a failed job successful, including a contradictory process
exit of zero.

## Private diagnostic contract

The materialized signed backup payload retains versions 1–4. The Server adds
`sourceDiagnosticsVersion: 1` only for stable Agent versions at least 0.7.1. No new
inventory capability is advertised, because old Servers reject unknown inventory
fields. Agent 0.7.1 accepts old commands and omits the new completion field unless
that exact opt-in was present. Existing 0.7.0 HMAC vectors remain unchanged.

An illustrative failed completion has closed stage/code fields plus:

```json
{
  "sourceDiagnostics": {
    "version": 1,
    "origin": "restic",
    "problemCount": 1,
    "countIsLowerBound": true,
    "entries": [
      {
        "relativePath": "app/logs/id_rsa",
        "entryType": "unknown",
        "errno": "EACCES",
        "excluded": false
      }
    ]
  }
}
```

This example is synthetic. Before the patch the operator saw only
`restic-backup/source-entry-inaccessible`. Afterwards this observation can show
`app/logs/id_rsa`, `Permission denied (EACCES)`, and that Restic did not report the
entry type. Historical jobs cannot acquire paths retrospectively.

The Server validates unknown fields, enum values, integer counts, consistency,
at most 20 entries and at most 512 UTF-16 units per name before command mutation.
Diagnostics on success, cancellation, another command type, another Agent's
command, or an unrelated stage/code are rejected. Existing lease validation still
gates forwarding. The existing Agent transport body limit remains 512 KiB; this
extension is bounded independently by its schema.

Absolute paths, traversal, backslashes, HTML, controls/newlines, malformed
surrogates, direction overrides, excessive combining marks, credential assignments
and PEM markers cannot enter displayed/copied names. Unsupported names are omitted
on the Agent and shown as **path withheld for safety**, without inventing a path.
Names are never truncated into a different filename. Legitimate sensitive
basenames such as `id_rsa` remain identifiable; no file content is sent. Filenames
are untrusted text, not markup or commands.

Counts are observations, not a complete filesystem inventory or distinct-file
count. The Agent marks them as lower bounds: an unreadable directory can hide
children, scans have limits, and Restic may report an entry repeatedly. Sample
retention stops at 20 while the bounded counter continues. `origin` distinguishes
preflight inspection from Restic execution even if the failure stage is already
`restic-backup` during the final root check.

Paths are stored only in the private SQLite progress field and the Agent's existing
protected durable completion receipt. They are excluded from generic error text,
command `last_error`, notifications, telemetry and journal messages. History/list
projections omit progress fields. The existing authenticated session-only backup
progress route returns them with `Cache-Control: private, no-store`; API keys cannot
use that route. This installation has a global administrator session, not per-user
backup ACLs. The change does not invent a finer authorization model.

## Explicit source preflight audit

`SOURCE_ACCESS_VALIDATE` validates canonical selected roots and approval/access
state. It does not recursively check a saved plan's included files or apply its
exclusion policy. Reusing it as a full scan would change its security and cost
contract. This change therefore does **not** add a remote Scan button or change
Source Access Validate into a recursive inspection operation.

The existing explicit local CLI can inspect an approved synthetic source as the
backup service identity, without a snapshot, hooks, dump or approval change:

```sh
sudo -u pluton-agent /opt/pluton-agent/runtime/bin/node \
  /opt/pluton-agent/app/dist/index.js preflight \
  --source /srv/example-app --allowed-roots /srv/example-app --scan \
  --exclude app/logs --exclude .git --exclude cache \
  --exclude public_html/console-app/export/tmp
```

Use the actual saved exclusions; the examples above are alternatives to review,
not advice to exclude every log or credential automatically. CLI scans retain
their established first-error behavior and 10,000-entry/five-second limits. A
partial readable scan is not full coverage. No new scan runs on page open,
inventory heartbeat, polling or Error Details; those actions read saved data.
The two existing v4 backup inspection passes are not new scans introduced by this
patch. Collecting multiple problems uses those same budgets.

A future remote explicit scan needs a separate signed, plan-bound command and
capability, an immutable source/exclusion receipt, no approval mutation, durable
progress/cancellation, an execution timeout, bounded traversal and concurrency,
and explicit partial-result semantics. It must run as the service identity and
must not invoke backup preparation, hooks, dumps, Restic or a directory browser.
That larger command/lifecycle extension is not delivered here.

## Exclusion guidance

`app/logs` and `public_html/console-app/export/tmp` are anchored inside the selected
source. Bare `.git` and `cache` match those names at any depth. The editor rejects
absolute patterns and warns if a relative pattern appears to begin with the whole
source root, for example `srv/example-app/app/logs` for `/srv/example-app`. It never
rewrites exclusions. Preview checks only a typed relative sample using the actual
v1 matcher; it makes no remote filesystem request and is not an accessibility test.

Review individual source entries and parent traverse permissions read-only. Do
not make keys readable simply to make a backup pass. Review whether a deliberate
exclusion or a narrowly approved access change is appropriate outside this tool.
No chmod, ownership, ACL, source file, allowed root or automatic exclusion is
changed by diagnostics.

## Rollout and rollback

1. Review both local feature commits, build immutable artifacts, and retain the
   previously approved artifacts. Update the Server first in an authorized test
   deployment. No environment setting is added.
2. Verify an existing Agent 0.7.0 still receives the original command shape and
   completes a synthetic backup. Its failures display the explicit no-path limit.
3. Upgrade one disposable Agent to the separately built 0.7.1 artifact, refresh
   inventory, and run a synthetic included unreadable file/directory case. Confirm
   a failed terminal state, safe relative paths and no path text in notifications
   or general logs. Check exclusions, disappearing entries, cancellation and an
   ordinary successful backup. Only then separately authorize a wider rollout.
4. For rollback, pause/drain new work and completion deliveries before reverting
   the Server. Restore the previous immutable Agent artifact using the existing
   approved upgrade/rollback procedure, then the Server artifact. An in-flight
   diagnostic completion sent to an old strict Server would be rejected; drain it
   first. Never remove Agent receipts or identities to force a replay.
5. Existing progress JSON is additive and can remain in SQLite; no downgrade SQL
   is necessary. Verify old jobs, authentication, backup status, cancellation,
   a synthetic success and absence of unexpected new work after rollback.

## Validation and revision evidence

Validated on 2026-10-23 using cached disposable Linux images, with no external
network and no production mounts. Server base is `5126fb7`; the MCP commits in
the original working checkout are excluded. Both independent repositories use
the feature branch `codex/source-access-diagnostics`.

| Check | Result |
| --- | --- |
| Full backend Jest run | 195 suites passed; 3,878 tests passed, seven existing skips |
| Focused final schema regression after filename-filter refinement | 23 passed |
| Frontend diagnostics, Source Access, exclusion editor and operational tests | 44 passed |
| Backend lint | Passed |
| Frontend lint | Blocked before file analysis by the unchanged existing configuration: `tseslint.config()` rejects the string `eslint-config-prettier` in `extends` |
| Backend and frontend TypeScript checks | Passed |
| `pnpm build` | Three tasks succeeded, no cached tasks |
| Offline frozen-lockfile validation | Passed; no dependencies or lockfile changed |
| Agent typecheck, Ubuntu 22.04 and 24.04 | Passed on both |
| Agent unit tests, each Ubuntu version | 191 passed, no skips |
| Agent source/contracts, each Ubuntu version | Source baseline passed; nine contract tests passed |
| Agent installer/upgrade checks, each Ubuntu version | Installer shell checks passed; 70 upgrade tests passed |
| `git diff --check`, both repositories | Passed |

The initial Windows runs could not exercise local HTTP fixtures under the sandbox
and lacked OpenSSL for the TLS fixture. Linux runners supplied the required
validation instead. The source-archive runner preserves Git executable modes;
an initial archive without those modes could not invoke the installer fixture.
The first UI fixture needed its browser user-agent property restored, and the
release assertions were explicitly updated to 0.7.1 while keeping the original
0.7.0 protocol vectors. Corrected runs are reported above. Existing frontend SSR
fixtures emit React layout-effect warnings; their assertions pass.

Exact local feature commit IDs are recorded in the final task report.
Reproduce with pinned pnpm 10.20.0, Node 24.22.1 for the Server and Node 22.23.4 for
the standalone Agent. The Linux runners use synthetic local fixtures, mock
processes/control planes, disposable SQLite and no external network. They do not
prove production systemd behavior or constitute deployment approval.

Relevant commands:

```sh
pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-frontend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-frontend exec tsc -b
node --experimental-strip-types --test frontend/__tests__/sourceDiagnostics*.test.ts
pnpm build
git diff --check
```

In the independent Agent checkout:

```sh
pnpm typecheck
pnpm test
pnpm validate:standalone
pnpm test:contracts
pnpm test:installers
git diff --check
```

Source hashing preserves the immutable extraction record and explicitly updates
the independent Agent baseline for each changed runtime/test file. No proprietary
source, production inventory, credentials or runtime state is used.
