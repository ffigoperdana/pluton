# Beralih dari SYS MON ke Pluton secara bertahap

Peralihan dimulai dengan menambahkan jalur backup baru yang dapat dibuktikan, bukan mematikan backup lama. Selama **SHADOW**, SYS MON tetap jalur yang berwenang. Pluton memakai repository terkelola baru dan mengumpulkan bukti scheduled backup, dump, restore, serta recovery pada workload yang mewakili kebutuhan aplikasi. **CUTOVER** adalah keputusan eksplisit setelah bukti diterima dan rollback siap.

```text
SYS MON tetap authoritative
  → SHADOW Pluton pada repository baru
  → VALIDATION scheduled + dump + staging restore + recovery
  → keputusan CUTOVER eksplisit
  → pemantauan lanjutan atau rollback yang disetujui
```

## Persiapan dan batas peralihan

Tentukan pemilik aplikasi, DBA, infrastruktur, dan pihak yang menerima risiko. Inventaris source, database/engine, jadwal, lokasi backup, credential consumer, retensi, serta prosedur pemulihan lama secara privat. Gunakan nama sintetis `app-01`, `example.internal`, dan `/srv/example-app` untuk dokumen publik.

Jangan mengarahkan plan baru ke repository SYS MON atau mengubahnya agar menjadi managed. [Legacy Repositories](/docs/legacy-repositories) menyediakan alur inspeksi terpisah dengan kontrak read-only/no-lock. [Akses repository historis saat migrasi](/docs/legacy-repositories/migration) berbeda dari berpindah tanggung jawab backup terjadwal.

## Urutan yang dapat ditinjau

1. Tetapkan cakupan dan target RPO/RTO bersama pemilik aplikasi. Catat apa yang wajib dipulihkan: file, seluruh database, konfigurasi, permission, serta dependensi aplikasi.
2. Siapkan storage/Agent yang disetujui dan repository baru. Periksa [Managed Agent plan](/docs/backup-plans/managed-agent), [database backup](/docs/database-backup), serta [batas keamanan](/docs/security/boundaries).
3. Jalankan [SHADOW](/docs/migration/shadow) tanpa menghentikan SYS MON. Gunakan beberapa siklus **terjadwal** dan variasi workload yang relevan, bukan hanya beberapa klik Backup Now.
4. Buktikan exact snapshot berisi source dan artefak SQL yang dimaksud. Verifikasi browse/download yang diperlukan, staging restore, serta SQL import di target recovery-only bila diwajibkan.
5. Uji hasil aplikasi secara semantik, tinjau warning/cleanup, ukur umur data dan waktu pemulihan nyata, lalu catat celah yang belum diuji.
6. Tinjau [gate keputusan operator](/docs/operations/cutover). Bila bukti belum lengkap, lanjutkan SHADOW dengan SYS MON tetap aktif.
7. Setelah persetujuan yang tercatat, jalankan [CUTOVER dan rollback](/docs/migration/cutover) pada window yang disetujui. Panduan tidak menjalankan perubahan jadwal, script, service, credential, atau produksi secara otomatis.

## Contoh yang tidak mengarang hasil

`app-01` memiliki file aplikasi dan dua database fiktif. Pada SHADOW, operator mengisi satu baris bukti untuk setiap siklus dan mengikat restore drill ke snapshot yang sama. Jika hanya satu database diuji import, hasilnya adalah satu database diuji dan satu **belum diuji**. Jika primary sukses tetapi mirror gagal, backup dan redundansi dilaporkan terpisah. Tidak ada angka durasi/kapasitas fiktif yang dianggap hasil acceptance.

## Catatan penerimaan

| Keputusan atau bukti | Isian nyata |
| --- | --- |
| Pemilik aplikasi/DBA/infrastruktur dan pemeriksa | … |
| Cakupan source/database serta pengecualian yang disetujui | … |
| Target RPO/RTO dan periode SHADOW | … |
| Repository baru dan akses read-only historis | … |
| Bukti scheduled/dump/restore/import/aplikasi | … |
| Warning, kapasitas, cleanup, notifikasi/replika yang diwajibkan | … |
| Celah belum diuji dan tindakan/pemilik | … |
| Keputusan lanjut SHADOW atau CUTOVER beserta waktu | … |

RAM host 4 GiB belum membuktikan kapasitas. Ukur workload representatif dan pertahankan resource/disk/concurrency guard. Interoperabilitas HCP nyata belum diuji; jika dibutuhkan, masukkan validasi namespace uji dan batas pemulihannya pada gate. Managed Agent belum mendukung physical cleanup/prune atau direct mirror file/native database restore; jangan menjadikannya asumsi rollback.

Setelah peralihan, ikuti [operasi harian](/docs/operations) dan [DR runbook](/docs/operations/disaster-recovery). Simpan akses backup lama dan credential yang diperlukan sampai pemilik data menyetujui retensi serta dependency review; rotasi credential dilakukan melalui rencana terpisah.
