# Melindungi akses, kredensial, dan data backup

Pluton menghubungkan dashboard, server, Agent, repository, dan tujuan pemulihan. Siapkan batas akses setiap bagian sebelum pekerjaan pertama. Gunakan akun layanan dengan hak minimum, koneksi tepercaya, serta salinan privat konfigurasi/kunci yang dapat dipulihkan. Contoh `app-01` dan `/srv/example-app` di panduan ini adalah data fiktif.

## Control plane

Web UI/API yang diautentikasi mengelola plan, penyimpanan, pekerjaan, dan konfigurasi. API key memiliki daftar route terbatas; key tersebut tidak otomatis memberi akses administrasi notifikasi, Legacy Repositories, recovery, atau Database Restores. Artikel `/docs` bersifat publik dan hanya memuat panduan bundled, bukan inventaris atau konfigurasi instance.

Untuk melindungi login, buka **Settings → General → Enable Two-Factor Authentication (2FA)**. Pilih **Yes, Enable 2FA**, pindai QR atau setup key pada authenticator privat, masukkan kode enam digit, lalu **Verify & Enable 2FA**. Simpan recovery codes di tempat aman sebelum menutup dialog; kode tidak ditampilkan lagi. Verifikasi login berikutnya menggunakan authenticator. Jangan menaruh QR, setup key, recovery codes, atau cookie pada screenshot/tiket publik.

## Data plane

Remote Agent mempunyai identitas enrollment sendiri, HMAC, perintah bertanda tangan, lease, dan allowed roots. Dashboard **ONLINE** menunjukkan konektivitas, bukan bukti seluruh source terbaca. Kredensial yang dibutuhkan command diberikan hanya pada pengiriman terautentikasi. Untuk replikasi Managed Agent, salinan S3 berjalan di server dan kredensial replika tidak dikirim ke Agent.

1. Daftarkan source yang benar dan allowed roots sempit melalui [panduan Agent](/docs/remote-agent).
2. Jalankan preflight read-only sebagai akun layanan mengikuti [permissions](/docs/remote-agent/permissions), bukan sebagai root untuk menyembunyikan error.
3. Buktikan satu backup dan pemulihan staging yang diizinkan. Periksa snapshot dan metadata, bukan hanya status heartbeat.
4. Catat siapa berwenang mengubah root, storage, akun dump, dan tujuan recovery di runbook privat.

## Network

Gunakan HTTPS dengan sertifikat tepercaya untuk browser, Agent, serta endpoint yang mensyaratkannya. HMAC melindungi integritas pesan, bukan kerahasiaan HTTP. Pengecualian HTTP trusted LAN perlu persetujuan serta segmentasi; jangan mengekspos port aplikasi langsung ke Internet. Ikuti [migrasi HTTPS](/docs/security/https) dan periksa DNS/CA dari tiap runtime.

## Repository dan recovery

Repository terkelola dan repository Legacy mempunyai batas berbeda. Legacy tetap read-only dengan allowlist backend; jangan init, migrate, re-key, tag, backup, forget, prune, atau unlock sebagai pemulihan error. Pembacaan snapshot juga dapat menulis lock sehingga kontrak no-lock dan akses storage read-only harus dipenuhi.

Restore menulis file tujuan. Pilih staging baru yang tervalidasi dan terpisah dari source/repository; jangan restore ke lokasi asli atau melewati never-overwrite. SQL recovery membutuhkan target terisolasi serta pemeriksaan kepemilikan. [Database Restores](/docs/database-restores) menghasilkan database uji tersimpan dengan batas akses/umur sendiri; itu bukan izin impor ke database aplikasi.

## Notifikasi

Channel memakai pemeriksaan DNS/alamat, izin CIDR privat eksplisit, TLS, serta retry terbatas. Pada Webhook, siapkan verifikasi HMAC dan deduplikasi event ID di receiver. Jangan masukkan credential pada URL atau memakai plain transport untuk menghindari error TLS.

Sebelum perubahan, cocokkan [batas isolasi](/docs/security/boundaries) dan [preservasi kunci](/docs/security/credentials). Jika akses ditolak, kumpulkan stage/code aman dan perbaiki penyebab; jangan mengurangi guard agar pekerjaan tampak berhasil.
