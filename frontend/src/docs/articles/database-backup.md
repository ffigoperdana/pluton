# Mencadangkan berkas aplikasi dan database bersama

Gunakan pencadangan database ketika pemulihan aplikasi memerlukan berkas dan isi database dari satu pekerjaan backup. Pluton membuat dump SQL setiap database yang Anda daftarkan, kemudian menyimpannya bersama berkas aplikasi dalam satu snapshot. Contoh pada panduan ini sepenuhnya fiktif: app-01 mempunyai berkas di /srv/example-app dan database example_app.

## Sebelum mulai

Siapkan plan **managed agent** dengan tujuan SFTP yang sudah dapat melakukan backup berkas. Administrator agent harus memasang klien dump yang sesuai, sedangkan DBA menyiapkan akun backup dengan hak minimum dan koneksi terverifikasi. Pengaturan ini tersedia untuk sumber perangkat remote; menyalin berkas .sql biasa tidak mengaktifkan pencadangan database native.

Sediakan ruang sementara untuk seluruh dump dan waktu operasi yang disetujui pemilik aplikasi. Lihat [plan managed agent](/docs/backup-plans/managed-agent), [engine](/docs/database-backup/engines), dan [koneksi](/docs/database-backup/connections).

## Konfigurasi

1. Buka plan aplikasi, klik **Edit**, lalu pilih **Advanced → Database & Hooks**.
2. Pada **Database Backup**, centang **Enable database backup**. Satu kartu database akan muncul.
3. Pilih **Engine**, lalu isi **Host**, **Port**, **Database**, **Username**, dan **Password** dengan informasi yang disetujui DBA. Masukkan rahasia hanya melalui kolom password.
4. Isi **Dump filename**, misalnya example-app.sql. Tinjau **Dump timeout (seconds)**, **Maximum dump size (GiB)**, dan **Database transport**.
5. Untuk database kedua, klik **+ Add database (1/8)**. Contoh fiktifnya adalah example_audit dengan filename example-audit.sql. Setiap nama berkas harus unik.
6. Gunakan **Move up** atau **Move down** untuk menentukan urutan dump. **Remove database** menghapus entri dari konfigurasi backup berikutnya.
7. Klik **Update Plan**. Saat membuat plan baru, selesaikan formulir dengan **Create Plan**.

Satu plan menerima paling banyak delapan database; engine boleh berbeda. Gunakan satu plan untuk satu aplikasi atau workload yang memang perlu dipulihkan bersama.

## Eksekusi

Alurnya adalah: pre-hook opsional → dump database pertama → dump database berikutnya → backup berkas dan SQL → konfirmasi snapshot → post-hook dan cleanup.

Dump berjalan berurutan. Bila database kedua gagal, database berikutnya dan backup Restic tidak diteruskan sebagai backup sukses. SQL parsial tidak dianggap hasil valid. Satu snapshot juga tidak membuat beberapa database dan filesystem menjadi transaksi atomik; tinjau [konsistensi](/docs/database-backup/artifacts).

## Existing plan

Plan lama dengan satu database tetap dibuka sebagai satu entri. Label **Replace password (blank keeps saved secret)** berarti kolom kosong mempertahankan password tersimpan. Mengubah urutan kartu tidak memindahkan rahasia antar-database: identitas tetap terikat pada entri yang sama. Jangan menghapus lalu menambah kartu hanya untuk mengubah urutan.

## Sesudah backup

Jalankan **Backup Now** setelah menyimpan konfigurasi. Pada **Backups**, tunggu **Complete**, lalu gunakan **Browse** untuk mencari berkas aplikasi dan /pluton/database/example-app.sql dalam snapshot yang sama. Tinjau peringatan bila tampil **Complete***.

Jika gagal, baca tahap dan kode kegagalannya melalui [opsi dump](/docs/database-backup/dump-options); masalah privilege, TLS, atau klien tidak selalu berarti password salah. Setelah sukses, gunakan [Recovery Test](/docs/recovery-testing) untuk pengujian sementara atau [Restore Database](/docs/database-restores) untuk mempertahankan database hasil pemulihan selama retensi yang dipilih.
