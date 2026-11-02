# Application-encrypted export validation

Branch: `codex/application-encrypted-hcp-export`. Base: freshly fetched
`origin/main`, `7536fcce164f07991d46a29439857b609e4413c8`.

See the [format, key lifecycle and operator runbook](APPLICATION_ENCRYPTED_HCP.md).
All datasets, credentials, namespaces and endpoints used locally are synthetic.
No production HCP/storage access, deployment, push, merge, Agent upgrade or
production-secret change is part of this task.

## Acceptance matrix

| Area                                                                              | Status                  | Evidence / remaining gate                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chunked AES-256-GCM; wrapped per-export material; authenticated manifest          | PASS                    | Roundtrip, wrong key/tag, manifest/context/envelope tampering, reorder/omission/truncation and arbitrary ranges are covered by automated tests                                                                                      |
| HCP without SSE evidence                                                          | PASS locally            | Explicit application mode passes encrypted readback and provider gates with SSE headers removed; auto/legacy modes retain their AES256 requirement                                                                                  |
| Historical unknown ownership                                                      | PASS locally            | A matching-key/marker legacy probe without durable proof is refused by inventory/cleanup; no DELETE/adoption                                                                                                                        |
| Cancellation, upload/complete failure, unknown uploads, cleanup retry and restart | PASS locally            | Existing and new HCP/service/native fixtures; key/manifest recovery errors preserve ready ciphertext and journal                                                                                                                    |
| Native 120 MB encrypted fixture                                                   | PASS                    | Exact TAR/hash/content, multiple interruption offsets, authenticated resume, Standard Download, hard restart, Full/Regular Files Only, privacy and ownership gates; five replicas unchanged; zero orphan objects/parts and zero OOM |
| Native 1.23 GB, 3.17 GB large-entry and 4 GB fixtures                             | PASS locally            | Exact TAR/hash/content, resume, source/replica invariance and cleanup; measured below                                                                                                                                               |
| Streaming 20/80 GiB encryption/decryption stress                                  | PASS locally            | Complete streaming encrypt/decrypt/SHA with no archive file, bounded RAM and zero OOM; separate from native HCP certification                                                                                                       |
| Complete backend/frontend, lint, types and production build                       | PASS with lint baseline | Linux 214 backend suites / 4,351 passed / seven inherited skips; frontend 366 passed; types, backend lint and production build passed; follow-up details below                                                                      |
| Private keyring deployment/provisioning policy                                    | PASS on Linux           | Seven key policy tests, rotation retention, no-overwrite, actual UID 10001 read-only mount smoke; POSIX tooling                                                                                                                     |
| Hosted GitHub Actions                                                             | BLOCKED                 | Branch is local/unpublished; operator must publish and verify CI                                                                                                                                                                    |
| Production HCP compatibility / existing historical cleanup                        | NOT TESTED              | Operator read-only reconciliation and administrator attribution must precede real destination preflight                                                                                                                             |
| Independent cryptographic/security review                                         | BLOCKED                 | Required human review before controlled production enablement; local tests are not an external audit                                                                                                                                |
| Rollback serving live exports with a pre-format image                             | BLOCKED                 | Old binaries cannot decode a new format; retain a v1-capable image/keys/journal, or drain first                                                                                                                                     |

## Reproducers

Use Node.js 24 and the locked pnpm 10.20.0 workspace. Linux native runs use
2 vCPU, 4 GiB RAM with no swap, a read-only root filesystem, bounded writable
scratch, dropped capabilities, no-new-privileges and an internal disposable Docker
network without published ports. The local gateway models write-once collisions
and strips SSE evidence only for the export prefix; it is not HCP.

```sh
pnpm install --frozen-lockfile
pnpm --filter @plutonhq/core-backend test --runInBand
pnpm --filter @plutonhq/core-backend lint
pnpm --filter @plutonhq/core-backend exec tsc --noEmit -p tsconfig.json
pnpm --filter @plutonhq/core-frontend exec tsc -b
node --experimental-strip-types --test frontend/__tests__/*.test.ts
node --test scripts/__tests__/managedExportCompose.test.cjs scripts/__tests__/deployment.test.cjs
python3 scripts/__tests__/managed_export_keys_test.py
python3 scripts/__tests__/managed_export_ca_test.py
python3 scripts/__tests__/deployment_policy_test.py
python3 scripts/__tests__/deployment_fixture_test.py
pnpm build
git diff --check
```

Native synthetic TAR/download/Restic/SFTP/replication lab, from PowerShell:

```powershell
./scripts/validate-managed-resumable.ps1 -Modes small -SharedNamespace -WriteOnceReference -ApplicationEncrypted
./scripts/validate-managed-resumable.ps1 -Modes @('large','combined','four') -SharedNamespace -WriteOnceReference -ApplicationEncrypted
```

