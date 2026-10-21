# Membuat plan Managed Agent dengan SFTP primer

Gunakan plan Managed Agent untuk mencadangkan satu folder aplikasi pada mesin Linux lain. Agent membaca source dan menulis snapshot ke SFTP primer. Setelah server memverifikasi snapshot, server dapat menyalinnya ke paling banyak dua repository S3 tambahan.

Contoh fiktif: mesin `app-01`, source `/srv/example-app`, storage `SFTP contoh`, dan destination `daily/app-01`. Siapkan file latihan dahulu agar Anda dapat menguji backup serta restore tanpa mengubah aplikasi aktif.

## Sebelum membuka formulir

Periksa mode pada **Source Access** mesin. Server-Managed memungkinkan validasi
dan pengaktifan source di dalam delegasi host langsung dari UI. Host-Approved
memerlukan persetujuan lokal untuk path baru di luar maksimum saat ini. Dalam
kedua mode, path pending belum boleh menjadi source yang dijalankan; hasil
canonical dan akses efektif harus dikonfirmasi dahulu. Mode tidak mengubah
identitas plan, Database & Hooks, tujuan SFTP, replication atau retention.

Pastikan agent sudah [terdaftar](/docs/remote-agent/enrollment), berstatus **ONLINE**, melaporkan capability `BACKUP_FILESYSTEM`, dan mempunyai **Allowed roots configured: Yes**. Jalankan [preflight source](/docs/remote-agent/permissions) agar folder serta file di dalamnya terbaca.

Tambahkan [SFTP](/docs/storage/sftp) pada **Storages**. Agent dan server perlu mengakses primer itu. Layanan SFTP boleh berada pada VM Pluton jika operator menyiapkannya; alurnya tetap memakai SFTP, bukan pilihan Local. Siapkan path baru atau kosong khusus plan dan staging pemulihan yang terpisah.

## Mengisi Basic dan Source & Destination

1. Buka **Backup Plans → + New**.
2. Pada **Basic**, isi **Backup Plan Name***, misalnya `Backup contoh app-01`, dan gunakan **Incremental Backup**.
3. Klik **Next: Configure Source & Destination**, lalu pilih `app-01` pada **Select Device***.
4. Pada Agent yang mendukung **Source Access**, pilih **Effective approved source root** atau masukkan satu path pada **Remote Backup Source***, klik **Validate source path**, lalu periksa canonical target. Dalam Server-Managed, gunakan **Apply source access** untuk path yang readable di dalam delegasi. Dalam Host-Approved, gunakan **Request access for this path** bila masih pending dan selesaikan host approval pada detail mesin. Setelah akses efektif dikonfirmasi, pilih **Use validated canonical path**. Agent lama tetap memakai input path manual dan preflight statis lokal. Tidak ada remote file browser.
5. Pada **Backup Destination***, pilih SFTP dan isi path `daily/app-01`. Periksa pemetaan home/chroot akun SFTP agar lokasi fisiknya benar.
6. Biarkan **Enable Replication** mati untuk backup pertama.

Source harus tetap berada dalam allowed roots setelah symlink diselesaikan. Source, mesin, serta destination yang sudah dipilih tidak dapat dipindahkan lewat edit biasa sebagai cara memigrasi repository.

## Backup Exclusions

Pada **Edit → Advanced → General → Backup Exclusions**, isi satu pola relatif per
baris. Field ini tersedia juga saat membuat plan; edit tidak membuat repository
atau plan baru. Perlu server yang mendukung exclusions dan Agent 0.7.0 dengan
capability `backupExclusionsVersion: 1`. Server menolak Agent lama bila pola diisi;
plan dengan exclusions kosong tetap memakai perilaku sebelumnya.

Contoh yang perlu disesuaikan dengan data yang benar-benar ingin dipulihkan:

```text
.git/
node_modules/
.cache/
**/cache/
*.tmp
```

Nama tunggal cocok di semua kedalaman. Pola berisi `/` dimulai dari source;
`*/cache/` hanya satu tingkat, sedangkan `**/cache/` juga mencakup cache pada root
source. `*` dan `?` tidak melewati `/`; `**` harus satu komponen utuh. Huruf,
angka, spasi, titik, `_`, `+` dan `-` didukung. Trailing `/` diabaikan, sehingga
pola nama juga dapat mengecualikan file atau symlink dengan nama yang sama.
Maksimum satu komponen recursive `**` ditambah akhiran `/**` opsional;
`**/dir/**/cache` ditolak. `.cache` berbeda dari `cache`. Jangan menyalin semua pengecualian sistem lama
tanpa menilai data yang dibutuhkan untuk pemulihan.

