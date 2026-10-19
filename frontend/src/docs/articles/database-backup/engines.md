# Memilih MariaDB, MySQL, atau PostgreSQL

Pilih engine sesuai server database aplikasi. Pilihan ini menentukan alat pembuat dump dan identitas yang dicatat untuk pemulihan. Mengubah nama berkas menjadi .sql tidak mengubah engine dan tidak menjadikannya backup database native.

## Client pada agent

Administrator harus memasang klien yang sesuai sebelum Anda menyimpan konfigurasi. Klien dan direktori induknya harus dimiliki root serta tidak dapat ditulis oleh grup atau pengguna lain. Agent menjalankan pekerjaan sebagai pengguna non-root; antarmuka tidak menerima binary path bebas.

| Pilihan Engine | Klien dump | Hal yang perlu dipastikan |
| --- | --- | --- |
| MariaDB (mariadb-dump) | mariadb-dump asli atau alias MariaDB terverifikasi | Identitas klien, bukan hanya nama executable |
| MySQL (mysqldump) | Klien MySQL asli | Alias mysqldump MariaDB tidak membuktikan dukungan MySQL |
| PostgreSQL (pg_dump) | pg_dump dengan keluaran plain SQL | Kompatibilitas versi server dan trust CA |

Klien backup pada agent berbeda dari klien import atau worker pada Pluton Server. Backup sukses belum memastikan server pemulihan mempunyai semua kebutuhan tersebut.

## Pilihan DB

1. Buka plan → **Edit → Advanced → Database & Hooks**.
2. Pilih **Engine** pada kartu database. Pemilihan engine mengatur ulang **Port** ke nilai awal; periksa bila endpoint memakai port lain.
3. Isi **Database**, **Host**, akun, transport, dan filename unik. Contoh fiktif: example_app dengan example-app.sql.
4. Untuk MariaDB/MySQL, tinjau **Include routines (extra DB privileges)** dan **Include events (extra DB privileges)**. Keduanya tidak ditampilkan untuk PostgreSQL.
5. Klik **Update Plan**, jalankan **Backup Now**, dan periksa **Complete** serta isi snapshot melalui **Browse**.

Setiap kartu memilih satu logical database. Beberapa engine dapat dipakai dalam satu plan, tetapi dump tetap berurutan. Fitur ini tidak mencakup dump seluruh cluster, pengelolaan WAL/binlog/PITR, atau pencadangan otomatis semua role dan konfigurasi global.

## Native metadata dan berkas SQL biasa

Backup native mencatat database ID, engine, nama logical database, path artefak, ukuran, dan SHA-256 pada hasil pekerjaan yang terikat snapshot. Catatan ini digunakan untuk [Restore Database](/docs/database-restores) dan [import Recovery Test](/docs/recovery-testing/import).

Berkas .sql yang berada dalam folder sumber dicadangkan sebagai berkas biasa. Pluton tidak menebak engine atau identitas database dari filename atau isi SQL untuk mengaktifkan import native. Gunakan [Restore berkas](/docs/restore) atau Download, kemudian ikuti prosedur DBA yang direview untuk penanganan manual.

## Acceptance

Uji pada target terisolasi yang mewakili versi, ekstensi, owner, dan grant aplikasi Anda. Bukti integrasi disposable satu versi tidak mengesahkan seluruh versi database atau perilaku bisnis aplikasi.

MySQL Internal memerlukan worker Oracle MySQL asli dan host operator yang disetujui, berikut pemeriksaan TLS, resource, dan ownership. Host 4 GiB belum terbukti mampu menjalankan recovery hanya karena fitur tersedia. Batas SQL MySQL Internal tetap 128 MiB dan kebutuhan RAM tersedia tetap 2.944 MiB. Lihat [resource pemulihan](/docs/database-restores/resources) sebelum menjalankannya.
