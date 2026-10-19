# Memisahkan source, staging, database, dan endpoint

Pemisahan lokasi serta hak akses menjaga pekerjaan backup/recovery tidak menulis ke sistem yang salah. Sebelum membuat plan, petakan source, state Agent, repository utama, replika, staging, dan database uji. Semua nama pada contoh berikut fiktif; daftar nyata disimpan privat.

## Filesystem

Source `app-01` di `/srv/example-app` di-resolve ke realpath dan harus berada dalam allowed root yang disetujui. Parent memerlukan traverse, direktori read/traverse, dan file regular read bagi akun layanan. Source tidak perlu writable. State Agent tidak boleh overlap source; symlink escape, mount hilang, node tidak didukung, dan permission gagal harus ditangani sesuai kategorinya.

1. Tinjau canonical source dan allowed roots, termasuk symlink dan parent.
2. Jalankan preflight read-only sebagai akun layanan mengikuti [permissions](/docs/remote-agent/permissions); gunakan scan eksplisit bila perlu memeriksa descendant.
3. Bila gagal, administrator meninjau ACL minimum pada path yang tepat. Installer tidak otomatis melakukan chmod/chown/setfacl source.
4. Uji lagi dengan identitas layanan yang sama, lalu verifikasi backup baru yang diizinkan. **ONLINE** bukan bukti keterbacaan source.

Binary privat tetap dilindungi, workspace privat memakai pembatasan akses, dan file sementara tidak boleh menjadi arsip publik. Jangan memakai root, `chmod 777`, atau seluruh `/home` sebagai allowed root untuk menghindari pemeriksaan.

## Restore

Restore menulis tujuan meskipun repository read-only. Pilih staging baru yang tervalidasi, tidak overlap source/repository/state, dan tidak menimpa data. Managed remote/Legacy memakai pemeriksaan containment, identitas snapshot, kepemilikan, serta never-overwrite. Perilaku historis mode lokal bukan alasan mengurangi guard remote.

Contoh: restore uji source `/srv/example-app` menuju area staging yang disetujui di luar source, kemudian bandingkan file di sana. Jangan mengarahkan restore ke source asli atau menyalin hasil ke aplikasi hidup tanpa prosedur peralihan terpisah. Ikuti [staging](/docs/restore/staging).

## Database

Pisahkan akun dump, akun import recovery, dan akun aplikasi. Required import memerlukan target dedicated dengan marker/grant yang sah, menolak existing database sesuai engine, serta cleanup berdasarkan kepemilikan. Lease cleanup tidak memberi hak menghapus database lain.

[Database Restores](/docs/database-restores) dapat mempertahankan database uji untuk inspeksi; periksa akses, TTL, resource, dan [penghapusan](/docs/database-restores/delete) sebelum meninggalkannya. Jangan menunjuk ke database produksi, menghapus marker keamanan, atau menganggap validasi hash SQL sama dengan aplikasi berhasil pulih.

## Outbound endpoint

Webhook/SMTP privat membutuhkan pilihan jaringan dan CIDR eksplisit. Semua jawaban DNS IPv4/IPv6 diperiksa dan koneksi dipin. Loopback, link-local/metadata, multicast, unspecified, credential dalam URL, dan redirect tetap ditolak. Replika Managed Agent memakai HTTPS S3 dengan prefix dedicated; endpoint/bucket/prefix tidak boleh overlap repository plan lain. Jangan menambah arbitrary Rclone/SSH flags atau izin jaringan luas untuk menghindari error.

## Review sebelum deployment

Periksa image/revisi yang ditinjau, volume/key yang sama, prosedur rollback, serta bukti uji disposable. Repository Legacy tidak masuk lifecycle backup terkelola dan tidak mempunyai jalur automatic forget/prune/unlock/repair. Kapasitas server 4 GiB belum membuktikan workload apa pun mampu berjalan; ukur beban representatif tanpa menurunkan resource/disk/concurrency guard. [Checklist migrasi](/docs/migration) memisahkan bukti uji dari persetujuan CUTOVER.
