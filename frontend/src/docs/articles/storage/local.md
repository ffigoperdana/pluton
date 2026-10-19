# Menggunakan disk lokal sebagai tujuan backup

Storage **Local** menyimpan backup pada filesystem yang dilihat proses Pluton. Pilihan ini cocok untuk latihan atau disk tujuan yang memang dipasang pada host Pluton. Jika Pluton berada di container, path yang Anda pilih adalah path di dalam container; folder pada host perlu dipasang terlebih dahulu.

Untuk source pada Managed Agent, gunakan [SFTP primer](/docs/storage/sftp). Disk pada VM Pluton dapat melayani repository agent melalui SFTP yang disiapkan operator, tetapi memilih **Local** pada form bukan pengganti layanan SFTP itu.

## Sebelum mulai

Administrator perlu menyediakan folder repository yang terpisah dari source, dapat ditulis oleh pengguna non-root Pluton, serta berada pada penyimpanan persisten. Contoh fiktif: source `/srv/example-app` dan tujuan `/srv/example-backups/app-01`. Jangan memilih source sebagai destination, atau menyimpan repository di dalam source yang akan dicadangkan.

Pastikan ruang cukup untuk pertumbuhan backup dan pekerjaan restore. Dua folder pada disk fisik yang sama tetap mempunyai risiko kegagalan disk yang sama. Siapkan salinan pada lokasi berbeda bila tujuan Anda mencakup perlindungan terhadap kegagalan host.

## Menambahkan storage dan memilih folder

1. Buka **Storages → + New** untuk menampilkan **Add New Remote Storage**.
2. Isi **Storage Name***, misalnya `Disk backup contoh`, lalu pilih **Local** pada **Storage Type***. Nama panel tetap menyebut remote meskipun tipe yang dipilih lokal.
3. Tinjau **Advanced Options** hanya bila diperlukan. Klik **Add Storage** dan pastikan storage muncul.
4. Buka **Backup Plans → + New**. Pada **Source & Destination**, pilih source host Pluton pada **Select Device*** dan tentukan **Backup Sources***.
5. Pada **Backup Destination***, pilih storage Local tadi. Isi path absolut tujuan atau gunakan ikon folder untuk membuka **Select Path**.
6. Gunakan folder repository baru khusus plan. Tinjau jadwal dan pengaturan, lalu simpan lewat **Create Plan**.

Path destination tidak dapat diubah melalui edit biasa setelah plan dibuat. Periksa lokasi sebelum menyimpan, terutama saat container memiliki mount yang berbeda dari host. Lihat [panduan Backup Plan standar](/docs/backup-plans) untuk formulir lengkap.

## Memeriksa hasil

Jalankan **Backup Now**, tunggu **Complete**, lalu buka **Browse** pada backup tersebut. Pulihkan satu file ke [staging terpisah](/docs/restore/staging) dan cocokkan isinya dengan source contoh. Periksa pula bahwa data repository tetap berada pada volume persisten yang dimaksud.

Bila folder tidak terlihat pada pemilih, periksa mount dan akses proses server. Bila penulisan gagal, periksa izin, quota, kapasitas, serta apakah mount read-only. Perbaiki akses pada folder tujuan yang spesifik; jangan membuat seluruh source atau filesystem dapat ditulis.

## Hal yang perlu dihindari

Jangan menggunakan folder sementara container sebagai satu-satunya salinan. Jangan memakai repository Restic lama untuk plan baru; gunakan [Legacy Repositories](/docs/legacy-repositories) untuk inspeksi read-only. Jangan menghapus isi repository secara manual saat menguji retensi.

Pada alur standar, **Remove Backup Plan** dapat mencoba menghapus data tujuan jika **Remove backup data from the Storage** diaktifkan. Keputusan tersebut berbeda dari **Pause**. Baca [penghapusan plan](/docs/backup-plans/delete) sebelum membersihkan latihan.
