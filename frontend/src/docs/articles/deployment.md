# Menyiapkan instalasi Pluton

Panduan instalasi ditujukan kepada operator host. Pengguna yang sudah menerima URL Pluton dan akun administrator dapat langsung mengikuti [backup pertama](/docs/getting-started/quick-start).

## Pilih jalur instalasi

Jalur server yang dipelihara pada fork ini adalah image container yang dibangun dari source dan dipasang menggunakan bundle deployment yang direview. Web UI, API, dan `/docs` dilayani oleh aplikasi yang sama. Dokumentasi tidak memerlukan layanan produksi tambahan.

Repository juga menyimpan packaging historis. Jangan mengasumsikan setiap installer lama sudah setara dengan jalur container, atau menjalankan installer yang mengambil helper upstream yang tidak direview.

## Prasyarat operator

- Host dan akses administrasi yang disetujui, Docker/Compose yang sesuai, serta Python 3.8+ untuk alat deployment host.
- Volume persisten untuk `/data`, ruang staging/cache, serta Primary Storage yang terpisah dari source.
- Origin HTTPS, DNS, routing, dan kepercayaan sertifikat yang sesuai.
- Image dengan digest immutable yang telah diverifikasi, konfigurasi privat, dan rencana rollback.
- Jika memakai database Internal: operator host, worker, image database, dan kapasitas yang diverifikasi secara terpisah.

## Urutan penyiapan

1. Tentukan model Standard Backup atau Managed Agent dan penempatan penyimpanannya.
2. Siapkan bundle deployment dari checkout yang direview. Jangan memulai instalasi baru pada volume instalasi yang sudah ada.
3. Lengkapi konfigurasi privat dan mount yang disetujui sesuai [Compose dan environment](/docs/deployment/configuration).
4. Verifikasi image, volume, dan overlay sebelum operator menjalankan deployment yang disetujui.
5. Periksa kesehatan layanan, login, dan informasi build.
6. Tambahkan Storage, source, lalu plan latihan. Buktikan backup dan Restore sebelum beban operasional dipindahkan.

## Contoh rancangan

Contoh fiktif: satu VM Pluton, volume aplikasi persisten, SFTP primer khusus di VM tersebut, dan Agent pada `app-01`. S3 tambahan baru diaktifkan setelah koneksi dan perilaku vendor diuji pada namespace latihan yang disetujui.

Host 4 GiB tidak otomatis cukup untuk MySQL Internal. Fitur dapat tetap menolak operasi secara aman saat kapasitas kurang; kemampuan menjalankan recovery nyata perlu pengukuran tersendiri.

## Verifikasi dan masalah umum

Health yang baik membuktikan layanan dasar dapat merespons, bukan bahwa semua database, backup, replica, atau receiver siap. Jika startup gagal, pulihkan konfigurasi/key yang benar dan periksa mount; jangan membuat key atau volume baru untuk menghilangkan error.

Lanjutkan ke [image Docker](/docs/deployment/docker), [persistence](/docs/deployment/persistence), dan [pemeriksaan layanan](/docs/deployment/vm-logs).
