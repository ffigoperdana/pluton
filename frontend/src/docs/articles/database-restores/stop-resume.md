# Menghentikan dan melanjutkan database Internal

Gunakan Stop ketika database hasil restore masih perlu disimpan tetapi belum diperlukan untuk inspeksi. Gunakan Resume bila Anda ingin mengaktifkan kembali database Internal yang sama sebelum masa berlakunya habis. Data tetap terikat pada restore, snapshot, dan storage yang sudah diverifikasi.

Contoh pada panduan ini adalah restore fiktif example_app. Tombol pada halaman detail mengirim permintaan terbatas; pemberitahuan bahwa permintaan tersimpan belum membuktikan runtime sudah berhenti atau aktif.

## Sebelum bertindak

Buka **Database Restores**, pilih restore yang benar, lalu periksa restore ID, **Exact snapshot**, mode Internal, **Expires**, dan status cleanup. Stop/Resume hanya tersedia untuk Internal. Custom merupakan server eksternal dengan lifecycle terpisah yang dikelola operatornya.

Masuk sebagai administrator. Jangan menerapkan tindakan pada entri lain hanya karena nama database sama. Restore yang kedaluwarsa atau diminta dihapus tidak dapat diaktifkan kembali untuk inspeksi.

## Meminta Stop

1. Pastikan status **Active Restore**.
2. Klik **Request stop** satu kali.
3. Baca pemberitahuan permintaan. Pada mode otomatis, host reconciler memproses intent; pada mode manual, operator masih harus menyelesaikan tindakannya.
4. Gunakan **Refresh** dan periksa status serta **Current host state** bila tersedia.
5. Tunggu **Stopped** sebelum menyimpulkan runtime sudah berhenti.

Stop mempertahankan database dan storage milik restore. Ia tidak menghapus data, mengembalikan SQL ke source, atau memulai backup baru. Metadata inspection tidak tersedia selama Stopped.

## Meminta Resume secara eksplisit

1. Pastikan entri yang dipilih berstatus **Stopped**, TTL belum habis, dan tidak ada permintaan deletion.
2. Tinjau kebutuhan kapasitas serta kesiapan operator bersama administrator bila sebelumnya ada resource error.
3. Klik **Request resume** dari sesi administrator yang terautentikasi.
4. Tunggu verifikasi host dan gunakan **Refresh** untuk membaca hasilnya.
5. Setelah status kembali **Active Restore**, gunakan **Refresh metadata inspection** untuk memeriksa katalog dan waktu pengamatan terbaru.

Permintaan Resume diverifikasi lagi terhadap resource, ownership, target, dan masa berlaku. Resume memakai database serta storage yang sama; ia bukan import ulang, format ulang, pembuatan target pengganti, atau perpanjangan TTL.

## Permintaan bukan restart policy

Resume memerlukan permintaan eksplisit dari administrator yang terautentikasi. Pembacaan status, polling, restart aplikasi, atau restart host tidak menjadi persetujuan Resume baru.

Pada lifecycle otomatis, permintaan diproses dengan urutan durabel dan tidak boleh berubah menjadi izin Start yang dapat dipakai berulang. Jika permintaan sudah dikonsumsi lalu Start tidak dapat dipastikan, sistem dapat tetap Stopped atau menunjukkan cleanup/ownership yang perlu ditinjau. Setelah keadaan aman dan terverifikasi, administrator harus memilih **Request resume** lagi bila masih ingin melanjutkan.

Jangan mengirim permintaan berulang otomatis untuk mencari status sukses. Minta operator meninjau restore ID dan keadaan sebenarnya bila status tidak jelas.

## TTL tetap berjalan

Waktu **Expires** berasal dari konfirmasi awal dan tidak berhenti selama **Stopped**. Contoh fiktif: restore berakhir pukul 16.00; Stop pukul 15.00 tidak memindahkan waktu kedaluwarsa.

Saat TTL habis, akses inspeksi dicabut dan cleanup diminta. Reconciler dapat menyalakan target tepat yang dimiliki hanya untuk cleanup database, bukan untuk menghidupkan kembali akses pengguna. Jangan menganggap runtime yang sementara aktif untuk cleanup sebagai Resume yang Anda minta.

## Jika tindakan ditolak

**operator-action-not-allowed** dapat berarti status, mode, TTL, atau cancellation tidak memenuhi syarat. Penolakan resource saat Resume harus diselesaikan melalui pengukuran dan operator; acknowledgement tidak menghapus batas MySQL Internal 2.944 MiB RAM tersedia atau SQL 128 MiB.

Kegagalan koneksi bukan bukti data hilang. Gunakan [troubleshooting](/docs/database-restores/troubleshooting), [resource](/docs/database-restores/resources), atau [TTL/cleanup](/docs/database-restores/ttl-cleanup). Jika data sudah tidak diperlukan, lakukan [owned deletion](/docs/database-restores/delete).
