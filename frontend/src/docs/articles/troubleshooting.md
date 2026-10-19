# Diagnostik yang aman

Mulai dari pekerjaan dan tahap yang gagal, lalu kumpulkan bukti minimum sebelum mengubah konfigurasi. Status ONLINE, login storage, login database, dan queued notification menguji bagian yang berbeda. Jangan menganggap salah satunya membuktikan seluruh alur backup atau pemulihan.

## Mulai dari stage

1. Buka plan → **Backups**, temukan baris berdasarkan tanggal/zona waktu, lalu catat status, backup ID, snapshot bila tersedia, waktu, serta warning.
2. Jika baris tidak tampak, periksa filter/pagination. Jika pekerjaan masih berjalan, baca stage/counters di progress; persentase yang belum diketahui tidak otomatis berarti macet.
3. Buka **More plan actions → View Logs** atau **Settings → App Logs**. Untuk Managed Agent, cocokkan journal layanan dengan command/job yang sama secara privat.
4. Catat apakah penolakan terjadi sebelum command diberikan ke Agent, saat source/dump/repository check, saat backup, saat restore/import, atau saat cleanup/delivery.
5. Gunakan artikel sesuai tahap: [source](/docs/troubleshooting/source), [database](/docs/troubleshooting/database), [incremental/progress](/docs/troubleshooting/incremental), [SFTP](/docs/troubleshooting/sftp), [recovery](/docs/troubleshooting/recovery), dan [notifikasi](/docs/troubleshooting/notifications).

Contoh sintetis: `app-01` ONLINE tetapi backup gagal `source-parent-not-traversable`. Periksa permission parent sebagai akun layanan, bukan mengganti password database. Setelah perbaikan, uji preflight dan satu pekerjaan baru yang diizinkan pada source yang sama.

## Pemeriksaan minimum

Cocokkan identitas plan/source/repository, capabilities Agent, snapshot exact, safe stage/code, dan waktu. UI error yang disanitasi sengaja tidak menampilkan semua detail; DBA/administrator dapat memeriksa detail lokal secara privat. Untuk replika, gunakan [status dan retry](/docs/replication/status-retry); uncertain tidak boleh diputar ulang atau direset manual.

### HTTP 405, HTML, dan JSON

Bila tombol simpan/hapus gagal, lihat permintaan terkait melalui Network pada browser: metode, URL, HTTP status, **Content-Type**, dan waktu. Jangan menyalin cookie, authorization, request body berisi credential, atau response rahasia ke laporan.

- **405 dengan HTML** atau halaman proxy/login dapat berasal dari aturan reverse proxy, WAF, routing SPA, atau upstream yang salah. Administrator perlu mencocokkan log proxy dan route API untuk **metode asli**, termasuk PUT/DELETE bila dipakai fitur. Status 405 saja belum membuktikan Pluton menolak dependensi.
- **JSON dengan pesan Pluton** perlu ditangani sesuai makna: 401 sesi/akses, 403 origin/kebijakan, atau 409 pekerjaan/dependensi aktif. JSON dari proxy lain juga mungkin, jadi cocokkan sumber dan log.
- HTML yang diterima saat client mengharapkan JSON dapat tampil sebagai parsing error; perbaiki routing dan content type di penyebabnya.

Jangan mengubah DELETE/PUT menjadi POST, membuka backend langsung untuk melewati proxy, mematikan auth/origin/CSRF, atau menghapus data secara manual. Sesudah konfigurasi proxy ditinjau dan diperbaiki administrator, ulangi tindakan yang memang diizinkan dari origin yang sama dan verifikasi hasil di UI. Untuk penghapusan, baca [plan](/docs/backup-plans/delete) atau [Database Restore](/docs/database-restores/delete) sebelum mencoba lagi.

## Sharing

Gunakan `app-01`, `example.internal`, `192.0.2.10`, dan `/srv/example-app` pada laporan publik. Hilangkan inventaris, akun nyata, enrollment/HMAC/lease token, SSH/repository password, kunci utama, SQL, konfigurasi plaintext, dan dump SQLite. Kirim hanya safe stage/code, versi yang relevan, langkah reproduksi sintetis, serta apa yang sudah diverifikasi.

## Larangan umum

Jangan regenerate secret, recreate plan/storage, chmod 777, run Agent root, melemahkan allowed-root/TLS/non-empty/ownership/resource guard, atau menjalankan maintenance Legacy hanya agar pesan hilang. Perbaikan dinyatakan selesai setelah tahap yang gagal dan hasil akhir yang relevan diverifikasi, bukan ketika toast error menghilang.
