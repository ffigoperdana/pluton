# Memahami apa yang diperiksa Recovery Test

Gunakan hasil pengujian sesuai cakupannya agar keputusan pemulihan tidak bergantung pada satu label sukses. Recovery Test memeriksa data yang dipulihkan dari snapshot pilihan; ia tidak membandingkan langsung dengan database produksi atau menjalankan seluruh alur bisnis aplikasi.

## Meninjau cakupan sebelum test

1. Buka plan → **Backups** → menu backup **Complete** → **Run Recovery Test**.
2. Periksa **Exact snapshot**, engine, logical database, path, dan ukuran artefak pada **Confirm Recovery Test**.
3. Tinjau **Validation mode**. Pastikan native import diwajibkan jika tujuan Anda menguji kemampuan import.
4. Gunakan **Refresh snapshot and resource checks** bila resource atau kesiapan target berubah.
5. Setelah test selesai, periksa bagian **Filesystem**, **Databases**, dan **Cleanup** pada **Recovery Test Result**.

Contoh fiktif: snapshot example_app memiliki 12 regular files dan tiga direktori. Struktur yang sesuai dan ukuran benar adalah bukti pemulihan berkas, tetapi belum bukti aplikasi dapat login.

## Struktur filesystem

Restore berjalan dalam workspace privat. Server memeriksa full snapshot, ikatan plan/backup, pohon sumber, path, jenis node, jumlah regular file, byte, dan direktori hasil restore.

Path tidak diharapkan, source tree hilang, traversal, symlink, node khusus, dan perbedaan struktur dapat membuat test gagal. Recovery managed menggunakan repository primary; test tidak mengambil snapshot pengganti dari mirror atau source agent.

Validasi ini mencakup integritas restore Restic dan struktur. Ia bukan perbandingan SHA-256 setiap berkas terhadap source aktif dan bukan pemeriksaan aplikasi dapat berjalan.

## SQL artifacts

Identitas database dan engine berasal dari hasil backup yang tepercaya. Sebelum import, server memeriksa path artefak, ukuran, dan SHA-256. Identitas atau path duplikat, metadata rusak, SQL tercatat yang hilang, atau ukuran/hash berbeda tidak disembunyikan sebagai keberhasilan filesystem-only.

Di hasil, periksa **Artifact integrity** dan label import setiap database. **SQL import NOT TESTED** berarti integritas artefak saja belum menguji kemampuan import. Jika import sukses, jumlah tabel/views dan hasil pemeriksaan versi tetap tidak menjamin perilaku bisnis aplikasi.

File .sql biasa dalam folder sumber tidak memperoleh metadata native otomatis. Metadata versi source/dump juga belum selalu dicatat; jangan mengartikan preview engine sebagai sertifikasi kompatibilitas versi.

## Resource

Sediakan kapasitas untuk data logical yang dipulihkan, SQL, ruang sementara, dan kebutuhan target database. Preflight ruang bebas bukan kuota sistem operasi untuk seluruh pekerjaan.

Pengujian memiliki batas waktu, keluaran, dan workspace, serta pembatasan pekerjaan bersamaan. Internal memakai batas tambahan; lihat [resource recovery](/docs/database-restores/resources). Capacity unknown atau Blocked harus ditangani dengan pengukuran dan operator, bukan dengan melewati acknowledgement.

## Historical metadata

Snapshot filesystem lama dapat diuji bila ikatan dan source tree dapat dibuktikan. Metadata single-database lama hanya membuktikan informasi yang memang dicatat. Required import menolak metadata engine/nama yang tidak lengkap; ia tidak menebaknya dari filename.

Jangan mengubah snapshot historis atau credential untuk membuat bukti terlihat lengkap. Simpan catatan privat tentang apa yang diperiksa, apa yang tidak diuji, dan tindak lanjutnya. Lanjutkan ke [interpretasi hasil](/docs/recovery-testing/results) serta [target import](/docs/recovery-testing/import).
