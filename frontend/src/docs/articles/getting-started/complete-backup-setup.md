# Complete Backup Setup — dari nol sampai recovery terverifikasi

**Start Here.** Ikuti urutan ini untuk Managed Agent Linux dengan primer SFTP dan
replika S3 opsional. Setiap langkah mempunyai hasil yang harus diperiksa sebelum
lanjut. Ini panduan operasional, bukan bukti bahwa suatu deployment telah lulus
acceptance. Semua host, akun dan path contoh adalah sintetis.

Untuk latihan singkat filesystem saja, gunakan [Quick Start](/docs/getting-started/quick-start).
Panduan rinci yang ditautkan di bawah tetap menjadi referensi masing-masing fitur;
jangan menyalin satu perintah ke instalasi existing tanpa memeriksa kontraknya.

## 1. Pahami arsitektur dan siapa yang menjalankan operasi

```text
Browser administrator --HTTPS/session--> Pluton Server (frontend + API + SQLite)
                                             |
Linux Agent --outbound HTTPS/poll------------>|
  | baca source yang diizinkan                | verifikasi snapshot primary
  | client DB -> dump + metadata              | antrekan copy, satu executor
  +--Restic + Rclone--> SFTP primary <---------+--> S3/HCP replica (opsional)
                              |
                    Server membaca primary
                              +--> Browse/Download/Restore ke staging server
                              +--> Recovery Testing / target DB terisolasi
```

Source berisi aplikasi/database asal. Primary adalah repository Restic terenkripsi
khusus plan; replica adalah repository tujuan copy, bukan source tambahan. Server
menyimpan control plane di `/data`; backup aplikasi pada SFTP bukan backup `/data`.
Agent tidak menerima kredensial S3 replika. Browser tidak membaca filesystem Agent
secara langsung. Operator root untuk database Internal adalah komponen terpisah,
bukan kemampuan otomatis yang diberikan enrollment Agent.

Diagram memakai blok teks yang didukung renderer dokumentasi; tidak memerlukan
eksekusi Mermaid atau script eksternal. Baca [arsitektur](/docs/architecture) dan
[status terpisah](/docs/architecture/states).

## 2. Siapkan dan deploy server

Prasyarat: Linux amd64 untuk image source yang dicakup, Docker dengan Compose
plugin, Python 3.8+ untuk bundle host, administrator host, DNS/TLS tepercaya,
volume persisten dan kapasitas staging/cache/log. Server dapat mengakses SFTP,
S3 opsional, serta target recovery yang diperlukan. [Requirements](/docs/getting-started/requirements)
menjelaskan batas platform; RAM 4 GiB bukan jaminan MySQL Internal dapat admitted.

Gunakan bundle `deploy/` dari commit yang direview. Contoh berikut untuk instalasi
**baru**, setelah persetujuan operator; `<APP_DIGEST>` adalah 64 digit hex yang
diverifikasi dari registry/provenance, bukan tag mutable:

```sh
# Dari checkout yang direview; target /opt/pluton harus belum ada.
sh deploy/install.sh sha256:<APP_DIGEST> /opt/pluton
```

Pemanggilan pertama menyalin bundle dan berhenti dengan sengaja agar `.env` diisi
privat. Itu belum menjalankan aplikasi. Edit `/opt/pluton/.env` secara privat:
registry `PLUTON_IMAGE`, volume, port, kredensial bootstrap, `APP_URL`, origin dan
`ENCRYPTION_KEY` yang dibuat offline hanya untuk instalasi baru. Jangan menaruh
nilainya di command/chat. Lalu, setelah konfigurasi dan kontrak ditinjau:

```sh
cd /opt/pluton
sh install.sh sha256:<APP_DIGEST>
sh status.sh
```

Untuk instalasi existing, gunakan [upgrade](/docs/deployment/updates), termasuk
upgrade bundle host bila diperlukan; jangan menjalankan init atau memilih volume
baru. Compose standar mempertahankan `/data`, memakai pengguna non-root,
read-only root filesystem, tmpfs dan capability restrictions. Hanya environment
yang diteruskan Compose/overlay benar-benar masuk ke aplikasi.

