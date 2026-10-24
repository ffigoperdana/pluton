# Diagnostik yang aman

Mulai dari pekerjaan dan tahap yang gagal, lalu kumpulkan bukti minimum sebelum mengubah konfigurasi. Status ONLINE, login storage, login database, dan queued notification menguji bagian yang berbeda. Jangan menganggap salah satunya membuktikan seluruh alur backup atau pemulihan.

Untuk filesystem source, buka [Troubleshooting: Source Files or Directories Are Inaccessible](/docs/troubleshooting/source#1-understand-the-error). Panduan mencakup safe path diagnostics, service identity, POSIX ACL dan exclusion review.

## Mulai dari stage

1. Buka plan → **Backups**, temukan baris berdasarkan tanggal/zona waktu, lalu catat status, backup ID, snapshot bila tersedia, waktu, serta warning.
2. Jika baris tidak tampak, periksa filter/pagination. Jika pekerjaan masih berjalan, baca stage/counters di progress; persentase yang belum diketahui tidak otomatis berarti macet.
3. Buka **More plan actions → View Logs** atau **Settings → App Logs**. Untuk Managed Agent, cocokkan journal layanan dengan command/job yang sama secara privat.
4. Catat apakah penolakan terjadi sebelum command diberikan ke Agent, saat source/dump/repository check, saat backup, saat restore/import, atau saat cleanup/delivery.
5. Gunakan artikel sesuai tahap: [source](/docs/troubleshooting/source), [database](/docs/troubleshooting/database), [incremental/progress](/docs/troubleshooting/incremental), [SFTP](/docs/troubleshooting/sftp), [recovery](/docs/troubleshooting/recovery), dan [notifikasi](/docs/troubleshooting/notifications).

Contoh sintetis: `app-01` ONLINE tetapi backup gagal `source-parent-not-traversable`. Periksa permission parent sebagai akun layanan, bukan mengganti password database. Setelah perbaikan, uji preflight dan satu pekerjaan baru yang diizinkan pada source yang sama.

## Peta troubleshooting operasional

Gunakan gejala/kode aktual, bukan mengganti semua masalah menjadi error password.
Kode yang tidak tercetak tidak boleh diklaim sebagai diagnosis. Setiap langkah
di bawah dimulai dari inspeksi; mutasi/retry hanya pada window yang disetujui.

### Agent, Source Access dan exclusions

| Gejala/kode bila tersedia | Penyebab dan cek aman | Resolusi didukung / jangan lakukan | Eskalasi |
| --- | --- | --- | --- |
| Agent OFFLINE | Last seen, service/journal, DNS, clock, outbound HTTPS, CA dari runtime | Perbaiki jalur; heartbeat-only `check` memakai config aktual, bukan `run --once`/reset identity | Operator Agent bila heartbeat tetap gagal |
| Version/capability mismatch; HTTP 409 exclusions | Commit server/Agent dan capability v1 authenticated | Server kompatibel dahulu, app-only Agent upgrade; jangan edit capability di SQLite | Maintainer bila kombinasi tidak didukung |
| Delegasi belum ada / pending host setup | Mode report, exact request/revision/expiry dan drain | One-time host command UI yang direview; radio di browser bukan approval | Administrator host |
| Validation rejected | Details pada Recent requests, requested/canonical path dan safe reason | Betulkan source dalam delegasi lalu explicit Validate/Apply; jangan substitusi canonical/bypass revision | Pemilik scope/host |
| `source-parent-not-traversable`, `source-root-not-readable`, `source-entry-inaccessible` | Preflight sebagai service, parent ACL, nested file/mount | Izin minimum atau exclusion yang diterima owner; jangan chmod 777/chown aplikasi/run root | Host dan pemilik aplikasi |
| Exclusions tidak berlaku / invalid pattern 400 | Case, hidden name, anchoring, saved policy dan Agent v4 | Perbaiki pola supported lalu job baru; included denial tetap gagal | Maintainer bila hasil native berbeda |
| Restic nonzero / backup Failed | Stage/source/repository/dump error, exact backup/time | Selesaikan penyebab lalu satu retry eligible; jangan suppress error/unlock Legacy | Owner sesuai safe stage/code |

[Agent diagnostics](/docs/remote-agent/troubleshooting), [source](/docs/troubleshooting/source),
[database dump](/docs/troubleshooting/database) dan [exclusions](/docs/backup-plans/managed-agent#backup-exclusions)
memuat prosedur terperinci. Error DB 1045 berbeda dari grant 1044/1142/1227;
dump gagal bukan alasan memakai akun admin atau mematikan routines yang diperlukan.

### SFTP, S3 dan HCP

| Gejala/kode bila tersedia | Penyebab dan cek aman | Resolusi didukung / jangan lakukan | Eskalasi |
| --- | --- | --- | --- |
| SFTP connection/path denied | DNS/port dari Agent+server, akun privat, home/chroot, quota | Perbaiki mapping/grant minimum; jangan purge repository unknown atau pakai external SSH arbitrary | Operator SFTP |
| `S3_AUTHENTICATION_DENIED` / `storage-authentication-failed` | API endpoint, S3 key scope, clock/signature/region | Update field privat sesuai operator; console login atau anonymous 403 bukan S3 credential test | Storage owner |
| `S3_NAMESPACE_UNAVAILABLE` | Namespace existing, authenticated listing, ACL dan API yang diaktifkan | Protected pre-existing mode tetap aktif; jangan create bucket baru/disable guard | HCP/namespace owner |
| `TLS_HOSTNAME_MISMATCH` | Certificate SAN versus exact endpoint/namespace hostname | Gunakan approved matching endpoint/cert; jangan curl -k atau mengabaikan TLS | PKI/DNS/storage owner |
| `TLS_TRUST_INVALID` / `storage-tls-failed` | CA runtime server/container dan path operator | Perbaiki trust melalui kontrak CA, bukan arbitrary per-storage TLS flags | Operator server/PKI |
| HCP S3 API disabled | Operator memeriksa namespace protocols dan ACL versi HCP | Coordinate enable dengan owner; HCP REST/console bukan endpoint S3 | HCP administrator |
| `storage-access-denied`, `retention-denied` | Prefix grant, quota, Object Lock/retention dan operasi yang gagal | Tinjau policy compatible; jangan bypass WORM/beri admin/delete unknown objects | Storage/compliance owner |

[HCP](/docs/storage/hcp) memisahkan tenant/namespace, path-style, region dan TLS;
[SFTP](/docs/troubleshooting/sftp) memisahkan koneksi dari repository preparation.
Raw logs/network headers dapat mengandung secret dan wajib disanitasi.

### Replication, integrity dan recovery

| Gejala/kode bila tersedia | Penyebab dan cek aman | Resolusi didukung / jangan lakukan | Eskalasi |
| --- | --- | --- | --- |
| Complete + Redundancy incomplete | Dialog Mirrors backup exact, Decision/Attempts/Last replicated snapshot | Periksa tiap mirror, bukan usage/plan count; primary tidak diulang hanya agar label hijau | Operator replika |
| Replica Failed/copy denied | Safe code, source binding/artefact, prefix/ownership/TLS/quota | Explicit Retry hanya failed/cancelled eligible; jangan replay active/uncertain atau reset lease | Maintainer untuk uncertain/binding |
| Prefix/path berubah | Repository binding/history/retained scope lama | Tujuan baru + verifikasi recovery; edit bukan migration, jangan hapus lama sebelum accepted | Data owner/maintainer |
| Integrity mismatch/upgrade preflight | Locale fix commit, artifact/metadata/mode/owner dan exact receipt | `--check` dari fixed checkout; jangan force/rewrite provenance/re-enroll | Agent operator/maintainer |
| `PROVENANCE_TIMEOUT`, BACKUP/HEALTH failure | Failed stage/code dan rollback outcome, disk/I/O/journal privat | Pertahankan evidence dan service lama; jangan weaken fsync/hash/health | Agent maintainer |
| Recovery Failed / Cleanup Required | Exact snapshot, validation/import/SQL cap/resource/ownership/TTL | Selesaikan melalui normal lifecycle; import Disabled tetap NOT TESTED; jangan drop DB unknown/reset sequence | DBA/root operator |

Lihat [status/retry replica](/docs/replication/status-retry),
[integrity/upgrader](/docs/remote-agent/troubleshooting#integrity-dan-upgrade-preflight),
[Recovery Testing](/docs/recovery-testing/results) dan
[Persistent Restore diagnostics](/docs/database-restores/troubleshooting).
Jika underlying code belum diketahui, catat **unknown** beserta stage/waktu;
jangan mengarang sebab atau menjalankan SQL/DELETE untuk membuktikannya.

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
