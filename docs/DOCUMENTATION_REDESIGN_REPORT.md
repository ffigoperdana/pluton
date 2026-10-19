# Laporan redesign dokumentasi Pluton

Tanggal: 19 Oktober 2026, Asia/Jakarta. Scope: dokumentasi saja.

Branch: `codex/documentation-user-journey`. Base dan HEAD tetap `e2575cc734ec002518e919c7e71567832fc4ded7`. Tidak ada staging, commit, push, merge, publikasi, deploy, akses production, atau aplikasi yang dijalankan terhadap data.

## Sumber dokumentasi dan arsitektur

Artikel yang ditampilkan di /docs berasal dari `frontend/src/docs/articles/`. Judul, kategori, urutan, dan tingkat dukungan berada pada `frontend/src/docs/manifest.ts`. Proyek Fumadocs terpisah di `documentation/` mengompilasi artikel tersebut menjadi bundle statis. Build aplikasi existing menyalinnya ke frontend/dist/docs; renderer, React, dan stylesheet aplikasi utama tetap terpisah.

Markdown engineering di docs/ bukan sumber otomatis artikel portal. Laporan historis dan historical acceptance failures tetap dipertahankan. docs/ARCHITECTURE.md hanya diperbarui pada jumlah artikel dan penjelasan build dokumentasi.

## Navigasi sebelum dan sesudah

Total berubah dari 77 menjadi 96 artikel, tetap dalam 15 kategori. Seluruh 77 pathname artikel lama dipertahankan. Ada 19 artikel baru; tidak ada artikel dipindah atau dihapus.

Baris berikut membandingkan urutan, bukan pemetaan topik satu-satu. Arsitektur bergabung ke onboarding; deployment bergabung ke operasi; keamanan dan troubleshooting digabung. Database Restore Management, Replication, dan Migrasi mendapat kategori tersendiri.

| Urutan sebelumnya | Urutan baru, jumlah artikel |
| --- | --- |
| 1. Mulai menggunakan | 1. Memulai dengan Pluton — 8 |
| 2. Instalasi dan deployment | 2. Storage dan Repository — 6 |
| 3. Arsitektur dan workflow | 3. Remote Machine dan Agent — 5 |
| 4. Storage dan repository | 4. Membuat dan Mengelola Backup Plan — 7 |
| 5. Backup Plan dan statistik | 5. Database Backup dan Hooks — 6 |
| 6. Remote Machine dan Agent | 6. Browse, Download, dan File Restore — 4 |
| 7. Database Lifecycle dan Hooks | 7. Recovery Testing — 4 |
| 8. Browse, Download, dan Restore | 8. Database Restore Management — 7 |
| 9. Automated Recovery Testing | 9. Backup Replication dan HCP — 5 |
| 10. Legacy Repository Adapter | 10. Membaca Legacy Repository — 3 |
| 11. Webhook dan Email | 11. Webhook dan Email — 5 |
| 12. Keamanan | 12. Instalasi, Upgrade, dan Pemeliharaan — 10 |
| 13. Operasi dan pemeliharaan | 13. Migrasi SYS MON ke Pluton — 5 |
| 14. Troubleshooting | 14. Keamanan dan Troubleshooting — 11 |
| 15. Referensi | 15. Referensi dan Batas Dukungan — 10 |

Beranda /docs menyediakan Mulai di sini dan empat jalur: backup pertama, file Restore, Recovery Testing, serta Persistent Restore. Sidebar, landing kategori, breadcrumbs, Previous/Next, dan pencarian memakai manifest yang sama. Tidak ada perubahan navigasi aplikasi utama atau stylesheet global.

## Workflow yang dicakup

