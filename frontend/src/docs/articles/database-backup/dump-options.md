# Mengatur cakupan dump, privilege, dan batas pekerjaan

Gunakan opsi dump agar objek database yang diperlukan aplikasi ikut dicadangkan. Login berhasil atau pembacaan satu tabel belum membuktikan dump lengkap dapat dibuat. Sepakati cakupan dan batas beban dengan DBA sebelum backup pertama.

## Mengubah opsi di antarmuka

1. Buka plan → **Edit → Advanced → Database & Hooks**.
2. Periksa **Engine** dan **Database** pada kartu yang benar.
3. Atur **Dump timeout (seconds)** untuk waktu maksimum pembuatan dump. Nilai awalnya 900 detik.
4. Tinjau **Maximum dump size (GiB)**. Nilai awalnya 10 GiB; formulir menyediakan rentang 1–100 GiB.
5. Tentukan routines/events jika memakai MariaDB/MySQL, lalu klik **Update Plan**.
6. Jalankan **Backup Now** pada waktu yang disetujui dan periksa tahap serta hasil pada **Backups**.

Contoh fiktif: example_app membutuhkan routines tetapi tidak memakai events. DBA tetap perlu mengonfirmasi kebutuhan aplikasi sebenarnya.

## Login bukan full dump acceptance

MariaDB/MySQL error 1045 menunjukkan kegagalan autentikasi. Error 1044, 1142, dan 1227 dapat menunjukkan privilege yang tidak cukup. Mengganti password tidak memperbaiki grant yang kurang.

Akun backup memerlukan hak untuk database dan objek yang dicadangkan, termasuk SELECT, SHOW VIEW, TRIGGER, serta kebutuhan opsi dan versi yang digunakan. Minta DBA meninjau hak minimum. Jangan memberi global SUPER, FILE, atau akun administrator sebagai jalan pintas.

## Routines dan Events

**Include routines (extra DB privileges)** dan **Include events (extra DB privileges)** meminta objek tambahan pada dump MariaDB/MySQL. Pluton tidak mematikannya otomatis jika dump ditolak. Bila aplikasi memakainya, perbaiki grant dan uji dump lengkap. Mematikan opsi dapat membuat backup kurang lengkap untuk memulihkan aplikasi.

Untuk PostgreSQL, kedua opsi tidak tersedia. Owner, role, ekstensi, dan kompatibilitas tetap perlu ditinjau saat menyiapkan recovery.

## Batas resource

Timeout backend menerima 1–3600 detik dan batas keluaran 1 KiB–100 GiB, sedangkan formulir mengisikan ukuran dalam GiB. Timeout hook terpisah, 1–300 detik. Batas dump berbeda dari kemampuan import: SQL 1 GiB yang sah untuk backup tetap melebihi batas 128 MiB MySQL Internal.

Timeout atau keluaran melebihi batas menghasilkan kegagalan. SQL parsial yang sudah berisi data tidak dianggap backup sukses. Periksa ukuran, ruang workspace agent, beban database, dan cakupan objek sebelum menaikkan batas.

## Consistency

MariaDB/MySQL menggunakan single-transaction tanpa lock tabel pada dump ini. Konsistensinya memerlukan engine transaksional seperti InnoDB dan tidak adanya perubahan skema bersamaan. Dump beberapa database berurutan; berkas aplikasi dapat berubah selama prosesnya.

Tentukan kebutuhan jeda penulisan atau [hooks](/docs/database-backup/hooks) bersama pemilik layanan. Sesudah sukses, periksa [artefak SQL](/docs/database-backup/artifacts) dan jalankan [Recovery Test](/docs/recovery-testing). Import yang lolos tetap memerlukan pemeriksaan fungsi aplikasi.
