# Menjalankan SHADOW dan validasi sebelum cutover

SHADOW menjalankan Pluton sebagai jalur baru yang diamati sementara SYS MON tetap authoritative dan tetap melindungi workload. Tujuannya mengumpulkan bukti yang dapat ditinjau sebelum tanggung jawab backup berpindah. Jangan menghentikan jadwal lama, memodifikasi repository lama, atau menganggap satu backup manual sukses sebagai acceptance.

## Siapkan cakupan uji

1. Tentukan pemilik aplikasi/DBA, periode pengamatan, jadwal, target RPO/RTO, dan kriteria penerimaan. Pilih workload yang mewakili ukuran file, perubahan data, seluruh engine/database, dan kondisi sibuk yang relevan.
2. Catat jalur backup/pemulihan SYS MON secara privat dan pastikan masih dapat dipakai. Repository historis hanya diakses melalui kontrak read-only yang didukung.
3. Siapkan repository baru dedicated, source canonical/allowed roots, credential least privilege, dump client yang kompatibel, staging terisolasi, dan target database recovery-only.
4. Tinjau jadwal supaya beban dua jalur backup tidak diasumsikan aman. Ukur beban aktual pada pengujian yang disetujui; host 4 GiB bukan hasil capacity test. Jangan menurunkan guard memori/disk/CPU, ownership, atau concurrency.
5. Bila notifikasi/replika diperlukan untuk operasi, siapkan channel/tujuan yang disetujui dan definisikan bukti penerimaan masing-masing. Real HCP tetap **belum diuji** sampai ada hasil lingkungan uji yang dicatat.

Contoh fiktif: plan `app-01-shadow` membaca `/srv/example-app` dan menyertakan daftar database yang ditinjau DBA. Targetnya repository SFTP baru, dengan replika S3 opsional. Nama plan tidak mengubah SYS MON menjadi managed dan tidak memberi izin menulis repository lama.

## Rekam siklus terjadwal

Buka plan → **Backups** setelah setiap jadwal yang dipilih. Periksa **Status**, **Date** beserta zona waktu, **Duration**, **Changes**, **Snapshot Size**, snapshot exact, serta warning. Jangan hanya mengandalkan grafik/dashboard atau email sukses. Perubahan file yang sedikit dapat memiliki pertumbuhan fisik kecil; [counter incremental](/docs/backup-plans/incremental) perlu dibaca sesuai maknanya.

| Tanggal/jam/zona waktu | Backup dan snapshot privat | Terjadwal/manual | File + seluruh artefak SQL | Warning/replika/cleanup | Hasil dan tindak lanjut |
| --- | --- | --- | --- | --- | --- |
| … | … | … | … | … | … |
| … | … | … | … | … | … |
| … | … | … | … | … | … |

Jumlah siklus dan variasi ditentukan kebutuhan workload, bukan angka universal dari panduan. Bukti harus mencakup scheduled runs representatif. Jika satu database gagal dump, partial SQL atau database lain yang sukses tidak menggantikan daftar yang diwajibkan. Untuk 1044/privilege, gunakan [diagnostik database](/docs/troubleshooting/database).

## Validasi snapshot dan pemulihan

1. Pilih snapshot dari siklus representatif dan ikat seluruh bukti ke backup/snapshot itu.
2. Gunakan **Browse Snapshot** untuk memeriksa source serta artefak database yang seharusnya ada. Jika download menjadi kebutuhan runbook, uji download melalui jalur yang didukung.
3. Lakukan restore ke staging baru yang tervalidasi, terpisah dari source/repository, tanpa overwrite. Periksa file/direktori, isi, ukuran, dan metadata yang relevan.
4. Jalankan [Recovery Testing](/docs/recovery-testing) sesuai kebijakan. **Disabled — artifact-only validation, with warning** berarti SQL import **NOT TESTED**; hash valid tidak membuktikan import.
5. Jika SQL import diwajibkan, pakai **Required — all databases must import** dengan target terisolasi yang memenuhi preflight/marker/grant, atau [Database Restore](/docs/database-restores) untuk inspeksi yang perlu dipertahankan. Catat hasil **setiap** database.
6. Pemilik aplikasi/DBA memeriksa schema, data yang diperlukan, grants/config, dan fungsi bisnis pada lingkungan uji. Snapshot yang diambil pada waktu berbeda dapat mempunyai data berbeda; jangan menilai dump live pada dua waktu berbeda hanya dari hash yang sama/tidak sama.
7. Catat waktu mulai sampai aplikasi/data siap diverifikasi serta umur data yang dipulihkan. Bandingkan hasil RPO/RTO aktual dengan target.
8. Tinjau cleanup workspace/database dan lifecycle **Database Restores**: [inspect](/docs/database-restores/inspect), [stop/resume](/docs/database-restores/stop-resume), [delete](/docs/database-restores/delete), serta [TTL](/docs/database-restores/ttl-cleanup). Jangan menghapus target yang ownership-nya tidak jelas.

| Bukti pemulihan | Isian aktual |
| --- | --- |
| Backup/snapshot exact dan waktu pengambilannya | … |
| File/database/config yang benar-benar dipulihkan | … |
| Hash/ukuran artefak dan hasil import per database | … |
| Pemeriksaan semantik aplikasi dan penerimanya | … |
| RPO/RTO terukur beserta metode pengukuran | … |
| Sisa workspace/database, cleanup, resource, serta pemilik | … |
| Bagian belum diuji dan alasan | … |

## Validasi gangguan dan ketergantungan

Tinjau safe error paths menggunakan lingkungan disposable yang diizinkan: credential/permission ditolak, TLS tidak valid, tujuan non-empty, source tidak terbaca, resource tidak cukup, serta pekerjaan terinterupsi. Jangan memutus database produksi, merusak repository lama, atau menyuntik fault pada source hidup untuk melengkapi checklist.

Verifikasi bahwa penolakan tetap aman dan dapat didiagnosis tanpa menurunkan guard. Pada Managed Agent, uncertain tidak otomatis diulang atau dilepas; lihat [status replika](/docs/replication/status-retry). Tes fixture membuktikan skenario fixture saja, bukan ketersediaan seluruh infrastruktur nyata.

## Putuskan langkah berikutnya

Isi [checklist keputusan](/docs/operations/cutover) bersama pemilik. Jika scheduled/dump/restore/import/aplikasi, kapasitas, warning, atau rollback belum diterima, catat **LANJUT SHADOW** dengan tindakan/pemilik/tanggal tinjauan. SYS MON tetap berjalan. Hanya keputusan CUTOVER eksplisit yang membawa alur ke [peralihan dan rollback](/docs/migration/cutover).
