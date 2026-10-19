# Menyiapkan koneksi database yang aman

Koneksi database digunakan agent ketika membuat dump. Sebelum mengisi formulir, pastikan DBA sudah menentukan endpoint, database, akun backup, dan jalur jaringan yang boleh digunakan. Host db-01.example.internal pada halaman ini adalah contoh fiktif.

## Dua mode transport

Buka plan → **Edit → Advanced → Database & Hooks**, lalu temukan kartu database. Pada **Database transport**, pilih sesuai letak server:

| Pilihan antarmuka | Kegunaan | Pemeriksaan |
| --- | --- | --- |
| TLS: verify certificate and hostname | Database pada host lain, atau koneksi lokal yang memakai TLS | Sertifikat valid, CA dipercaya, dan Host cocok dengan identitas sertifikat |
| Loopback-only TCP (localhost / 127.0.0.1 / ::1) | Database melalui loopback agent | Host harus localhost, 127.0.0.1, atau ::1 |

Loopback mengacu pada lingkungan tempat agent berjalan. Bila agent berada dalam lingkungan terisolasi, localhost belum tentu menunjuk database yang dimaksud. Mode ini bukan izin koneksi tanpa TLS ke host LAN lain.

## Mengisi dan menguji koneksi

1. Isi **Host**, misalnya db-01.example.internal, dan **Port** yang disetujui. Nilai awalnya 3306 untuk MariaDB/MySQL dan 5432 untuk PostgreSQL.
2. Isi **Database** dengan nama logical database; gunakan satu kartu untuk setiap database.
3. Isi **Username** dan **Password** melalui formulir privat. Jangan taruh password dalam Host, filename, catatan plan, atau argumen hook.
4. Pilih transport, tinjau opsi dump, lalu klik **Update Plan**.
5. Jalankan **Backup Now** dan periksa hasil lengkap pada **Backups**. Penyimpanan formulir belum membuktikan koneksi atau dump berhasil.

DNS, firewall, CA, dan sertifikat disiapkan administrator. Formulir tidak menerima socket path, connection string bebas, atau opsi klien tambahan. PostgreSQL remote memerlukan CA sistem terpercaya dan pg_dump yang kompatibel.

## Credential terpisah

Password backup disimpan terenkripsi dan tidak ditampilkan kembali. Label **Replace password (blank keeps saved secret)** berarti kolom kosong mempertahankan rahasia lama. Isi hanya jika memang ingin menggantinya.

Akun backup membaca sumber. Akun [Recovery Test](/docs/recovery-testing/import) atau [Persistent Restore](/docs/database-restores) bekerja pada target terpisah. Jangan memakai endpoint atau akun produksi sebagai jalan pintas untuk import. Credential sementara dibuat privat dan dihapus sebelum SQL masuk snapshot.

## Reorder dan edit

**Move up** dan **Move down** mengubah urutan dump, bukan pasangan database dan password. **Remove database** menghapus entri beserta ikatan credential pada konfigurasi yang disimpan. Periksa kembali Host, Database, dan label password sesudah perubahan; entri baru memerlukan password sendiri.

## Diagnostik

Untuk kegagalan TLS, tinjau CA, masa berlaku, dan hostname bersama administrator. Jangan mematikan verifikasi untuk memaksa koneksi. Jika login ditolak, periksa akun dan sumber koneksinya. Jika login berhasil tetapi dump gagal, periksa privilege dan routines/events melalui [opsi dump](/docs/database-backup/dump-options).

Bagikan hanya tahap, kode aman, dan engine ketika meminta bantuan. Hilangkan endpoint asli, nama akun, password, konfigurasi koneksi, dan keluaran SQL dari laporan publik.
