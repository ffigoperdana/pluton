# Menjaga isolasi, kunci, dan kapasitas storage

Sebelum menyimpan data penting, pastikan Anda tahu lokasi repository, siapa yang dapat mengaksesnya, dan bagaimana kunci dipulihkan bila server Pluton hilang. Contoh pada halaman ini memakai source `/srv/example-app` dan repository terpisah untuk plan `app-01`.

## Boundary

Setiap repository managed harus memiliki lokasi yang jelas. Jangan memakai folder yang sama untuk dua plan, mengarahkan satu plan ke induk repository plan lain, atau mencampur file aplikasi dengan isi repository. Pada replika S3 managed, server juga memeriksa identitas endpoint, bucket, dan prefix untuk mencegah tumpang tindih dengan lokasi yang masih dimiliki atau dipertahankan.

Akun source agent memerlukan akses baca file dan traverse direktori. Akun storage managed memerlukan akses yang sesuai untuk menulis repository tujuan. Kebutuhan itu berbeda dari staging restore yang perlu ditulis oleh pekerjaan pemulihan. Jangan memberi akses menulis ke source aplikasi hanya untuk menyelesaikan error backup.

## Encryption

Ada beberapa kunci yang perlu dijaga:

| Bahan akses | Kegunaannya |
| --- | --- |
| Kredensial storage | Mengakses layanan SFTP atau object storage |
| Password repository Restic | Membuka isi repository yang terenkripsi |
| `SECRET` aplikasi | Melindungi kredensial yang disimpan aplikasi |
| `ENCRYPTION_KEY` | Digunakan oleh lifecycle Restic/Rclone standar sesuai konfigurasi instalasi |

Managed Agent mempunyai password repository yang disimpan terenkripsi oleh server. Kredensial provider dan password repository tidak saling menggantikan. Kehilangan kunci aplikasi dapat menghalangi akses meskipun objek backup masih ada.

1. Tinjau [persistensi](/docs/deployment/persistence) dan [pengelolaan kredensial](/docs/security/credentials) sebelum mengisi storage.
2. Simpan salinan konfigurasi dan kunci yang diperlukan melalui prosedur privat operator.
3. Batasi akun storage pada repository yang dimaksud. Untuk replika S3, server menyimpan kredensial dan agent tidak menerimanya.
4. Setelah mengganti kredensial, uji akses melalui alur yang sama, lalu jalankan backup dan restore contoh. Jangan membuat repository pengganti untuk menyembunyikan kegagalan dekripsi.

## Capacity dan retention

Pantau ruang filesystem/bucket, quota, inode bila relevan, cache, log, database kontrol, dan staging. Backup yang kecil di repository dapat menghasilkan file restore yang jauh lebih besar karena kompresi dan deduplikasi.

Atur retensi hanya pada alur yang mendukungnya. Retensi standar, retensi replika managed, dan object lifecycle provider adalah kebijakan terpisah. Penghapusan objek berdasarkan umur tanpa memahami referensi snapshot dapat merusak repository. Managed mirror belum menyediakan physical prune atau restore langsung.

Hasil verifikasi yang baik adalah lokasi setiap repository terdokumentasi secara privat, akses minimum bekerja, ruang mencukupi, dan file contoh dapat dipulihkan. **Add Storage** yang berhasil saja tidak membuktikan hal-hal tersebut.

## Larangan

Jangan menggunakan `chmod 777`, menyalin secret ke screenshot, mematikan TLS, atau menghapus snapshot sebagai perbaikan error persiapan. Repository legacy tetap read-only: tidak ada init, re-key, retensi, prune, unlock, atau repair melalui adopsi awal.

Sebelum menghapus plan, baca [dampak Remove Plan](/docs/backup-plans/delete). Penghapusan metadata dapat meninggalkan data storage, dan retained database restore dapat memblokirnya. Untuk pemeriksaan tambahan, buka [batas keamanan](/docs/security/boundaries).
