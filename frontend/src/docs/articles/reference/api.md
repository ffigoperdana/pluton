# Referensi API untuk diagnosis operator

Gunakan API untuk memahami lapisan yang gagal dan mengorelasikan hasil UI. Panduan ini bukan izin menjalankan mutasi pada data nyata. Mulailah dengan UI untuk Backup, Restore, Resume, dan Delete agar konfirmasi serta policy tetap berlaku.

## Auth boundary

API aplikasi memerlukan autentikasi dan pemeriksaan izin sesuai route. API key terbatas bukan pengganti administrator. Database Restore dan notifikasi mempunyai pemeriksaan tambahan seperti session administrator, same-origin JSON, dan rate limit.

Jangan menaruh cookie, token, password, atau secret pada URL maupun contoh publik.

## Endpoint yang membantu diagnosis

| Method dan path | Kegunaan |
| --- | --- |
| `GET /api/health` | Status dasar layanan dan control database, tanpa kredensial |
| `GET /api/health/details` | Pemeriksaan komponen dengan autentikasi; mencakup file uji kecil pada data directory |
| `GET /api/agent-admin/devices/:id/source-access` | Report/source-selection dan 20 request terbaru; sesi administrator |
| `GET /api/agent-admin/devices/:id/source-access/requests?limit=10` | History read-only dengan cursor, status/kind; default 10, maksimum 50; sesi administrator, no-store |
| `GET /api/plans/:id/backups` | Riwayat backup yang dipaginasi dan difilter |
| `GET /api/backups/:id/files` | Browse isi snapshot sesuai backup |
| `GET /api/backups/:id/progress` | Progress dan tahap pekerjaan |
| `GET /api/database-restores` | Daftar Persistent Restore milik administrator |
| `GET /api/database-restores/:id` | Status, retensi, dan hasil lifecycle resource tertentu |
| `GET /api/recovery-testing/:planId/configuration` | Kesiapan policy dan target recovery |
| `GET /api/notifications/channels` | Metadata channel yang disanitasi, tanpa secret |
| `GET /api/notifications/deliveries?page=0` | Riwayat pengiriman; page dimulai dari 0 |

Endpoint lifecycle seperti `POST /api/database-restores/:id/inspect`, `/stop`, `/resume`, dan `/delete` tetap merupakan operasi yang memerlukan policy/otorisasi. Inspect menghubungi target; jangan menganggapnya sekadar membaca baris SQLite.

## Method dan hasil harus cocok

Remove Backup Plan menggunakan `DELETE /api/plans/:id`; opsi `removeData` menentukan scope data sesuai jenis plan. HTTP 409 retained database dependency adalah penolakan keselamatan yang sah. Jangan mengganti DELETE menjadi POST untuk melewati reverse proxy.

Jika UI melaporkan `Unexpected token '<'`, catat method, path tersanitasi, status HTTP, Content-Type, dan redirect. HTML dapat berasal dari proxy, login, atau fallback; itu bukan JSON aplikasi yang boleh dianggap sukses.

## Respons asinkron

History Source Access memakai `cursor`/`nextCursor`, bukan nomor page/offset.
Boundary menahan insert baru selama pagination; Refresh/filter memulai boundary
baru. Cursor tidak memberi otorisasi dan bukan identifier durable setelah
maintenance/restore database. Request status tetap dapat berubah; history bukan
snapshot ekspor database. Jangan menafsirkan **View all** sebagai bulk mutation.

HTTP 202 berarti pekerjaan diterima/diantrekan. Tunggu status terminal dan cleanup, bukan hanya respons request awal. Prinsip ini berlaku pada recovery, Delete, dan test notifikasi sesuai kontrak masing-masing.

Lihat [troubleshooting](/docs/troubleshooting), [Delete aman](/docs/backup-plans/delete), dan [keamanan](/docs/security).
