# Menjalankan backup pertama dan memulihkan satu file

Latihan ini membawa Anda dari source contoh sampai file hasil pemulihan. Gunakan data sekali pakai: mesin `app-01`, folder `/srv/example-app`, dan tujuan repository baru. Sediakan satu file teks yang isinya mudah dikenali. Jangan memakai folder aplikasi aktif untuk percobaan pertama.

## Persiapan

Pastikan [Pluton Server sudah terpasang](/docs/deployment), Anda dapat login, dan [kebutuhan sistem](/docs/getting-started/requirements) terpenuhi. Jika data berada pada mesin lain, lakukan [enrollment agent](/docs/remote-agent/enrollment) dan pastikan mesin **ONLINE**. Jika data berada pada host Pluton, pastikan folder terlihat serta terbaca dari lingkungan server atau container.

Pilih alur sesuai lokasi source. Contoh utama berikut memakai Managed Agent dengan SFTP primer. Untuk filesystem host Pluton, gunakan panduan [Backup Plan](/docs/backup-plans); pilihan primer dapat berupa Local, SFTP, atau S3 sesuai konfigurasi yang tersedia.

## Setup aplikasi

1. Buka **Storages → + New**. Pada **Add New Remote Storage**, isi **Storage Name***, pilih **Storage Type*** yang sesuai, lalu isi koneksinya. Untuk contoh Managed Agent, ikuti [SFTP](/docs/storage/sftp) dan klik **Add Storage**.
2. Buka **Backup Plans → + New**. Formulir **Add New Plan** dimulai pada **Basic**. Isi **Backup Plan Name***, misalnya `Backup contoh app-01`, dan gunakan **Incremental Backup**.
3. Klik **Next: Configure Source & Destination**. Pilih `app-01` pada **Select Device***, isi **Remote Backup Source*** dengan `/srv/example-app`, lalu pilih SFTP pada **Backup Destination***.
4. Isi path repository baru, misalnya `daily/app-01`. Path harus khusus untuk plan ini dan belum ada atau kosong. Biarkan **Enable Replication** mati selama latihan pertama.
5. Klik **Next: Setup Schedule & Retention**. Pilih **Backup Interval** yang sesuai waktu uji, misalnya **Daily**. Managed Agent tidak menawarkan retensi/prune lokal pada langkah ini.
6. Klik **Next: Advanced Settings**. Pada **General**, tinjau **Encryption**, **Compression**, dan **Run Backup Now**. Matikan **Run Backup Now** agar Anda dapat memeriksa plan dahulu; jangan menambahkan database atau hooks dulu.
7. Klik **Create Plan**. Pada halaman plan yang tersimpan, tinjau source dan tujuan, lalu klik **Backup Now** satu kali.

## Validasi pertama

Tunggu pekerjaan mencapai status akhir. Permintaan mulai diterima belum berarti backup selesai. Pada riwayat **Backups**, periksa **Complete**, waktu, ukuran snapshot, dan detail pekerjaan. Buka menu tiga titik pada baris backup, pilih **Browse**, dan pastikan file contoh ada di snapshot yang dipilih.

Gunakan **Download** untuk mengambil arsip atau **Restore** untuk [pemulihan ke staging](/docs/restore/staging). Pilih tujuan terpisah, lalu bandingkan isi file hasil pemulihan dengan source contoh. Hasil yang diharapkan adalah isi yang sama tanpa menulis ulang aplikasi aktif.

Jalankan backup kedua tanpa mengubah file. Setelah itu ubah satu file contoh dan jalankan lagi. Baca [statistik incremental](/docs/backup-plans/incremental) untuk membedakan perubahan file dari byte baru yang tersimpan. Latihan ini tidak memerlukan penghapusan snapshot lama.

## Bila hasil belum sesuai

Jika mesin OFFLINE, buka [diagnostik agent](/docs/remote-agent/troubleshooting). Jika source ditolak, periksa [allowed roots dan izin](/docs/remote-agent/permissions). Jika tujuan tidak kosong atau akses ditolak, periksa [pemetaan SFTP](/docs/storage/sftp); jangan mengosongkan folder hanya agar inisialisasi lolos.

Setelah file dapat dipulihkan, tambahkan [database](/docs/database-backup), [Recovery Testing](/docs/recovery-testing), [replikasi](/docs/replication), dan [notifikasi](/docs/notifications) satu per satu. Pertahankan backup lama sampai [cutover](/docs/migration/cutover) selesai dinilai.
