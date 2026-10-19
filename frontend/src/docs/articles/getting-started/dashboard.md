# Masuk dan menemukan pekerjaan di halaman utama

Sesudah membuka alamat Pluton, masuk melalui **Username**, **Password**, dan **Login**. Halaman utama membantu Anda menemukan plan, mesin sumber, serta storage. Gunakan halaman ini untuk menentukan pekerjaan yang perlu ditindaklanjuti, lalu buka detailnya untuk memastikan hasil.

## Autentikasi awal

Pada deployment Docker, administrator menggunakan akun yang disiapkan operator melalui konfigurasi privat. Instalasi binary/desktop mempunyai alur **Initial Setup** tersendiri: **Admin Username**, **Admin Password**, **Confirm Password**, lalu **Complete Setup**. Muncul atau tidaknya alur tersebut bergantung pada mode instalasi; itu bukan cara mengganti kredensial container yang sudah berjalan.

Gunakan akun yang disediakan bagi Anda. Jika login gagal, periksa instance yang dibuka dan konfigurasi autentikasinya bersama operator. Jangan membuat volume atau kunci enkripsi baru sebagai percobaan memperbaiki login. Lindungi screenshot yang berisi konfigurasi, QR autentikasi, atau token.

## Navigasi

| Halaman | Kapan Anda membukanya |
| --- | --- |
| **Backup Plans** | Membuat plan melalui **+ New**, menjalankan backup, membaca riwayat, dan membuka pemulihan |
| **Sources** | Melihat mesin lokal/remote dan menambahkan mesin lewat **+ Add Remote Machine** |
| **Storages** | Menambahkan konfigurasi tujuan melalui **+ New** dan memeriksa storage yang dipakai plan |
| **Legacy Repositories** | Mengakses repository yang sudah ada melalui jalur read-only |
| **Settings** | Mengelola pengaturan server, self-backup, dan kanal **Webhooks & Email** |
| **Database Restore Management** | Meninjau database hasil restore yang masih disimpan dan membersihkannya melalui alurnya sendiri |

Daftar plan dan storage mempunyai pencarian, pengurutan, serta pilihan tampilan. Misalnya, cari `app-01` untuk menemukan plan contoh. Bila daftar tampak kosong, periksa pencarian dan filter sebelum membuat plan kedua. Jika muncul error pemuatan, muat ulang setelah masalah koneksi ditangani; daftar kosong saat error bukan bukti bahwa datanya sudah hilang.

## Membaca status

1. Buka plan yang Anda cari pada **Backup Plans**.
2. Tinjau pekerjaan terbaru pada tab **Backups**, termasuk status akhir dan waktunya. Plan aktif dapat memiliki backup terakhir yang gagal.
3. Jika pekerjaan berjalan, periksa tahap progress. **Backup Now** yang diterima server belum membuktikan snapshot sudah tersedia.
4. Sesudah **Complete**, buka **Browse** dari menu baris untuk memeriksa isi. Periksa badge recovery dan replika secara terpisah.
5. Di **Sources**, buka mesin terkait dan lihat **Last seen**, **Agent capabilities**, serta **Allowed roots configured** pada panel **Remote Agent**.

Contoh hasil yang sehat: plan `Backup contoh app-01` memiliki backup terbaru **Complete**, file contoh terlihat, dan hasil pemulihannya sesuai. **ONLINE** pada agent hanya menunjukkan heartbeat baru. **Recovery: Not tested** berarti pemulihan belum diuji meskipun snapshot selesai. **Not measured** pada statistik berarti nilai tidak tersedia, bukan nol.

Jika Anda akan menghentikan jadwal sementara, gunakan **Pause** pada halaman plan; **Resume** mengaktifkannya kembali. Penghapusan mempunyai dampak berbeda dan perlu mengikuti [panduan Remove Plan](/docs/backup-plans/delete). Untuk pemeriksaan rutin setelah latihan, lanjutkan ke [operasional harian](/docs/operations).