Pasang reverse proxy HTTPS dengan origin dan trusted proxy yang sesuai; jangan
menonaktifkan TLS/CSRF atau menulis aturan yang menolak metode API. Login Docker
memakai akun bootstrap yang disiapkan operator; **Initial Setup** binary/desktop
adalah alur berbeda. Verifikasi `GET /api/health` mengembalikan HTTP 200 JSON
`{"status":"healthy"}`, login, metadata build, mount serta volume yang benar.
Health tidak membuktikan storage/Agent/worker siap. Simpan backup control plane,
key dan digest lama sebelum perubahan. [Deployment](/docs/deployment),
[environment](/docs/deployment/configuration), [TLS](/docs/security/https),
[rollback](/docs/deployment/rollback).

## 3. Install dan enroll Managed Agent

Gunakan Debian/Ubuntu Linux x86_64 dengan systemd; upgrade juga memerlukan cgroup
v2 dan kontrak instalasi standar. Sediakan source spesifik yang boleh dibaca
service, CA tepercaya dan koneksi outbound HTTPS ke server. Tidak perlu inbound
port protokol Agent. Database client dan izin DB tidak dipasang oleh installer.

Di **Sources → + Add Remote Machine**, buat token sekali pakai melalui sesi
administrator privat. Pilih roots yang sempit, tinjau mode otorisasi, lalu ikuti
**Copy secure install command** dari checkout fork yang telah direview. Contoh
non-secret untuk pemasangan pertama:

```sh
sudo bash installers/install-agent.sh \
  --server https://pluton.example.internal \
  --allowed-root /srv/example-app
systemctl is-active pluton-agent
```

Token dimasukkan pada prompt lokal, bukan argumen/public shell history.
`--ca-file /path/to/approved-ca.pem` tersedia bila private CA diperlukan.
Installer memakai private Node/Corepack serta Restic/Rclone dengan pin; system
Node dan pnpm global tidak diganti. Installer menyiapkan EnvironmentFile, unit,
identity dan state; **jangan menggunakannya sebagai updater existing**.

Hasil: Sources menampilkan mesin yang sama **ONLINE**, Last seen baru, versi
Agent dan client, serta capability `BACKUP_FILESYSTEM`. Agent 0.7.0/capability
`backupExclusionsVersion: 1` wajib untuk exclusions nonempty. Online hanya bukti
heartbeat. [Enrollment](/docs/remote-agent/enrollment) menjelaskan token expired,
revocation, TLS, konfigurasi dan batas dukungan.

## 4. Delegasikan Source Access, validasi, lalu Apply

Bedakan lima bukti: delegasi host → pilihan UI → hasil validasi → Applied/effective
roots → readability Linux. Tidak ada satu bukti yang menggantikan empat lainnya.
Instalasi baru tetap Host-Approved sampai host menyetujui peralihan.

1. Buka detail mesin → **Source Access → Authorization Mode**.
2. Pilih **Server-Managed**, isi prefix canonical spesifik dan tinjau semua plan
   terdampak. Pause plan dan drain pekerjaan sebelum meminta perubahan mode.
3. Klik **Request one-time host setup** setelah konfirmasi review. Pending belum
   memberi akses. Salin **Copy one-time host setup command** dan jalankan persis
   pada host yang tepat melalui terminal operator privat.
4. Command UI mengikat Agent ID, request ID, revision, scope, expiry dan konfirmasi
   drained. Jangan mengetik ulang ID/revision berdasarkan contoh atau memakai
   command receipt yang expired. Untuk receipt baru, buat request eksplisit baru.
5. Refresh agent report; pastikan mode/delegated scope benar-benar dikonfirmasi.
6. Masukkan source di **Application source paths**, klik **Validate paths**,
   periksa canonical preview, kemudian **Apply validated paths**. Di form plan,
   labelnya **Validate source path**, **Apply source access**, lalu **Use validated
   canonical path** setelah effective confirmation.

