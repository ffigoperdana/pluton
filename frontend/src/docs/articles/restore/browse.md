# Menemukan dan mengunduh isi snapshot

Gunakan **Browse** untuk memastikan backup berisi data yang dibutuhkan sebelum memulihkan atau mengunduhnya. Yang ditampilkan adalah isi snapshot pada waktu backup, sehingga berkas yang sekarang hilang dari aplikasi masih dapat terlihat di sana.

## Browse

1. Buka plan → tab **Backups**.
2. Pilih pekerjaan **Complete** dengan waktu yang sesuai. Buka menu titik tiga dan klik **Browse**.
3. Telusuri direktori pada panel pohon atau buka direktori pada daftar.
4. Gunakan **Search in current Directory...** untuk membantu mencari isi yang ditampilkan. Pencarian tidak mengganti snapshot yang sedang dibuka.
5. Periksa nama, ukuran, dan path lengkap. Tutup tampilan dan gunakan **Restore** dari baris backup yang sama untuk memilih beberapa berkas dengan pratinjau.

Contoh fiktif: snapshot menyimpan /srv/example-app/uploads/example.txt. Hierarki srv/example-app dapat muncul utuh karena path sumber awal absolut. Dump native database berada pada /pluton/database, misalnya example-app.sql; bukan di folder kerja sementara agent.

Browser dan cache tampilan tidak mengubah metadata snapshot. Untuk managed remote, hanya regular file dan direktori yang didukung dalam staging; symlink atau node khusus dapat menyebabkan permintaan ditolak.

## Download

**Download** pada menu backup managed remote menghasilkan TAR seluruh snapshot. Ini bukan unduhan hanya untuk baris yang sedang terlihat atau hasil pencarian.

1. Pastikan perangkat pengunduh memiliki ruang dan koneksi yang memadai. Data logical dapat jauh lebih besar daripada ukuran repository setelah kompresi dan deduplikasi.
2. Pada baris backup yang sudah diperiksa, klik **Download**.
3. Tunggu unduhan selesai. Bila perlu membatalkan proses yang masih berjalan, gunakan **Cancel Download** pada menu pekerjaan tersebut.
4. Simpan arsip di lokasi privat. Ekstrak hanya ke direktori staging baru yang telah diperiksa, lalu tinjau struktur dan izin berkas sebelum menggunakannya.

Jangan mengekstrak langsung ke root filesystem atau folder produksi. SQL di dalam TAR tetap mengandung data aplikasi yang perlu dilindungi. Mengunduh SQL tidak mengimpor database; gunakan [Restore Database](/docs/database-restores) bila backup memiliki metadata native yang diperlukan.

## Batas sumber recovery

Browse, Download, Restore, Recovery Test, dan Persistent Restore managed menggunakan repository primary yang terikat backup. Keberhasilan replikasi tidak berarti UI dapat membaca mirror sebagai sumber pemulihan managed. Bila primary tidak tersedia, lihat [batas recovery mirror](/docs/replication/retention-restore) dan minta administrator meninjau jalur pemulihan yang didukung.

## Error

Snapshot hilang, password repository tidak cocok, jaringan gagal, timeout, atau akses storage ditolak merupakan kegagalan yang perlu diperiksa. Jangan memilih snapshot terbaru sebagai pengganti tanpa keputusan pemulihan yang baru. Jangan memberi izin tulis tambahan atau mengubah TLS untuk mengatasi unduhan gagal.

Jika Browse kosong, periksa direktori aktif, pencarian, dan backup yang dipilih. Jika masalah berulang, simpan tahap dan pesan aman tanpa isi SQL, password, atau path produksi pada laporan publik. Untuk berkas terpilih, lanjutkan ke [selection](/docs/restore/selection) dan [staging](/docs/restore/staging).