Path absolut, traversal, negasi `!`, character class `[ab]`, shell syntax dan
backslash ditolak. Maksimum 100 pola, 512 karakter per pola dan 16.384 unit teks
total. Semua pola dibatasi ke source canonical. Dump SQL dan metadata yang
dihasilkan **Database & Hooks** pada workspace terpisah tidak ikut dikecualikan;
file SQL yang sudah berada di source tetap mengikuti pola source.

Data yang dikecualikan tidak ada dalam snapshot pemulihan baru. Snapshot lama
tidak dihapus. Direktori yang dikecualikan tidak perlu dibuka; file terpilih yang
tidak terbaca tetap membuat backup gagal. Exclusions tidak memberi izin baru,
tidak mengikuti target nested symlink, dan tidak mengubah private-path guards.
Jika source atau exclusions berubah setelah job diantrekan, jalankan backup baru
sesuai pesan penolakan. Jangan melewati error dengan mengubah permission aplikasi.

Pada daftar plan, default pagination sekarang 9, dengan pilihan 18/27. Label
`DB · MariaDB` berarti database **dikonfigurasi**, bukan bukti dump masuk snapshot
atau recovery lulus. Detail plan menunjukkan engine/jumlah konfigurasi; periksa
artifact snapshot dan hasil recovery secara terpisah.

## Salinan S3 opsional

Anda dapat menambahkan 0, 1, atau 2 replika melalui **Enable Replication** dan **+ Add Replication Destination**. Pilih **AWS S3** atau **S3 Compatible Storage**, lalu gunakan prefix khusus pada bucket yang sudah tersedia. UI menampilkan awalan bucket bila ada; isi hanya subfolder pada field sisanya.

Untuk storage S3 compatible atau endpoint non-AWS, aktifkan **HCP / pre-existing namespace mode** pada konfigurasi storage sebagaimana [panduan HCP](/docs/storage/hcp). Kredensial replika digunakan server dan tidak diberikan kepada agent. Penyalinan managed dilakukan berurutan pada server untuk membatasi penggunaan sumber daya.

Alurnya adalah: **folder agent → snapshot SFTP primer → verifikasi server → replika S3 opsional**. Status sukses primer dan setiap replika terpisah. Interoperabilitas dengan HCP nyata belum diuji. Baca [replikasi Managed Agent](/docs/replication/managed-agent) sebelum mengandalkan salinan tambahan.

## Jadwal dan pengaturan awal

1. Klik **Next: Setup Schedule & Retention** dan pilih **Backup Interval**. Form remote tidak menampilkan kebijakan prune standar pada langkah ini.
2. Klik **Next: Advanced Settings**. Pertahankan **Encryption** aktif; repository managed memerlukan password yang dikelola server.
3. Pada **General**, matikan **Run Backup Now** jika ingin meninjau plan sebelum berjalan.
4. Untuk latihan awal, biarkan **Database & Hooks** tanpa database atau hook. Tambahkan fitur tersebut setelah filesystem tervalidasi.
5. Klik **Create Plan**, periksa detail tersimpan, lalu klik **Backup Now**.

## Memastikan plan siap digunakan

Tunggu **Complete** pada tab **Backups**. Buka **Browse**, lakukan **Download** atau restore ke staging, dan bandingkan file contoh. Jika replika diaktifkan, periksa badge serta detail setiap salinan. Backup primer sukses tidak membuktikan replica sukses.

Untuk dump database, lanjutkan ke [backup database](/docs/database-backup). Untuk uji pemulihan, gunakan [Recovery Testing](/docs/recovery-testing). Pemulihan file dan native database recovery saat ini tetap memakai primer; restore langsung dari mirror managed dan physical prune belum tersedia.

Jika source ditolak, periksa allowed roots serta izin. Jika repository preparation gagal karena isi destination atau akses, jangan mengosongkan folder atau mengubah validasi. Saat ingin menghentikan atau menghapus plan, gunakan [jadwal](/docs/backup-plans/schedule-retention) dan [penghapusan plan](/docs/backup-plans/delete); repository remote managed tetap dipertahankan.
