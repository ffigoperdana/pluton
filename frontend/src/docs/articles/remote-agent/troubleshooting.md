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

## Revoke/remove

**Revoke remote machine** langsung menghentikan penggunaan kredensial agent. Gunakan untuk pencabutan yang memang disengaja, bukan untuk me-refresh status. Tinjau pekerjaan aktif serta plan terkait dahulu. Bila UI melaporkan pencabutan gagal, kredensial mungkin masih aktif.

Uninstall tanpa purge berbeda dari menghapus identity dan state. `--purge` atau `--re-enroll` bukan langkah default untuk OFFLINE. Ikuti [pembaruan yang menjaga identity](/docs/remote-agent/updates).

Untuk meminta bantuan, catat waktu, agent/plan/backup ID yang relevan, tahap, dan kode error yang aman. Samarkan path, hostname, dan isi log; jangan menyertakan token, identity file, password, atau temporary config.
