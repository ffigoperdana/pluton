# Membaca hasil Recovery Test dan cleanup

Periksa hasil untuk snapshot yang akan digunakan, bukan hanya test terakhir yang pernah lolos. Backup dan recovery mempunyai status terpisah; kegagalan pengujian tidak otomatis menghapus snapshot backup.

## Membuka hasil yang benar

1. Buka plan → **Backups** dan cari backup yang diuji.
2. Buka menu titik tiga → **View Recovery Result** bila hasil tersedia.
3. Pada **Recovery Test Result**, cocokkan **Backup**, **Test**, dan **Exact snapshot** dengan catatan Anda.
4. Baca **Backend recovery status**, **Last reported stage**, **Tested at**, serta kode kegagalan bila ada.
5. Tinjau **Filesystem**, setiap entri **Databases**, dan seluruh **Cleanup**.

Menutup dialog tidak membatalkan pekerjaan server. Saat pekerjaan masih aktif, gunakan **Cancel Recovery Test** bila memang ingin menghentikannya, lalu tunggu hasil dan cleanup.

## Passed, warning, Failed, dan cleanup

| Status antarmuka | Makna | Tindakan |
| --- | --- | --- |
| Queued | Menunggu dijalankan | Tunggu dan pantau pekerjaan lain |
| Running | Pemeriksaan masih berjalan | Jangan menyimpulkan hasil dari tahap parsial |
| Passed | Semua pemeriksaan yang diwajibkan lolos untuk snapshot ini | Tinjau cakupan dan lanjutkan validasi aplikasi |
| Passed with warning | Pemeriksaan yang dilakukan lolos, tetapi ada bagian dilewati atau cleanup/peringatan perlu perhatian | Baca kode warning dan status import/cleanup |
| Failed | Setidaknya satu pemeriksaan wajib gagal | Perbaiki penyebab lalu uji lagi secara sadar |
| Cancelled | Pengujian dihentikan | Pemeriksaan yang belum dijalankan tidak dianggap lolos |

Untuk Internal, import/katalog yang sukses belum cukup: penghapusan infrastruktur milik test harus terverifikasi sebelum hasil dinyatakan Passed. Kegagalan cleanup dapat membuat hasil Failed.

## Filesystem-only

Bagian **Filesystem** menampilkan regular files, byte, dan source trees yang dipulihkan serta divalidasi. Snapshot tanpa database dapat lolos pengujian filesystem. Bukti ini tidak memeriksa aplikasi boot, koneksi eksternal, atau fungsi bisnis.

Contoh fiktif: 12 regular files berhasil dipulihkan dari app-01. Anda tetap perlu memastikan konfigurasi aplikasi benar dalam lingkungan terisolasi sebelum cutover.

## Database artifact-only

Periksa **Artifact integrity** untuk setiap database. Ukuran dan SHA-256 yang cocok membuktikan artefak sesuai catatan. Jika terlihat **SQL import NOT TESTED (Disabled)**, jangan mengklaim database berhasil dipulihkan menjadi database yang berjalan.

Required import yang tidak memiliki target, identitas, client, atau compatibility yang valid harus ditangani sebagai kegagalan. Jangan menurunkan policy hanya agar label hasil menjadi lebih baik.

## Cleanup

Baca **Workspace**, **Temporary databases**, dan, untuk Internal, status infrastruktur. **Not confirmed** atau cleanup pending berarti masih ada hal yang perlu diperiksa; SQL sensitif atau database sementara dapat tertinggal.

Minta operator mencocokkan test ID, ownership, dan resource tepat milik pekerjaan sebelum pembersihan manual. Jangan menghapus database asing atau resource bersama untuk mengosongkan status. Untuk database yang sengaja dipertahankan, gunakan [Persistent Restore](/docs/database-restores), yang mempunyai lifecycle berbeda.

## Snapshot binding

Passed untuk snapshot lama bukan bukti snapshot terbaru sudah diuji. Catat waktu, full snapshot, mode import, warning, dan hasil cleanup secara privat. Jika masalah berulang, gunakan [cakupan validasi](/docs/recovery-testing/validation) dan [target import](/docs/recovery-testing/import) untuk menentukan penyebab, tanpa memublikasikan SQL atau credential.
