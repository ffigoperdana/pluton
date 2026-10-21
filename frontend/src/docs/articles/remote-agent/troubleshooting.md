# Memperbaiki agent OFFLINE dan capability yang tidak sesuai

Mulai dari gejala pada **Sources**, lalu periksa mesin agent. Hindari menghapus state atau membuat identity baru sebelum mengetahui penyebabnya. Mesin contoh pada panduan ini adalah `app-01` yang menghubungi `https://pluton.example.internal`.

## OFFLINE

1. Buka mesin pada **Sources** dan periksa **Last seen** pada panel **Remote Agent**.
2. Pada host agent, periksa `systemctl status pluton-agent` dan journal service pada rentang waktu kegagalan.
3. Periksa DNS, rute, firewall outbound, serta waktu host. Agent harus menjangkau origin Pluton yang dikonfigurasi.
4. Pastikan certificate HTTPS cocok dengan hostname dan CA dipercaya runtime agent. Keberhasilan browser membuka Pluton tidak membuktikan private Node pada agent memiliki trust yang sama.
5. Jika memakai private CA, gunakan konfigurasi CA yang didukung installer. Jangan menonaktifkan pemeriksaan certificate atau berpindah ke HTTP untuk melewati error.

Sesudah masalah diperbaiki, tunggu heartbeat baru lalu pastikan status **ONLINE** dan **Last seen** berubah. Jika status tetap OFFLINE, gunakan pemeriksaan koneksi berikut dengan identity yang sama.

## Heartbeat-only check

Perintah `check` melakukan heartbeat terautentikasi tanpa mengambil atau menjalankan pekerjaan. Contoh untuk layout instalasi default:

```sh
sudo -u pluton-agent /opt/pluton-agent/runtime/bin/node \
  /opt/pluton-agent/app/dist/index.js check \
  --server https://pluton.example.internal \
  --data-dir /var/lib/pluton-agent \
  --bin-dir /opt/pluton-agent/bin \
  --allowed-roots /srv/example-app
```

Sesuaikan origin, roots, CA, dan konfigurasi lain dengan service yang sebenarnya. Menjalankan CLI dari terminal tidak otomatis membaca seluruh systemd EnvironmentFile. Perbedaan environment dapat menghasilkan hasil koneksi atau inventory yang berbeda.

Hasil yang diharapkan adalah pesan bahwa authenticated heartbeat berhasil dan tidak ada command yang dipoll atau dieksekusi. Jangan memakai `run --once` untuk tes koneksi pada mesin yang mempunyai pekerjaan dalam antrean, karena perintah itu dapat menjalankan pekerjaan.

## Capabilities

| Gejala | Langkah berikutnya |
| --- | --- |
| ONLINE tetapi source gagal | Jalankan [preflight read-only](/docs/remote-agent/permissions) sebagai pengguna service |
| **Allowed roots configured: No** | Tinjau root yang dipasang dan akses ke lokasi sebenarnya |
| `BACKUP_FILESYSTEM` tidak ada | Periksa roots serta instalasi Restic/Rclone yang dipercaya |
| Engine database tidak tersedia | Pasang client yang didukung dan periksa ownership/izin sesuai [persiapan database](/docs/database-backup/engines) |
| Hooks ditolak | Tinjau konfigurasi hook executable yang disiapkan administrator |
| Versi tampak benar tetapi fitur gagal | Cocokkan revision/build server dan agent, bukan label versi saja |

Jangan memalsukan capability di database. Setelah perbaikan lokal, perbarui heartbeat/inventory dan jalankan satu backup contoh. Periksa hasil **Browse** serta restore sebelum menganggap masalah selesai.

## Integrity dan upgrade preflight

Gejala **Installed artifacts differ from their recorded integrity digest** dapat
terjadi sebelum Node upgrader menghasilkan Failed stage. Versi sebelumnya
mengurutkan tree menggunakan locale shell administrator. Tree yang identik dapat
berbeda urutannya pada `en_US.UTF-8`, sedangkan provenance dibuat pada C.
Checkout yang sudah diperbaiki memakai C hanya dalam fungsi hash dan tetap
menerima format=1 C lama. Locale global dan environment Agent tidak diubah.

1. Catat commit checkout, versi Agent, waktu, apakah kegagalan sebelum transaksi
   atau di suatu stage, dan hasil service lama secara privat.
2. Gunakan checkout fixed yang direview dan jalankan
   `sudo bash installers/upgrade-agent.sh --check`. Ini read-only dan tidak
   mengoreksi metadata, menjalankan backup atau membuktikan queue server kosong.
3. Jika mismatch tetap ada, pertahankan instalasi dan `.verified-install`
   asli. Operator/maintainer perlu membandingkan konten, ownership, mode, symlink,
   pin, exact source dan riwayat transaksi secara privat. Hash C yang berbeda
   juga bukan bukti bahwa penimpaan metadata aman.
4. Setelah penyebab dan kompatibilitas terverifikasi, approval retry melalui
   prosedur [upgrade](/docs/remote-agent/updates), normal pause/drain dan rollback.
   Provenance yang memang tercatat di non-C tidak ditulis ulang otomatis.

| Gejala/kode | Pemeriksaan aman | Resolusi dan batas |
| --- | --- | --- |
| Integrity mismatch sebelum stage | Commit fix, pin, original metadata dan perubahan artefak/mode | Hentikan retry bila masih mismatch; eskalasi maintainer/operator, jangan rewrite hash/force/re-enroll |
| `BACKUP_FAILED` / substage COPY/SYNC | Disk/inodes, permission, file/directory sync serta receipt privat | Pertahankan evidence; kegagalan durability perlu review, bukan disable fsync atau chmod source |
| `PROVENANCE_TIMEOUT` | Stage PROVENANCE, banyak file/runtime, CPU/I/O dan batas khusus 300 detik | Tinjau beban; jangan menaikkan global timeout atau mengurangi hashing tanpa review |
| `AGENT_HEALTH_TIMEOUT` atau health/startup gagal | Journal window, preserved configuration/TLS, compatible server dan exact executable | Pastikan rollback/previous service outcome; jangan melewati health check |
| `PRESERVATION_MISMATCH` | Cocokkan identity/config/unit/policy/receipt changes melalui operator | Stop; perubahan legitimate pun perlu review, jangan restore state lama agar cocok |

Gunakan kode yang benar-benar dicetak; contoh tabel bukan diagnosis otomatis.
**Rollback SUCCESS / Previous Agent preserved YES** tidak membuktikan candidate
berhasil, dan kode umum saja tidak membuktikan sebab. Jangan membagikan raw
subprocess output, env, config, receipt atau identity. Jika receipt/ownership
tidak pasti, jangan menghapus upgrade lock/history atau menjalankan installer.
Real systemd startup dan server connectivity tetap perlu pilot terpisah.

## Revoke/remove

**Revoke remote machine** langsung menghentikan penggunaan kredensial agent. Gunakan untuk pencabutan yang memang disengaja, bukan untuk me-refresh status. Tinjau pekerjaan aktif serta plan terkait dahulu. Bila UI melaporkan pencabutan gagal, kredensial mungkin masih aktif.

Uninstall tanpa purge berbeda dari menghapus identity dan state. `--purge` atau `--re-enroll` bukan langkah default untuk OFFLINE. Ikuti [pembaruan yang menjaga identity](/docs/remote-agent/updates).

Untuk meminta bantuan, catat waktu, agent/plan/backup ID yang relevan, tahap, dan kode error yang aman. Samarkan path, hostname, dan isi log; jangan menyertakan token, identity file, password, atau temporary config.
