# Membuat plan Managed Agent dengan SFTP primer

Gunakan plan Managed Agent untuk mencadangkan satu folder aplikasi pada mesin Linux lain. Agent membaca source dan menulis snapshot ke SFTP primer. Setelah server memverifikasi snapshot, server dapat menyalinnya ke paling banyak dua repository S3 tambahan.

Contoh fiktif: mesin `app-01`, source `/srv/example-app`, storage `SFTP contoh`, dan destination `daily/app-01`. Siapkan file latihan dahulu agar Anda dapat menguji backup serta restore tanpa mengubah aplikasi aktif.

## Sebelum membuka formulir

Pastikan agent sudah [terdaftar](/docs/remote-agent/enrollment), berstatus **ONLINE**, melaporkan capability `BACKUP_FILESYSTEM`, dan mempunyai **Allowed roots configured: Yes**. Jalankan [preflight source](/docs/remote-agent/permissions) agar folder serta file di dalamnya terbaca.

Tambahkan [SFTP](/docs/storage/sftp) pada **Storages**. Agent dan server perlu mengakses primer itu. Layanan SFTP boleh berada pada VM Pluton jika operator menyiapkannya; alurnya tetap memakai SFTP, bukan pilihan Local. Siapkan path baru atau kosong khusus plan dan staging pemulihan yang terpisah.

## Mengisi Basic dan Source & Destination

1. Buka **Backup Plans → + New**.
2. Pada **Basic**, isi **Backup Plan Name***, misalnya `Backup contoh app-01`, dan gunakan **Incremental Backup**.
3. Klik **Next: Configure Source & Destination**, lalu pilih `app-01` pada **Select Device***.
4. Isi **Remote Backup Source*** dengan satu path absolut Linux, misalnya `/srv/example-app`. Tidak ada remote file browser untuk memilih isi mesin.
5. Pada **Backup Destination***, pilih SFTP dan isi path `daily/app-01`. Periksa pemetaan home/chroot akun SFTP agar lokasi fisiknya benar.
6. Biarkan **Enable Replication** mati untuk backup pertama.

Source harus tetap berada dalam allowed roots setelah symlink diselesaikan. Source, mesin, serta destination yang sudah dipilih tidak dapat dipindahkan lewat edit biasa sebagai cara memigrasi repository.

## Salinan S3 opsional

Anda dapat menambahkan 0, 1, atau 2 replika melalui **Enable Replication** dan **+ Add Replication Destination**. Pilih **AWS S3** atau **S3 Compatible Storage**, lalu gunakan prefix khusus pada bucket yang sudah tersedia. UI menampilkan awalan bucket bila ada; isi hanya subfolder pada field sisanya.

Untuk storage S3 compatible atau endpoint non-AWS, aktifkan **HCP / pre-existing namespace mode** pada konfigurasi storage sebagaimana [panduan HCP](/docs/storage/hcp). Kredensial replika digunakan server dan tidak diberikan kepada agent. Penyalinan managed dilakukan berurutan pada server untuk membatasi penggunaan sumber daya.

Alurnya adalah: **folder agent → snapshot SFTP primer → verifikasi server → replika S3 opsional**. Status sukses primer dan setiap replika terpisah. Interoperabilitas dengan HCP nyata belum diuji. Baca [replikasi Managed Agent](/docs/replication/managed-agent) sebelum mengandalkan salinan tambahan.

## Jadwal dan pengaturan awal

1. Klik **Next: Setup Schedule & Retention** dan pilih **Backup Interval**. Form remote tidak menampilkan kebijakan prune standar pada langkah ini.
2. Klik **Next: Advanced Settings**. Pertahankan **Encryption** aktif; repository managed memerlukan password yang dikelola server.
3. Pada **General**, matikan **Run Backup Now** jika ingin meninjau plan sebelum berjalan.
4. Untuk latihan awal, biarkan **Database & Hooks** tanpa database atau hook. Tambahkan fitur tersebut setelah filesystem tervalidasi.
5. Klik **Create Plan**, periksa detail tersimpan, lalu klik **Backup Now**.

## Memastikan plan siap digunakan

Tunggu **Complete** pada tab **Backups**. Buka **Browse**, lakukan **Download** atau restore ke staging, dan bandingkan file contoh. Jika replika diaktifkan, periksa badge serta detail setiap salinan. Backup primer sukses tidak membuktikan replica sukses.

Untuk dump database, lanjutkan ke [backup database](/docs/database-backup). Untuk uji pemulihan, gunakan [Recovery Testing](/docs/recovery-testing). Pemulihan file dan native database recovery saat ini tetap memakai primer; restore langsung dari mirror managed dan physical prune belum tersedia.

Jika source ditolak, periksa allowed roots serta izin. Jika repository preparation gagal karena isi destination atau akses, jangan mengosongkan folder atau mengubah validasi. Saat ingin menghentikan atau menghapus plan, gunakan [jadwal](/docs/backup-plans/schedule-retention) dan [penghapusan plan](/docs/backup-plans/delete); repository remote managed tetap dipertahankan.
