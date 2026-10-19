# Memulihkan database dan menyimpannya sementara

Gunakan **Restore Database** bila Anda ingin mengimpor satu database dari backup lalu mempertahankan hasilnya untuk pemeriksaan selama waktu yang dipilih. Hasil dibuat pada target terpisah dengan batas retensi. Berkas SQL yang hanya diunduh atau dipulihkan ke staging belum menjadi database yang berjalan.

Contoh pada panduan ini sepenuhnya fiktif: plan app-01 mencadangkan database example_app dan example_audit. Anda ingin memeriksa example_app tanpa mengganti database sumber.

## Sebelum mulai

Siapkan backup managed agent berstatus **Complete** dengan full snapshot ID dan metadata database native. Metadata harus mencatat identitas database, engine, nama logical database, path SQL, ukuran, serta SHA-256. Berkas .sql biasa dalam folder sumber tidak cukup; engine tidak ditebak dari filename.

Masuk sebagai administrator Pluton. Administrator host harus menyiapkan profile Internal atau target Custom yang disetujui, TLS, pembatasan resource, dan mekanisme ownership. Anda tidak memasukkan credential administrator database atau perintah host pada wizard ini.

Pemulihan memakai repository **primary** managed. Mirror bukan sumber Persistent Restore yang didukung. Source agent tidak dihubungi untuk menulis kembali data.

## Membuat Persistent Restore

1. Buka plan → tab **Backups**. Pilih pekerjaan **Complete** dengan waktu yang diperlukan.
2. Buka menu titik tiga pada baris tersebut → **Restore Database**.
3. Pada dialog **Restore Database**, cocokkan **Completed backup**, **Exact snapshot**, dan **Repository**.
4. Pilih **Recorded database**, misalnya example_app. Periksa **Auto-detected engine**, ukuran SQL, **SHA-256**, dan **Artifact**. Identitas ini berasal dari catatan backup, bukan tebakan terhadap isi SQL.
5. Pada **Destination**, pilih opsi yang tersedia:
   - **Internal — automatic host lifecycle** menggunakan host operator yang telah disetujui.
   - **Internal — manual operator provisioning** membutuhkan tindakan operator manual pada instalasi yang memakai kontrak tersebut.
   - **Custom — root-approved dedicated target** memakai target terpisah yang sudah disetujui. Pilih target yang cocok pada **Approved target**.
6. Pilih **Retention from confirmation**. Pilihan standar adalah 1, 6, atau 24 jam; 24 jam merupakan nilai awal. Pilihan lebih lama hanya muncul sesuai approval operator.
7. Baca **Resources and isolation** dan **Internal database resource warning** bila ditampilkan. Gunakan **Refresh verification** jika informasi berubah.
8. Setelah target, resource, dan retensi benar, centang kedua pernyataan persetujuan penggunaan resource/cleanup serta database dedicated baru dengan owned deletion.
9. Klik **Confirm persistent restore**.

Satu permintaan memulihkan **satu** database yang dipilih. Jika snapshot berisi beberapa database, database lain tidak ikut diimpor oleh permintaan ini. [Recovery Test](/docs/recovery-testing) mempunyai aturan berbeda: native test mewajibkan seluruh database yang tercatat.

## Memantau sampai siap

Setelah permintaan diterima, Anda diarahkan ke **Database Restore Management**. Buka juga melalui navigasi **Database Restores**; **All restores** kembali ke daftar dan **Refresh** membaca status terbaru.

Alurnya adalah: verifikasi snapshot dan resource → penyediaan target → staging SQL terpilih → validasi ukuran/hash → import → validasi katalog → **Active Restore**.

Permintaan diterima belum berarti import berhasil. **Awaiting automatic host lifecycle**, **Provisioning Required**, atau **Ready / Queued — not imported** masih merupakan tahap persiapan. **Importing** menunjukkan pekerjaan berjalan; tunggu **Active Restore** dan waktu **Import validated**.

## Memeriksa hasil dan batasnya

Pada detail, cocokkan **Restore**, **Exact snapshot**, **Archived database**, dan **Retained database**. Gunakan [metadata inspection](/docs/database-restores/inspect) untuk meninjau engine, versi, tabel, views, dan katalog yang divalidasi.

Import dan katalog yang lolos belum membuktikan aplikasi dapat berjalan atau seluruh transaksi bisnis benar. UI tidak menyediakan SQL console, pembacaan row, atau tindakan mengganti database produksi.

Untuk Internal, tersedia [Request stop dan Request resume](/docs/database-restores/stop-resume). Retensi tetap berjalan saat Stopped. Setelah selesai memeriksa, gunakan [owned deletion](/docs/database-restores/delete), lalu tunggu cleanup terverifikasi. [TTL dan cleanup](/docs/database-restores/ttl-cleanup) menjelaskan kedaluwarsa otomatis.

## Jika tidak dapat melanjutkan

**Capacity unknown**, **Blocked**, target tidak tersedia, metadata tidak lengkap, atau pekerjaan lain yang aktif harus diselesaikan sebelum konfirmasi. Checkbox persetujuan tidak melewati penolakan tersebut. MySQL Internal memerlukan worker Oracle MySQL asli, profile host otomatis yang disetujui, TLS terverifikasi, RAM tersedia minimal 2.944 MiB, dan SQL maksimal 128 MiB.

Lihat [resource pemulihan](/docs/database-restores/resources) dan [pemecahan masalah](/docs/database-restores/troubleshooting). Ketersediaan fitur atau deployment bukan bukti kapasitas recovery data nyata pada host 4 GiB.
