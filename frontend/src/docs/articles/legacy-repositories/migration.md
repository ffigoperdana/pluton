# Menjalankan backup baru paralel dengan sistem lama

Gunakan masa paralel untuk mengumpulkan bukti bahwa backup baru dapat memenuhi kebutuhan pemulihan aplikasi. Selama pilot, pertahankan SYS MON sebagai sistem backup yang menjadi acuan dan biarkan source serta repository lamanya tetap berjalan sesuai prosedur yang ada.

Semua contoh di panduan ini fiktif: aplikasi app-01 memakai /srv/example-app, sedangkan repository managed baru menggunakan tujuan terpisah dari repository Legacy.

## Shadow operation

1. Catat kebutuhan pemulihan aplikasi secara privat: berkas, database, rentang riwayat, RPO, RTO, dan pemilik keputusan.
2. Daftarkan repository lama melalui **Legacy Repositories → + Register** untuk akses read-only.
3. Pastikan **Check access**, pencarian snapshot, dan contoh restore Legacy bekerja tanpa mutasi repository.
4. Buat managed plan dan repository tujuan baru melalui [panduan managed agent](/docs/backup-plans/managed-agent). Jangan menunjuk tujuan baru ke repository Legacy.
5. Konfigurasikan [database native](/docs/database-backup) jika aplikasi memerlukannya, kemudian jalankan backup baru pada jadwal yang disetujui.
6. Pertahankan pekerjaan SYS MON selama menguji hasil managed secara paralel.

Registrasi Legacy tidak memindahkan jadwal, password, retensi, atau ownership ke lifecycle managed. Tidak ada pengambilalihan otomatis setelah backup pertama sukses.

## Evidence

Pada plan baru, buka tab **Backups** dan cocokkan pekerjaan **Complete** dengan snapshot yang benar. Periksa berkas dan artefak SQL melalui **Browse**, lalu lakukan [restore ke staging](/docs/restore/staging).

Jalankan [Recovery Test](/docs/recovery-testing) dengan native import pada target recovery-only bila cakupan aplikasi memerlukan database. Catat mode import, hasil setiap database, cleanup, serta hal yang belum diuji. Contoh uji yang hanya membaca hash SQL tidak boleh dicatat sebagai pemulihan database semantik.

Ukur RPO/RTO dari latihan yang relevan, termasuk pemulihan aplikasi terisolasi. Ukuran repository, warna status, deployment fitur, atau Passed satu snapshot tidak otomatis membuktikan kapasitas dan target layanan terpenuhi.

## Credential lama

Inventarisasi pemakaian credential script lama secara privat. Rotasi dilakukan manual setelah dependency, pemilik layanan, dan urutan cutover disetujui. Jangan menaruh password, script berisi rahasia, IP nyata, atau akun produksi dalam dokumentasi dan laporan publik.

Pekerjaan dokumentasi atau keberhasilan pilot bukan izin mengubah script maupun server produksi.

## Cutover

Cutover memerlukan persetujuan eksplisit pemilik layanan, latihan recovery yang memadai, maintenance window, monitoring, dan jalur rollback. Keputusan untuk menghentikan cron atau SYS MON merupakan perubahan operasional terpisah.

Pilot tidak mengotorisasi drop database, penggantian source path, init, forget, prune, unlock, atau migrasi format repository lama. Ikuti [migrasi shadow](/docs/migration/shadow) dan [cutover](/docs/migration/cutover) untuk melanjutkan perjalanan.

## Sesudah transisi

Pertahankan akses riwayat lama secara read-only selama kebijakan pemilik data masih memerlukannya. Repository serta snapshot tidak ditulis ulang atau di-rekey otomatis.

Simpan bukti privat yang menghubungkan backup, snapshot, restore, hasil aplikasi, dan keputusan operator. Jika bukti belum cukup, lanjutkan masa paralel dengan SYS MON sebagai acuan; jangan menandai transisi selesai hanya karena plan baru sudah aktif.
