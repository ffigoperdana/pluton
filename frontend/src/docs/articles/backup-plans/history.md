# Menjalankan Backup Now dan membaca riwayat backup

Gunakan riwayat untuk memastikan kapan backup selesai, isi snapshot mana yang dipakai, dan pekerjaan apa yang memerlukan tindak lanjut. Contoh pada halaman ini adalah plan `Backup contoh app-01` dengan source latihan `/srv/example-app`.

Sebelum memulai, pastikan source dan destination sudah siap serta tidak ada pekerjaan backup/restore yang sedang berjalan pada plan tersebut. **Backup Now** meminta pekerjaan baru; klik satu kali lalu ikuti progress-nya.

## Menjalankan job

1. Buka plan melalui **Backup Plans**.
2. Klik **Backup Now** dan tunggu respons awal. Pesan bahwa backup dimulai belum membuktikan snapshot selesai.
3. Perhatikan progress nyata. Pada Managed Agent, tahapan dapat mencakup validasi source, persiapan/dump database, persiapan repository, backup file, dan verifikasi snapshot.
4. Tunggu status terminal, lalu buka tab **Backups**.
5. Klik nama backup untuk melihat detail event/statistik dan catat waktu serta ID yang diperlukan untuk korelasi.

Progress dapat tidak menampilkan persentase saat total belum diketahui. Itu tidak otomatis menunjukkan pekerjaan macet. Jika concurrency limit tercapai atau mesin tidak siap, periksa pesan yang diberikan sebelum mengirim permintaan baru.

## Menemukan backup yang benar

Gunakan **Today**, **7 Days**, atau **30 Days** untuk rentang cepat. Untuk rentang khusus, isi **Start**, **End**, dan timezone tampilan, lalu klik **Apply**. Status **Pending** berarti perubahan filter belum diterapkan. **Clear** menghapus batas tanggal.

Kedua hari kalender yang dipilih disertakan sesuai timezone filter. Tanggal memakai waktu selesai; untuk pekerjaan belum selesai dipakai waktu mulai, dan record lama dapat memakai waktu dibuat sebagai fallback. Timezone tampilan ini tidak mengubah jadwal backup.

Jika riwayat kosong, periksa filter dan halaman pagination dahulu. **No backups match this date range.** berbeda dari **No finished backups yet.**. Jika riwayat gagal dimuat, gunakan **Retry** setelah masalah koneksi ditangani; error pemuatan bukan bukti snapshot hilang.

## Membaca hasil

| Informasi | Cara membacanya |
| --- | --- |
| **Complete** | Pekerjaan snapshot selesai; hasil pemulihan tetap perlu diuji |
| **Complete · Cleanup warning** | Snapshot selesai, tetapi pekerjaan sesudah backup atau cleanup perlu ditinjau |
| **New Files**, **Modified Files**, **Unmodified Files** | Perbandingan file terhadap parent yang dipilih |
| **Snapshot Size** | Ukuran logis isi snapshot, bukan pemakaian fisik repository |
| **Data Added**, **Compressed Data Added** | Data baru sebelum dan sesudah kompresi |
| **Recovery: Not tested** | Belum ada uji recovery untuk backup tersebut |
| **Not measured** | Nilai tidak tersedia; bukan angka nol |

Restic backup summary tidak mengukur jumlah file terhapus. **Deleted Files: Not measured** tidak berarti tidak ada file yang dihapus dari source. Baca [statistik incremental](/docs/backup-plans/incremental) sebelum menarik kesimpulan dari counter.

## Aksi sesudah backup

Buka menu tiga titik pada baris backup yang dipilih. **Browse** menampilkan isi snapshot, **Download** mengambil data melalui alur unduhan, dan **Restore** membuka pemulihan file. Untuk Managed Agent yang memenuhi syarat, tersedia **Run Recovery Test**, **Restore Database**, serta **View Recovery Result** jika hasilnya ada.

Aksi tersebut harus merujuk snapshot dari baris yang Anda periksa. Gunakan [staging](/docs/restore/staging) untuk latihan pemulihan. Native database recovery serta file restore Managed Agent saat ini memerlukan repository primer; restore langsung dari mirror managed belum tersedia.

Jika ada replikasi, buka badge/detailnya dan periksa setiap tujuan. Keberhasilan primer, replika, recovery, dan delivery notifikasi adalah hasil terpisah. Kegagalan delivery notifikasi tidak membatalkan snapshot yang sudah selesai.

## Jangan lakukan

Jangan mengedit snapshot ID atau counter di database untuk mengubah tampilan. Jangan menghapus snapshot agar jumlah **New Files** terlihat lebih kecil. Jika perlu menghapus backup atau plan, tinjau dependency [Database Restore Management](/docs/database-restores) dan [panduan penghapusan plan](/docs/backup-plans/delete).

Untuk kegagalan, kumpulkan tahap, kode error aman, waktu, dan ID terkait tanpa menyalin password, raw environment, atau dump. Lanjutkan ke [pemecahan masalah](/docs/troubleshooting).