| Tugas operator | Isi dan bukti source utama |
| --- | --- |
| Backup pertama | Storage → Source/Agent → Plan → Backup Now → Backups/Complete → Browse/Restore. UI PlanFormNav, PlanSourceSettings dan PlanService |
| Storage | Local/SFTP/S3, mapping path, endpoint API vs console, bucket/namespace/prefix, region/addressing, TLS/private CA, secret dan kapasitas. providers serta storageSecurity |
| Managed Agent | Enrollment, Online, allowed roots, izin source, SFTP primary, update dan identitas. install-agent.sh, identity, filesystemPolicy |
| Backup Plan | Standard dan Managed, jadwal/Retention, Pause/Resume, progress/history, edit dan Remove. PlanService/Store, source-removal isolation dan retained DB guards |
| Database Backup & Hooks | MariaDB, Oracle MySQL, PostgreSQL, akun/TLS, multiple DB, dump berurutan, hooks dan SQL artifact pada snapshot. backupLifecycle dan lifecyclePolicy |
| File Restore | Browse/Download, selection, preview, staging, verifikasi manual, serta perbedaan penghapusan history dan file. RemoteRepositoryRecoveryService serta RestoreService |
| Recovery Testing | Artifact-only vs native import, seluruh recorded DB, admission, hasil dan cleanup. RecoveryTestService, recoveryValidation, recoveryDatabaseImport |
| Database Restore Management | Pilih satu recorded DB; Internal/Custom; Inspect metadata; explicit Stop/Resume; TTL tetap; owned Delete; cleanup dan resource. Wizard, DatabaseRestores, DatabaseRestoreService/Store dan host lifecycle contract |
| Replication | Standard vs Managed, 0–2 managed S3 destinations, copy serialized, hasil independen, retry dan uncertain refusal. ManagedReplicationService/Store/Executor serta MirrorDetails |
| Legacy | Registrasi lokal read-only, no-lock, browse/download dan staging. LegacyRepositoryService/Inspector |
| Notifikasi | Webhooks & Email, SMTP/Webhook, subscriptions, test, delivery history/retry, at-least-once. NotificationSettings, delivery manager dan policy |
| Operasi dan migrasi | Configuration backup, identitas image/digest, upgrade, kompatibilitas migration, drain-first rollback, SHADOW/VALIDATION/CUTOVER. deploy scripts, SelfBackupService, CLI self-restore dan kontrak recovery |
| Troubleshooting | Agent/source, privilege SQL, TLS, proxy 404/405 HTML-vs-JSON, retained dependency 409, S3/quota/network, admission dan cleanup |

Artikel menggunakan Bahasa Indonesia, label UI aktual, contoh fiktif, prasyarat, langkah, hasil yang diharapkan, cara verifikasi, error, peringatan dan cross-link. Materi developer ditempatkan setelah alur pengguna atau dalam referensi. Diagram memakai teks karena renderer saat ini tidak menyediakan Mermaid.

## Integrasi dan perubahan pemeriksaan

Perubahan rendering terbatas pada isi landing dokumentasi. Inventory compiler mengikuti jumlah artikel manifest; literal 77 yang lama tidak lagi menghalangi artikel baru.

Pemeriksaan cakupan diperluas: jumlah 96 tetap diperiksa secara eksplisit; semua 77 rute lama diuji; kategori dan search topic baru diperiksa; kompilasi/rendering aktual menguji beberapa rute baru. Assertions keamanan Markdown/URL, privacy, clipboard, TOC, dan isolasi React tetap dipertahankan. Tidak ada perubahan tests backend, CI, dependency atau lockfile.

## Hasil validasi aktual

Seluruh pemeriksaan memakai dependency yang sudah terpasang. Tidak ada instalasi package baru.

| Pemeriksaan | Hasil |
| --- | --- |
| `node --experimental-strip-types --test frontend/__tests__/docs.test.ts frontend/__tests__/productIdentity.test.ts` | PASS: 13 tes. Inventory, rute lama, link/anchor saat ini, pencarian, privacy, isolasi dokumen, dan identitas produk |
| `node --experimental-strip-types --test tests/documentation.test.ts` di documentation/ | PASS: 8 tes. Compiler aktual seluruh 96 judul/rute/TOC, layout resmi, local search, Markdown security dan clipboard |
| `node node_modules/typescript/bin/tsc --noEmit` di documentation/ | PASS |
| `node node_modules/vite/bin/vite.js build` di documentation/ | PASS |
| Audit inventory, judul, dan search artifact | PASS: 96 file sesuai manifest, judul unik, tanpa orphan/missing page; seluruh 96 rute ditemukan pada search-index.json hasil build |
| Privacy dan scope | PASS: contoh fiktif; scan marker privat/secret clear; hanya file dokumentasi yang berubah |
| `git diff --check` | PASS setelah merapikan baris kosong berlebih pada akhir file dokumentasi |
| Frontend ESLint pada manifest | FAIL pada baseline konfigurasi existing, sebelum source diperiksa: tseslint.config() menolak string extends eslint-config-prettier. frontend/eslint.config.js tidak berubah; tidak ada rule/config dinonaktifkan |
| Browser visual mobile/light-dark dan screenshot baru | NOT TESTED; tidak diklaim sebagai human/visual acceptance |
| Full frontend app build, backend/DB regression, Docker/VM, vendor, production | TIDAK DIJALANKAN; validasi dibatasi pada proyek dokumentasi dan loader/renderer-nya |

