# Troubleshooting: Source Files or Directories Are Inaccessible

Panduan untuk operator Ubuntu/Linux dengan standalone Pluton Agent. Gunakan saat Error Details menampilkan `source-entry-inaccessible`, kegagalan source lain, atau detail path yang perlu ditinjau. Semua contoh memakai identitas sintetis `app-01` dan `/srv/example-app`; ganti dengan source yang **sudah disetujui**, bukan menambah scope. Pluton tidak menjalankan command di panduan ini. Tombol salin hanya membantu contoh diagnostik statis read-only; baca dan sesuaikan sebelum menjalankannya sendiri.

## 1. Understand the error

### Source tidak terbaca atau symlink ditolak

Ada dua batas yang berbeda: **Source Access/host approval** menentukan root yang boleh dipakai; POSIX permission/ACL menentukan apa yang benar-benar dapat dibaca identitas layanan `pluton-agent`. Persetujuan root tidak mengubah chmod, ownership, ACL atau policy OS. File membutuhkan read; setiap parent membutuhkan execute/search untuk traversal. Untuk mendaftar direktori, layanan memerlukan read dan search.

Status root **Readable**, Agent **ONLINE**, dan **Allowed roots configured** tidak membuktikan semua nested files readable. Source Access Validate memeriksa root dan authorization, bukan recursive scan seluruh plan. Restic bisa mencapai descendant yang tidak terbaca setelah berjalan lama. Aplikasi dapat membuat, menghapus, merotasi atau mengganti permission file setelah validation; mount dan symlink juga bisa berubah.

### Gejala

**Error Details** dan **Backup Events → View Error** menunjukkan safe stage/code serta relative paths bila dilaporkan. Agent 0.7.0/historical jobs hanya mungkin punya kode generik. Agent 0.7.1 memerlukan Server yang menegosiasikan extension. Tidak ada path/errno/type yang dikarang. Type dari Restic bisa **Not reported**. `.` berarti source root. Nama unsafe ditahan, bukan dipotong menjadi nama lain.

Maksimum 20 contoh ditampilkan; observation count bisa lower bound dan berulang untuk entry yang sama. Direktori inaccessible dapat menyembunyikan banyak child. **Source scan (before Restic)** berbeda dari **Restic backup**; tanpa field origin, titik deteksi tepat tidak diketahui. Copy Sanitized Diagnostics tetap perlu ditinjau sebelum dibagikan.

ACL memberi akses terhadap data yang harus dicadangkan; exclusion sengaja mengurangi coverage. Keduanya keputusan berbeda. Filesystem backup juga terpisah dari **Database & Hooks**: root aplikasi readable tidak membuktikan dump SQL sukses, dan exclusion source tidak mengecualikan workspace dump terpisah. Mengubah exclusions memengaruhi backup berikutnya; snapshot historis tidak diubah atau dihapus olehnya.

## 2. Verify the Agent

Jalankan pada host Agent yang benar. Pemeriksaan ini tidak memulai backup:

```bash readonly
systemctl is-active pluton-agent.service
systemctl is-enabled pluton-agent.service
systemctl status --no-pager pluton-agent.service
```

`is-active` mengembalikan status nonzero bila tidak aktif; `is-enabled` hanya memeriksa konfigurasi startup, bukan kesehatan backup. Cocokkan versi, heartbeat terakhir dan service identity melalui informasi host yang diotorisasi. Jangan menjalankan daemon sebagai root untuk melewati kegagalan akses.

```bash readonly
sudo journalctl -u pluton-agent.service \
  --since "30 minutes ago" \
  --no-pager -o short-iso \
  | grep -Ei 'source-validation|source-entry|restic-backup|failed stage=' \
  | tail -50
```

