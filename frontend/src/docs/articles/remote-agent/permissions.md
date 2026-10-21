# Memberi agent akses baca yang tepat ke source

Gunakan panduan ini saat agent sudah ONLINE tetapi source ditolak atau beberapa file tidak terbaca. Administrator host perlu memeriksa dua hal: folder itu termasuk allowed roots, dan pengguna service `pluton-agent` mempunyai izin baca yang cukup.

Contoh berikut menggunakan `/srv/example-app`. Semua pemeriksaan dijalankan pada mesin agent. Pemeriksaan izin tidak membuat backup dan tidak mengubah file aplikasi.

## Canonical containment

Agent menyelesaikan source dan allowed roots ke path sebenarnya sebelum memeriksa batas. Misalnya source `/var/www/example-app` adalah symlink ke `/srv/example-app`; lokasi yang harus diizinkan adalah lokasi hasil resolusinya. Mengizinkan nama symlink saja tidak membolehkan akses ke target di luar allowed roots.

Setiap direktori induk memerlukan izin traverse/execute. Direktori source memerlukan read serta execute, dan file regular memerlukan read. Izin menulis pada source tidak diperlukan. Exclusion di plan tidak memperluas allowed roots.

## Diagnostik lokal read-only

1. Pastikan source pada **Remote Backup Source*** adalah satu path absolut Linux yang benar.
2. Pada Agent 0.6.0 atau lebih baru, buka **Sources → mesin → Source Access**. Periksa **Host-approved roots**, **Effective roots**, status izin, dan revision. Agent lama tetap memakai konfigurasi statis; **Allowed roots configured: Yes** bukan bukti seluruh file terbaca.
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

## Menambah beberapa source dari UI

Periksa **Authorization Mode** dan scope yang dilaporkan Agent. Dalam
**Server-Managed**, administrator host sudah mendelegasikan batas canonical.
Validasi beberapa folder, tinjau hasil canonical, lalu Apply melalui UI. Folder
baru di dalam delegasi tidak memerlukan persetujuan SSH lagi; folder di luarnya
tetap tidak dapat digunakan. Izin baca/traverse Linux masih wajib.

Dalam **Host-Approved**, gunakan alur Request Access dan perintah persetujuan lokal
di bawah. Perubahan mode yang belum disetujui host ditampilkan sebagai pending
host setup, bukan akses aktif. Pause plan terdampak dan drain pekerjaan sebelum
peralihan; kembali ke Host-Approved tidak mempertahankan akses khusus delegasi.

Masukkan beberapa path absolut Linux pada **Application source paths**, satu per baris. **Validate paths** hanya memeriksa path yang diminta dan menampilkan target canonical tanpa mengubah akses. **Request access** mengirim perubahan pilihan; path di luar maksimum host tetap **Pending host approval**.

Salin **Copy host approval command** untuk administrator host. Perintah lokal itu memeriksa Agent ID dan revision, lalu menyetujui hanya direktori canonical yang ditinjau. Tidak ada remote shell, perubahan ACL otomatis, atau izin untuk seluruh filesystem. Host approval tidak langsung mengaktifkan source: lakukan **Refresh agent report**, pilih root, lalu **Apply enabled roots**. Perubahan policy tidak memerlukan reinstall atau restart service.

Untuk menghapus pilihan, nonaktifkan root yang sesuai. UI menyebut plan terdampak; pause plan tersebut, tunggu backup antre/aktif selesai, dan konfirmasi sebelum menerapkan. Root yang tidak terbaca tetap tercatat sampai sengaja dihapus. Pencabutan maksimum host merupakan tindakan operator lokal yang terpisah.

Pada plan baru, pilih root efektif atau gunakan **Validate source path**, periksa hasil canonical, lalu **Use validated canonical path**. Permintaan pending belum dapat dipakai sebagai source backup. Source plan existing tetap terkunci; validasi tidak memindahkan repository atau mengganti kredensial.

Jika policy atau durabilitas state tidak dapat diverifikasi, Agent menolak akses. Jangan menghapus file state, mengulang enrollment, atau mengubah revision untuk mencoba memulihkannya. Ikuti prosedur operator yang telah ditinjau.

## Meninjau riwayat Source Access

Pada detail mesin, **Source Access → Recent requests** menampilkan lima request
terbaru, termasuk validasi, perubahan akses dan perubahan mode. Setiap baris
meringkas jenis, status dan waktu. Klik **Details** untuk melihat request ID,
path yang diminta/canonical, hasil validasi, alasan, versi/revision serta waktu
penyelesaian. Detail tetap dibatasi dalam area scroll; tidak ada riwayat yang
dipotong atau dihapus dari database audit.

Gunakan **View all requests** untuk membuka history dengan 10 request per halaman,
urutan terbaru dahulu, serta filter **Status** dan **Type**. **Previous** dan
**Next** menelusuri kumpulan request yang sama walaupun request baru masuk.
**Refresh history** kembali ke halaman pertama dan memasukkan request terbaru;
perubahan filter juga kembali ke halaman pertama. Status request dapat berubah
ketika Agent mengonfirmasi hasil; ini bukan ekspor snapshot database yang beku.

Membuka atau memperluas history hanya membaca data. Tombol **Cancel request** dan
persetujuan host yang sudah ada tetap merupakan tindakan eksplisit tersendiri;
melihat history tidak memberikan akses. Modal dapat ditutup dengan Escape dan
mengembalikan fokus ke tombol pembuka. Jika history gagal dimuat, periksa sesi
administrator lalu klik **Refresh history**. Jangan membagikan path/policy detail
internal tanpa penyamaran.

## ACL minimum

Administrator dapat memberi ACL read-only khusus service account: traverse pada induk yang diperlukan, read/traverse pada direktori source, serta read pada file. Periksa ACL mask efektif dan kebijakan file baru/default ACL agar backup berikutnya tidak gagal setelah aplikasi membuat file.

Jangan menggunakan `chmod 777`, mengganti ownership aplikasi menjadi agent, memberi grup dengan akses tulis luas, atau mengizinkan seluruh disk untuk satu folder yang ditolak. Perubahan source melalui symlink tetap diperiksa saat backup.

Setelah akses diperbaiki, ulangi preflight, jalankan satu **Backup Now**, lalu periksa **Browse** dan [restore contoh](/docs/restore/staging). Jika masalahnya justru koneksi agent, buka [diagnostik OFFLINE](/docs/remote-agent/troubleshooting).
