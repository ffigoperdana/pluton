# Menghapus database hasil restore yang dimiliki

Gunakan penghapusan ketika pemeriksaan selesai atau Anda ingin membatalkan restore yang belum selesai. Tindakan ini hanya ditujukan pada database hasil restore dan resource yang ownership-nya dapat dibuktikan. Backup asli dan snapshot sumber tetap ada.

Contoh example_app pada halaman ini sepenuhnya fiktif. Cocokkan restore ID, bukan hanya nama database, sebelum meminta penghapusan.

## Sebelum menghapus

Pastikan Anda sudah menyimpan bukti pemeriksaan yang diperlukan secara privat. Database yang berhasil dihapus tidak dapat diaktifkan kembali dengan Resume. Jika kemudian dibutuhkan lagi, pemulihan baru memerlukan keputusan, snapshot, resource, dan konfirmasi baru.

Masuk sebagai administrator Pluton, buka **Database Restores**, lalu pilih entri yang benar pada **Database Restore Management**. Periksa **Restore**, **Exact snapshot**, **Backup**, **Archived database**, **Retained database**, mode, dan **Expires**.

## Langkah penghapusan

1. Pada detail restore, temukan **Delete / cancel this restore**.
2. Baca penjelasan bahwa penghapusan hanya menyasar database yang dimiliki dan meminta penghapusan infrastruktur yang dimiliki.
3. Isi **Type the exact restore ID** dengan restore ID yang ditampilkan.
4. Periksa ulang pilihan tersebut, lalu klik **Confirm owned deletion**.
5. Tunggu hasil. Pemberitahuan **Owned deletion requested. Await verified cleanup below.** menunjukkan permintaan diterima, bukan selesai.
6. Gunakan **Refresh** dan pantau status, **Cleanup**, serta kode error.

Konfirmasi harus cocok tepat. Jangan menyalin ID dari pekerjaan lain atau membuat otomatisasi yang menyetujui penghapusan semua entri.

## Urutan cleanup

Permintaan mengakhiri akses restore, menghentikan operasi terkait bila masih berjalan, kemudian menjalankan cleanup yang dibatasi ownership. Lease dan marker database harus cocok sebelum database dihapus.

Untuk **Internal**, penghapusan database dan workspace mendahului verifikasi penghapusan container/storage yang dimiliki. Target Stopped dapat dinyalakan hanya sejauh diperlukan untuk cleanup database yang terverifikasi. UI tidak memberi akses inspeksi kembali selama proses ini.

Untuk **Custom**, cleanup hanya menghapus database hasil restore dengan marker ownership yang cocok. Server database eksternal, database lain yang sudah ada, dan resource yang tidak terkait tidak dihapus. Riwayat restore tetap disimpan.

## Mengenali hasil yang selesai

| Tampilan | Makna operasional |
| --- | --- |
| Deleting — verification pending | Penghapusan masih perlu verifikasi |
| Cleanup Required | Ada langkah cleanup atau ownership yang perlu diselesaikan |
| Cleanup: infrastructure_pending | Cleanup database sudah melewati tahapnya, tetapi penghapusan infrastruktur belum terverifikasi |
| Cleanup: uncertain | Keadaan belum cukup pasti untuk menyatakan resource bersih |
| Deleted — owned cleanup verified | Penghapusan resource yang dimiliki sudah terverifikasi |
| Failed / cancelled — owned cleanup verified | Operasi awal gagal/dibatalkan dan cleanup yang dimiliki telah terverifikasi |

Periksa **Original failure** bila ditampilkan. Cleanup yang akhirnya berhasil tidak mengubah import yang gagal menjadi restore sukses.

## Jika cleanup tertahan

Koneksi hilang, file approval tidak terbaca, atau database tidak dapat dijangkau bukan bukti fisik resource sudah hilang. Sistem mempertahankan keadaan tidak pasti untuk investigasi, bukan menghapus resource asing atau mengganti marker.

Minta operator meninjau restore ID, binding snapshot, ownership database/storage, tahap kegagalan, dan receipt cleanup melalui prosedur host yang disetujui. Jangan menjalankan penghapusan Docker, SQL, atau direktori secara bebas untuk menyembunyikan status.

Plan atau backup yang masih mempunyai restore retained dapat menolak penghapusan sampai cleanup terverifikasi. Selesaikan ownership restore terlebih dahulu; lihat [menghapus plan](/docs/backup-plans/delete).

Untuk kedaluwarsa tanpa permintaan manual, baca [TTL dan cleanup](/docs/database-restores/ttl-cleanup). Untuk error berulang, gunakan [troubleshooting](/docs/database-restores/troubleshooting).
