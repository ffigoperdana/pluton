# Menambahkan SFTP dan memastikan path repository benar

Gunakan SFTP sebagai storage primer untuk backup dari Managed Agent. Sebelum mulai, administrator SFTP perlu menyediakan akun khusus dan folder tujuan yang dapat ditulis. Agent dan Pluton Server harus dapat mengakses layanan tersebut. Server SFTP boleh berada di VM Pluton; tentukan kapasitas serta dampak kegagalan VM itu terhadap salinan primer.

Contoh fiktif: nama storage `SFTP contoh`, host `sftp.example.internal`, port `22`, dan path plan `daily/app-01`. Password diisi secara privat melalui formulir.

## Menambahkan koneksi

1. Buka **Storages → + New**.
2. Isi **Storage Name*** dan pilih **SFTP** pada **Storage Type***.
3. Buka **Account Authentication**, lalu isi **SSH Host**, **SSH Port**, **SSH Username**, dan **SSH Password** dengan data akun yang disiapkan operator.
4. Untuk Managed Agent, gunakan autentikasi password yang didukung. Jangan menambahkan external SSH binary, key file, SSH agent, custom hash command, atau path konfigurasi arbitrary.
5. Klik **Add Storage** dan pastikan konfigurasi berhasil tersimpan.
6. Saat membuat plan, pilih storage ini pada **Backup Destination*** dan masukkan path repository tersendiri.

## Path efektif

Path plan ditafsirkan dari filesystem yang terlihat dalam sesi SFTP akun tersebut. Path itu tidak otomatis menunjuk root filesystem fisik host, dan nama storage tidak menambahkan folder tertentu.

Misalnya administrator menyiapkan chroot fisik `/srv/sftp/app-01` dengan home sesi `/repo`. Destination plan `daily/app-01` berarti repository di `/repo/daily/app-01` pada sesi SFTP, atau `/srv/sftp/app-01/repo/daily/app-01` pada host. Jika home sesinya berbeda, hasil pemetaannya juga berbeda.

Minta administrator memverifikasi working directory dan listing dengan akun yang sama. Jangan mengisi `/repo` dua kali berdasarkan dugaan. **SSH Path Override** adalah opsi untuk perbedaan path perintah SSH; membiarkannya kosong tidak berarti destination menjadi absolut dari `/`.

## Subset remote

Managed Agent memakai host, port, username, dan password SFTP yang dipersiapkan server untuk pekerjaan terkait. Opsi lanjutan provider pada form standar tidak otomatis tersedia untuk agent. Validator backend menolak nilai atau opsi yang tidak didukung.

Representasi password sementara yang dibutuhkan Rclone bukan pengganti perlindungan kredensial aplikasi. Jangan menyalin temporary config atau process environment ke tiket dukungan. Kredensial S3 replika terpisah: server menggunakannya sendiri sesudah snapshot primer diverifikasi.

## Repository safety

### Akun, connectivity dan failure domain

Siapkan akun backup khusus dengan scope pada repository yang disetujui, bukan
akun administrator source. Agent memerlukan write untuk snapshot; server juga
memerlukan akses primary untuk verification/copy/restore. Permission/chroot/quota
ditata administrator SFTP. Tidak ada perintah chroot/setfacl otomatis di panduan
ini, dan keberhasilan password login bukan bukti scope atau host-key pinning.

Sebelum membuat plan, verifikasi DNS/port dari Agent dan server serta working
directory/listing dengan akun yang sama melalui tool privat yang disetujui.
Jangan menampilkan password pada argumen atau salinan transcript publik. Setelah
Add Storage berhasil, uji hanya prefix kosong dedicated dan satu file sintetis
melalui workflow backup/restore; jangan menguji penulisan pada repository existing.

Folder berbeda pada filesystem/VM yang sama memberi isolasi logical tetapi
tetap berbagi disk, quota dan kegagalan host. Replica independen memerlukan
failure domain yang benar-benar berbeda dan jalur recovery teruji. Storage
authentication, password repository Restic dan master key Pluton berbeda.

Untuk rotasi password: identifikasi semua consumer (Agent/server/retained
repository) secara privat, pause/drain, ubah melalui konfigurasi storage yang
didukung, verifikasi koneksi, backup dan staged restore sebelum mencabut akses
lama. Jangan recreate storage/plan atau merotasi encryption key sebagai shortcut.

Tujuan Managed Agent harus belum ada atau kosong. Setelah plan pertama disiapkan, repository itu menjadi milik plan tersebut. Jangan memasukkan file aplikasi, dump manual, atau repository plan lain ke dalamnya.

Hasil yang diharapkan adalah storage tersimpan, plan dapat mempersiapkan repository, lalu **Backup Now** mencapai **Complete**. Buka **Browse** dan lakukan [restore ke staging](/docs/restore/staging) untuk membuktikan isi dapat diambil kembali.

Jika **Add Storage** berhasil tetapi persiapan backup gagal, periksa pemetaan home/chroot, izin menulis, kuota, dan konfigurasi remote. Jangan menghapus isi destination atau memperluas izin hanya untuk lolos validasi. Gunakan [diagnostik SFTP](/docs/troubleshooting/sftp) untuk memisahkan error koneksi dari error repository.
