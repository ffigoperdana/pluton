# Runbook pemulihan bencana

Gunakan runbook ini untuk menyiapkan dan menjalankan drill pemulihan yang terisolasi. Pulihnya dashboard bukan bukti aplikasi pulih; backup file, SQL, konfigurasi, akun, dan dependensi aplikasi perlu diverifikasi bersama. Tindakan produksi, perubahan DNS, atau promosi database membutuhkan window dan persetujuan terpisah.

## Persiapan offline

Simpan di lokasi terkontrol off-host: image digest/revisi rilis, prosedur deployment, salinan database aplikasi yang konsisten, konfigurasi/key yang sesuai, kredensial repository, identitas Agent, trust CA, dan kontak penanggung jawab. Jangan menyimpan plaintext pada repository publik. Periksa bahwa orang yang berwenang dapat mengaksesnya ketika host Pluton hilang.

Contoh drill memakai `app-01` dan snapshot yang dicatat privat. Dokumen publik memakai `/srv/example-app` dan `example.internal`; tidak memuat IP atau username nyata. Siapkan target staging dan database uji yang tidak terhubung ke aplikasi hidup, serta ruang untuk dump/restore/import.

## Control plane

1. Pilih backup control plane yang konsisten dan versi aplikasi/migration journal yang cocok. Ikuti [persistensi](/docs/deployment/persistence) dan [rollback deployment](/docs/deployment/rollback).
2. Provision instance drill terisolasi dengan volume khusus yang sengaja dipakai untuk pemulihan. Tinjau akses jaringan dan dispatch sebelum service restored boleh berjalan.
3. Pulihkan database, konfigurasi, dan key sebagai pasangan; jangan meregenerasi SECRET, ENCRYPTION_KEY, atau identitas untuk melewati error.
4. Pastikan jadwal/dispatch restored tidak mengirim pekerjaan ke tujuan produksi tanpa review. Scheduler dapat memutasi repository terkelola.
5. Verifikasi login, pembacaan konfigurasi, inventory yang diharapkan, dan akses snapshot yang memang diizinkan. Simpan hasil tiap langkah.

## Data aplikasi

1. Pilih backup dan snapshot **exact**, bukan sekadar nama plan atau kata latest. Periksa sumber, artefak database, waktu, dan warning.
2. Jalankan [browse](/docs/restore/browse), download bila dibutuhkan, serta [restore staging](/docs/restore/staging) melalui jalur yang didukung.
3. Periksa jumlah regular files/direktori, ukuran, hash/metadata yang tersedia, permission yang dibutuhkan aplikasi, serta kelengkapan konfigurasi/dependensi.
4. Untuk SQL, lakukan [Required import](/docs/recovery-testing/import) atau [Database Restore](/docs/database-restores) pada target recovery-only yang sesuai. Catat artefak mana diuji dan hasil import per database.
5. Jalankan pemeriksaan semantik aplikasi di lingkungan uji: versi schema, data yang diharapkan, relasi, dan fungsi bisnis yang disepakati pemilik aplikasi. Hash valid dan import sukses belum menguji seluruh perilaku aplikasi.

Managed Agent file restore dan native database recovery masih memakai repository utama; direct restore dari mirror belum didukung. Repository Legacy tetap read-only dengan kontrak no-lock. Jangan init, prune, unlock, atau melakukan repair sebagai recovery otomatis.

## Cutover dan rollback

Promosi file staging, startup aplikasi pengganti, DNS switching, serta SQL production import bukan tindakan auto-restore panduan ini. Gunakan [gate CUTOVER](/docs/migration/cutover), data freshness, persetujuan pemilik aplikasi/DBA/infrastruktur, dan fallback yang masih dapat dipakai. Jangan menganggap hasil automated test sebagai izin peralihan produksi.

## Sesudah drill

Isi catatan berikut dengan hasil pengukuran; tanda kosong berarti belum diverifikasi.

| Bukti drill | Isian |
| --- | --- |
| Waktu kejadian simulasi dan waktu backup/snapshot | … |
| Target RPO / umur data yang benar-benar dipulihkan | … |
| Waktu mulai, siap diuji, dan hasil RTO terukur | … |
| File/database/konfigurasi yang tercakup | … |
| SQL import dan pemeriksaan aplikasi yang lulus/gagal | … |
| Cleanup workspace/database, pemilik, dan sisa data | … |
| Kekurangan, tindakan perbaikan, penanggung jawab | … |

Tinjau cleanup berdasarkan ownership dan status. Jangan menghapus database/file yang tidak dibuat drill, menghapus snapshot untuk menyembunyikan hasil gagal, atau menandai SQL yang Disabled sebagai sudah diuji. Gunakan [diagnostik recovery](/docs/troubleshooting/recovery) untuk tindakan aman.