Tidak ada hasil grep bukan bukti sehat: rentang waktu, filter atau akses journal mungkin tidak sesuai. Journal sengaja memakai stage/code generik; path-level diagnostics dibaca dari hasil job tersimpan, bukan harus muncul di journal. Log lain dapat memuat metadata operasi. Redaksi host, user, path, token, header dan credential sebelum sharing. Jangan mencetak isi file/key untuk diagnosis. Masalah OFFLINE/network dibahas di [konektivitas Agent](/docs/remote-agent/troubleshooting#offline).

## 3. Identify the approved backup root

### Diagnostik aman

Contoh root di bawah adalah fiktif. Buka plan dan tinjau source yang disimpan serta approved canonical root sebelum mengisi variabel. Gunakan shell yang sama untuk blok yang memakai variabel; jangan menyalin nama dari output yang tidak dipercaya sebagai command.

```bash readonly
ROOT='/srv/example-app'
sudo realpath -e "$ROOT"
namei -l "$ROOT"
stat -c '%U:%G %a %n' "$ROOT"
```

`realpath -e` harus cocok dengan canonical target yang memang diharapkan. Hasil berbeda, symlink atau alternate mount perlu review host owner; jangan mengikuti path ke luar approved scope atau memperluas allowed roots sebagai workaround. `namei -l` membantu melihat tiap parent; `stat` hanya metadata saat itu, bukan bukti akses identitas Agent. Root privileges pada terminal operator tidak mewakili permission layanan.

## 4. Find inaccessible entries

Utamakan relative entry yang sudah ada di popup; tidak perlu scan seluruh tree untuk setiap error. Jika masih perlu scan, lakukan eksplisit sekali pada jendela operasi yang disetujui:

```bash readonly
cd /
ROOT='/srv/example-app'
sudo -u pluton-agent find -P "$ROOT" -xdev \
  \( \
    -type d \( ! -readable -o ! -executable \) \
    -o -type f ! -readable \
  \) -print 2>&1 | head -80
```

- `cd /` menghindari error kembali ke working directory operator yang tidak dapat diakses akun layanan, misalnya home administrator privat.
- `-P` tidak mengikuti target symlink; jangan menggantinya dengan `-L`. Pastikan starting root canonical sudah ditinjau.
- `-xdev` tidak turun ke filesystem lain. Bila backup memang mencakup mount lain, contoh ini tidak membuktikan coverage mount tersebut.
- `-readable` memeriksa akses identitas yang menjalankan find; `-executable` pada direktori memeriksa search/traverse. Bukan simulasi lengkap pembacaan Restic.
- Direktori terblok dapat membuat descendants tidak terlihat. Tree bisa berubah selama scan; `ENOENT` bisa transient.
- `head -80` membatasi output, **bukan runtime, jumlah traversal atau bukti sukses**. Pipeline dapat berakhir karena SIGPIPE; jangan menganggap status pipeline atau tidak adanya output sebagai scan lengkap. Hentikan dengan Ctrl+C bila perlu, dan batasi waktu/resource sesuai prosedur host.
- Output dapat memuat absolute paths, nama berkarakter kontrol/newline atau metadata privat. Perlakukan sebagai teks tidak dipercaya; jangan paste ke shell atau laporan publik. Popup melakukan sanitasi tersendiri.

Jangan memasang full scan otomatis pada polling, heartbeat atau pembukaan halaman. Scan sukses tidak menjamin backup besar berikutnya sukses. CLI read-only Agent yang sudah ada adalah alternatif bounded (10.000 entries/lima detik); partial results bukan full coverage:

```bash readonly
sudo -u pluton-agent /opt/pluton-agent/runtime/bin/node \
  /opt/pluton-agent/app/dist/index.js preflight \
  --source /srv/example-app --allowed-roots /srv/example-app --scan
```

Path instalasi harus sesuai deployment yang disetujui. `--allowed-roots` pada contoh bukan perintah memberi host approval. CLI tidak menyimpan plan. Tambahkan `--exclude` yang persis sudah disetujui bila relevan; tidak ada remote recursive Scan button baru.

## 5. Inspect an individual file

Ganti placeholder dengan file yang sudah dicocokkan terhadap relative path popup dan approved root. Jangan berasumsi basename saja cukup.

```bash readonly
FILE='/srv/example-app/path/to/reviewed-file.pdf'
namei -l "$FILE"
stat -c '%U:%G %a %n' "$FILE"
sudo -u pluton-agent test -r "$FILE" \
  && echo READABLE \
  || echo NOT_READABLE
```

`test -r` hanya akses dasar saat pemeriksaan. NOT_READABLE juga dapat muncul bila sudo/akun/path gagal, bukan bukti errno EACCES tertentu. Periksa parent, mount, identity dan error lain. File dapat diganti sebelum backup; jangan membuka atau mencetak isinya. Untuk direktori, read saja tidak cukup tanpa search/traverse.

## 6. Inspect ACLs

```bash readonly
sudo getfacl -p "$FILE"
```

Owner/group/other mode bits dan named user/group ACL bersama-sama menentukan akses. `mask::` membatasi effective permission named users dan group class; perhatikan komentar `#effective:`. Parent traversal tetap dibutuhkan walaupun ACL file benar. ACL direktori dan default ACL untuk child baru adalah hal berbeda. Simpan/review ACL awal, mask, mode, owner/group secara privat di catatan perubahan yang disetujui sebelum tindakan apa pun. Lihat [manual getfacl Ubuntu](https://manpages.ubuntu.com/manpages/jammy/man1/getfacl.1.html).

Jika `getfacl` tidak tersedia, utilitas itu disediakan paket Ubuntu **acl**, bukan paket bernama getfacl. **PERUBAHAN SISTEM — hanya setelah persetujuan operator dan review package management**, jalankan manual bila memang dibutuhkan:

```bash review
sudo apt-get install acl
```

Instalasi paket bukan diagnostik read-only. Pluton tidak menjalankannya dan panduan tidak menyediakan tombol salin command mutasi.

## 7. Safely grant read-only access

### Resolusi

**PERUBAHAN PERMISSION — perlu persetujuan application/host owner.** Pastikan data benar-benar wajib untuk recovery; tinjau full parent path, ownership, policy OS dan ACL awal. Jangan otomatis memberi read ke SSH private keys, credentials, secret stores atau sensitive configuration. Hindari broad group membership, recursive ownership dan permission terbuka untuk semua.

Untuk **satu regular file yang sudah ditinjau**, contoh tindakan manual:

```bash review
sudo setfacl -m u:pluton-agent:r-- "$FILE"
```

Verifikasi read-only sesudah perubahan disetujui:

```bash readonly
sudo getfacl -p "$FILE"
sudo -u pluton-agent test -r "$FILE" \
  && echo READABLE \
  || echo NOT_READABLE
```

Untuk **satu direktori yang sudah ditinjau**, contoh tindakan manual berbeda:

```bash review
DIR='/srv/example-app/path/to/approved-directory'
sudo setfacl -m u:pluton-agent:rx "$DIR"
sudo getfacl -p "$DIR"
```

Parent yang diperlukan mungkin butuh search permission minimum; directory listing membutuhkan read juga. ACL pada direktori tidak otomatis memberi read pada semua child. Tidak ada `-R` default; default ACL bagi file baru memerlukan keputusan dan persetujuan terpisah, bukan resep universal.

**Peringatan mask:** setfacl secara default dapat menghitung ulang mask. Akibatnya effective access principal lain dapat ikut berubah walaupun entry Agent hanya read-only. Bandingkan ACL/mask sebelum dan sesudah bersama owner; bila filesystem tidak mendukung ACL atau hasil tidak sesuai, hentikan dan eskalasi. Jangan mengubah file sistem/aplikasi lain. Lihat [manual setfacl Ubuntu](https://manpages.ubuntu.com/manpages/jammy/man1/setfacl.1.html).

**ROLLBACK MANUAL — hanya jika entry ini baru diperkenalkan oleh remediation ini**, bukan entry lama yang dibutuhkan proses lain:

```bash review
sudo setfacl -x u:pluton-agent "$FILE"
```

Removal bukan pemulihan otomatis seluruh ACL/mask awal. Cocokkan kembali original ACL, mask dan mode; pemulihan nilai awal harus ditinjau owner. Jangan menghapus entry yang sudah ada sebelumnya atau menimpa perubahan sah orang lain. Catat tindakan, persetujuan dan hasil verifikasinya.

## 8. When exclusions are better

Exclusion dapat lebih aman/efisien daripada memberi akses ke data disposable yang tidak diperlukan recovery. Kandidat **setelah verifikasi owner**, bukan default: `.git`, cache, temporary PDF exports, generated temporary directories, application logs bila retensi/audit mengizinkan, dan dependencies yang terbukti dapat dibangun ulang dari deployment terdokumentasi.

Jangan menganggap uploads, user documents, business records, persistent app data, database files/dumps atau direktori dengan nama tidak dikenal aman di-exclude. Exclusion bukan cara menyembunyikan kegagalan data penting. Jangan mengandalkan raw database data files sebagai pengganti dump native yang konsisten.

Jika popup menyebut `app/logs/id_rsa`, jangan membuat private key lebih readable untuk memaksa backup sukses. Tinjau mengapa key ada di sana, pemilik, penggunaan dan strategi pemulihannya. Exclude hanya jika recovery plan membolehkan; kebutuhan backup material rahasia memerlukan rancangan keamanan tersendiri.

## 9. Configure Backup Exclusions

### Excluded versus included

UI aktual untuk **Managed Agent filesystem backup**: **Backup Plans → pilih plan → Edit → Advanced → General → Backup Exclusions**. Masukkan satu pola relatif per baris dan simpan. Field itu tidak disediakan untuk setiap jenis source/method. Plan memakai satu canonical source root; jangan copy seluruh host root ke field exclusions.

Contoh A sintetis, root `/srv/example-app`, kandidat yang harus ditinjau:

```text review
app/logs
.git
cache
```

Contoh B sintetis, root `/srv/example-portal`, kandidat transient export:

```text review
public_html/console-app/export/tmp
```

`/srv/example-app/app/logs` adalah absolute path dan ditolak. `srv/example-app/app/logs` tanpa leading slash juga salah jika maksudnya child `app/logs`; UI memperingatkan copied-root prefix tetapi tidak mengganti pola otomatis. Gunakan preview sample path untuk mengecek matcher statis, bukan untuk mengklaim Agent sudah bisa membacanya.

Semantik v1 aktual Server/Agent, case-sensitive:

| Pola | Makna |
| --- | --- |
| `.git` atau `cache` | Nama bare pada setiap kedalaman; `.cache` berbeda dari `cache` |
| `app/logs` | Path anchored di dalam root source |
| `public_html/console-app/export/tmp` | Subtree relatif yang tepat, termasuk entry direktori itu sendiri |
| `*/cache` | Satu komponen sebelum cache; tidak mencakup root `cache` |
| `**/cache` | Recursive whole-component; mencakup root dan nested cache |
| `*.tmp`, `file?.pdf` | Wildcard komponen yang didukung, bukan arbitrary regex/shell |
| `node_modules/**` | Subtree anchored pada root `node_modules`; bukan setiap nested directory dengan nama itu |

Satu whole-component recursive `**` didukung, dengan optional trailing `/**`; trailing `/` diabaikan. Negation `!`, character classes `[ab]`, traversal `..`, absolute paths dan shell expansion tidak didukung. Batasnya 100 pola, 512 karakter per pola, total 16.384 units. Pola invalid ditolak, bukan dilewati diam-diam.

Agent 0.7.0/0.7.1 memakai capability exclusions v1 dan payload v4 bila nonempty. Exclusions diterapkan **sebelum** lstat/access/traversal dan Restic di-anchor ke canonical source. Excluded entries tidak boleh masuk daftar inaccessible hanya karena dilewati. File included yang tidak terbaca tetap membuat backup gagal; tidak ada auto-exclude. Mandatory private-directory guards tetap berlaku. Workspace dump terpisah tidak ikut terfilter oleh exclusions source.

Data excluded tidak ada dalam snapshot baru; snapshot lama tetap mengikuti retention yang sudah ada. Jika source/exclusions berubah setelah job diantrekan, ikuti penolakan receipt dan buat satu run baru setelah setting tersimpan; jangan memodifikasi queued command. Baca juga [kontrak exclusions](/docs/backup-plans/managed-agent#backup-exclusions).

## 10. Verify exclusions safely

Contoh manual berikut hanya mem-prune tiga direktori root yang sudah ditinjau:

```bash readonly
cd /
ROOT='/srv/example-app'
sudo -u pluton-agent find -P "$ROOT" -xdev \
  \( -path "$ROOT/app/logs" \
     -o -path "$ROOT/.git" \
     -o -path "$ROOT/cache" \) -prune -o \
  \( \
    -type d \( ! -readable -o ! -executable \) \
    -o -type f ! -readable \
  \) -print 2>&1 | head -80
```

Ini **manual sample scanner, bukan bukti exact Restic exclusion behavior**. Root-only prune `.git`/`cache` di contoh tidak sama dengan bare-name Agent matcher yang mencakup setiap kedalaman. Sesuaikan manual hanya terhadap keputusan owner; jangan menerjemahkan glob Agent ke find secara otomatis. Inaccessible descendants bisa belum ditemukan, file dapat berubah, `-xdev` membatasi mount dan `head` membatasi output saja. Lihat [GNU Findutils](https://www.gnu.org/software/findutils/manual/html_node/find_html/Changing-the-Current-Working-Directory.html) untuk batas traversal/race. Exact coverage tetap memerlukan satu controlled backup dan recovery verification.

## 11. Controlled retry and recovery verification

1. Simpan exclusions yang sudah ditinjau; jika ada ACL remediation, selesaikan prosedur host, original ACL dan approval record lebih dahulu.
2. Pastikan tidak ada conflicting backup/restore yang aktif; jangan enqueue duplikat.
3. Pastikan Agent **Online** dengan heartbeat baru dan source approval tetap benar.
4. Klik **Backup Now** **sekali** dalam jendela yang diotorisasi.
5. Pantau **Backup Events** dan tahap aktual. Progress lambat bukan alasan menekan berulang.
6. Periksa terminal **Complete**. Failed/cancelled tetap gagal/dibatalkan, bukan sukses karena popup lebih informatif.
7. Verifikasi exact snapshot dan intended protected data lewat Browse/metadata, termasuk coverage exclusions yang diterima owner.
8. Jalankan [isolated Recovery Test](/docs/recovery-testing/validation) dan [restore staging](/docs/restore/staging). Filesystem Complete tidak membuktikan SQL import, replication atau recovery lulus.
9. Pertahankan SYS MON/legacy backups selama Pluton masih SHADOW hingga validasi independen dan cutover disetujui. Jangan memodifikasi scripts atau repository lama untuk diagnosis ini.

## 12. Troubleshooting reference

### Penyebab

| Kode/gejala | Pemeriksaan read-only | Langkah berikut dan eskalasi |
| --- | --- | --- |
| `source-entry-inaccessible` | Relative entry, service identity, namei, stat, ACL dan saved exclusions | Owner menilai minimal access vs exclusion; kode ini saja tidak membuktikan errno tertentu |
| `EACCES` | Read file dan search tiap parent, effective ACL mask | Review izin minimum dengan host owner; tidak otomatis memperluas scope |
| `EPERM` | Metadata dan policy OS, mount/security logs oleh admin | Security/host admin memeriksa policy; jangan menonaktifkan enforcement sebagai workaround |
| `ENOENT` | Canonical path, mount, file rotation/removal pada waktu job | Bedakan transient disappearance dari source salah; bukan otomatis permission denied |
| Symlink escape / `ELOOP` | Realpath yang diharapkan dan link metadata | Host owner review target; jangan mengikuti keluar approved root atau melonggarkan containment |
| Permission berubah sesudah validation | Waktu, application rotation, file creator/default ACL | Perbaiki proses pembuatan file setelah owner review; jangan recursive ACL default |
| Mounted filesystem unavailable | Mount status/path oleh host admin, status operasi lain | Eskalasi storage/host; jangan initialize repository atau recreate plan untuk memperbaiki mount |
| Source root mismatch / policy violation | Source plan vs canonical/approved root dan request revision | Ikuti approval resmi untuk source yang memang dimaksud; jangan ubah identity/receipt manual |
| Exclusion rule mismatch | Saved pola, case, root anchoring, capability dan queued receipt | Preview matcher lalu owner review dan save; new run eksplisit, tanpa auto-rewrite |
| Agent offline / network timeout | Heartbeat, service dan [connectivity guide](/docs/remote-agent/troubleshooting#offline) | Connectivity/admin menilai DNS/TLS/network; tidak diklasifikasikan sebagai source permission |
| Restic execution failure | Safe stage/code, tool/version/storage status | Periksa [SFTP](/docs/troubleshooting/sftp) atau [database/TLS](/docs/database-backup/connections#diagnostik) sesuai bukti; jangan mengarang source path/errno |
| Unknown / historical job | Versi, waktu, safe code dan detail yang benar-benar tersimpan | Nyatakan keterbatasan; upgrade terkontrol tidak dapat mengisi path historis yang tidak pernah dilaporkan |

## 13. Security and operational guidance

### Jangan lakukan

Tidak ada automatic chmod/chown/setfacl, sudo shell dari browser, arbitrary remote command, source approval change atau auto-exclusion. Jangan menggunakan `chmod -R 777`, broad chown, unrestricted groups, Agent root, `cat` secret files, atau menurunkan TLS/HMAC/lease/replay checks. Perintah ACL di artikel adalah **mutasi manual setelah approval**, bukan tombol tindakan UI. Detail source hanya untuk authenticated operator sesuai kewenangan instalasi; docs statis ini public dan tidak menerima path melalui query/fragment.

Popup memakai relative path dan closed fields dari hasil tersimpan, maksimum 20 samples, dengan sanitasi display/clipboard. Full source paths atau nama file sensitif masih perlu redaksi saat operator menyalin laporan. Pertahankan host-approved scope, staged review, audit dan rollback. Jangan mengubah source files, backup data, Agent identities atau SYS MON scripts. Biarkan SYS MON aktif selama SHADOW.

## 14. FAQ and anonymized incidents

### Incident A — synthetic portal workload

Bukti insiden yang dilaporkan operator: source sekitar **78 GB** memiliki temporary PDF export directories yang inaccessible dan satu PDF lain dengan akses baca kurang. Operator meninjau satu ACL file yang sempit serta exclusion relatif `public_html/console-app/export/tmp`; backup berikut dilaporkan berhasil. Nama host, account dan root asli disamarkan. Ini laporan operator, bukan pengujian produksi oleh patch ini. Jangan menganggap setiap PDF/export dapat dibuang; owner harus membedakan dokumen pengguna dari output transient.

### Incident B — synthetic application workload

Bukti insiden yang dilaporkan operator: source sekitar **22 GB** gagal pada `app/logs/id_rsa`. Setelah kebutuhan recovery ditinjau, operator memilih exclusion log yang tidak dibutuhkan, dan filesystem backup berikut dilaporkan berhasil. Private key tidak dibuat lebih readable sebagai solusi praktis. Identitas/root asli disamarkan. Keberhasilan filesystem tersebut tidak membuktikan dump database, replica atau restore telah lulus.

### Why did Validate say Readable?

Validate memeriksa root/approval saat itu. Descendants bisa memiliki owner, ACL, mount atau lifecycle berbeda. Gunakan path-level result bila tersedia dan jangan mengulang large backup hanya untuk menebak path.

### Does a passing find command prove backup success?

Tidak. Manual sample scan, bounded Agent preflight, Restic backup dan isolated recovery test memiliki cakupan berbeda. Gunakan satu controlled retry setelah review, kemudian verifikasi coverage/recovery. Jangan menjalankan full scans berulang pada busy production host.

### Can I roll back an exclusion or ACL?

Pulihkan hanya setting plan yang disetujui dan simpan kembali. Untuk ACL, gunakan catatan awal dan prosedur di bagian 7; jangan menghapus entry lama. Perubahan exclusions tidak memodifikasi snapshot historis, dan re-including data memerlukan backup baru yang sukses. Eskalasi bila tidak ada evidence cukup untuk perubahan yang aman.