Host delegation tidak memberikan ACL. Parent perlu execute/traverse, directory
read+execute, file read. Source root yang readable belum membuktikan semua child
readable. Read-only preflight sebagai service account:

```sh
sudo -u pluton-agent /opt/pluton-agent/runtime/bin/node \
  /opt/pluton-agent/app/dist/index.js preflight \
  --source /srv/example-app --allowed-roots /srv/example-app --scan
```

Roots pada command harus mencerminkan scope yang sudah diotorisasi, bukan cara
memberikan scope baru. Scan dibatasi entry/deadline; hasil partial bukan bukti
seluruh pohon aman. Nested symlink tidak diikuti saat backup. Scope dan private
path guards tetap berlaku. Jangan chmod 777, chown aplikasi ke Agent, recursive
permission relaxation, menghapus policy atau mengubah revision.

**Recent requests** merangkum lima request; Details mempertahankan alasan/path/
revision. **View all requests** memakai 10 per halaman, filter dan Refresh.
Membaca history tidak menerapkan request. [Source Access](/docs/remote-agent/permissions)
adalah referensi izin, one-time command dan audit.

## 5. Register primary storage dan pastikan isolasinya

Managed Agent backup memakai **SFTP primary**, bukan Local/S3 langsung. Standard
server filesystem backup mendukung provider lain sesuai [storage](/docs/storage).
Siapkan akun backup khusus, kapasitas/kuota, folder baru/empty dedicated, dan
akses dari **Agent serta server**. Tidak perlu shell admin untuk akun tersebut.

Di **Storages → + New → SFTP**, isi host/port/username/password secara privat.
Managed Agent menerima subset password SFTP; SSH agent/key/external shell/options
arbitrary tidak otomatis didukung. Jangan mengklaim verifikasi host-key yang
belum diprovisioning hanya karena form tersimpan. Uji jalur sebenarnya sesuai
kontrak client yang dipakai dan review jaringan SFTP bersama operator.

Hasil awal: storage tersimpan dan listing path melalui akun yang sama masuk akal.
Periksa home/chroot: path relatif sesi tidak selalu sama dengan path fisik host.
Folder chroot dan area write harus diatur administrator SFTP, tanpa melonggarkan
ownership seluruh tree. Detail pada [SFTP](/docs/storage/sftp).

Repository terenkripsi memiliki password managed tersendiri; password SFTP bukan
password Restic. Backup control-plane/key tetap diperlukan untuk recovery.
Dua folder SFTP pada disk/VM yang sama memberi isolasi logical, **bukan** failure
domain fisik independen. Credential rotation perlu pause/drain, update privat,
tes Agent+server dan recovery; jangan menghapus storage lama untuk mengganti key.

## 6. Buat plan filesystem pertama

1. **Backup Plans → + New**; beri nama jelas, misalnya `app-01-files`,
   **Incremental Backup**.
2. **Source & Destination**: pilih Managed Agent, pilih/validasi/apply source
   seperti langkah 4. Jangan memindahkan existing source lewat edit biasa.
3. Pilih SFTP primary dan subfolder dedicated `repositories/app-01`; destination
   bukan folder aplikasi dan bukan repository Legacy/plan lain.
4. **Setup Schedule & Retention**: pilih interval, periksa zona waktu server dan
   window. Managed Agent belum mempunyai prune/retention fisik seperti Standard.
5. **Advanced → General**: tinjau encryption/compression. Matikan **Run Backup Now**
   selama review awal. Biarkan database/hooks dan replication kosong dulu.
6. **Create Plan**, buka kembali source/path yang tersimpan, lalu **Backup Now**
   sekali pada window yang disetujui.

Hasil: pekerjaan diterima lalu mencapai terminal. Bila preparation ditolak,
pertahankan isi repository dan tinjau safe stage/code; jangan empty/purge agar
init lolos. [Managed Agent plan](/docs/backup-plans/managed-agent) memuat label UI
lengkap. Daftar plan memakai 9/18/27 per halaman; filter/sort mendahului pagination.

