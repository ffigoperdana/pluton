# Menyiapkan import database untuk Recovery Test

Pilih native import bila Anda ingin mengetahui apakah semua SQL native pada snapshot dapat diimpor dan katalognya dapat diperiksa. Target pengujian bersifat sementara dan harus terpisah dari database sumber maupun produksi. Contoh recovery-db.example.internal di halaman ini sepenuhnya fiktif.

## Prasyarat wajib

DBA menyediakan endpoint recovery-only, pembatasan jaringan, akun berhak minimum, serta marker tujuan **pluton_recovery_guard** dengan purpose **pluton-phase6-recovery-only**. Untuk target remote, gunakan TLS terverifikasi. Klien import kompatibel harus tersedia pada Pluton Server; MySQL asli memerlukan worker Oracle yang disetujui.

Checkbox pada UI tidak membuat endpoint menjadi aman. Aplikasi memeriksa marker, grant, atribut akun, dan katalog sebelum membuat database disposable. Provisioning target dilakukan melalui runbook administrator yang direview, tanpa memakai database sumber.

## Menyimpan target Custom

1. Buka plan yang sudah disimpan → **Edit → Advanced → Recovery Testing**.
2. Pada engine terkait, pilih **Recovery Target → Custom** bila pilihan tersedia.
3. Centang **Enable this recovery target**.
4. Isi **Host**, **Port**, **Recovery username**, dan **Write-only recovery password** dengan data target terisolasi.
5. Pilih **Transport → Verified TLS (remote)** untuk endpoint remote. **Explicit loopback local target** hanya untuk localhost, 127.0.0.1, atau ::1.
6. Setelah DBA memverifikasi target dan marker, centang pernyataan dedicated recovery infrastructure.
7. Klik **Save mariadb recovery target**, **Save mysql recovery target**, atau **Save postgresql recovery target**, sesuai engine.
8. Pilih **Database import validation → Required — all databases must import**, lalu klik **Save recovery policy**.

Password tersimpan tidak dibaca kembali. Target recovery ini berbeda dari credential backup dan approval Persistent Restore.

## Internal atau Custom

**Internal** memerlukan host operator, profile, TLS, dan resource yang sudah dipersiapkan administrator. Pada instalasi otomatis, host operator membuat target disposable setelah admission. Pada mode manual, operator harus menyiapkan dan mengaktifkan target sebelum test.

Hanya satu engine boleh memakai Internal dalam satu test; engine lain tetap Custom. Matikan **After every successful backup (opt-in)** ketika memakai Internal dan simpan policy. Tinjau [resource Internal](/docs/database-restores/resources); acknowledgement tidak melewati batas, termasuk 2.944 MiB RAM tersedia dan SQL maksimal 128 MiB untuk MySQL Internal.

## Per-engine

MariaDB/MySQL mempertahankan nama logical database dari dump. Nama tersebut harus belum ada pada target; aplikasi tidak menghapus database yang sudah ada untuk meloloskan import. Scope akun mengikuti nama database yang diizinkan dan marker read-only, tanpa global admin, FILE, SUPER, atau grant option.

PostgreSQL membuat nama disposable baru. Akun, role NOLOGIN, owner, dan ekstensi harus sesuai kebutuhan dump; superuser, CREATEROLE, replication, BYPASSRLS, dan akses luas yang tidak aman ditolak. Kompatibilitas aplikasi tetap perlu pengujian tersendiri.

## Cleanup ownership

Lease dicatat sebelum pembuatan database, kemudian ownership token mengikat database yang dibuat. Cleanup hanya menghapus database dengan identitas milik pekerjaan tersebut. Bila ownership tidak pasti, minta tinjauan operator; jangan menghapus database yang tidak dikenal.

Test Internal belum selesai hanya karena import lolos: database, workspace, dan penghapusan infrastruktur yang dimiliki harus terverifikasi.

## Required atau Disabled

Di **Confirm Recovery Test**, **Native import — every recorded database required** mencakup semua database tercatat. Kegagalan salah satunya bukan keberhasilan parsial. **Artifact-only — SQL import NOT TESTED** memeriksa integritas SQL tanpa menguji import. Required tidak diturunkan otomatis menjadi artifact-only.

Berkas .sql biasa tanpa metadata native tidak mendapat engine yang ditebak. Untuk kebutuhan tersebut, gunakan [Restore berkas](/docs/restore). Setelah test, baca [hasil](/docs/recovery-testing/results) dan pisahkan validasi katalog dari validasi fungsi aplikasi.