Build Vite sukses dengan peringatan chunk entry sekitar 734 kB, di atas ambang 500 kB. Ambang tidak dinaikkan. Tidak ada framework, service pencarian eksternal, dependency atau shared CSS baru.

Semua tautan internal dan anchor dokumentasi saat ini resolve. Seluruh pathname artikel lama dipertahankan; bookmark eksternal ke heading yang judulnya berubah belum dijamin seluruhnya. Redirect lintas dokumen, backend fallback, autentikasi, dan service-worker boundary aplikasi tetap tidak berubah.

## Batasan dan hal yang tidak diklaim

- Direct file Restore dari managed S3 mirror dan native Database Recovery Testing/Persistent Restore dari mirror belum tersedia. Akses primer tetap diperlukan.
- Physical cleanup/prune managed replica belum tersedia. Dokumentasi membedakan detach/retain dari penghapusan data.
- HCP nyata belum diuji. Detail endpoint, region/addressing, private CA, izin dan retensi vendor membutuhkan informasi teknis serta pengujian terpisah yang disetujui.
- Kapasitas production, termasuk host 4 GiB, tidak diukur. Deployment fitur dan kemampuan menjalankan recovery nyata adalah dua penilaian berbeda. Threshold 2.944 MiB, SQL 128 MiB, resource guard, TLS, ownership dan replay protection tidak diubah.
- Tidak ada automatic production SQL replacement, failover aplikasi, atau completed cutover yang diklaim.
- Pengiriman SMTP/Webhook nyata serta recovery semantik aplikasi tetap memerlukan acceptance lingkungan masing-masing.
- Laporan ini tidak menutup gate Phase 6, mengubah historical failure, atau memberikan production GO.

### TODO screenshot opsional

Jika tersedia lingkungan sintetis yang diizinkan, ambil screenshot nyata tersanitasi untuk: home/sidebar desktop-mobile light-dark; form backup pertama; Browse/Restore preview; Resource/Inspect/Stop/Resume/Delete database; detail replica gagal; dan test/history notifikasi. Tidak ada screenshot rekaan, screenshot production, atau gambar dari evidence privat lama yang ditambahkan.

## Daftar file yang tepat

Dimodifikasi: 83. Dibuat: 20 (19 artikel baru dan laporan ini). Total:103. Dipindah: 0. Dihapus: 0.

### Dimodifikasi