## 7. Tambahkan database dan constrained hooks

Sesudah filesystem baseline tervalidasi, buka **Edit → Advanced → Database &
Hooks**. Konfigurasikan 0–8 database MariaDB/MySQL/PostgreSQL yang diperlukan,
engine/client yang sesuai, database, credentials privat, transport dan unique
dump filename. Credential tersimpan tidak perlu diisi ulang saat edit tanpa
perubahan. Client dump berjalan pada **Agent**; server-side client/worker recovery
adalah kebutuhan terpisah. [Connections](/docs/database-backup/connections),
[engines](/docs/database-backup/engines).

Dump memakai timeout/maximum bytes dan routines/events bila didukung. MySQL/
MariaDB single-transaction tidak menjamin konsistensi nontransactional tables,
DDL bersamaan atau atomisitas lintas DB/filesystem. DB didump berurutan sebelum
snapshot filesystem dan seluruh generated artifacts. Kegagalan dump tidak
diturunkan menjadi backup sukses tanpa SQL. DBA menentukan privilege minimum;
jangan memberi SUPER/FILE/global admin untuk memperbaiki error 1044/1142/1227.

Hooks hanya executable/config host yang diizinkan, tanpa shell arbitrary dari
browser dan tanpa elevation. Tentukan konsistensi/quiescence bersama pemilik
aplikasi, serta prosedur jika pre/post/cleanup gagal. [Dump options](/docs/database-backup/dump-options),
[hooks](/docs/database-backup/hooks), [artifacts](/docs/database-backup/artifacts).

**Configured → dump generated → SQL included/verified → recovery imported →
application validated** adalah bukti terpisah. Label `DB · MariaDB` hanya
konfigurasi. Complete dengan warning tidak menghapus kewajiban memeriksa hasil.

## 8. Atur exclusions secara sengaja

**Edit → Advanced → General → Backup Exclusions**, satu pola per baris. Server
dan Agent memvalidasi kontrak yang sama; Agent lama ditolak untuk pola nonempty.
Tidak ada migration atau otomatis menyalin exclusion sistem lama.

```text
.git
.cache
node_modules
```

Nama tunggal berlaku pada semua kedalaman dan case-sensitive; `.cache` berbeda
dari `cache`. `*/cache` dimulai dari source, tepat satu tingkat; `**/cache` juga
cocok pada root. `*`/`?` di dalam komponen, satu recursive `**`, terminal `/**`
opsional; trailing `/` bukan directory-only. `node_modules/**` anchored di root;
`**/node_modules` berlaku semua kedalaman. Multiple interior `**`, absolute path,
traversal, backslash, negation dan shell syntax ditolak. Maksimum 100 pola,
512 UTF-16 units per pola, total 16.384 sebelum dedup.

`cache`, `tmp`, `temp`, `logs`, `log`, `sessions`, `vendor` dapat dikecualikan
**hanya bila** pemilik memastikan recovery tidak membutuhkannya. Sessions/uploads/
vendor bisa memuat state/dependency penting; jangan menerapkan daftar umum secara
buta. File/directory/link yang cocok dan subtree-nya dipangkas sebelum access;
entri included tidak readable tetap gagal. Root dan allowed scope tetap diperiksa.

