# Replikasi untuk Managed Agent Backup

Pada Managed Agent, Agent membaca source dan membuat snapshot pada repository SFTP utama. Setelah primary selesai dan snapshot diverifikasi, server Pluton menyalin snapshot tersebut ke nol sampai dua repository S3 tambahan. Source Agent tidak menerima credential replika dan tidak menjalankan copy ke S3.

```text
Source + dump SQL di Agent
  → repository SFTP utama → verifikasi snapshot utama
  → antrean server Pluton → replika S3 A → replika S3 B

Hasil primary dan hasil setiap replika dicatat terpisah.
```

## Prasyarat

- Plan **Managed Agent Backup** tersimpan, memakai primary SFTP dedicated, serta Agent/allowed roots yang sesuai. Lihat [plan Managed Agent](/docs/backup-plans/managed-agent) dan [SFTP](/docs/storage/sftp).
- Server dapat membaca snapshot primary dan mengakses S3 API HTTPS. Browser atau Agent yang bisa mengakses endpoint belum membuktikan jalur server.
- Tujuan bertipe S3 atau S3-compatible dengan bucket/namespace existing dan prefix dedicated. Bucket root, prefix yang sama, dan parent/child overlap ditolak, termasuk melalui alias storage.
- Untuk **semua S3-compatible atau endpoint non-AWS**, aktifkan **HCP / pre-existing namespace mode** pada storage. Ini prasyarat perlindungan namespace, bukan hanya untuk merek HCP. Jika belum, backend menolak dengan **Enable protected HCP / pre-existing namespace mode before using this managed replica.** Ikuti [HCP/namespace](/docs/replication/hcp); jangan melewati penolakan.
- Gunakan server pada platform yang mendukung executor. Init/copy Managed Agent ditolak pada Windows dengan `platform-not-supported`; keberhasilan menjalankan UI Windows bukan bukti dukungan copy.

## Mengatur plan

1. Tambahkan storage sesuai [S3](/docs/storage/s3) atau [HCP](/docs/storage/hcp). Credential asli hanya di UI/config privat dan CA harus dipercaya runtime server.
2. Buka plan → **Edit**, kemudian bagian **Backup Destination***. Pastikan primary tetap SFTP yang benar.
3. Centang **Enable Replication**, pilih **+ Add Replication Destination**, lalu pilih storage S3.
4. Isi subfolder dedicated pada picker. Contoh sintetis: bucket `example-backups` ditampilkan picker dan Anda mengisi `app-01/replica-a`; path akhirnya `example-backups/app-01/replica-a`.
5. Klik **Confirm** untuk baris tambahan pada plan existing, kemudian **Update Plan**. Tambahkan paling banyak dua tujuan. Mode concurrent tidak tersedia untuk Managed Agent.
6. Jalankan satu backup baru yang diizinkan, tunggu primary selesai, lalu periksa modal mirrors pada **Backups**. Catat hasil primary dan replica secara terpisah.

## Yang diverifikasi server

Pekerjaan membutuhkan backup remote terenkripsi yang completed, sukses, tidak lagi in progress, dan terikat plan/Agent/repository yang benar. Server memakai snapshot ID penuh, memeriksa identitas repository dan snapshot, serta mencocokkan artefak SQL yang dikonfigurasi. Pada tujuan, snapshot/tree/paths serta ukuran dan SHA-256 artefak diperiksa sebelum **Completed**. Ini bukan pengujian SQL import atau pemulihan semantik aplikasi.

Server hanya menginisialisasi prefix yang terbukti kosong melalui lifecycle yang dimilikinya. Repository existing yang tidak memiliki binding sah tetap ditolak meskipun password cocok. Jangan memilih repository SYS MON/Legacy, mengosongkan prefix yang tidak dikenal, atau mengedit binding secara manual.

## Antrean dan kegagalan

Salinan diserialkan **secara global di server**, bukan hanya berurutan dalam satu plan. Pending dari beberapa plan dapat menunggu satu pekerjaan. Startup dapat merekonsiliasi pekerjaan yang belum masuk antrean, tetapi tidak otomatis mengulang terminal failed/cancelled. Retry perlu tindakan eksplisit yang diizinkan backend. Hasil uncertain menahan guard karena proses/initialization tidak dapat dipastikan selesai; jangan reset lease/status atau melakukan unlock.

Jika mirror gagal, primary yang sukses tetap sukses. Baca **Decision**, **Attempts**, **Source snapshot**, dan **Last replicated snapshot** bila tersedia, lalu ikuti [status/retry](/docs/replication/status-retry). Untuk TLS/auth/prefix, perbaiki penyebab yang ditolak dan jangan menurunkan pemeriksaan.

## Verifikasi dan batas operasi

### Mengubah prefix bukan memindahkan sejarah

Field repository pada tujuan baru adalah prefix kosong yang akan dimiliki
lifecycle baru. Mengubah setting/prefix tidak otomatis memindahkan snapshot lama,
rekey repository atau mengubah retained binding. Jangan menukar primary/mirror
atau membuat alias untuk melewati overlap guard. Rencanakan tujuan baru melalui
flow Add/Confirm yang didukung, buktikan copy dan jalur recovery yang disetujui,
lalu baru pertimbangkan detach lama sesuai owner/retention. Jangan hapus salinan
lama sebelum tujuan baru dan pemulihannya diterima.

**Redundancy incomplete** berkaitan dengan mirrors backup exact, bukan quota
storage atau jumlah plan yang memakai storage. Untuk bukti copy, bandingkan
source snapshot/verification/last replicated snapshot di dialog; bila field
evidence tidak tersedia jangan mengisinya dengan asumsi. Direct recovery dari
managed mirror belum tersedia: recovery primer tidak menjadi bukti recovery
replica. Runbook operator terpisah diperlukan sebelum mengandalkan replica saat
primary hilang. Lihat [retention/restore](/docs/replication/retention-restore).

Contoh `app-01` dengan dua tujuan baru dinyatakan redundansinya lengkap bila kedua mirror **Completed** untuk backup yang diperiksa. Simpan bukti exact snapshot dan waktu verifikasi secara privat. RAM server 4 GiB bukan capacity result; ukur workload, queue wait, disk, dan memori tanpa menurunkan guard atau menambah concurrency.

Physical cleanup/prune replika, Agent prune, serta direct mirror file/native database restore belum didukung. Detach mempertahankan data. Periksa [retention dan restore](/docs/replication/retention-restore) sebelum menghapus plan atau merencanakan recovery saat primary hilang. Interoperabilitas **HCP nyata belum diuji**; konfigurasi dan fixture otomatis tidak menggantikannya.