- `docs/ARCHITECTURE.md`
- `documentation/plugins/content.ts`
- `documentation/src/App.tsx`
- `documentation/tests/documentation.test.ts`
- `frontend/__tests__/docs.test.ts`
- `frontend/src/docs/articles/architecture.md`
- `frontend/src/docs/articles/architecture/states.md`
- `frontend/src/docs/articles/architecture/workflow.md`
- `frontend/src/docs/articles/backup-plans.md`
- `frontend/src/docs/articles/backup-plans/advanced.md`
- `frontend/src/docs/articles/backup-plans/history.md`
- `frontend/src/docs/articles/backup-plans/incremental.md`
- `frontend/src/docs/articles/backup-plans/schedule-retention.md`
- `frontend/src/docs/articles/changelog.md`
- `frontend/src/docs/articles/database-backup.md`
- `frontend/src/docs/articles/database-backup/artifacts.md`
- `frontend/src/docs/articles/database-backup/connections.md`
- `frontend/src/docs/articles/database-backup/dump-options.md`
- `frontend/src/docs/articles/database-backup/engines.md`
- `frontend/src/docs/articles/database-backup/hooks.md`
- `frontend/src/docs/articles/deployment.md`
- `frontend/src/docs/articles/deployment/configuration.md`
- `frontend/src/docs/articles/deployment/docker.md`
- `frontend/src/docs/articles/deployment/persistence.md`
- `frontend/src/docs/articles/deployment/rollback.md`
- `frontend/src/docs/articles/deployment/updates.md`
- `frontend/src/docs/articles/deployment/vm-logs.md`
- `frontend/src/docs/articles/getting-started.md`
- `frontend/src/docs/articles/getting-started/dashboard.md`
- `frontend/src/docs/articles/getting-started/quick-start.md`
- `frontend/src/docs/articles/getting-started/requirements.md`
- `frontend/src/docs/articles/getting-started/terms.md`
- `frontend/src/docs/articles/legacy-repositories.md`
- `frontend/src/docs/articles/legacy-repositories/migration.md`
- `frontend/src/docs/articles/legacy-repositories/registration.md`
- `frontend/src/docs/articles/legacy-repositories/restore.md`
- `frontend/src/docs/articles/notifications.md`
- `frontend/src/docs/articles/notifications/history.md`
- `frontend/src/docs/articles/notifications/smtp.md`
- `frontend/src/docs/articles/notifications/subscriptions.md`
- `frontend/src/docs/articles/notifications/webhook.md`
- `frontend/src/docs/articles/operations.md`
- `frontend/src/docs/articles/operations/cutover.md`
- `frontend/src/docs/articles/operations/disaster-recovery.md`
- `frontend/src/docs/articles/operations/monitoring.md`
- `frontend/src/docs/articles/recovery-testing.md`
- `frontend/src/docs/articles/recovery-testing/import.md`
- `frontend/src/docs/articles/recovery-testing/results.md`
- `frontend/src/docs/articles/recovery-testing/validation.md`
- `frontend/src/docs/articles/reference.md`
- `frontend/src/docs/articles/reference/acknowledgements.md`
- `frontend/src/docs/articles/reference/api.md`
- `frontend/src/docs/articles/reference/configuration.md`
- `frontend/src/docs/articles/reference/contributing.md`
- `frontend/src/docs/articles/reference/faq.md`
- `frontend/src/docs/articles/reference/limitations.md`
- `frontend/src/docs/articles/reference/status-codes.md`
- `frontend/src/docs/articles/reference/version.md`
- `frontend/src/docs/articles/remote-agent.md`
- `frontend/src/docs/articles/remote-agent/enrollment.md`
- `frontend/src/docs/articles/remote-agent/permissions.md`
- `frontend/src/docs/articles/remote-agent/troubleshooting.md`
- `frontend/src/docs/articles/remote-agent/updates.md`
- `frontend/src/docs/articles/restore.md`
- `frontend/src/docs/articles/restore/browse.md`
- `frontend/src/docs/articles/restore/selection.md`
- `frontend/src/docs/articles/restore/staging.md`
- `frontend/src/docs/articles/security.md`
- `frontend/src/docs/articles/security/boundaries.md`
- `frontend/src/docs/articles/security/credentials.md`
- `frontend/src/docs/articles/security/https.md`
- `frontend/src/docs/articles/storage.md`
- `frontend/src/docs/articles/storage/s3.md`
- `frontend/src/docs/articles/storage/security.md`
- `frontend/src/docs/articles/storage/sftp.md`
- `frontend/src/docs/articles/troubleshooting.md`
- `frontend/src/docs/articles/troubleshooting/database.md`
- `frontend/src/docs/articles/troubleshooting/incremental.md`
- `frontend/src/docs/articles/troubleshooting/notifications.md`
- `frontend/src/docs/articles/troubleshooting/recovery.md`
- `frontend/src/docs/articles/troubleshooting/sftp.md`
- `frontend/src/docs/articles/troubleshooting/source.md`
- `frontend/src/docs/manifest.ts`

### Dibuat

- `docs/DOCUMENTATION_REDESIGN_REPORT.md`
- `frontend/src/docs/articles/backup-plans/delete.md`
- `frontend/src/docs/articles/backup-plans/managed-agent.md`
- `frontend/src/docs/articles/database-restores.md`
- `frontend/src/docs/articles/database-restores/delete.md`
- `frontend/src/docs/articles/database-restores/inspect.md`
- `frontend/src/docs/articles/database-restores/resources.md`
- `frontend/src/docs/articles/database-restores/stop-resume.md`
- `frontend/src/docs/articles/database-restores/troubleshooting.md`
- `frontend/src/docs/articles/database-restores/ttl-cleanup.md`
- `frontend/src/docs/articles/migration.md`
- `frontend/src/docs/articles/migration/cutover.md`
- `frontend/src/docs/articles/migration/shadow.md`
- `frontend/src/docs/articles/replication.md`
- `frontend/src/docs/articles/replication/hcp.md`
- `frontend/src/docs/articles/replication/managed-agent.md`
- `frontend/src/docs/articles/replication/retention-restore.md`
- `frontend/src/docs/articles/replication/status-retry.md`
- `frontend/src/docs/articles/storage/hcp.md`
- `frontend/src/docs/articles/storage/local.md`

## Konfirmasi batas pekerjaan

Tidak ada perubahan backup/backend/Agent/frontend business logic, API, schema/migration, guard keamanan, konfigurasi production, shared component/style, dependency, atau workflow CI. Seluruh perubahan terbatas pada artikel, navigasi/rendering/pemeriksaan khusus docs, serta dokumentasi arsitektur/laporan.

HEAD tetap pada base; index Git kosong. Output build dan evidence validasi berada di direktori yang diabaikan Git. Tidak ada stage, commit, push, merge, publish atau deployment. Hasil lokal siap untuk review sebelum publikasi yang memerlukan izin terpisah.
