# Membuka riwayat backup dari repository lama

Gunakan **Legacy Repositories** untuk melihat dan mengambil data dari repository Restic yang sudah ada. Registrasi ini mempertahankan riwayat lama sebagai sumber baca, sehingga Anda dapat meninjau snapshot tanpa menjadikannya tujuan backup managed baru.

## Sebelum mulai

Administrator harus menyediakan repository pada filesystem lokal yang dapat dibaca Pluton Server, password yang sah, dan akses storage read-only. Contoh path /srv/example-backups/restic pada panduan ini fiktif. Folder sumber aplikasi, misalnya /srv/example-app, harus terpisah dari repository dan staging.

Jika backup lama dijalankan SYS MON, pertahankan SYS MON beserta source dan jadwalnya sebagai acuan utama selama pilot. Membuka repository di Pluton tidak mengambil alih tugas tersebut.

## Pemisahan wajib

Legacy bukan **Backup Plan** managed. Registrasi tidak mengaktifkan scheduler, backup baru, retensi, replikasi, hook recovery, atau import database otomatis. Repository remote harus tersedia sebagai filesystem lokal yang sesuai kontrak read-only; formulir bukan pendaftaran URL storage remote.

Perlindungan diberlakukan di backend. Inspeksi memakai operasi terbatas dan selalu meminta **--no-lock** serta **--no-cache**. Membaca snapshot biasanya dapat membuat lock pada penggunaan Restic umum, sehingga dukungan no-lock dan pembatasan storage benar-benar diperlukan; label READ ONLY pada layar saja tidak cukup.

## Mulai dari antarmuka

1. Buka **Legacy Repositories** pada navigasi.
2. Klik **+ Register**, lalu isi **Display name**, **Local repository path**, dan **Repository password**.
3. Klik **Register read-only repository**. Registrasi memeriksa akses sebelum menyimpan metadata lokal.
4. Buka kartu repository, gunakan **Check access** bila perlu, lalu cari snapshot melalui **Workload**, **Dataset**, atau filter lanjutan.
5. Buka snapshot yang tepat dan gunakan **Restore selected to staging** bila ingin mengambil isinya.

Rincian langkah ada pada [registrasi dan pencarian](/docs/legacy-repositories/registration) serta [restore Legacy](/docs/legacy-repositories/restore).

## Operasi terlarang

Adapter tidak melakukan init, backup, re-key, tag, copy ke repository, retention, forget, prune, unlock, migrate, atau repair. Jangan memakai tindakan tersebut sebagai pemulihan error browser.

Restore tetap menulis berkas tujuan meskipun repository read-only. Penulisan dibatasi ke staging privat milik aplikasi, bukan source asli, repository, atau tujuan bebas yang diketik pengguna.

## Compatibility

Tidak ada jaminan universal untuk seluruh versi Restic, format repository, dan tipe node. Jika kontrak read-only tidak dapat dipenuhi, operasi harus berhenti dengan aman. Jangan memberi izin tulis, memasukkan credential yang lebih kuat, atau melakukan automatic unlock agar akses lolos.

Status tersedia membuktikan pemeriksaan akses saat itu, bukan hasil recovery aplikasi. Uji data representatif pada lingkungan disposable yang disetujui sebelum menjadikannya dasar pemulihan.

## Migrasi

Buat managed repository baru secara terpisah dan jalankan [migrasi paralel](/docs/legacy-repositories/migration). **Remove registration** hanya menghapus pendaftaran lokal; repository dan snapshot lama tetap ada. Tindakan cutover, perubahan script SYS MON, atau penghentian backup lama memerlukan keputusan operasional tersendiri.
