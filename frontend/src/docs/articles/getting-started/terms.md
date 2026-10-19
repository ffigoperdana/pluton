# Memahami istilah pada backup dan pemulihan

Gunakan halaman ini saat menemukan istilah pada formulir atau riwayat Pluton. Contoh berikut memakai satu aplikasi fiktif pada `app-01` dengan source `/srv/example-app`. Tujuannya agar Anda dapat memilih tindakan yang benar tanpa harus memahami seluruh implementasi Restic.

## Istilah inti

| Istilah | Artinya dalam pekerjaan Anda |
| --- | --- |
| Source | File atau mesin yang ingin dicadangkan. Untuk Managed Agent, satu path absolut berada dalam allowed roots |
| Storage | Konfigurasi koneksi ke tempat penyimpanan, misalnya Local, SFTP, atau S3 |
| Backup Plan | Aturan satu workload: nama, source, tujuan, jadwal, dan pengaturan backup |
| Repository | Kumpulan data backup Restic pada path tujuan. Berbeda dari database kontrol Pluton |
| Snapshot | Representasi data dari satu backup yang dapat dipilih kembali untuk browse/restore |
| Primary | Repository utama yang menerima backup sebelum replikasi dilakukan |
| Replica / mirror | Salinan snapshot pada repository tambahan; keberhasilannya dicatat terpisah |
| Remote Agent | Service pada mesin sumber yang mengambil pekerjaan melalui koneksi outbound |
| Allowed root | Folder yang telah diizinkan administrator sebagai batas pembacaan agent |
| Retention | Kebijakan mengenai snapshot mana yang dipertahankan |
| Staging | Tempat terpisah untuk menampung hasil restore sebelum Anda menggunakannya |
| SQL artifact | File dump database yang disimpan bersama snapshot, dengan ukuran dan checksum |
| Recovery Test | Pekerjaan pemulihan dan validasi terhadap snapshot yang dipilih |
| Outbox | Antrean persisten untuk mengirim notifikasi dan mencoba ulang delivery |

## Mengikuti satu contoh

1. Pada **Sources**, Anda memilih `app-01`; foldernya adalah source.
2. Pada **Backup Destination***, Anda memilih storage SFTP dan path khusus `daily/app-01`; lokasi itu menjadi repository primer.
3. Anda menyimpan plan bernama `Backup contoh app-01`, lalu menjalankan **Backup Now**.
4. Setelah **Complete**, satu snapshot dapat dibuka melalui **Browse**. Snapshot berikutnya merupakan versi lain dari source yang sama.
5. Anda memilih **Restore** pada snapshot tertentu dan menaruh hasil di staging. File source tetap berada pada tempatnya selama Anda tidak memilih tindakan lain yang menulis ke sana.

Hasil yang perlu diverifikasi adalah isi snapshot dan file hasil pemulihan, bukan hanya keberadaan sebuah plan. Jika replikasi diaktifkan, periksa status mirror; snapshot primer yang sukses tidak otomatis berarti semua salinan selesai.

## Ukuran yang berbeda

**Snapshot Size** adalah ukuran logis isi snapshot. **Data Added** adalah data baru sebelum kompresi, sedangkan **Compressed Data Added** menunjukkan data baru setelah kompresi. Beberapa snapshot dapat berbagi blok data yang sama melalui deduplikasi. Karena itu, menjumlahkan ukuran snapshot tidak menghasilkan pemakaian disk repository.

**New Files**, **Modified Files**, dan **Unmodified Files** membandingkan file terhadap parent yang dipilih. Parent adalah snapshot kompatibel untuk membantu mengenali perubahan. Nilai **New Files** yang besar belum membuktikan seluruh byte diunggah ulang. Lihat [cara membaca incremental](/docs/backup-plans/incremental).

## Identity yang berbeda

Plan ID, backup ID, snapshot ID, database ID, dan notification event ID menunjuk objek berbeda. Saat menyelidiki error, catat jenis ID dan waktu kejadiannya agar operator dapat menemukan pekerjaan yang sama. Jangan menyalin ID ke record lain atau mengedit database untuk menyamakan status.

Jika istilah masih membingungkan, mulai dari [Quick Start](/docs/getting-started/quick-start). Untuk memahami batas akses repository lama, baca [Legacy Repositories](/docs/legacy-repositories); plan baru tidak digunakan untuk mengadopsi repository tersebut.
