# Menjaga data Pluton dan configuration backup

Backup aplikasi sumber dan backup konfigurasi Pluton melindungi hal berbeda. Agar layanan dapat dipulihkan, Anda memerlukan repository backup serta konfigurasi, riwayat, dan key Pluton yang cocok.

## Data yang wajib bertahan

Volume `/data` menyimpan control database SQLite, konfigurasi, key, riwayat pekerjaan, dan workspace aplikasi. Repository Restic berada pada penyimpanan yang dipilih plan. Menyalin salah satunya saja tidak membuktikan keseluruhan sistem dapat dipulihkan.

SQLite menggunakan WAL. Menyalin file `.db` yang sedang ditulis tanpa prosedur konsistensi dapat menghasilkan backup yang tidak lengkap. Jalur deployment menghentikan aplikasi sebelum membuat salinan control database yang diperlukan.

## Self-backup

Gunakan **Settings → Backup Pluton** untuk membuat backup konfigurasi terenkripsi. Prasyaratnya adalah Storage yang dapat ditulis, ruang yang cukup, serta salinan key pemulihan melalui saluran privat yang terpisah.

1. Aktifkan **Back up Pluton's configuration**.
2. Pilih **Where to store backups** dan gunakan lokasi khusus. Contoh fiktif: `pluton-state/latihan` pada storage yang disetujui.
3. Tentukan **Back up every (hours)** dan **Number of backups to keep** sesuai kebijakan.
4. Klik **Update** untuk menyimpan pengaturan.
5. Gunakan **Backup now**, lalu tunggu status selesai dan periksa daftar melalui **View backups**.
6. Jadwalkan rehearsal self-restore pada instalasi disposable dengan versi/schema dan key yang sesuai.

Service dapat melewati upload ketika tidak ada perubahan. Periksa waktu keberhasilan dan status, bukan hanya apakah nama blob baru muncul setiap interval.

## Yang tidak dicakup

Self-backup bukan backup otomatis seluruh repository, filesystem aplikasi sumber, database produksi, maupun instalasi host operator. Inventory dan kredensial yang tersimpan dalam control plane tetap sensitif walaupun blob terenkripsi.

Retensi configuration backup dapat menghapus blob lama melebihi jumlah yang dipilih. Gunakan direktori tujuan khusus, kebijakan off-host, dan verifikasi akses sebelum mengaktifkannya.

## Saat gagal startup

Missing, conflicting, atau corrupt key harus ditangani dengan memulihkan pasangan key/config yang asli. Jangan menghapus config supaya aplikasi membuat key baru. Self-restore harus mengikuti runbook dengan server dihentikan dan pemeriksaan versi/schema; jangan menggunakan opsi paksa sebagai diagnosis awal.

Lihat [disaster recovery](/docs/operations/disaster-recovery), [key dan kredensial](/docs/security/credentials), serta [rollback](/docs/deployment/rollback).
