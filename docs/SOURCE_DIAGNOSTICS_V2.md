# Source Diagnostics V2 delivery audit

## Scope and baseline

Branch: `codex/source-diagnostics-v2`, based on Source Diagnostics V1 server/UI
commit `4377c7c586df5297a00a789b19a1aea38e29da34`. This is an incremental
frontend/documentation change. It introduces no server, Agent, database, backup
execution, retention, restore, MCP or repository-operation changes.

The existing authenticated saved-progress response already carries bounded
`sourceFailure` metadata. V2 consumes that contract without adding a scan,
permission mutation, command execution endpoint or wire version. The optional
dynamic shell-command builder was deliberately omitted; the existing `/docs`
system supplies static diagnostic examples instead.

No standalone Agent patch is necessary. The V1 Agent 0.7.1 implementation at
`61c17d2f9f8a349cc9fa99f18c27431839fa50b5` remains unchanged. The separate MCP
checkout and original Agent checkout were not modified. Nothing was pushed,
merged, deployed, run over SSH or validated against production data.

## Operator experience

Backup status and Backup Events open the same Error Details component. Supported
source codes show a plain-language problem, safe stage/code, approved-source
reference through the plan ID, reported detection origin and next action. The
plan reference identifies the source context; V2 does not invent or disclose a
new canonical absolute-root field.

The popup shows at most 20 representative relative entries, actual reported
entry types/errno, lower-bound counts and omitted observations. It explains that
observations may repeat and that inaccessible descendants can remain unknown.
Unknown types are labeled **Not reported**. Historical jobs explain why path
diagnostics cannot be recovered. Other errors retain their plain-text message.

Sensitive names, including `app/logs/id_rsa`, produce a warning to review
ownership, purpose and recovery needs without granting key readability. The
help panel links to a static documentation topic. Copy exports only bounded,
sanitized diagnostic metadata; it never turns a path into a command or URL.

Status triggers support Enter/Space, and event triggers are native buttons.
Dialogs use the existing labeled modal, Escape/Close handling, focus trap and
focus restoration. Entry lists and dialog content scroll. Mobile fields stack
and action buttons use the available width.

### Synthetic preview evidence

An isolated headless Edge fixture rendered the actual Error Details component
and existing Modal with their compiled SCSS, synthetic diagnostics, simplified
theme values and an icon stub. It had no production data or API access. Desktop
viewport was 1280 × 1000; the dialog measured 680 × 800. Mobile viewport was
390 × 844; the dialog measured 358 pixels wide with 16-pixel side margins and
document width 390, confirming no horizontal page overflow. Top and scrolled
action views were inspected at both sizes. Mobile showed the warning, guide
link, full-width copy and Close controls within the dialog.

These are component/layout previews, not an authenticated live deployment or
an end-to-end claim about production backups. Fixture screenshots remain local
under ignored `tmp/`; they are not shipped as public product assets.

## Documentation routes and discoverability

The existing article `/docs/troubleshooting/source` is expanded in place. All
97 registered articles and 15 manifest categories remain. A **Backup & Recovery**
shortcut group in the existing Fumadocs sidebar and homepage links to Source
Access, Permission Troubleshooting, Backup Exclusions, ACL Reference, Source
Diagnostics and Recovery Verification. Search uses the existing local index.
Related Source Access, Managed Agent and troubleshooting articles link here;
the Backup Exclusions editor also links to the relevant section.

| Section | Fragment under `/docs/troubleshooting/source` |
| --- | --- |
| 1. Understand the error | `#1-understand-the-error` |
| 2. Verify the Agent | `#2-verify-the-agent` |
| 3. Identify the approved backup root | `#3-identify-the-approved-backup-root` |
| 4. Find inaccessible entries | `#4-find-inaccessible-entries` |
| 5. Inspect an individual file | `#5-inspect-an-individual-file` |
| 6. Inspect ACLs | `#6-inspect-acls` |
| 7. Safely grant read-only access | `#7-safely-grant-read-only-access` |
| 8. When exclusions are better | `#8-when-exclusions-are-better` |
| 9. Configure Backup Exclusions | `#9-configure-backup-exclusions` |
| 10. Verify exclusions safely | `#10-verify-exclusions-safely` |
| 11. Controlled retry and recovery verification | `#11-controlled-retry-and-recovery-verification` |
| 12. Troubleshooting reference | `#12-troubleshooting-reference` |
| 13. Security and operational guidance | `#13-security-and-operational-guidance` |
| 14. FAQ and anonymized incidents | `#14-faq-and-anonymized-incidents` |

