# Memeriksa selection dan warning pemulihan

Hasil pemulihan perlu dibaca bersama snapshot, pilihan file, pengujian SQL, dan cleanup. Gunakan artikel ini jika jumlah pilihan terlihat berbeda, Recovery Test **Passed with warning**, atau database uji belum dapat dipakai. Hasil lulus untuk snapshot lama tidak mewakili backup terbaru.

## Gejala

Contoh fiktif: Select All pada snapshot `app-01` menunjukkan 12 regular files dan 3 directories, lalu operator mengira tiga item hilang. Contoh lain: hash SQL valid dan file berhasil direstore, tetapi recovery memberi warning karena import **Disabled**. Keduanya perlu dibedakan dari kegagalan restore sebenarnya.

## Penyebab

Jumlah regular files berbeda dari total entries (files + directories). Filter/search dan status pilihan ancestor/partial juga dapat memengaruhi apa yang terlihat. Pada SQL, validasi artefak/ukuran/SHA-256 tidak menjalankan import ketika Disabled. Warning dapat pula berasal dari cleanup tidak lengkap. Missing identity historis tidak boleh diisi dengan menebak source/snapshot.

## Diagnostik aman

1. Pastikan backup ID dan snapshot exact. Pada plan Managed Agent, bandingkan **Latest Backup**, **Recovery for this backup**, **Latest Recovery Test**, dan **Tested Snapshot**.
2. Pada browse/restore confirmation, baca jumlah files, directories, serta entries dan path pilihan. Periksa selection partial serta filter sebelum menyimpulkan isi hilang.
3. Buka hasil Recovery Test dan baca validasi filesystem, ukuran/hash artefak, `importValidation` setiap database, warning, serta cleanup workspace/database.
4. Untuk database yang dipertahankan, buka [Database Restores](/docs/database-restores) dan periksa status, akses, umur/TTL, serta safe failure code. Jangan menyamakan hasil restore persisten dengan Recovery Test sementara.
5. Untuk penolakan resource, catat stage/code, ruang disk, memory/worker, dan batas pekerjaan. RAM host 4 GiB tidak membuktikan kapasitas import. Ikuti [resources](/docs/database-restores/resources), tanpa menurunkan guard.

## Resolusi

Jika selection yang salah, tinjau ulang pilihan lalu restore ke staging baru yang tervalidasi, terpisah dari source/repository dan tanpa overwrite. Cocokkan jumlah serta isi file/direktori pada tujuan. Jangan memakai original source sebagai target verifikasi.

Jika import Disabled, laporkan SQL **NOT TESTED**. Untuk membuktikan import, siapkan target recovery-only yang memenuhi marker/grant/engine checks, pilih Required sesuai [panduan import](/docs/recovery-testing/import), dan jalankan test baru yang diizinkan. Untuk inspeksi lebih lama gunakan [Database Restore](/docs/database-restores/inspect), kemudian ikuti lifecycle stop/resume/delete/TTL yang didukung.

Jika cleanup tidak lengkap, identifikasi workspace/database yang benar-benar dimiliki pekerjaan, status proses, dan lease. Gunakan aksi pembersihan yang didukung hanya setelah ownership jelas. Jangan menghapus direktori/database luas atau memaksa pelepasan lease. Warning tidak boleh diubah menjadi pass hanya agar dashboard hijau.

## Jangan lakukan

Jangan drop database produksi, menimpa source, menganggap hash SQL sebagai pemulihan semantik, atau memakai pass untuk snapshot lain sebagai bukti latest. Direct mirror file/native database restore Managed Agent belum didukung; gunakan primary dan [batas replika](/docs/replication/retention-restore). Baca [result semantics](/docs/recovery-testing/results) dan [diagnostik Database Restore](/docs/database-restores/troubleshooting) untuk tahap spesifik.
