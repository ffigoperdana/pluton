# Memberi agent akses baca yang tepat ke source

Gunakan panduan ini saat agent sudah ONLINE tetapi source ditolak atau beberapa file tidak terbaca. Administrator host perlu memeriksa dua hal: folder itu termasuk allowed roots, dan pengguna service `pluton-agent` mempunyai izin baca yang cukup.

Contoh berikut menggunakan `/srv/example-app`. Semua pemeriksaan dijalankan pada mesin agent. Pemeriksaan izin tidak membuat backup dan tidak mengubah file aplikasi.

## Canonical containment

Agent menyelesaikan source dan allowed roots ke path sebenarnya sebelum memeriksa batas. Misalnya source `/var/www/example-app` adalah symlink ke `/srv/example-app`; lokasi yang harus diizinkan adalah lokasi hasil resolusinya. Mengizinkan nama symlink saja tidak membolehkan akses ke target di luar allowed roots.

Setiap direktori induk memerlukan izin traverse/execute. Direktori source memerlukan read serta execute, dan file regular memerlukan read. Izin menulis pada source tidak diperlukan. Exclusion di plan tidak memperluas allowed roots.

## Diagnostik lokal read-only

1. Pastikan source pada **Remote Backup Source*** adalah satu path absolut Linux yang benar.
2. Tinjau allowed roots yang dipasang administrator. Panel **Allowed roots configured: Yes** hanya menunjukkan bahwa konfigurasi root ada, bukan daftar seluruh file yang terbaca.
3. Jalankan preflight sebagai pengguna service menggunakan runtime privat instalasi.
4. Gunakan `--scan` untuk memeriksa entri di dalam source secara eksplisit ketika dibutuhkan.

```sh
sudo -u pluton-agent /opt/pluton-agent/runtime/bin/node \
  /opt/pluton-agent/app/dist/index.js preflight \
  --source /srv/example-app --allowed-roots /srv/example-app --scan
```

Tanpa `--scan`, pemeriksaan root dan direktori induk tetap dilakukan. Scan rekursif dibatasi dan tidak dijalankan pada setiap heartbeat. Perintah di atas tidak mengubah ACL atau memperluas kebijakan service.

Hasil yang diharapkan adalah preflight berhasil untuk path yang sama dengan source plan. Jika berhasil tetapi backup masih gagal, catat tahap serta kode error backup dan periksa apakah file atau symlink berubah setelah pemeriksaan.

## Membaca hasil pemeriksaan

| Masalah | Tindakan yang tepat |
| --- | --- |
| Source tidak ada | Periksa ejaan, mount, dan lokasi pada mesin agent |
| Parent tidak dapat dilalui | Tinjau izin traverse pada direktori induk |
| Root tidak dapat dibaca | Tinjau read/execute pada folder source |
| Entri di dalam source tidak terbaca | Periksa pemilik, grup, ACL efektif, dan file yang baru dibuat |
| Symlink keluar batas | Tinjau target sebenarnya; ubah scope hanya bila memang diizinkan |
| Tipe file tidak didukung atau pelanggaran policy | Periksa entri terkait dan kebijakan yang berlaku sebelum mencoba ulang |

Output lokal masih dapat memuat nama path internal. Samarkan path dan identitas sebelum membagikan diagnostik; jangan menyertakan file konfigurasi identity atau kredensial.

## ACL minimum

Administrator dapat memberi ACL read-only khusus service account: traverse pada induk yang diperlukan, read/traverse pada direktori source, serta read pada file. Periksa ACL mask efektif dan kebijakan file baru/default ACL agar backup berikutnya tidak gagal setelah aplikasi membuat file.

Jangan menggunakan `chmod 777`, mengganti ownership aplikasi menjadi agent, memberi grup dengan akses tulis luas, atau mengizinkan seluruh disk untuk satu folder yang ditolak. Perubahan source melalui symlink tetap diperiksa saat backup.

Setelah akses diperbaiki, ulangi preflight, jalankan satu **Backup Now**, lalu periksa **Browse** dan [restore contoh](/docs/restore/staging). Jika masalahnya justru koneksi agent, buka [diagnostik OFFLINE](/docs/remote-agent/troubleshooting).