The existing local fixture image must be prepared using
`scripts/fixtures/managed-resumable/Dockerfile`; no production image/data is used.
The combined mode includes 100,000+ entries. Each dataset gets a fresh private
keyring, S3 storage and backup fixtures. The runner deletes only its own validated
random resource names. The hold/fault hook identifies encrypted archives by their
explicit purpose marker rather than requiring plaintext SHA metadata in S3.

Large-file crypto/backpressure stress runs
`backend/__tests__/integration/exportEncryptionStress.lab.ts 20` and `80` using
tsx in a disposable Linux container with the same 2 CPU / 4 GiB / no-swap bounds.
It streams generated bytes through encrypt/decrypt and full SHA validation,
records memory/CPU/throughput and writes no archive to disk. This is separate from
native multipart/TAR extraction tests and from actual HCP validation.

## Resource measurements and final checks

Measurements below are local observations, not production throughput promises.
Native application containers had 2 CPU / 4 GiB limits and zero swap. MinIO ran
separately with 1 CPU / 1 GiB. CI/crypto runners used Node 24.22.1; native image
and Windows focused checks used Node 24.16.0. All used pnpm 10.20.0 and the
unchanged lockfile. Some workloads overlapped on the local Docker host.

| Synthetic source    | Entries | Original TAR bytes | Export/preparation ms | Download MiB/s | Server Node peak RSS bytes | Cgroup peak bytes | Private metadata disk bytes |
| ------------------- | ------- | ------------------ | --------------------- | -------------- | -------------------------- | ----------------- | --------------------------- |
| 120,000,000 bytes   | 4       | 120,005,632        | 19,047                | 13.52          | 397,139,968                | 1,233,723,392     | 135,680                     |
| 1,230,000,000 bytes | 7       | 1,230,007,296      | 175,785               | 57.85          | 448,450,560                | 4,295,102,464     | 119,296                     |
| 3,170,000,000 bytes | 115,566 | 3,406,661,632      | 987,450               | 46.95          | 609,763,328                | 4,296,323,072     | 329,007,616                 |
| 4,000,000,000 bytes | 17      | 4,000,012,288      | 230,404               | 151.01         | 457,695,232                | 4,295,479,296     | 127,488                     |

TAR/header overhead explains the combined dataset's larger archive. All four
native datasets passed TAR structure/extracted content/SHA verification and
interrupted/resumed transfer. All reported zero OOM events/kills, zero temporary
server TAR bytes, zero orphan objects/parts and unchanged synthetic replicas
with native Restic read-data checks. The 120 MB fixture additionally exercised
Full/Regular Files Only, hard restarts during upload/verify, expiry, cancellation,
provider fault/retry, slow clients, independent native backup/replication and five
unchanged historical replicas. Every invocation removed its own volumes/network.

Native cgroup peaks reached approximately the 4 GiB ceiling; these include file
cache/kernel accounting and small observed peak overruns, not just Node heap.
The 4 GB end sample recorded 455,147,520 bytes anonymous memory and
3,722,170,368 bytes file cache. Anonymous/file breakdown was not sampled in the
earlier 1.23/3.17 GB runs. No claim of ample VM headroom follows from zero OOM.
The 115,566-entry run also needed about 314 MiB private metadata disk. Operators
must monitor filesystem/cache, CPU, free storage and cleanup before increasing
production workload. Download throughput varies with local cache and is not a
network/WAN prediction.

The initial native key fixture placed its key file in the TLS lab volume. Final
review separated it into an application-only read-only volume that is never
mounted on MinIO, added a regression for this boundary, and repeated the complete
120 MB native lifecycle on that final topology. Larger data-volume results above
exercise the same encryption/TAR format before this fixture-only mount change;
they are not evidence of key isolation on the earlier lab topology. Production
Compose independently mounts only one private read-only keyring file. An actual
UID 10001 smoke test loaded a random key and verified write denial with no network
and a read-only root filesystem; its disposable private volume was removed.

| Crypto/backpressure stream | Frames | Ciphertext bytes | Elapsed ms | Throughput MiB/s | CPU user/system microseconds | Peak RSS bytes |
| -------------------------- | ------ | ---------------- | ---------- | ---------------- | ---------------------------- | -------------- |
| 20 GiB                     | 5,120  | 21,474,918,400   | 312,423    | 65.55            | 234,108,655 / 138,315,381    | 272,969,728    |
| 80 GiB                     | 20,480 | 85,899,673,600   | 945,237    | 86.67            | 712,245,239 / 403,536,799    | 270,700,544    |

Both stress streams verified complete plaintext size/SHA, wrote no TAR or
ciphertext archive file and recorded zero OOM kills. The repeated source block
is synthetic incompressible data, not a real backup. This validates streaming
framing/backpressure at these sizes; native S3 multipart/TAR extraction acceptance
was run through 4 GB, not 80 GB. The benchmark deadline is workload-derived at a
minimum 32 MiB/s plus one minute; no production deadline was changed. The recorded
runs also completed within the earlier 20-minute per-run benchmark bound.

### Regression evidence and limitations

- Linux full serial backend run: 214 suites, 4,351 passed, seven inherited skips,
  286.928 seconds, natural exit 0. No forceExit or new test skipping.
