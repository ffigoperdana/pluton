# Menangani masalah Persistent Restore

Mulai dari status restore, tahap terakhir, dan kode error yang aman. Jangan menilai keberhasilan dari hilangnya pesan loading atau keberadaan tombol. Permintaan yang tersimpan, import yang lolos, dan cleanup terverifikasi merupakan hasil yang berbeda.

Contoh database example_app pada halaman ini fiktif. Simpan informasi asli pada catatan operasional privat dan sanitasi sebelum membagikan laporan.

## Mengumpulkan informasi yang diperlukan

1. Buka **Database Restores** → pilih restore yang bermasalah.
2. Klik **Refresh**.
3. Catat restore ID, **Exact snapshot**, backup ID, engine, mode, status, **Cleanup**, dan waktu **Expires**.
4. Baca **Last backend restore stage** atau **Historical import stage**, kode **Error**, serta **Original failure** jika ada.
5. Cocokkan masalah dengan tabel berikut dan libatkan operator atau DBA yang berwenang.

Jangan membagikan password, approval privat, ownership token, isi SQL, endpoint nyata, atau inventaris produksi.

## Tidak dapat mengonfirmasi permintaan baru

| Gejala atau kode | Pemeriksaan berikutnya |
| --- | --- |
| Trusted database identity is missing / database-metadata-incomplete | Pastikan snapshot mempunyai metadata native yang lengkap; berkas .sql biasa tidak cukup |
| snapshot-metadata-changed | Klik Refresh verification dan tinjau ulang snapshot serta acknowledgement |
| Capacity unknown atau resource-capacity-unknown | Minta operator memulihkan pengukuran host/cgroup yang valid |
| resource-host-memory-headroom atau resource-operator-memory-headroom | Tinjau RAM tersedia pada envelope terkait |
| resource-operator-sql-budget | Cocokkan ukuran SQL dengan budget; MySQL Internal maksimal 128 MiB |
| database-workload-busy | Tunggu backup, restore, atau recovery lain selesai sebelum memeriksa ulang |
| mysql-worker-not-configured atau mysql-internal-unavailable | Minta operator memeriksa worker Oracle serta approval Internal otomatis |
| Daftar Approved target kosong | Belum ada target Custom yang disetujui untuk engine dan nama database yang dipilih |

Gunakan [resource pemulihan](/docs/database-restores/resources) untuk batas lengkap. MySQL Internal tetap memerlukan minimal 2.944 MiB RAM tersedia. Acknowledgement tidak mengatasi penolakan; jangan mematikan TLS, menambah credential produksi, atau mengubah threshold agar tombol aktif.

## Permintaan diterima tetapi belum aktif

**Awaiting automatic host lifecycle** atau **Provisioning Required** berarti penyediaan belum selesai. **Ready / Queued — not imported** juga belum menunjukkan SQL berhasil diimpor. Periksa tahap, status host, dan kemampuan operator; pada mode manual, operator masih harus bertindak.

**Importing** dapat melewati pemeriksaan koneksi, marker tujuan, grant, database kosong, staging/hash, import, dan katalog. Jika gagal, lihat **Original failure**. Jangan mengimpor ulang atau menghapus database yang sudah ada agar pemeriksaan empty-database lolos.

Binding/ownership atau TLS yang berubah harus ditinjau operator. Sistem tidak memilih target lain, snapshot latest, atau mirror secara otomatis sebagai pengganti primary.

## Inspect atau Resume ditolak

**restore-access-not-active** berarti inspeksi tidak memenuhi kondisi Active, belum expired, dan belum diminta dihapus. Periksa **Expires** dan status; [metadata inspection](/docs/database-restores/inspect) tidak membaca row atau menyediakan SQL console.

**operator-action-not-allowed** dapat menunjukkan mode atau status tidak sesuai, TTL habis, atau cancellation aktif. **Request resume** hanya merupakan tindakan administrator untuk Internal yang memenuhi syarat. Pembacaan status/polling tidak memberi persetujuan Resume baru.

Jika Resume sudah diminta tetapi status tetap Stopped atau tidak pasti, minta operator memeriksa urutan durabel dan ownership. Setelah kondisi aman, lakukan permintaan manusia baru hanya bila masih diperlukan dan TTL berlaku. Jangan menggunakan loop retry untuk mengaktifkan target.

## Expired atau Cleanup Required bertahan

Expired mencabut akses, tetapi belum membuktikan resource sudah dihapus. Nilai **uncertain** atau **infrastructure_pending** memerlukan bukti cleanup berikutnya. Error **workspace-cleanup-failed**, **reconciliation-required**, atau **host-ownership-unverified** perlu ditinjau terhadap restore ID dan resource tepat milik pekerjaan.

Koneksi hilang bukan bukti database atau container tidak ada. Unknown resources dipertahankan untuk investigasi. Jangan melakukan penghapusan Docker/SQL bebas, mengganti marker, menghapus data server secara luas, atau menghapus riwayat agar status tampak bersih.

Hasil akhir normal adalah **Deleted — owned cleanup verified**. Bila operasi awal gagal/dibatalkan, hasil dapat menjadi **Failed / cancelled — owned cleanup verified**; cleanup sukses tidak mengubah sejarah import.

## Memilih tindak lanjut

Jika hanya memerlukan SQL atau berkas, gunakan [Restore ke staging](/docs/restore/staging). Jika ingin menguji semua database sementara, gunakan [Recovery Test](/docs/recovery-testing). Untuk mengakhiri retained restore, ikuti [owned deletion](/docs/database-restores/delete) dan [TTL/cleanup](/docs/database-restores/ttl-cleanup).

Ketersediaan fitur, deployment, atau uji sintetis bukan pengukuran kapasitas recovery data nyata. Jangan menyatakan host 4 GiB sudah memenuhi kebutuhan aplikasi sebelum pengukuran dan latihan yang relevan benar-benar selesai.
