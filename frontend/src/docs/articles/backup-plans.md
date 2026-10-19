# Membuat Backup Plan untuk folder pada host Pluton

Buat satu Backup Plan untuk satu aplikasi atau kumpulan file yang ingin dipulihkan bersama. Panduan ini memakai folder yang dapat dibaca host Pluton. Jika folder berada pada mesin lain, gunakan [plan Managed Agent](/docs/backup-plans/managed-agent), yang mempunyai pilihan source dan storage berbeda.

Contoh fiktif: source `/srv/example-app`, nama plan `Backup folder contoh`, dan tujuan Local `/srv/example-backups/app-01`. Gunakan data latihan dan repository baru khusus plan.

## Satu workload

Sebelum mulai, pastikan source terlihat dari proses Pluton atau container, dapat dibaca oleh pengguna non-root, dan destination sudah disiapkan pada **Storages**. Folder pada host tidak otomatis terlihat di container tanpa mount yang sesuai. Siapkan pula [staging restore](/docs/restore/staging) yang terpisah.

1. Buka **Backup Plans → + New** untuk menampilkan **Add New Plan**.
2. Pada **Basic**, isi **Backup Plan Name*** dan, bila diperlukan, **Backup Plan Description**.
3. Gunakan **Incremental Backup**. Pilihan strategi lain yang dinonaktifkan bukan bagian alur ini.
4. Klik **Next: Configure Source & Destination**.
5. Pada **Select Device***, pilih host Pluton. Tentukan folder melalui **Backup Sources***. Tinjau semua path yang disertakan dan dikecualikan sebelum melanjutkan.

Pilih folder aplikasi yang memang ingin dicadangkan. Menambahkan database files yang sedang aktif ke daftar source tidak otomatis menghasilkan dump SQL yang konsisten. Untuk dump database melalui Managed Agent, ikuti [backup database](/docs/database-backup).

## Destination

Pada **Backup Destination***, pilih storage sesuai kebutuhan: [Local](/docs/storage/local), [SFTP](/docs/storage/sftp), atau [S3](/docs/storage/s3) yang didukung konfigurasi standar. Isi folder atau prefix repository khusus. Jika UI telah menampilkan bucket, isi subfolder tanpa mengulang nama bucket.

Jangan menempatkan destination di dalam source, memilih root storage, atau memakai repository yang berisi backup lama. Existing repository diakses melalui [Legacy Repositories](/docs/legacy-repositories). Pilihan destination dan path tidak dapat diubah melalui edit biasa sesudah plan dibuat.

Biarkan **Enable Replication** mati untuk latihan pertama. Setelah backup primer terbukti, ikuti [replikasi](/docs/replication) untuk menambahkan salinan lain dengan lokasi terpisah.

## Advanced

1. Klik **Next: Setup Schedule & Retention**. Atur **Backup Interval**, misalnya **Daily**, dan tinjau **Backup Retention Policy**.
2. Untuk latihan awal, pilih **Keep All Backups (Disable Pruning)** sambil memantau kapasitas. Untuk penggunaan berkelanjutan, tentukan [jadwal dan retensi](/docs/backup-plans/schedule-retention) yang sesuai.
3. Klik **Next: Advanced Settings**. Pada **General**, tinjau **Encryption**, **Compression**, **Retries**, dan **Retries Delay**.
4. Matikan **Run Backup Now** bila ingin memeriksa plan tersimpan sebelum job pertama berjalan. Nilai awal toggle ini aktif.
5. Klik **Create Plan**. Pada alur standar, pembuatan plan sudah dapat menginisialisasi repository dan membuat jadwal; mematikan **Run Backup Now** hanya menunda backup awal.

Jangan memakai pembuatan plan untuk mencoba akses ke repository lama. Periksa lokasi tujuan dan simpan konfigurasi/kunci melalui prosedur privat operator sebelum langkah terakhir.

## Pemeriksaan pertama

Pada halaman plan, tinjau source, tujuan, dan interval, lalu klik **Backup Now** satu kali. Tunggu **Complete** pada tab **Backups**, buka **Browse**, dan pulihkan satu file contoh ke staging. Hasil yang diharapkan adalah isi yang sama dengan source pada waktu snapshot dibuat.

Jika proses tidak mulai atau gagal, periksa pekerjaan aktif, kapasitas, izin source, serta akses destination. Jangan mengganti kunci atau menghapus isi repository sebagai percobaan. Gunakan [riwayat backup](/docs/backup-plans/history), [pengaturan lanjutan](/docs/backup-plans/advanced), dan [pemecahan masalah](/docs/troubleshooting) untuk langkah berikutnya.