- Windows focused encryption/HCP/service suite: 98 passed after the explicit
  key-change recovery guard. Original ciphertext remains Ready during missing-key
  or invalid-manifest recovery; no cleanup is authorized by those local errors.
- Linux frontend: 366 passed, zero skipped; 79.534 seconds.
- Linux deployment/API/Compose Node checks: 19 passed in the initial final build;
  the final native key-volume regression adds one more Compose test.
- Linux host policy checks: seven keyring + six CA + 29 deployment + three
  historical bundle tests passed. Runtime comparison checks thirteen export
  environment fields privately. The new keyring policy test is included in the
  Container Image validation workflow.
- Backend lint, backend/frontend type checks and all three production workspace
  build tasks passed (164.512 seconds). No dependency or Agent upgrade.
- Frontend lint retains its pre-existing exit-2 configuration failure:
  `tseslint.config()` rejects the string `eslint-config-prettier` in `extends`.
  It was run and reported; no suppression or unrelated configuration edit added.

An early full run overlapped the native/stress workload and failed an existing
five-second remote path-validation test. An attempted isolated run with only
512 MiB scratch then correctly hit existing 512 MiB restore free-space guards;
with 1 GiB scratch all 123 recovery tests passed. The full 214-suite run above
then passed. A later follow-up run encountered the existing five-second global
Pino-close hook deadline in PlanService while the native fixtures were still
finishing; that run is not counted as PASS. Final no-competing-fixture verification
is recorded below. No production logger, restore guard, assertion or test timeout
was changed to obtain these results.

Final security review also corrected inheritance of the dedicated key error so
key-change/missing-slot errors retain their recovery classification, and added an
assertion that a keyring change between configuration capture and new encryption
is refused. Restarts with retained old slots can still decrypt old live exports.

Final verification (2026-11-02), with all native/stress containers stopped:
the complete serial backend passed **214/214 suites, 4,351 tests passed and seven
inherited skips in 231.148 seconds**, natural exit 0. This was followed by seven
keyring policy tests and four Compose/security regressions passing, plus backend
type check, lint and production recompilation passing. No hook deadline was
increased. The earlier 286.928-second full pass and final pass are both retained
as evidence; intervening failed runner attempts above are not hidden. All
disposable test containers, native volumes and internal networks were removed.
Tracked/untracked source review found no introduced credentials or production
identifiers; the only key-header pattern was an unchanged synthetic negative CA
fixture already present on main. Generated local logs/key material were excluded
from Git. The working tree is committed locally; hosted CI remains pending
operator publication.

Hosted CI, actual HCP and real client-network UAT remain untested operator gates.
No production GO or hosted CI PASS follows from this report.

## Changed files

Production encryption, storage and delivery:

- `backend/src/utils/managedExport/ExportEncryption.ts`
- `backend/src/utils/managedExport/ExportKeyring.ts`
- `backend/src/utils/managedExport/ExportPolicy.ts`
- `backend/src/utils/managedExport/ExportDiagnostics.ts`
- `backend/src/utils/managedExport/HcpWriteOnceStorage.ts`
- `backend/src/utils/managedExport/S3ExportStorage.ts`
- `backend/src/services/ManagedExportService.ts`
- `backend/src/stores/ManagedExportStore.ts`
- `frontend/src/utils/reliableDownload.ts`
- `frontend/src/components/Plan/Backups/ReliableDownload.tsx`

Deployment and configuration:

- `.env.template`
- `.gitignore`
- `.github/workflows/container.yml`
- `deploy/.env.example`
- `deploy/compose.yml`
- `deploy/compose.managed-export-keys.yml`
- `deploy/compose-tools.py`
- `deploy/managed-export-keys.py`
- `deploy/bundle-tools.py`
- `deploy/install.sh`

Regression tests and disposable fixtures:

- `backend/__tests__/utils/ExportEncryption.test.ts`
- `backend/__tests__/services/HcpWriteOnceStorage.test.ts`
- `backend/__tests__/services/ManagedExportService.test.ts`
- `backend/__tests__/integration/exportEncryptionStress.lab.ts`
- `backend/__tests__/integration/managedResumableRecovery.lab.ts`
- `backend/__tests__/integration/managedResumableRecovery.process.ts`
- `backend/__tests__/integration/writeOnceReferenceGateway.ts`
- `frontend/__tests__/reliableDownload.test.ts`
- `scripts/__tests__/managedExportCompose.test.cjs`
- `scripts/__tests__/managed_export_ca_test.py`
- `scripts/__tests__/managed_export_keys_test.py`
- `scripts/validate-managed-resumable.ps1`

Operator documentation:

- `docs/APPLICATION_ENCRYPTED_HCP.md`
- `docs/APPLICATION_ENCRYPTED_HCP_VALIDATION.md`
- `docs/ARCHITECTURE.md`
- `docs/MANAGED_RELIABLE_DOWNLOAD_UAT.md`
