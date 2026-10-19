# Menyiapkan kebutuhan sebelum backup pertama

Sebelum membuka formulir backup, tentukan mesin sumber, tempat penyimpanan, dan tempat pemulihan uji. Ketiganya membutuhkan akses serta ruang yang berbeda. Contoh di halaman ini adalah folder `/srv/example-app` pada `app-01` dan tujuan backup yang disediakan khusus untuk latihan.

## Pluton Server

Jalur deployment server yang dicakup repository adalah image Docker yang dibangun dari source untuk Linux amd64, dengan Compose plugin dan volume persisten `/data`. Container berjalan sebagai pengguna non-root. Ikuti [deployment Docker](/docs/deployment/docker) untuk langkah pemasangan; jangan menyalin konfigurasi pengembangan ke produksi tanpa meninjaunya.

Build repository menggunakan Node.js 24 dan pnpm 10.20.0. Restic dan Rclone disertakan pada jalur instalasi yang didukung. Pengguna Web UI tidak perlu memasang Node.js pada komputernya sendiri hanya untuk mengelola backup.

Siapkan ruang bagi database kontrol, cache, log, unduhan, staging restore, dan recovery. Tidak ada ukuran RAM atau disk tunggal yang cocok untuk semua workload. Pemulihan dapat membutuhkan ruang mendekati ukuran logis snapshot; ukuran repository terkompresi tidak cukup untuk memperkirakan kebutuhan staging.

## Source agent

Untuk folder yang berada pada mesin Linux lain, siapkan Remote Agent pada Linux Debian/Ubuntu x86_64 dengan systemd. Administrator membutuhkan hak pemasangan service. Service kemudian berjalan non-root dan hanya membaca folder dalam allowed roots yang dikonfigurasi. Jalur Windows/macOS belum memiliki pengujian penerimaan yang setara.

Sediakan satu folder contoh yang memang boleh dibaca agent, bukan seluruh disk. Database client dipasang terpisah jika nanti diperlukan untuk dump. Installer tidak otomatis memasang semua client database atau mengubah izin file aplikasi.

## Infrastruktur

1. Pastikan browser administrator dapat mengakses Pluton melalui alamat HTTPS yang benar.
2. Pastikan agent dapat menghubungi Pluton secara outbound. Port inbound pada agent tidak diperlukan untuk protokol agent.
3. Untuk Managed Agent, pastikan agent dan server dapat menjangkau SFTP primer. Akun SFTP perlu menulis pada lokasi repository baru yang terisolasi.
4. Jika memakai replika S3, pastikan server dapat mengakses endpoint serta bucket. Kredensial S3 replika disimpan dan digunakan server; agent tidak menerimanya.
5. Sediakan staging pemulihan yang terpisah dari source dan repository, dengan kapasitas serta izin yang sesuai.

## Pemeriksaan sebelum melanjutkan

Sesudah login, buka **Sources**. Mesin remote yang siap dipakai seharusnya menunjukkan **ONLINE**, versi Restic/Rclone, dan **Allowed roots configured: Yes** pada panel **Remote Agent**. Verifikasi [izin source](/docs/remote-agent/permissions) karena ONLINE hanya membuktikan heartbeat.

Pada **Storages**, buat atau pilih tujuan yang sesuai. Keberhasilan menambahkan storage membuktikan konfigurasi/koneksi tertentu; backup dan restore tetap harus diuji. Untuk HCP, gunakan namespace yang sudah ada dan ikuti [persyaratan HCP](/docs/storage/hcp).

Bila folder tidak terlihat, periksa mount dan akses non-root. Bila koneksi gagal, periksa DNS, firewall, waktu host, serta CA yang dipercaya proses terkait. Jangan mengatasi error dengan izin `777`, menonaktifkan TLS, atau memakai repository lama sebagai tujuan percobaan. Setelah siap, lanjutkan ke [Quick Start](/docs/getting-started/quick-start).