Older article fragments remain as subheadings: `#gejala`, `#penyebab`,
`#diagnostik-aman`, `#resolusi`, `#excluded-versus-included`, `#jangan-lakukan`
and `#source-tidak-terbaca-atau-symlink-ditolak`.

The article covers host approval versus Linux access, service/journal checks,
canonical roots, read-only `find`/metadata/ACL checks, narrowly reviewed ACLs and
rollback, actual exclusion matching, controlled retry and isolated recovery.
It distinguishes filesystem and database-dump stages and preserves SYS MON
shadow-backup guidance. Incident examples use synthetic identities/roots and
explicitly distinguish operator-reported outcomes from this task's validation.

Static code-to-topic mapping lives in `troubleshootingTopics.ts`. Known source
codes open section 1; typed database TLS and Agent availability codes open
existing relevant guides. Unknown/malformed codes open the troubleshooting
overview. No English error-description matching selects a topic. Historical
source recognition uses only the existing terminal `(stage/code)` marker.

Links use native same-origin anchors so navigation crosses from the main React
18 application into the existing isolated React 19 docs document. The established
`/docs/*` fallback and loader support direct refresh; the existing location
effect scrolls to the compiled heading. No authentication redirect or dynamic
diagnostic query parameter was introduced.

## Security and operational boundaries

- Saved-progress reads retain the V1 session-authenticated, no-store API. API
  keys do not gain this permission. The current product is an administrator UI;
  this change does not introduce per-source user roles or a new authorization
  model. Timeline paths arrive through the existing authenticated progress read.
- Reopening a remote backup rechecks saved progress. Cached paths are hidden
  while fetching and after denied/failed reads; copy is disabled in those states.
  No new browser or server storage persists diagnostics.
- Rendering uses React text nodes, never Agent-provided HTML. Clipboard content
  drops arbitrary error text, unrecognized fields, control/bidi characters,
  unsafe/traversal paths and shell-like filename delimiters, with a 20-entry cap.
  Filenames are still operational metadata and require review before sharing.
- Documentation is static/public; examples contain synthetic infrastructure
  only. No diagnostic record is embedded in public docs or their search index.
- New guide fences explicitly mark `readonly` or `review`. Only static read-only
  examples receive command-copy controls. Package/ACL mutations show a manual
  review label without a copy button. Highlighting cannot silently lose the
  policy: the final compiler pass binds it to rendered blocks and fails the
  build if the block structure cannot be matched. Existing articles retain
  their existing code-copy behavior.
- Examples do not print key contents, grant broad permissions, install software
  automatically or execute commands in the browser. ACL examples require owner
  approval and review of original ACL/mask, parents and pre-existing entries.
  No recursive/default ACL change is prescribed.
- `find` examples do not follow symlinks and stay on one filesystem. Documentation
  explicitly says output bounds do not bound scan runtime or prove completeness;
  manual root-only pruning is not the Agent's recursive bare-name matcher.
- Source scope, mandatory private-directory guards, job receipts, included-file
  failure semantics, database dumps, retention and read-only legacy repository
  boundaries are unchanged.

## Validation

Checks ran in a disposable, network-disabled container using Node.js 24.22.1,
the pinned pnpm 10.20.0 and the existing frozen lockfile/dependencies. A source
archive preserved Git executable modes. No dependency or lockfile changed.

