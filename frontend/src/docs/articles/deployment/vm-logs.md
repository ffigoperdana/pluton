# Memeriksa layanan, resource, dan log

Gunakan pemeriksaan ini ketika menilai kesehatan instalasi atau menyusun laporan gangguan. Pemeriksaan dasar tidak menjalankan backup, SQL import, maupun perubahan repository.

## Prasyarat

Anda perlu akses baca yang disetujui ke host atau akun administrator Pluton. Gunakan lokasi, port, dan kontrak Compose instalasi yang sebenarnya; contoh di bawah adalah contoh fiktif pada host latihan.

## Pemeriksaan dasar

1. Buka Pluton melalui origin yang biasa dipakai pengguna. Pastikan halaman login, plan, dan dokumentasi dapat diakses.
2. Periksa respons GET `/api/health`. Respons sehat adalah JSON `{"status":"healthy"}` dengan HTTP 200.
3. Periksa container/service dan restart count melalui alat operator yang disetujui.
4. Buka **Settings → App Logs** untuk melihat tahap/kode error yang relevan. Ambil potongan tersanitasi, bukan seluruh konfigurasi.
5. Periksa kapasitas volume `/data`, staging, Primary Storage, dan setiap replica.

Contoh pemeriksaan health lokal, tanpa kredensial:

```sh
curl --fail http://127.0.0.1:5173/api/health
```

Jangan mengandalkan HEAD sebagai pengganti GET pada healthcheck. HTML dengan status 200 menunjukkan routing yang perlu ditinjau, bukan health aplikasi yang valid.

## Menafsirkan health

Public health menilai layanan dasar dan SQLite. Endpoint detail membutuhkan autentikasi serta melakukan pemeriksaan komponen tambahan, termasuk penulisan file uji kecil pada data directory. Pemeriksaan detail bukan bukti backup atau recovery berhasil.

Host VM memerlukan waktu yang benar, disk persisten, dan jalur DNS/TLS yang sesuai. Snapshot hypervisor bukan pengganti backup control plane yang konsisten atau rehearsal pemulihan.

## Capacity

Pantau RAM fisik dan memory available, batas cgroup tiap komponen, CPU/PSI, swap, serta disk bebas dan reservasi. Host 4 GiB belum membuktikan tersedia 2.944 MiB untuk admission MySQL Internal. Ukuran SQL juga tetap dibatasi 128 MiB pada workflow tersebut.

Jangan menurunkan guard untuk menyelesaikan pengujian. Resource tidak cukup harus menghasilkan penolakan yang jelas, lalu operator menambah kapasitas atau mengurangi beban yang memang boleh dihentikan.

## Log dan privacy

Korelasikan waktu, ID pekerjaan, tahap, dan safe error code. Jangan membagikan `.env`, cookie, key file, SQL dump, Rclone config, atau inventory internal. Jika cleanup gagal, pertahankan bukti kepemilikan dan gunakan prosedur resmi; jangan menghapus data root secara rekursif.

Lihat [monitoring harian](/docs/operations/monitoring), [troubleshooting](/docs/troubleshooting), dan [resource database](/docs/database-restores/resources).
