# Menjaga SECRET, ENCRYPTION_KEY, dan kredensial

Kredensial storage/database, kunci aplikasi, password repository, dan identitas Agent mempunyai fungsi berbeda. Kehilangan salah satunya dapat menghalangi pemulihan walaupun file backup masih ada. Siapkan penyimpanan privat off-host dan uji pemulihan konfigurasi secara terisolasi sebelum mengandalkan instalasi untuk kebutuhan operasional.

## Preservasi

`SECRET` melindungi kredensial aplikasi tersimpan dan sesi yang ditandatangani. `ENCRYPTION_KEY` berkaitan dengan konfigurasi Restic/Rclone existing. Password per-repository terkelola dan secret/identity Agent mempunyai lifecycle sendiri. Mengganti password layanan tidak otomatis memutar semua kunci tersebut. Jangan mengganti atau meregenerasi key saat upgrade.

1. Sebelum maintenance, identifikasi volume data, salinan database aplikasi yang konsisten, file konfigurasi/kunci persisten, image/revisi rilis, dan identitas Agent. Catat lokasi serta penanggung jawab, bukan nilainya, pada checklist.
2. Simpan pasangan konfigurasi/database/kunci dari titik waktu yang konsisten di penyimpanan privat terkontrol, dengan akses dan retensi yang disetujui.
3. Pastikan salinan off-host dapat dibaca pihak yang berwenang ketika host utama tidak tersedia. Backup yang hanya ada pada disk host yang sama belum mencakup kehilangan host.
4. Uji pembacaan kredensial dan akses snapshot pada instance pemulihan terisolasi tanpa dispatch terjadwal ke produksi. Catat apa yang diuji dan hasil nyata; lihat [disaster recovery](/docs/operations/disaster-recovery).

Contoh: pengelola `app-01` mencatat lokasi arsip konfigurasi privat dan pemiliknya. Panduan publik hanya menyebut `example.internal`; tidak memuat key, username akun nyata, atau password contoh.

Missing/corrupt/conflicting key harus ditangani dengan pemulihan material asli yang konsisten. Mengubah environment agar startup lolos dapat membuat kredensial lama tidak terbaca. Jangan menyalin key dari instalasi lain, mereset identitas Agent, atau membuat repository pengganti untuk menyembunyikan kegagalan decrypt.

## UI dan logs

Kolom password database, recovery target, dan durable notification tidak menampilkan kembali plaintext tersimpan. Marker configured menunjukkan keberadaan credential, bukan bukti nilai masih valid. Pada channel **Settings → Webhooks & Email → Edit**, **Saved privately — leave blank to keep** berarti kosong mempertahankan credential; **Explicitly clear the saved credential** menghapusnya. Uji koneksi melalui tindakan yang didukung dan periksa hasil akhirnya.

Saat membuka **Settings → App Logs** atau **View Logs** pada plan, ambil hanya stage/code yang relevan. Jangan membagikan `.env`, konfigurasi terdekripsi, SQL dump, SSH/repository password, HMAC/signing secret, lease token, setup QR 2FA, atau seluruh SQLite dump. Sanitasi hostname, path, akun, dan inventaris sebelum laporan publik.

## Rotasi operasional

Untuk credential lama pada script SYS MON, inventaris consumer secara privat. Siapkan credential pengganti dengan hak minimum, uji koneksi/dump/restore yang relevan pada lingkungan disetujui, ubah consumer pada maintenance window, verifikasi hasil, lalu revoke credential lama setelah dependensi selesai. Pertahankan rollback yang masih sah selama window; jangan membatalkan akses pemulihan repository lama terlalu dini.

Rotasi master encryption key memerlukan prosedur migrasi/re-encryption tersendiri; mengganti environment bukan prosedur rotasi. Kunci Agent dan password repository juga memerlukan prosedur khusus. Panduan ini tidak menjalankan rotasi atau mengubah script/server. Ikuti [SHADOW](/docs/migration/shadow) dan [CUTOVER](/docs/migration/cutover) untuk gate peralihan yang dapat ditinjau.