Restic menerima pola anchored ke source canonical. SQL/manifest generated pada
workspace terpisah tetap terlindungi; SQL biasa dalam source mengikuti pola.
Periksa [kontrak exclusions](/docs/backup-plans/managed-agent#backup-exclusions).
Untuk scan lokal tambahkan `--exclude .git --exclude node_modules --exclude .cache`
pada command preflight langkah 4. Ini tidak mengubah plan atau izin Linux.

## 9. Verifikasi backup pertama dengan snapshot exact

Pada **Backups**, catat backup ID, full snapshot ID, start/end/timezone, duration,
stage/code/warnings, sumber dan destination. **Complete** membuktikan primary
workflow selesai; bukan bukti replica, SQL import, atau aplikasi sehat.

Buka **Browse** pada baris snapshot yang sama: cek file expected, nested/hidden
entries yang relevan dan ketiadaan data excluded. Unduh/restore file contoh untuk
bandingkan isi/hash di lokasi privat. Counter logical size, new/modified files
dan stored bytes tidak sama; unknown berarti tidak diukur. [History](/docs/backup-plans/history),
[incremental](/docs/backup-plans/incremental).

Untuk native SQL, periksa `/pluton/database/<dump-filename>.sql` dan metadata
engine/database/path/bytes/SHA-256 pada **Restore Database** preview. Tutup preview
jika tidak bermaksud membuat persistent resource. Required recovery memeriksa
artefak lagi sebelum import. Native guards tidak menebak engine dari `.sql`
biasa. Jangan membagikan dump/credentials untuk membuktikan hasil.

Tidak ada janji tombol universal repository repair/check di panduan ini. Snapshot
verification aplikasi dan restore drill bukan jaminan seluruh media bebas error;
maintenance repository hanya melalui kontrak managed/Standard yang sesuai.

## 10. Tambahkan optional replication dan buktikan salinannya

Managed replication berjalan **di server**, globally sequential, sesudah primary
completed dan snapshot/artefaknya diverifikasi. Maksimum dua tujuan S3/S3-compatible,
prefix khusus tanpa overlap. Non-AWS/S3-compatible wajib protected pre-existing
namespace mode. Agent tidak mendapat S3 key. Windows tidak mendukung executor ini.

Contoh logical, bukan path fisik otomatis:

```text
Primary: SFTP storage / repositories/app-01
Replica: S3 bucket example-backups / app-01/replica-a
```

1. Register storage S3/HCP teruji seperti langkah 11.
2. Plan → **Edit → Enable Replication → + Add Replication Destination**.
3. Pilih storage dan unique subfolder. Jika bucket ditampilkan picker, isi prefix
   `app-01/replica-a`, bukan bucket dua kali. S3 prefix adalah object-key prefix,
   bukan directory filesystem yang dibuat dengan chmod.
4. Klik **Confirm** untuk baris baru pada plan existing, kemudian **Update Plan**.
5. Jalankan satu backup baru yang diizinkan. Buka badge **Mirrors for …** pada
   backup exact; tinjau Decision, Attempts, Source snapshot dan Last replicated
   snapshot bila tersedia. Tunggu tiap mirror **Completed**.

Configured, queued/pending, Running, Completed dan verified recovery berbeda.
**Redundancy incomplete** berarti salinan yang diwajibkan backup tersebut belum
semuanya completed; primary dapat tetap Complete. Storage usage/plan count tidak
membuktikan objek snapshot terkirim. Server memverifikasi destination snapshot/
tree/path dan SQL bytes/hash; ini belum SQL import atau application recovery.

Retry terminal failed/cancelled perlu aksi eksplisit eligible; uncertain/active
tidak boleh di-replay/reset. [Managed replication](/docs/replication/managed-agent),
[status/retry](/docs/replication/status-retry).

Mengganti prefix/destination bukan migrasi otomatis snapshot historis. Jangan
mengedit binding. Rencanakan tujuan baru melalui flow yang didukung, validasi copy
dan recovery path dengan operator, pertahankan lama sampai bukti diterima. Detach
Managed Agent **retains data**; physical prune/purge belum didukung.

**Direct mirror restore Managed Agent belum tersedia**, termasuk Browse/Download,
Recovery Testing dan native database restore. Jangan mengklaim telah menguji
recovery dari replica melalui primary. Bila primary hilang, diperlukan runbook
terpisah yang direview dan diuji, bukan edit mirror menjadi primary. Standard
memiliki pilihan mirror berbeda sesuai eligibility. [Retention/restore](/docs/replication/retention-restore).

## 11. Integrasi Hitachi HCP yang benar

Gunakan [panduan HCP](/docs/storage/hcp) sebagai referensi authoritative untuk
Tenant, Namespace/bucket, endpoint, TLS, S3 protocol, ACL, key dan quotas. HCP REST
API/management console tidak sama dengan API S3. Console username/password bukan
pasangan access key/secret S3 siap pakai. Operator HCP menyediakan versi API,
namespace existing, S3 enabled, ACL/izin dan key terbatas.

Mode **HCP / pre-existing namespace mode** memaksa no-check-bucket, bukan bypass
auth atau verifikasi namespace: Pluton tetap menguji listing dengan credentials.
Path-style tersedia dalam konfigurasi provider; region mengikuti kontrak operator,
bukan janji bahwa `us-east-1` cocok pada semua HCP. Certificate endpoint harus
cocok dengan hostname/CA server; namespace hostname bisa mismatch meskipun tenant
endpoint yang disetujui valid. Jangan gunakan `curl -k`/skip verify.

Retensi/WORM/Object Lock, quotas, multipart capability dan izin delete harus
ditinjau sebelum penggunaan Restic. HCP DPL dan cluster replication bukan copy
Pluton dan tidak membuktikan recovery aplikasi. **Real HCP interoperability belum
diuji**; isi tabel acceptance pada [replikasi HCP](/docs/replication/hcp).

## 12. Uji recovery pada lingkungan terisolasi

1. Pilih **snapshot exact** yang coverage-nya sudah diterima. Browse/Download atau
   **Restore** ke staging server yang terpisah dari source/repository. Jangan
   overwrite aplikasi aktif. Cocokkan counts, struktur, sample file/content/hash.
2. **Run Recovery Test** pada backup yang sama: artifact-only membuktikan staging/
   metadata/SQL hash yang tersedia; import Disabled berarti SQL **NOT TESTED**.
3. Untuk Required native import, DBA/operator menyiapkan Custom recovery-only
   marker/grants/TLS atau Internal host operator/worker/image/approval/resources.
   Target bukan DB source. Semua recorded DB harus import, tidak ada silent fallback.
4. Periksa hasil/catalog Inspect dan cleanup. Passed with warning dibaca bersama
   import policy, warning dan cleanup, bukan disederhanakan menjadi full PASS.
5. Jika memakai **Restore Database**, itu persistent resource tersendiri: lease,
   TTL, Stop/Resume explicit, Inspect dan Delete ownership-verified. Stop tidak
   menghentikan TTL; Delete Plan tidak boleh cascade ke retained DB.
6. Pemilik aplikasi memverifikasi restore pada stack uji: konfigurasi, filesystem,
   DB compatibility/roles/extensions dan transaksi bisnis yang representatif.

MySQL Internal tetap memerlukan available memory admission **2.944 MiB**, SQL cap
**128 MiB**, fixed ext4 budget **2 GiB**, serta CPU/disk/TLS/ownership guards.
Host total RAM 4 GiB dapat memasang fitur tetapi **menolak** recovery bila headroom
kurang. Jangan menurunkan guard. [Recovery Testing](/docs/recovery-testing),
[resources](/docs/database-restores/resources), [staging](/docs/restore/staging).

Simpan hasil exact snapshot, waktu, expected/actual, operator, limitations, cleanup
dan keputusan acceptance secara privat. Restore filesystem, SQL import dan
application recovery masing-masing memerlukan bukti.

## 13. Scheduling, kapasitas dan operasi rutin

| Frekuensi                  | Verifikasi dan tindakan                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Harian                     | Scheduled backup muncul, last-success age/RPO, terminal/warning, tiap replica, Agent Online, failure stage, disk/queue dan notification delivery |
| Mingguan                   | Sample snapshot coverage/exclusions, growth primary/replica, quotas, staging/cache/workspace, drain uncertain jobs melalui review, bukan reset   |
| Periodik/setelah perubahan | Restore drill dan SQL/application test, RTO terukur, audit source drift/credentials/CA expiry, rollback artifacts serta owner retention          |

Dump, Restic, copy dan recovery dapat membebani CPU/RAM/disk/bandwidth pada host
berbeda. Hindari overlapping heavy jobs yang tidak diukur; queue wait bukan selalu
hang. Managed replica globally sequential tidak berarti backup/DB jobs otomatis
diserialkan. Jadwalkan berdasarkan measurement. Retention Standard dan Managed
berbeda; object expiry dapat merusak repository yang masih dirujuk.

Rotasi credential DB/storage melalui field privat yang didukung, pause/drain,
uji ulang koneksi/dump/copy/recovery dan pertahankan recovery material lama sesuai
policy. [Operasi](/docs/operations), [capacity](/docs/deployment/vm-logs),
[credentials](/docs/security/credentials).

## 14. Upgrade dan rollback tanpa kehilangan identitas

Review release compatibility + hosted CI exact commit, backup control plane,
old image/app rollback dan seluruh operations. Pause/drain termasuk Source Access
requests, replica dan recovery. Deploy server kompatibel dahulu; schema/migration,
root operator dan worker memerlukan pemeriksaan terpisah. Baru upgrade Agent:

```sh
cd /srv/pluton
git pull --ff-only origin main
sudo bash installers/upgrade-agent.sh --check
sudo bash installers/upgrade-agent.sh
systemctl is-active pluton-agent
```

`/srv/pluton` adalah contoh checkout, bukan source aplikasi. Upgrader memakai
private Node/Corepack/pinned pnpm; hanya app diganti. EnvironmentFile, unit,
identity, TLS, source policy, DB/hooks config dan receipts tetap. `--check` lokal
read-only bukan server queue-drain proof. Agent pre-0.6.1 yang masih running
perlu operator drain/stop terpisah; tidak pernah paksa stop backup aktif.

Fix locale memakai C **hanya dalam perhitungan** tree/source fingerprint: sorting
dan serialization tidak bergantung LANG/LC_ALL/LC_COLLATE administrator, format=1
dan existing C digest tetap cocok. Environment service tidak diubah. Jika
mismatch nyata masih terjadi, berhenti; jangan rewrite `.verified-install`, force
atau re-enroll. Provenance legacy non-C tidak dimigrasikan otomatis.

Catat Failed stage/Error code/Rollback/Previous Agent preserved. Rollback SUCCESS
bukan upgrade sukses. Simpan root-protected receipt/artifacts; gunakan
`--rollback <exact-upgrade-id>` hanya setelah drain dan preservation checks yang
sesuai. Jangan restore identity/receipts lama atau downgrade Agent sehingga v4
exclusions/source restrictions diabaikan. Periksa versi/capability authenticated,
Agent ID, effective scope, database/hooks dan satu shadow cycle sebelum resume.
[Agent updates](/docs/remote-agent/updates), [server rollback](/docs/deployment/rollback).

## 15. Shadow adoption dan keputusan cutover

Pertahankan platform lama authoritative selama SHADOW. Buat inventory privat
aplikasi/DB/source/options/exclusions/interval/retention/RPO/RTO dan owner;
bandingkan coverage, bukan hanya jumlah plan. Gunakan repository Pluton baru
independen. Repository Legacy tetap read-only, tanpa init/prune/unlock/migrate.

Gate CUTOVER: scheduled cycles representatif; snapshot/content dan semua DB
artifacts; exclusions diterima pemilik; file+SQL+application recovery sesuai
kebutuhan; replicas/failure domains dan **jalur recovery replica nyata** ditinjau;
capacity/retention; notifications; credential/control-plane/rollback tersedia;
owner sign-off tertulis dan trigger rollback. Gate yang belum diuji tetap
NOT TESTED/BLOCKED. Snapshot SHADOW sukses tidak memberi izin mematikan backup lama.

Tidak ada perubahan SYS MON, cron, production atau legacy jobs yang dilakukan
oleh panduan ini. Ikuti [SHADOW](/docs/migration/shadow), [CUTOVER](/docs/migration/cutover)
dan [DR runbook](/docs/operations/disaster-recovery) pada window terpisah yang
diotorisasi. Untuk masalah di setiap langkah, mulai dari [troubleshooting](/docs/troubleshooting).
