# Mengatur jadwal, retensi, dan percobaan ulang backup

Atur jadwal agar backup berjalan pada waktu yang dapat dipantau dan tidak mengganggu aplikasi. Tentukan retensi berdasarkan kebutuhan pemulihan serta kapasitas, bukan hanya jumlah file. Contoh di halaman ini adalah plan `Backup contoh app-01` yang dijalankan setiap hari.

Sebelum mengubah kebijakan, pastikan setidaknya satu snapshot telah diperiksa dan satu file sudah dipulihkan. Retensi standar pada host Pluton berbeda dari batas Managed Agent.

## Schedule

1. Buka plan, klik **Edit**, lalu pilih **Schedule & Retention**. Untuk plan baru, buka langkah ini melalui **Next: Setup Schedule & Retention**.
2. Pilih **Backup Interval**. Opsi yang tersedia mencakup **Hourly**, **Daily**, **Weekly**, **Monthly**, **Every x Minutes**, **Every x Hours**, dan **Every x Days**.
3. Isi waktu atau hari yang muncul sesuai interval. Misalnya pilih **Daily** dan jam pengujian yang Anda sepakati.
4. Simpan lewat **Update Plan**; pada form baru, lanjutkan ke **Advanced** sebelum **Create Plan**.
5. Periksa backup terjadwal berikutnya pada tab **Backups**, termasuk waktu mulai, status akhir, dan source yang digunakan.

Jadwal direkonsiliasi dari data plan saat startup. Perhatikan waktu dan timezone server. Mengubah timezone tampilan riwayat hanya mengubah cara tanggal/filter dibaca; itu tidak mengubah jadwal backup.

Gunakan **Pause** untuk menghentikan jadwal sementara dan **Resume** untuk mengaktifkannya kembali. Pause tidak menghapus snapshot dan bukan tombol untuk membatalkan backup aktif. UI menolak pause ketika backup sedang berjalan. Tunggu status akhir sebelum pemeliharaan atau perubahan yang memerlukan keadaan idle.

## Retention

Pada plan standar, tinjau **Backup Retention Policy**:

| Pilihan | Penggunaan |
| --- | --- |
| **Keep Number of Backups** | Menyimpan sejumlah backup terbaru melalui **Number of Backups to Keep** |
| **Remove Backups By Age** | Menggunakan **Remove Backups Older Than** dan batas minimum jumlah backup |
| **Advanced Policy** | Menggabungkan aturan harian, mingguan, atau bulanan; snapshot dipertahankan bila cocok dengan salah satu aturan |
| **Keep All Backups (Disable Pruning)** | Mematikan pruning; pantau pertumbuhan storage secara aktif |

Untuk latihan, **Keep All Backups (Disable Pruning)** menghindari penghapusan otomatis selama Anda memeriksa hasil. Untuk produksi, tinjau umur snapshot, minimum yang dipertahankan, serta ruang sebelum mengganti kebijakan. Nilai yang ditampilkan pada hint bukan bukti kebijakan itu cocok bagi workload Anda.

Pada Managed Agent, kebijakan prune standar tidak ditampilkan pada form ini. Jangan menganggap retensi lokal otomatis berjalan pada primer remote atau replika. Physical prune pada mirror managed belum didukung; baca [retensi dan pemulihan replika](/docs/replication/retention-restore) untuk batas yang berlaku.

Legacy Repositories tidak mempunyai jalur retensi, forget, prune, unlock, atau repair pada adopsi awal. Jangan menghubungkannya ke plan managed untuk membersihkan snapshot lama.

## Retry dan replay

Pada **Advanced → General**, form menyediakan **Retries** dan **Retries Delay**; delay dinyatakan dalam detik. Gunakan nilai sesuai alur yang didukung dan jangan memperpendek interval hanya untuk mengejar error yang berulang.

Retry internal pekerjaan remote memakai identitas pekerjaan yang sama. Pencatatan hasil dan snapshot membantu mencegah eksekusi backup duplikat saat konfirmasi penyelesaian hilang. Sebaliknya, **Backup Now** sesudah pekerjaan terminal adalah permintaan backup baru.

Jika backup gagal, periksa tahap serta kode error sebelum mencoba lagi. Perbaiki izin, credential, TLS, kapasitas, atau source yang ditolak lebih dahulu. Jangan menghapus snapshot atau mengubah database status agar antrean terlihat bersih.

Hasil yang diharapkan adalah satu pekerjaan pada jadwal yang dipilih, status akhir yang dapat dijelaskan, dan isi yang dapat dipulihkan. Gunakan [riwayat](/docs/backup-plans/history) dan [panduan incremental](/docs/backup-plans/incremental) untuk menilainya. Pertahankan sistem backup lama sampai [cutover](/docs/migration/cutover) disetujui.
