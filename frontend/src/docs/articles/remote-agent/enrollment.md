# Mendaftarkan dan memasang Remote Agent

Daftarkan mesin agar muncul pada **Sources** dan dapat dipilih sebagai sumber backup. Anda memerlukan akses administrator pada host Linux yang didukung, alamat Pluton yang dapat dijangkau host tersebut, dan satu folder contoh yang boleh dibaca agent.

Contoh fiktif pada panduan ini adalah `app-01`, server `https://pluton.example.internal`, dan source `/srv/example-app`. Gunakan alamat serta folder milik lingkungan uji Anda tanpa menyalin secret ke tiket atau chat.

## Token sekali pakai

Pilih **Authorization Mode** saat menyiapkan pemasangan. **Host-Approved** memakai
persetujuan lokal untuk penambahan di luar root yang sudah disetujui.
**Server-Managed** memerlukan delegasi host yang eksplisit atas beberapa prefix
canonical; setelah itu folder di dalamnya dapat ditambah lewat Validate dan Apply
di Pluton tanpa SSH berulang. Tinjau cakupan delegasi dan peringatannya sebelum
menjalankan perintah instalasi. Jangan memilih seluruh filesystem atau direktori
yang mencampur aplikasi dengan kredensial sistem.

Instalasi baru dimulai dalam Host-Approved. Setelah Agent ONLINE, ikuti setup lokal
satu kali di Source Access untuk mengonfirmasi pilihan Server-Managed dan prefix
delegasinya. Agent existing tetap memakai mode lamanya sampai administrator host
menyelesaikan setup tersebut. Pilihan radio di browser sendiri tidak memberikan izin.

1. Buka **Sources → + Add Remote Machine**.
2. Pada dialog **Add Remote Machine**, isi **Machine name**, misalnya `app-01`.
3. Klik **Create enrollment token**. Salin **One-time enrollment token** secara privat sebelum dialog ditutup; token tidak disimpan browser sesudahnya.
4. Isi **Allowed source roots — one application directory per line** dengan satu atau beberapa path absolut Linux, misalnya `/srv/example-app` dan `/srv/example-worker` pada baris terpisah. UI menolak root luas, traversal, duplikat, dan overlap. Installer menyelesaikan path canonical serta memeriksa akses pengguna service; preview UI bukan bukti realpath host.
5. Ikuti **Step 1 — Clone your Pluton community fork** pada mesin agent, lalu gunakan revision fork yang telah ditinjau.
6. Gunakan **Copy secure install command** pada **Step 3 — Secure install**. Nama Step 3 adalah pilihan cara instalasi, bukan perintah untuk mengulangi Quick install.

Token hanya dipakai sekali dan mempunyai umur terbatas. **Quick install** menyertakan token sebagai argumen sehingga dapat masuk shell history atau terlihat pada daftar proses. **Secure install** meminta token secara interaktif dan lebih sesuai ketika Anda ingin menghindari paparan tersebut.

## Installer

Contoh perintah non-secret dari checkout yang telah ditinjau:

```sh
sudo bash installers/install-agent.sh \
  --server https://pluton.example.internal \
  --allowed-root /srv/example-app \
  --allowed-root /srv/example-worker
```

Masukkan token pada prompt lokal. Installer menyiapkan runtime privat dan service `pluton-agent`; Node.js global host tidak diganti. Untuk private CA, operator dapat memberikan `--ca-file` yang menunjuk PEM CA tepercaya. Jangan mematikan certificate verification.

Jika browser membuka server lewat alamat yang tidak dapat dijangkau agent, gunakan origin yang benar-benar dapat diakses host agent dan cocok dengan certificate. HTTP pada LAN tepercaya memerlukan izin eksplisit pada server dan agent; jangan menerapkannya pada jaringan publik atau menggunakannya untuk melewati error HTTPS.

## Setelah instalasi

Periksa service secara lokal:

```sh
systemctl status pluton-agent
journalctl -u pluton-agent --since '10 minutes ago'
```

Buka kembali mesin pada **Sources**. Hasil yang diharapkan pada panel **Remote Agent** adalah **ONLINE**, **Last seen** terbaru, versi Restic/Rclone, **Allowed roots configured: Yes**, dan capability `BACKUP_FILESYSTEM`. Lanjutkan dengan [pemeriksaan source](/docs/remote-agent/permissions) dan [plan Managed Agent](/docs/backup-plans/managed-agent).

Installer tidak menyiapkan seluruh ACL source atau memasang client database. ONLINE belum membuktikan semua file dapat dibaca.

## Existing agent

Satu Agent dapat melayani beberapa aplikasi pada host yang sama; buat plan terpisah untuk source yang disetujui. Pada Agent 0.6.0, tambahkan source berikutnya melalui **Source Access**, tanpa reinstall: Validate dan Apply dalam delegasi Server-Managed, atau persetujuan host lokal lalu Apply dalam Host-Approved. Izin database dan hook tetap terpisah dari izin folder.

Jangan memakai `--re-enroll` hanya untuk menambah allowed root. Pembaruan binary harus mengikuti [pembaruan agent](/docs/remote-agent/updates), mempertahankan identity, konfigurasi lengkap, dan state pekerjaan. Installer tidak boleh diulang tanpa meninjau konfigurasi yang akan ditulisnya.

Jika token kedaluwarsa, sudah terpakai, atau tidak lagi diperlukan, gunakan **Revoke token** bila masih tersedia lalu buat token baru sesuai kebutuhan. Jika pencabutan gagal, token mungkin masih aktif; jangan menganggap menutup dialog telah mencabutnya. Untuk mesin yang sudah terdaftar, **Revoke remote machine** adalah tindakan berbeda yang langsung menghentikan penggunaan kredensial agent tersebut.
