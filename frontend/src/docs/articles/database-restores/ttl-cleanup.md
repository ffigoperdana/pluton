# Memahami masa berlaku dan cleanup Persistent Restore

Setiap Persistent Restore mempunyai waktu kedaluwarsa agar database hasil pemulihan tidak tersimpan tanpa batas. Pilih durasi yang cukup untuk pemeriksaan, kemudian tetap pantau cleanup. Kedaluwarsa mencabut akses; penghapusan resource baru selesai setelah hasilnya terverifikasi.

## Memilih TTL

Saat membuat restore melalui **Backups → Restore Database**, pilih **Retention from confirmation**. Pilihan standar adalah 1, 6, dan 24 jam dengan nilai awal 24 jam. Pilihan lebih lama memerlukan approval operator; batas kontrak tetap berlaku.

Waktu mulai TTL adalah konfirmasi yang diterima server, bukan saat import selesai. Waktu menunggu target dan pembuatan database ikut memakai durasi tersebut. UI saat ini tidak menyediakan perubahan atau perpanjangan masa berlaku untuk restore yang sudah dibuat.

Contoh fiktif: konfirmasi 6 jam diterima pukul 09.00, sehingga **Expires** pukul 15.00. Import selesai pukul 09.20 tidak menggeser expiry menjadi 15.20.

## Memeriksa masa berlaku

1. Buka **Database Restores** → **Database Restore Management**.
2. Pada daftar, periksa **Expires** dan restore ID.
3. Buka detail dan cocokkan **Created**, **Expires**, **Started**, **Import validated**, serta **Last validated**.
4. Jika data masih dibutuhkan, selesaikan pemeriksaan sebelum waktu berakhir.
5. Jika selesai lebih awal, gunakan [Confirm owned deletion](/docs/database-restores/delete).

Tanggal/waktu tampil mengikuti lingkungan browser. Cocokkan waktu lengkap pada catatan pemeriksaan; jangan mengandalkan perkiraan lama halaman terbuka.

## Stopped tidak menghentikan TTL

**Request stop** menghentikan runtime Internal sambil mempertahankan data dan storage. Masa berlaku tetap berjalan. **Request resume** juga tidak memperpanjang TTL atau mengimpor ulang database.

Restore yang sudah kedaluwarsa tidak dapat di-Resume untuk mengembalikan akses inspeksi. Jika membutuhkan data lagi setelah cleanup, buat permintaan baru melalui [alur Persistent Restore](/docs/database-restores) dengan snapshot yang masih tersedia.

## Saat kedaluwarsa

Alurnya adalah: **Expires tercapai → akses inspeksi dicabut → cleanup diminta → database yang dimiliki dibersihkan → infrastruktur Internal yang dimiliki dihapus → hasil removal diverifikasi**.

Tampilan dapat menunjukkan **Expired — access revoked; owned cleanup pending** pada lifecycle otomatis, atau **Expired — access revoked; cleanup may require operator action** pada mode manual. Expired tidak sama dengan Deleted.

Jika target Internal sedang Stopped, reconciler dapat mengaktifkan tepat target yang dimiliki hanya untuk menyelesaikan cleanup database. Itu bukan persetujuan Resume baru untuk pemeriksaan pengguna. Pada mode manual, operator mungkin perlu menjalankan proses cleanup yang disetujui.

## Membaca Cleanup

| Nilai Cleanup | Yang perlu dipahami |
| --- | --- |
| none | Belum ada cleanup yang diminta; database aktif dapat memang sedang dipertahankan |
| requested | Cleanup diminta dan belum selesai |
| database_removed | Tahap penghapusan database tercatat; periksa tahap berikutnya |
| infrastructure_pending | Penghapusan infrastruktur masih menunggu verifikasi |
| uncertain | Keadaan atau ownership belum dapat dipastikan |
| verified | Cleanup yang dimiliki sudah diverifikasi |

Untuk Custom, server eksternal tetap ada; hanya database yang dimiliki restore yang dihapus. Untuk Internal, database, workspace, dan infrastruktur mempunyai pemeriksaan tersendiri. Riwayat restore dipertahankan.

## Menangani keadaan yang belum pasti

Periksa **Original failure**, kode error, status host, dan **Last validated**. Import yang gagal dapat berakhir dengan label **Failed / cancelled — owned cleanup verified** sesudah cleanup, sedangkan keberhasilan normal berakhir **Deleted — owned cleanup verified**.

Resource yang tidak dapat dibuktikan ownership-nya tidak dihapus otomatis. Hilangnya koneksi bukan receipt removal. Jika **Cleanup Required** bertahan, serahkan restore ID dan kode aman kepada operator untuk meninjau resource yang tepat. Jangan menghapus container, database, atau direktori bersama secara luas.

Panduan ini membahas retensi database hasil restore, bukan retensi snapshot backup atau TTL staging berkas umum. Lihat [resource](/docs/database-restores/resources), [Stop/Resume](/docs/database-restores/stop-resume), dan [troubleshooting](/docs/database-restores/troubleshooting) untuk tindak lanjut.
