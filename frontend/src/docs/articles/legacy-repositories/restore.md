# Mengambil berkas dari snapshot Legacy ke staging

Gunakan restore Legacy untuk memulihkan berkas atau direktori historis ke area terpisah yang dikelola Pluton. Anda tidak perlu mengubah repository atau source aplikasi untuk meninjau hasilnya. Contoh /srv/example-app dan berkas uploads/example.txt berikut sepenuhnya fiktif.

## Read-only source

Siapkan repository yang sudah terdaftar, akses baca yang valid, ruang staging, dan waktu snapshot yang diperlukan. Operasi membaca repository memakai **--no-lock** serta **--no-cache**; bila kontraknya tidak tersedia, berhenti dan minta administrator meninjau kompatibilitas.

Repository read-only tetap menghasilkan penulisan pada staging. Tidak ada pilihan restore ke source asli atau absolute destination bebas pada dialog Legacy.

## Prosedur

1. Buka **Legacy Repositories**, pilih repository, lalu cari snapshot melalui Workload/Dataset atau filter.
2. Klik baris snapshot. Pada **Browse snapshot**, cocokkan waktu, hostname, dan full snapshot ID.
3. Gunakan breadcrumb **Root**, nama direktori, atau **Open** untuk menelusuri isi.
4. Centang regular file atau direktori yang dibutuhkan. Maksimum 20 path pilihan untuk satu pekerjaan; direktori terpilih sudah mencakup anaknya.
5. Periksa indikator item selected. Gunakan **Clear selection** bila perlu memulai lagi.
6. Klik **Restore selected to staging**.
7. Pada **Restore selected items to staging**, baca snapshot dan daftar **Selected paths**, lalu klik **Restore to staging**.
8. Pantau **Staged restore job** hingga **completed**. Periksa jumlah berkas dan byte yang dipulihkan.
9. Untuk mengambil satu regular file yang sudah dipulihkan, gunakan **Download** pada baris berkas tersebut.

Pilihan parent dan child yang tumpang tindih tidak diperlukan; UI menganggap child tercakup. Symlink ditandai **Not selectable** dan tidak boleh dipilih sendiri.

## Safety

Tujuan adalah workspace privat baru milik pekerjaan. Backend memeriksa containment serta pemisahan dari repository, menolak path escape, dan menetapkan never-overwrite. Anda tidak dapat meminta in-place restore, penghapusan isi tujuan, atau arbitrary filesystem destination.

Bila direktori berisi node yang tidak didukung atau hasil tidak aman, hentikan penggunaan dan minta tinjauan administrator. Jangan mengubah path atau request untuk melewati guard.

## Recovery aplikasi

Bandingkan hasil dengan berkas yang diharapkan, ukuran, struktur, dan izin dalam lingkungan privat. **completed** menjelaskan pemulihan berkas, bukan aplikasi siap produksi.

SQL historis tetap berkas data. Adapter tidak mengimpor SQL otomatis, menebak engine dari filename, atau menjalankan hook managed. Import dan pengujian aplikasi dilakukan pada target terisolasi melalui prosedur DBA yang direview. Cutover juga memerlukan keputusan terpisah.

## Error dan cleanup

Saat **queued** atau **running**, gunakan **Cancel restore** bila perlu membatalkan. Tunggu status **cancelled**; pembatalan bukan bukti staging kosong. Jika **failed**, catat pesan aman dan snapshot yang dipilih. Jangan menjalankan unlock, prune, atau repair pada repository sebagai respons.

UI Legacy belum menyediakan tombol hapus workspace atau TTL staging. **Remove registration** juga tidak menjanjikan cleanup data restore. Minta administrator memeriksa job ID dan workspace tepat milik pekerjaan, lalu membersihkan sesuai prosedur privat. Jangan menghapus repository atau direktori data server secara luas.

Lihat [staging umum](/docs/restore/staging) untuk verifikasi manual, serta [migrasi paralel](/docs/legacy-repositories/migration) untuk penggunaan hasil tanpa mengambil alih backup lama.
