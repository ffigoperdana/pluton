# Mendaftarkan repository lama dan mencari snapshot

Daftarkan repository lama ketika Anda perlu meninjau riwayat Restic yang sudah ada. Siapkan nama tampilan yang mudah dikenali, absolute path pada Pluton Server, dan password repository melalui saluran privat. Contoh Legacy example-app dan /srv/example-backups/restic di halaman ini fiktif.

## Registrasi

1. Pastikan administrator sudah menyediakan filesystem lokal dengan pembatasan read-only dan memisahkannya dari area restore.
2. Buka **Legacy Repositories**, lalu klik **+ Register**.
3. Pada **Register Legacy Repository**, isi **Display name** dengan nama deskriptif.
4. Isi **Local repository path** dengan absolute path pada server. Path pada laptop browser atau alamat SFTP bukan pengganti path server.
5. Masukkan **Repository password**. Password disimpan terenkripsi dan tidak ditampilkan kembali.
6. Klik **Register read-only repository** dan tunggu validasi.
7. Buka kartu repository yang baru muncul. Periksa **Status**, **Last checked**, dan **Backend: Local filesystem**.

Registrasi tidak membuat repository baru, mengubah password, atau menulis tag. Jika backup SYS MON masih berjalan, biarkan source serta proses lama tetap menjadi acuan backup selama pilot.

## Snapshot list

Pada halaman detail, **Check access** menguji ulang akses. Daftar **Snapshots** menampilkan waktu, ID pendek, hostname, tag, dan jumlah path.

1. Pilih **Workload** bila pengelompokan tersedia, lalu **Dataset** untuk mempersempit hasil.
2. Jika belum menemukan snapshot, buka filter lanjutan dan isi Tag, Path, atau Host sesuai metadata snapshot.
3. Klik **Apply filters**. Filter lanjutan mencocokkan nilai metadata secara tepat; sebagian nama belum tentu cocok.
4. Gunakan **Clear** untuk menghapus filter, atau ubah **Snapshots per page** untuk melihat 10, 30, 60, 100, atau **All**.
5. Gunakan halaman **Previous** dan **Next**, lalu klik baris snapshot yang waktunya sesuai.

Workload/Dataset berasal dari pola path metadata yang dikenali. Snapshot tanpa pola tersebut tetap dapat ditemukan melalui daftar dan filter lain; daftar pengelompokan kosong bukan bukti snapshot hilang. Membuka baris menampilkan full snapshot ID untuk pemeriksaan sebelum restore.

## Statistik

**Safe repository statistics** menampilkan **Snapshots**, **Stored size**, **Uncompressed size**, dan **Compression** dari inspeksi Restic yang didukung. Ini bukan penjumlahan ukuran logical seluruh snapshot atau pengukuran langsung pertumbuhan disk storage.

Metadata perubahan historis juga tidak selalu mencatat New/Modified. Jangan menganggap angka yang tidak tersedia sebagai nol.

## Gagal membuka

Jika akses gagal, periksa absolute path, mount, hak baca, password, kompatibilitas output, dan dukungan **--no-lock** bersama administrator. Gunakan **Check access** kembali setelah penyebab diperbaiki.

Jangan mendaftarkan repository yang sama sebagai managed plan, memberi izin tulis, menjalankan unlock, atau mengubah snapshot agar daftar terbuka. Bagikan hanya pesan aman yang telah disanitasi saat meminta bantuan.

## Menghapus pendaftaran

Klik **Remove registration**, baca konfirmasi, lalu pilih **Remove registration** bila pendaftaran lokal memang tidak diperlukan. Repository dan snapshot tidak dihapus; aksi ini juga bukan perintah cleanup staging. Ambil data yang diperlukan dan sepakati penanganan staging bersama administrator sebelum menghilangkan akses lewat registrasi.

Lanjutkan ke [pemulihan Legacy ke staging](/docs/legacy-repositories/restore) atau [migrasi paralel](/docs/legacy-repositories/migration).
