# Memilih dan menambahkan tempat penyimpanan backup

Storage adalah konfigurasi koneksi ke tempat backup disimpan. Repository adalah folder atau prefix khusus di dalam storage itu. Satu storage dapat digunakan untuk tujuan yang berbeda hanya jika setiap repository tetap terpisah dan tidak saling bertumpang tindih.

Sebelum mengisi formulir, tentukan dari mana backup dijalankan. Pilihan storage primer pada host Pluton berbeda dari pilihan untuk Managed Agent.

## Model storage

| Alur | Storage primer | Salinan tambahan |
| --- | --- | --- |
| Backup filesystem pada host Pluton | Local, SFTP, atau S3 sesuai konfigurasi provider | Mengikuti dukungan replikasi alur standar |
| Backup dari Managed Agent | SFTP dengan subset konfigurasi yang didukung | 0–2 tujuan S3/S3 Compatible Storage, disalin oleh server |
| Membaca repository lama | Melalui Legacy Repositories, bukan plan baru | Tidak menjadi bagian lifecycle managed |

SFTP primer untuk Managed Agent boleh dilayani oleh VM Pluton. Artinya agent tetap mengakses layanan SFTP melalui jaringan; memilih storage Local tidak menggantikan layanan tersebut. Replika S3 dapat memberikan pemisahan lokasi jika berada pada infrastruktur yang berbeda. Kredensial S3 replika hanya digunakan server dan tidak diberikan kepada agent.

## Pemilihan praktis

1. Siapkan lokasi khusus untuk contoh `app-01`. Pastikan kapasitas, izin akses, dan pemiliknya diketahui.
2. Buka **Storages → + New** untuk menampilkan **Add New Remote Storage**.
3. Isi **Storage Name*** dengan nama yang mudah dikenali, misalnya `SFTP contoh`, lalu pilih **Storage Type***.
4. Ikuti panduan [Local](/docs/storage/local), [SFTP](/docs/storage/sftp), [S3](/docs/storage/s3), atau [HCP](/docs/storage/hcp) untuk mengisi field provider.
5. Klik **Add Storage**. Pastikan storage tampil pada daftar sebelum memilihnya di **Backup Destination*** saat membuat plan.
6. Masukkan path repository terpisah pada form plan, lalu jalankan backup dan restore uji.

Hasil yang diharapkan pada tahap storage adalah konfigurasi tersimpan dan pemeriksaan koneksi/listing berhasil. Itu belum membuktikan Restic dapat membuat repository, kapasitas cukup untuk seluruh backup, retensi sesuai, atau hasil dapat dipulihkan. Lanjutkan pemeriksaan sampai [backup pertama](/docs/getting-started/quick-start) selesai.

## Repository baru

Gunakan folder atau prefix baru khusus plan, misalnya `daily/app-01` pada SFTP. Managed Agent hanya boleh menyiapkan tujuan yang belum ada atau sudah ada tetapi kosong; isi yang tidak dikenal ditolak. Error autentikasi, izin, transport, atau konfigurasi bukan bukti bahwa folder kosong.

Repository Restic yang sudah berisi backup lama tidak didaftarkan sebagai managed destination untuk mencoba UI. Gunakan [Legacy Repositories](/docs/legacy-repositories), yang mempertahankan batas read-only dan tidak menjalankan init, retensi, prune, atau unlock.

## Saat konfigurasi gagal

Periksa jenis storage yang dipilih, field wajib, alamat, dan izin akun pada lokasi yang sebenarnya. Nama storage yang berhasil dibuat tidak membuktikan semua opsi provider akan didukung Managed Agent. Form remote hanya menawarkan SFTP primer dan menolak pengaturan yang tidak didukung di backend.

Jangan menaruh password atau access key pada nama storage, path, tiket, atau screenshot. Kredensial provider dan password repository mempunyai fungsi berbeda; mengganti salah satunya secara acak dapat membuat akses yang masih valid menjadi hilang. Pelajari [isolasi dan keamanan storage](/docs/storage/security) sebelum menambahkan data penting.
