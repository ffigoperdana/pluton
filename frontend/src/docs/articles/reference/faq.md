# Pertanyaan umum operator

## Apa yang harus dibuat lebih dahulu?

Konfigurasikan Storage, siapkan source/Agent, lalu buat Backup Plan. Jalankan backup latihan, Browse snapshot, dan uji Restore sebelum mengandalkan jadwal. Mulai dari [Quick Start](/docs/getting-started/quick-start).

## Mengapa snapshot besar tetapi repository kecil?

Snapshot merepresentasikan isi logis file pada titik waktu tertentu. Kompresi dan penggunaan ulang data membuat pemakaian fisik berbeda. Ukur disk pada storage; jangan menjumlahkan ukuran logis snapshot sebagai kapasitas fisik.

## Apakah backup Complete berarti replica dan recovery sudah berhasil?

Tidak. Periksa hasil primer, tiap replica, Recovery Testing, dan cleanup secara terpisah. SQL import yang tidak dijalankan tetap NOT TESTED, walaupun pemeriksaan artifact lolos.

## Apakah semua file SQL dapat dipakai Restore Database?

File SQL yang ikut backup filesystem dapat diambil sebagai file biasa. Native database recovery memerlukan metadata tepercaya dari managed database backup, snapshot yang sesuai, serta target yang lolos policy. Lihat [SQL artifact](/docs/database-backup/artifacts).

## Apa bedanya Stop plan dengan Stop database?

Pause/Resume Backup Plan mengatur pelaksanaan backup berikutnya. Stop/Resume pada Database Restores mengelola target retained tertentu, tetap tunduk pada TTL, kapasitas, dan otorisasi. Keduanya tidak saling menggantikan.

## Apakah menghapus plan ikut menghapus database retained?

Tidak boleh diasumsikan demikian. Dependency database yang belum selesai cleanup dapat menolak penghapusan dengan HTTP 409. Gunakan Delete khusus pada Database Restore Management jika memang telah disetujui. Lihat [Delete aman](/docs/backup-plans/delete).

## Mengapa S3 mirror belum dapat dipakai restore Managed Agent?

Implementasi copy dan receipt replica tidak otomatis menyediakan jalur Restore yang menjaga seluruh otorisasi dan identitas sumber. Workflow managed saat ini masih memerlukan primer. Lihat [batas mirror](/docs/replication/retention-restore).

## Apakah dokumentasi memerlukan Internet atau login?

Artikel dan indeks pencarian dibundel secara lokal di `/docs`. Membaca dokumentasi tidak memberi akses API atau inventory. Tautan referensi eksternal hanya berguna bila operator memilih membukanya; fitur runtime tetap memerlukan izin masing-masing.

## Apakah mengganti image memperbarui semuanya?

Tidak. Agent, worker MySQL, root host operator, schema, dan konfigurasi deployment perlu dicocokkan tersendiri. Ikuti [pembaruan aman](/docs/deployment/updates).

## Kapan sistem backup lama boleh dihentikan?

Setelah beberapa backup terjadwal representatif, verifikasi SQL, rehearsal file/database recovery, kapasitas/replica, dan rencana rollback diterima melalui persetujuan cutover. Satu Complete belum cukup; gunakan [checklist migrasi](/docs/migration/cutover).
