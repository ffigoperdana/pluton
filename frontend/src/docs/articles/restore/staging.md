# Memulihkan ke staging dan memeriksa hasil

Staging adalah ruang terpisah untuk meninjau data hasil pemulihan sebelum digunakan oleh aplikasi. Untuk managed remote, Pluton membuat workspace privat baru di server; source agent tidak ditulis kembali. Contoh subfolder recovery/example-check pada halaman ini sepenuhnya fiktif.

## Target

Siapkan akses ke backup **Complete**, kapasitas disk untuk data logical, dan administrator yang akan meninjau hasil. Jalur managed memakai repository primary; mirror tidak menjadi sumber restore pada wizard ini.

1. Buka plan → **Backups** → menu backup yang dipilih → **Restore**.
2. Pada **Settings**, pilih **Staging destination**.
3. Pilih **New internal staging workspace** untuk tujuan standar. Jika perlu pengelompokan, pilih **Custom subfolder inside new staging workspace** dan isi **Relative staging subfolder**, misalnya recovery/example-check.
4. Klik **Next: Select Files to Restore**, lalu pilih isi yang diperlukan.
5. Klik **Next: Preview Restore**.

Subfolder tetap berada dalam workspace baru. Jangan isi absolute path server, path repository, atau path source. Backend memeriksa containment dan menolak tujuan tidak aman. Overwrite selalu never dan penghapusan berkas tidak tersedia pada managed staging.

## Preview

1. Klik **Generate Preview** dan tunggu hasilnya.
2. Tinjau path, jumlah berkas, direktori, ukuran, dan aksi yang akan dilakukan.
3. Klik **Next: Restore Backup**.
4. Pastikan konfirmasi menyebut **a new internal server staging workspace**, termasuk subfolder bila dipilih.
5. Klik **Yes, Restore** hanya setelah selection dan tujuan benar.

Preview belum menulis berkas. Pesan **Restore Started** hanya menunjukkan permintaan dimulai; tunggu hasil pada tab **Restores**. Periksa **Complete**, Restore Path, Files, dan **View Changes**. Klik nama pekerjaan untuk melihat rincian peristiwa bila dibutuhkan.

## Verifikasi manual

Bersama administrator, periksa isi, struktur direktori, izin, ukuran, dan berkas yang diperlukan aplikasi dalam staging privat. Bila memerlukan SQL, pastikan artefak sesuai snapshot dan import hanya ke target terisolasi yang disetujui. Restore berkas tidak otomatis membuat database berjalan.

Menyalin hasil ke deployment baru, menyalakan aplikasi, atau mengganti layanan produksi memerlukan prosedur dan persetujuan operasional tersendiri. [Recovery Test](/docs/recovery-testing) menyediakan pemeriksaan sementara, sedangkan [Restore Database](/docs/database-restores) mempunyai retensi database yang terpisah.

## Cleanup

Pada **Restores**, **Remove → Yes, Remove Restore** menghapus catatan riwayat. Aksi tersebut tidak menjanjikan penghapusan berkas staging yang sukses. Tidak ada TTL cleanup staging umum yang dapat Anda atur dari wizard ini.

Minta administrator mencatat workspace tepat milik pekerjaan, mempertahankan bukti yang diperlukan, lalu membersihkannya melalui prosedur host yang disetujui. Jangan menghapus direktori data server atau repository secara luas. Kegagalan/pembatalan restore managed mengusahakan cleanup workspace, tetapi peringatan cleanup tetap perlu diperiksa. Untuk TTL dan owned deletion database retained, gunakan [pengelolaan Persistent Restore](/docs/database-restores/ttl-cleanup).
