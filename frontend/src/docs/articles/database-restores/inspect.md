# Memeriksa metadata database hasil restore

Gunakan inspeksi untuk meninjau struktur database yang telah berhasil diimpor. Anda dapat melihat engine, versi, jumlah tabel/views, dan daftar objek tanpa membuka isi row atau menjalankan query bebas.

Contoh database example_app pada panduan ini fiktif. Kemunculan nama tabel yang diharapkan membantu pemeriksaan struktur, tetapi belum membuktikan seluruh data dan fungsi aplikasi benar.

## Syarat inspeksi

Restore harus berstatus **Active Restore**, belum melewati **Expires**, dan tidak sedang diminta untuk dihapus. Anda harus masuk sebagai administrator yang berwenang pada Pluton. Koneksi target, TLS, approval, dan ownership tetap diperiksa server.

**Stopped**, kedaluwarsa, pembatalan, atau status cleanup tidak memberikan akses inspeksi. Jika target Internal berhenti dan TTL masih berlaku, tinjau [Stop/Resume](/docs/database-restores/stop-resume) sebelum meminta Resume secara eksplisit.

## Langkah pemeriksaan

1. Buka navigasi **Database Restores** untuk menampilkan **Database Restore Management**.
2. Pilih entri berdasarkan nama database, engine, mode, dan restore ID yang benar.
3. Cocokkan **Exact snapshot**, **Backup**, **Repository**, **Archived database**, serta **Retained database**.
4. Pastikan status **Active Restore** dan waktu **Expires** masih berlaku.
5. Klik **Refresh metadata inspection** dan tunggu tanggapan server.
6. Baca **Validated catalog** serta waktu **Observed**. Periksa juga **Last validated** pada detail restore.

Tombol **Refresh** di bagian atas membaca ulang catatan restore. **Refresh metadata inspection** meminta pemeriksaan target database; keduanya bukan tindakan yang sama.

## Membaca hasil

| Informasi | Cara menggunakan |
| --- | --- |
| Engine dan versi | Cocokkan dengan engine artefak dan target yang disetujui |
| Tables dan views | Bandingkan jumlah dengan cakupan struktur yang diharapkan |
| Size | Gunakan sebagai informasi pengukuran target; Not measurable berarti ukuran tidak dapat diukur |
| Schema, Name, Type | Tinjau objek yang terdapat dalam katalog |
| Observed dan Last validated | Periksa kapan metadata terakhir diamati |

Tampilan katalog dibatasi paling banyak 200 entri. Bila muncul pemberitahuan pembatasan katalog, jumlah tabel/views tetap mencakup semua objek yang dihitung. Batas tampilan bukan tanda objek lain tidak dipulihkan.

UI tidak menampilkan isi row, password target, ownership token, atau SQL console. Jangan menafsirkan daftar katalog sebagai validasi transaksi bisnis, koneksi aplikasi, role aplikasi, atau kemampuan aplikasi boot.

## Jika inspeksi ditolak

Jika tombol tidak aktif, periksa status, masa berlaku, dan permintaan penghapusan terlebih dahulu. Bila muncul **restore-access-not-active**, akses memang tidak memenuhi kondisi aktif. Jangan mencoba Resume pada restore yang sudah kedaluwarsa.

**database-workload-busy** berarti pekerjaan lain masih memegang reservasi; tunggu selesai lalu periksa kembali. Error TLS, target berhenti, atau ownership/binding berubah memerlukan peninjauan operator. Koneksi yang gagal tidak membuktikan database sudah dihapus.

Simpan hanya hasil yang diperlukan secara privat. Nama skema dan tabel juga dapat mengandung informasi internal; sanitasi sebelum membagikan laporan publik.

## Setelah pemeriksaan

Jika masih memerlukan database Internal dan TTL mencukupi, [Stop](/docs/database-restores/stop-resume) dapat menghentikan runtime sambil mempertahankan data yang dimiliki. Stop tidak memperpanjang retensi dan tidak menggantikan penghapusan.

Jika pemeriksaan selesai, gunakan [Confirm owned deletion](/docs/database-restores/delete). Tunggu hasil cleanup yang terverifikasi, bukan sekadar hilangnya koneksi. Lihat [TTL dan cleanup](/docs/database-restores/ttl-cleanup) untuk keadaan Expired atau Cleanup Required.
