# Login berhasil tetapi dump database gagal

Login database yang sukses hanya membuktikan koneksi dan autentikasi pada percobaan itu. Dump juga membutuhkan client, opsi, TLS, serta hak objek yang sesuai. Gunakan artikel ini ketika backup gagal pada tahap database sebelum Restic, atau SQL sementara terlihat ada tetapi pekerjaan belum sukses.

## Gejala

Contoh fiktif: akun dump `backup_reader` dapat login ke database `example_app`, tetapi dump dengan Events aktif gagal **1044**. File `.sql` sementara mungkin tidak kosong; itu tidak membuktikan dump lengkap atau diarsipkan ke snapshot. Jangan menerima partial SQL sebagai backup yang sah.

## Penyebab

| Bukti/kategori | Yang perlu dibedakan |
| --- | --- |
| 1045 / authentication failure | Credential atau kebijakan login |
| 1044, 1142, 1227 / insufficient privileges | Hak database/objek/operasi dump |
| Client missing/incompatible | Binary/versi tool berbeda dari engine atau format |
| TLS/connection failure | CA, hostname, port, rute jaringan, atau server |
| Timeout/output limit/empty output | Batas kerja atau hasil dump tidak valid |

Views, triggers, routines, events, transactional consistency, dan nama/engine yang salah dapat memberi kebutuhan berbeda. Keberhasilan tes dari akun administrator tidak mewakili runtime akun Agent.

## Diagnostik aman

1. Temukan backup pada plan → **Backups**, lalu buka **View Logs** dan journal Agent yang sama. Catat database ID sintetis pada laporan publik, engine, stage, safe code, dan waktu.
2. Buka **Edit Plan → Advanced → Database & Hooks**. Cocokkan koneksi, engine, daftar database, serta opsi dump dengan maksud workload; jangan menampilkan credential.
3. Pastikan versi Agent dan dump client benar-benar sudah diperbarui. Deploy server tidak mengganti executable Agent.
4. DBA meninjau grants dan inventaris objek secara privat menggunakan akun, client, opsi, dan trust TLS yang sama seperti layanan.
5. Periksa apakah kegagalan terjadi sebelum dump, saat dump, saat validasi ukuran, atau sebelum snapshot. File sementara tidak boleh dijadikan bukti completion.

## Resolusi

DBA memberikan hak minimum yang memang dibutuhkan objek yang dibackup. Jika workload benar-benar tidak memiliki Events/Routines dan pemilik menyetujuinya, ubah opsi secara eksplisit dan catat cakupan baru. Jangan mematikan opsi otomatis untuk membuat 1044 hilang. Jangan memberi global admin/SUPER/FILE sebagai solusi umum.

Untuk error client, pasang/review client yang kompatibel melalui prosedur Agent. Untuk TLS, perbaiki hostname/rantai CA. Untuk timeout/ukuran, ukur dump representatif dan tinjau batas yang diizinkan tanpa menurunkan pengaman atau menganggap SQL terpotong berhasil.

Setelah perbaikan, jalankan satu backup baru yang diizinkan. Pastikan terminal sukses, seluruh artefak database yang dikonfigurasi tercatat dengan ukuran nonzero, dan snapshot exact dapat dibrowse. Lanjutkan [Required import](/docs/recovery-testing/import) atau [Database Restore](/docs/database-restores) di target uji bila ingin membuktikan SQL dapat diimpor; dump sukses saja belum bukti itu.

## Jangan lakukan

Jangan mengimpor ke source untuk tes, membagikan SQL/credential/raw config, merotasi password untuk seluruh kategori kegagalan, atau menerima satu database sukses sebagai pengganti seluruh daftar. Baca [dump options](/docs/database-backup/dump-options), [koneksi](/docs/database-backup/connections), dan [diagnostik Database Restore](/docs/database-restores/troubleshooting) untuk tahap setelah dump.
