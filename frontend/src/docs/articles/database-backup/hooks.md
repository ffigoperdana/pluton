# Menyiapkan pre-hook dan post-hook backup

Gunakan hook bila aplikasi membutuhkan persiapan sebelum backup dan pengembalian setelahnya, misalnya prosedur aplikasi fiktif untuk mengurangi penulisan sementara. Administrator harus menyiapkan dan meninjau executable terlebih dahulu. Mengisi identifier tidak memasang program baru pada agent.

## Kontrak remote

Hook remote adalah identifier executable di direktori administrator, biasanya /etc/pluton-agent/hooks. Executable dan direktori induknya harus dimiliki root serta tidak dapat ditulis oleh agent, grup, atau pengguna lain. Proses tetap berjalan sebagai akun agent non-root.

Antarmuka menerima identifier, argumen tetap yang diizinkan, dan timeout. Jangan menempelkan shell script, sudo, arbitrary executable path, password, atau token ke kolom tersebut.

## Mengaktifkan hook

1. Minta administrator memastikan executable tersedia, aman, dan memiliki prosedur kegagalan yang jelas.
2. Buka plan → **Edit → Advanced → Database & Hooks**.
3. Pada **Lifecycle Hooks**, centang **Pre-backup hook (failure blocks backup)** bila diperlukan.
4. Isi **Hook identifier** dengan identifier yang disetujui. prepare-example-app hanyalah contoh fiktif.
5. Isi **Fixed non-secret arguments (one per line)** hanya bila executable memang memerlukannya; selain itu kosongkan.
6. Atur **Timeout (seconds)** dalam rentang 1–300 detik.
7. Bila diperlukan, centang **Post-backup hook (always attempted; failures are warnings)** dan isi pasangan konfigurasinya.
8. Klik **Update Plan**, jalankan **Backup Now** pada waktu uji yang disepakati, lalu periksa hasil dan keadaan aplikasi.

## Urutan

Pre-hook plan berjalan sekali sebelum seluruh dump. Agent kemudian membuat dump database berurutan, mencadangkan berkas dan SQL, lalu mengonfirmasi snapshot. Post-hook diusahakan sesudah operasi, termasuk kegagalan dan pembatalan.

Hook tidak menghasilkan transaksi terdistribusi. Pemilik aplikasi menentukan kapan penulisan harus berhenti dan kapan layanan boleh kembali normal.

## Failure

Pre-hook gagal mencegah backup. Dump gagal juga mencegah backup Restic; post-hook tetap diusahakan. Bila snapshot berhasil tetapi post-hook gagal, hasilnya berupa peringatan lifecycle dan tidak membatalkan snapshot.

Timeout menghentikan kelompok proses terkait. Keluaran mentah hook tidak menjadi laporan publik. Jika host mati atau proses berhenti mendadak, post-hook dapat tidak berjalan. Administrator tetap membutuhkan fail-safe untuk mengakhiri mode persiapan aplikasi.

## Penggunaan aman

Sesudah uji, verifikasi dua hasil: **Backups** menunjukkan hasil yang benar dan aplikasi kembali pada keadaan yang disepakati. Periksa **Complete*** serta kode peringatan; warna sukses saja tidak cukup.

Tinjau idempotensi, hak minimum, dan langkah pemulihan manual bersama administrator. Script lokal mempunyai kontrak berbeda dan tidak memberi izin shell remote. Lanjutkan ke [artefak dan konsistensi](/docs/database-backup/artifacts) serta [Recovery Test](/docs/recovery-testing) untuk memeriksa hasil backup.
