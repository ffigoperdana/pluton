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
3. Klik **Create enrollment token**. Konfigurasi distribusi standalone harus tersedia; jika belum, administrator harus melengkapi konfigurasi server. Tidak ada fallback ke monorepo atau moving `main`.
4. Isi **Planned initial source roots** dengan satu atau beberapa path absolut Linux, misalnya `/srv/example-app` dan `/srv/example-worker` pada baris terpisah. UI menolak root luas, traversal, duplikat, dan overlap. Installer menyelesaikan path canonical serta memeriksa akses pengguna service; preview UI bukan bukti realpath host.
5. Gunakan **Copy installation commands** pada host Ubuntu 22.04 baru dengan Bash, Git, Python 3, sudo dan akses HTTPS. Jalankan seluruh blok sebagai administrator biasa, bukan pipe download ke root. Blok clone repository standalone, checkout full SHA yang direview, periksa clean tree serta versi package/runtime 0.7.0, baru memanggil installer root-level.
6. Pilih **Show token** saat diperlukan dan tempel token hanya ke prompt terminal tersembunyi installer. Token tidak masuk command, Git, URL atau clipboard perintah instalasi. **Hide token** menyembunyikannya lagi. Waktu expiry ditampilkan; masa berlaku 15 menit, sekali pakai.

Jika build/download melampaui masa berlaku, jangan mencoba reuse token. Selesaikan investigasi privat dan buat token baru. Menutup dialog bukan revoke. Token berada hanya dalam memori dialog/mutation sementara, tidak disimpan dalam local/session storage.

## Installer

Di dalam checkout standalone pada commit yang telah diverifikasi, bagian installer non-secret adalah:

```sh
sudo bash install-agent.sh \
  --server https://pluton.example.internal \
  --allowed-root /srv/example-app \
  --allowed-root /srv/example-worker
```

Masukkan token pada prompt lokal. Installer menyiapkan runtime privat dan service `pluton-agent`; Node.js global host tidak diganti. Untuk private CA, operator dapat memberikan `--ca-file` yang menunjuk PEM CA tepercaya. Jangan mematikan certificate verification.

Jika browser membuka server lewat alamat yang tidak dapat dijangkau agent, konfigurasi `AGENT_SERVER_URL` dengan origin HTTPS yang benar-benar dapat diakses dan cocok dengan certificate. Alur instalasi baru ini selalu memerlukan HTTPS, termasuk ketika exception HTTP lama masih aktif untuk Agent existing. CA custom pada `AGENT_INSTALL_CA_FILE` harus sudah diprovisikan secara aman, dapat dibaca pengguna service, dan cocok dengan server. Konfigurasi ini tidak mengubah trust Git; untuk Git HTTPS private CA, gunakan konfigurasi trust Git yang direview terpisah.

## Konfigurasi distribusi standalone

Operator server menetapkan `AGENT_INSTALL_REPOSITORY_URL` (HTTPS `.git` tanpa username/password/query), `AGENT_INSTALL_COMMIT` (full SHA lowercase 40 karakter yang telah direview), dan `AGENT_INSTALL_VERSION=0.7.0`. Compose resmi meneruskan nilai ini; restart/redeploy server hanya melalui prosedur deployment terpisah yang diotorisasi. Commit belum tersedia di remote, download gagal, SHA/versi tidak cocok atau konfigurasi kosong menghentikan proses; tidak beralih ke versi terbaru. Konfigurasi ini tidak memodifikasi Agent terdaftar.

Untuk private Git Organization, host administrator mengatur akses read-only melalui credential manager/helper yang disetujui atau akses sementara interaktif sebelum clone. Jangan menaruh PAT pada URL, source, `.env` distribusi, command atau tiket. Artifact archive/distribution privat non-Git belum didukung generator ini: harus memakai transport Git HTTPS yang disetujui atau integrasi artifact terverifikasi terpisah, bukan bypass SHA.

## Setelah instalasi

Periksa service secara lokal:

```sh
systemctl is-active pluton-agent.service
systemctl status --no-pager pluton-agent.service
journalctl -u pluton-agent --since '10 minutes ago'
```

Buka kembali mesin pada **Sources**. Hasil yang diharapkan pada panel **Remote Agent** adalah **ONLINE**, **Last seen** terbaru, versi Restic/Rclone, **Allowed roots configured: Yes**, dan capability `BACKUP_FILESYSTEM`. Lanjutkan dengan [pemeriksaan source](/docs/remote-agent/permissions) dan [plan Managed Agent](/docs/backup-plans/managed-agent).

Installer tidak menyiapkan seluruh ACL source atau memasang client database. ONLINE belum membuktikan semua file dapat dibaca.

## Existing agent

Satu Agent dapat melayani beberapa aplikasi pada host yang sama; buat plan terpisah untuk source yang disetujui. Pada Agent 0.6.0, tambahkan source berikutnya melalui **Source Access**, tanpa reinstall: Validate dan Apply dalam delegasi Server-Managed, atau persetujuan host lokal lalu Apply dalam Host-Approved. Izin database dan hook tetap terpisah dari izin folder.

Jangan memakai `--re-enroll` hanya untuk menambah allowed root. Installer standalone menolak existing install. Pembaruan binary harus mengikuti [pembaruan agent](/docs/remote-agent/updates), mempertahankan identity, konfigurasi lengkap, dan state pekerjaan. Agent monorepo tetap memakai updater monorepo; tidak ada migrasi otomatis ke standalone.

Jika token kedaluwarsa, sudah terpakai, atau tidak lagi diperlukan, gunakan **Revoke token** bila masih tersedia lalu buat token baru sesuai kebutuhan. Jika pencabutan gagal, token mungkin masih aktif; jangan menganggap menutup dialog telah mencabutnya. Untuk mesin yang sudah terdaftar, **Revoke remote machine** adalah tindakan berbeda yang langsung menghentikan penggunaan kredensial agent tersebut.