| Check | Command / result |
| --- | --- |
| Frozen dependency resolution | `pnpm install --offline --frozen-lockfile --ignore-scripts`: passed |
| Full frontend suite | `node --experimental-strip-types --test frontend/__tests__/*.test.ts`: 286 passed, 0 skipped |
| Real Fumadocs compiler/security suite | `pnpm test:fumadocs`: 9 passed |
| Frontend types | `pnpm --filter @plutonhq/core-frontend exec tsc -b`: passed |
| Documentation types | `pnpm --filter @plutonhq/documentation typecheck`: passed |
| Production build | `pnpm build`: all 3 tasks passed; app/docs/backend built |
| Backend regression | Jest `--runInBand --runTestsByPath` for the eight suites below: 213 tests passed |
| Backend lint | `pnpm --filter @plutonhq/core-backend lint`: passed |
| Frontend lint | `pnpm --filter @plutonhq/core-frontend lint`: inherited configuration failure before file analysis; see below |
| Diff hygiene | `git diff --check`: passed |
| Static shell examples | All 13 shell fences passed `/bin/sh -n` syntax-only validation; none executed |
| Layout | Synthetic desktop/mobile headless Edge preview described above |

Backend suites: `routes/backups.test.ts`, `services/AgentService.test.ts`,
`services/RemoteBackupService.test.ts`, `services/BackupEventService.test.ts`,
`stores/RemoteProgress.test.ts`, `utils/sourceDiagnostics.test.ts`,
`utils/backupExclusions.test.ts` and `utils/operationalHardening.test.ts` under
`backend/__tests__/`. They exercise persisted diagnostics, negotiated capability,
session/API-key permission boundaries, bounded payloads and exclusions without
production infrastructure.

New tests cover structured and historical popups, one/multiple/bounded entries,
sensitive names, unsafe paths/control characters, sanitized clipboard, denied
reads with seeded cache, focus/keyboard behavior, static topic fallbacks, all
article links/fragments, search, exclusion semantics and least-privilege examples.
The real compiled guide is checked for the exact read-only-copy/manual-review
counts. A deliberately mismatched rendered tree confirms copy-policy binding
fails closed. Existing Markdown escaping, URL restrictions, official Fumadocs
rendering and React isolation checks remain enabled.

**Inherited lint limitation:** unchanged `frontend/eslint.config.js` passes the
string `eslint-config-prettier` through a `tseslint.config()` extends array.
ESLint 10/typescript-eslint rejects that configuration before linting files
(exit 2). V2 does not change that configuration or claim frontend lint passed.

No production host commands, backup, ACL/package mutations or live recovery test
were run. The guide describes operator actions; incident outcomes are not task
test results. Agent tests were not rerun for V2 because no Agent source changed.

## Changed file groups

- Popup and triggers: `frontend/src/components/Plan/BackupEvents/BackupErrorDetails.tsx`,
  its SCSS module, `BackupEvents.tsx`, its SCSS module, and
  `frontend/src/components/Plan/Backups/Backups.tsx`.
- Exclusions help: `frontend/src/components/Plan/PlanSettings/PlanBackupExclusions.tsx`.
- Safe presentation/topics: `frontend/src/utils/sourceDiagnostics.ts` and
  `frontend/src/docs/troubleshootingTopics.ts`.
- Articles/manifest: `frontend/src/docs/articles/troubleshooting/source.md`,
  `troubleshooting.md`, `remote-agent/permissions.md`,
  `backup-plans/managed-agent.md`, and `frontend/src/docs/manifest.ts`.
- Existing docs system: `documentation/plugins/content.ts`, `source.config.ts`,
  `src/mdx.tsx`, `src/source.ts`, and `src/App.tsx`.
- Tests: `frontend/__tests__/sourceDiagnosticsUi.test.ts`,
  `sourceTroubleshooting.test.ts`, `sourceTroubleshootingUi.test.ts`, and
  `documentation/tests/documentation.test.ts`.
- Audit: this report and the architecture link.

## Compatibility and rollback

Agent 0.7.0 remains compatible and produces the historical/code-only experience.
Agent 0.7.1 supplies path details only when the existing Server negotiates the
diagnostics extension. Both retain exclusions v1 behavior. No unnegotiated field,
mandatory new capability, protocol bump, schema migration or Agent restart is
introduced by this patch. A newer UI cannot reconstruct historical unreported
paths, and V2 does not relabel missing/unknown errno or type as permission facts.

To roll back, revert the dedicated V2 commit through the normal review process
or restore the prior immutable server/UI artifact built from V1 `4377c7c`.
Deploy the matching frontend and docs bundles together to avoid stale links.
No database rollback, repository mutation, permission rollback or Agent change
is required for V2 itself. Operator-performed ACL/exclusion changes are separate
changes and must follow their own recorded approvals and rollback procedure.
