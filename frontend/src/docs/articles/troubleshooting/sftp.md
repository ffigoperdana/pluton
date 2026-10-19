# Memeriksa SFTP path, permission, dan transport

SFTP login dan Storage creation yang sukses belum membuktikan target repository dapat diinisialisasi atau ditulis dengan aman. Pemetaan home/chroot, parent directory, serta kredensial runtime dapat berbeda dari sesi administrator. Gunakan pemeriksaan read-only sebelum mengubah plan atau target.

## Gejala

Contoh sintetis: storage `SFTP app-01` tersimpan, tetapi backup pertama gagal target-check karena tujuan tidak dapat diakses. Pada server, physical path ada; di sesi SFTP tujuan memakai path relatif home/chroot. Gejala lain ialah target non-empty atau auth/transport failure saat pengecekan target.

## Penyebab

Path SFTP terlihat dari namespace sesi, bukan selalu root fisik host. Parent memerlukan traverse dan akses yang tepat; target repository terkelola baru memerlukan hak tulis yang memang diizinkan. Password representation, opsi Rclone/SSH tidak didukung, mount, DNS, jaringan, serta host trust juga dapat memengaruhi tahap berbeda.

**Directory not found** pada target berbeda dari missing config, access denied, auth failure, atau koneksi putus. Hanya target yang terbukti missing/empty dapat memenuhi pemeriksaan sebelum init. Error lain tidak boleh dianggap directory kosong.

## Diagnostik aman

1. Pada plan → **Backups**, catat stage/code dan waktu. Buka **View Logs** serta journal Agent terkait bila pekerjaan melalui Agent.
2. Tinjau storage dan path yang dipilih pada plan. Gunakan [contoh pemetaan SFTP](/docs/storage/sftp) untuk membedakan home-relative dan physical path.
3. Administrator memeriksa `pwd`, `ls /`, dan listing target melalui sesi SFTP dengan identitas yang sama. Tindakan ini membaca namespace; jangan membuat/menghapus directory untuk diagnosis.
4. Dengan protected config yang sama seperti runtime, bandingkan listing root dan target secara privat. Jangan membagikan password, SSH key, atau raw config.
5. Periksa safe rejected field/rule, misalnya `target-check-auth-failed`, `target-check-access-failed`, `target-check-transport-failed`, atau `repository-target-not-empty`, lalu tangani kategori yang tepat.

## Resolusi

Untuk salah mapping, betulkan path sesuai namespace SFTP yang benar setelah ditinjau. Untuk permission, administrator memberi hak minimum pada exact parent/target yang memang dedicated, tanpa mengganti ownership source atau membuka seluruh root. Untuk auth/transport, betulkan credential/trust/jaringan, kemudian ulangi pengecekan read-only.

Target baru yang terbukti missing atau kosong boleh berlanjut ke init melalui lifecycle plan yang didukung. Target non-empty harus tetap ditolak; pilih prefix/direktori baru yang dedicated, jangan menghapus data agar lolos. Repository lama yang ingin diperiksa menggunakan [Legacy Repositories](/docs/legacy-repositories), bukan init plan baru.

Sesudah perbaikan, jalankan satu backup yang diizinkan dan verifikasi snapshot exact, browse, serta staging restore. Sukses storage save/login saja belum menutup masalah.

## Jangan lakukan

Jangan recreate plan yang binding-nya sudah benar, overwrite target, menghapus parent repository, chmod 777, membuka arbitrary SSH/Rclone flags, atau melemahkan non-empty guard. Jangan mengulang init terhadap repository Legacy. Jika lokasi/ownership masih belum jelas, pertahankan data dan eskalasi bukti safe stage/code kepada administrator. [Storage security](/docs/storage/security) menjelaskan batas kredensial dan akses.
