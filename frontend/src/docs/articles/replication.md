# Menambah salinan backup melalui replikasi

Replikasi menyalin snapshot repository utama ke repository tambahan. Gunakan salinan ini untuk menambah redundansi dengan tujuan penyimpanan yang terpisah dan dapat dikelola. Satu plan mendukung nol, satu, atau dua tujuan tambahan. Backup utama dan hasil masing-masing replika dinilai terpisah: **Complete** atau primary SUCCESS tidak berarti seluruh mirror berhasil.

## Pilih alur sesuai jenis plan

| Hal yang diperiksa | Standard Restic Backup | Managed Agent Backup |
| --- | --- | --- |
| Jalur backup utama | Lifecycle Restic standar pada sumber yang didukung | Agent membuat backup ke repository SFTP utama terkelola |
| Tujuan tambahan | Storage yang didukung jalur standar, dengan repository dedicated | Hanya S3 atau S3-compatible HTTPS, 0–2 tujuan |
| Pelaksana penyalinan | Lifecycle backup standar | Server Pluton setelah snapshot utama diverifikasi |
| Paralelisme | Berurutan secara default; **Run replications concurrently** tersedia bila lebih dari satu tujuan | Satu pekerjaan salinan secara global di server; tidak ada opsi concurrent |
| Retry | Retry sesuai pengaturan plan dan aksi retry untuk mirror gagal | Retry terminal failed/cancelled harus eksplisit; uncertain ditolak |
| Lifecycle repository | Memiliki jalur init/copy serta retention/maintenance standar | Copy terverifikasi; tidak menyediakan physical cleanup/prune |
| Pemulihan melalui mirror | Pilihan mirror completed tersedia untuk browse/download pada jalur standar | File restore dan native database recovery tetap memerlukan primary |

Batas Standard tidak berlaku untuk repository Legacy. Jangan menambahkan repository lama sebagai replika untuk mengadopsinya; Legacy tetap read-only dengan [alur terpisah](/docs/legacy-repositories).

## Persiapan

Siapkan storage yang disetujui, akses jaringan dari pelaksana pekerjaan, credential privat, dan repository path khusus plan. Hindari tujuan yang sama atau prefix yang overlap, termasuk storage alias yang menunjuk endpoint/bucket sama. Tentukan siapa memantau hasil replika dan siapa menjaga akses pemulihannya.

Contoh fiktif: `app-01` memakai primary SFTP, lalu dua tujuan `S3-uji-a` dan `S3-uji-b` pada prefix terpisah. Contoh ini menggambarkan alur; tidak menyatakan S3/HCP nyata atau kapasitas server sudah diuji.

## Menambahkan tujuan

1. Buka plan → **Edit**. Pada bagian **Backup Destination***, periksa repository utama yang benar; path utama existing tidak dapat diganti di formulir edit.
2. Aktifkan **Enable Replication**, lalu **+ Add Replication Destination**.
3. Pilih **Select Storage** dan isi path dedicated untuk **Replication Destination 1**. Bila picker sudah menampilkan bucket, isi subfolder saja, misalnya `app-01/replica-a`; jangan mengulang nama bucket.
4. Pada plan existing, klik **Confirm** untuk memasukkan baris baru. Tambahkan tujuan kedua hanya jika dibutuhkan. Gunakan **Move Up**/**Move Down** untuk urutan yang diinginkan.
5. Untuk Managed Agent, ikuti [prasyarat SFTP/S3 dan protected namespace](/docs/replication/managed-agent). Untuk Standard, pertahankan mode berurutan kecuali concurrency memang sudah ditinjau terhadap kapasitas.
6. Simpan dengan **Update Plan**. Bila ada pekerjaan aktif atau binding/ownership ditolak, selesaikan penyebab melalui status yang didukung; jangan memaksa perubahan melalui database.
7. Gunakan backup baru yang diizinkan. Buka **Backups**, klik badge mirrors, dan cocokkan seluruh tujuan dengan snapshot yang diharapkan. Pengaturan tersimpan belum membuktikan data tersalin.

## Memeriksa hasil

Badge **Redundancy incomplete** berarti perlindungan tambahan belum lengkap. Modal **Mirrors for …** menampilkan **Completed**, **Failed**, **In progress**, atau **Pending**, beserta metadata yang tersedia. Baca [status dan retry](/docs/replication/status-retry) sebelum bertindak; **Replication retry queued!** baru berarti mengantre.

Replikasi bukan pengganti restore drill. Catat apa yang benar-benar diuji, terutama [batas restore/retention](/docs/replication/retention-restore) dan [HCP yang belum diuji nyata](/docs/replication/hcp). Jangan menurunkan disk, memori, TLS, ownership, atau concurrency guard untuk mengejar jumlah salinan.
