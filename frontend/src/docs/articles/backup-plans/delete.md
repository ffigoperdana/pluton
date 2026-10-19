# Menghapus Backup Plan dan memilih nasib data backup

Gunakan **Remove** jika plan memang tidak lagi diperlukan. Untuk penghentian sementara, gunakan **Pause**. Penghapusan plan menghilangkan plan serta riwayat terkait dari Pluton; nasib data repository bergantung pada mode plan dan pilihan pada dialog.

Sebelum menghapus plan contoh `Backup contoh app-01`, pastikan file yang dibutuhkan sudah dapat dipulihkan, lokasi repository diketahui, dan tidak ada orang yang masih bergantung pada riwayat itu. Periksa bahwa destination bukan source aplikasi atau folder bersama.

## Memeriksa pekerjaan dan dependency

1. Buka plan dan periksa backup/restore aktif. Tunggu pekerjaan selesai sebelum penghapusan.
2. Periksa replika Managed Agent. Status pending, berjalan, atau uncertain harus ditangani terlebih dahulu; backend dapat menolak dengan 409.
3. Tinjau recovery yang masih menggunakan plan. Pekerjaan recovery aktif juga dapat menghalangi penghapusan.
4. Buka [Database Restore Management](/docs/database-restores) bila masih ada database hasil restore yang dipertahankan dari plan tersebut.
5. Catat secara privat lokasi data yang akan dipertahankan dan prosedur aksesnya sebelum menghilangkan riwayat UI.

Database hasil restore yang persisten **tidak ikut dihapus secara cascade** ketika plan dihapus. Backend menolak penghapusan dengan HTTP **409** dan kode `RETAINED_DATABASE_RESTORE_DEPENDENCY` sampai cleanup yang diperlukan selesai serta diverifikasi. UI menyediakan **Open Database Restore Management** untuk menanganinya.

Record yang tampak sudah dihapus belum tentu cukup jika cleanup belum verified, masih ada import lease, atau lifecycle otomatis belum menyelesaikan penghapusan resource. Ikuti [pemeriksaan](/docs/database-restores/inspect) dan [cleanup](/docs/database-restores/delete) yang disediakan; jangan mengedit database Pluton atau menghapus record untuk melewati guard.

## Menggunakan dialog Remove Backup Plan

1. Pada halaman plan, buka menu tiga titik **More plan actions**, lalu pilih **Remove**.
2. Baca dialog **Remove Backup Plan**.
3. Tinjau **Remove backup data from the Storage**. Nilai awalnya mati, sehingga permintaan memakai `removeData=false`.
4. Pilih sesuai tabel dampak di bawah.
5. Klik **Yes, Remove Plan** satu kali dan tunggu hasil. Jangan menutup pesan yang memuat lokasi tersisa sebelum mencatatnya secara privat.

## Dampak pilihan data

| Mode plan dan pilihan | Hasil saat penghapusan berhasil |
| --- | --- |
| Standar, toggle mati / `removeData=false` | Jadwal, plan, dan riwayat terkait dihapus; data storage dipertahankan sesuai permintaan |
| Standar, toggle aktif / `removeData=true` | Server memeriksa scope, lalu mencoba menghapus repository primer serta replika yang diikutkan konfigurasi replikasi aktif |
| Managed Agent, toggle mati / `removeData=false` | Metadata plan/riwayat dihapus; repository primer SFTP dan replika managed tetap disimpan |
| Managed Agent, toggle aktif / `removeData=true` | Repository primer SFTP dan replika managed tetap disimpan; opsi ini tidak melakukan penghapusan fisik pada mode managed |

Pada Managed Agent, backend mempertahankan informasi akses repository sebelum menghapus record plan yang aktif. Pesan hasil menyebut data dipertahankan untuk cleanup manual. Data yang tersisa tidak berarti plan atau riwayat lama dapat langsung dibuka lagi di UI. Jangan menghapus kunci/config aplikasi hanya karena plan sudah hilang.

Pada alur standar, penghapusan data menargetkan path repository, bukan satu snapshot. Path primer kosong tidak dipurge; daftar replika yang dibersihkan bergantung pada konfigurasi replikasi yang aktif saat operasi. Tujuan yang sudah dilepas atau dipertahankan sebagai resource lain bukan alasan untuk menghapus seluruh bucket.

## Batas penghapusan standar

Backend menolak target root atau path tidak aman dan memeriksa tumpang tindih dengan resource lain yang masih tercatat: repository primer/replika plan lain, legacy, serta repository yang dipertahankan. Pemeriksaan S3 mempertimbangkan endpoint, bucket, dan prefix agar alias storage tidak membenarkan penghapusan lokasi yang sama.

Jika pemeriksaan menolak, pertahankan data dan tinjau pemetaan tujuan. Jangan mengganti path ke induknya, menghapus proteksi, atau memakai kredensial dengan hak lebih luas untuk melanjutkan. Penghapusan database hasil restore tetap dilakukan melalui [pengelolaan resource restore](/docs/database-restores/resources), bukan melalui toggle storage ini.

## Memeriksa hasil dan data tersisa

Sesudah sukses, plan tidak lagi tampil pada **Backup Plans**. Baca pesan hasil sampai selesai. Pada alur standar, kegagalan purge dapat meninggalkan sebagian data sementara metadata plan tetap terhapus. Pesan tersebut memuat path yang tidak berhasil dibersihkan; keberhasilan remove plan tidak membuktikan semua byte terhapus.

Untuk korelasi teknis, hasil storage dapat berupa `retained_by_request`, `retained_intentionally`, `removed`, atau `cleanup_failed`. Bedakan penolakan sebelum penghapusan dari penghapusan metadata yang sukses dengan cleanup warning.

Jika data memang perlu dibersihkan kemudian, lakukan peninjauan tersendiri atas lokasi, kepemilikan, kunci, dan kebutuhan pemulihan bersama operator. Jangan menjalankan prune, unlock, atau penghapusan otomatis terhadap repository legacy. Lihat [keamanan storage](/docs/storage/security) dan [batas pemulihan/retensi replika](/docs/replication/retention-restore).
