# Replikasi untuk Managed Agent Backup

Pada Managed Agent, Agent membaca source dan membuat snapshot pada repository utama. Setelah primary selesai dan snapshot diverifikasi, server Pluton menyalin snapshot tersebut ke nol sampai dua repository tambahan dengan tipe yang berlawanan: S3 untuk primary SFTP, atau SFTP untuk primary S3. Source Agent tidak menerima credential replika dan tidak menjalankan copy.

```text
Source + dump SQL di Agent
  → repository SFTP utama → verifikasi snapshot utama
  → antrean server Pluton → replika S3 A → replika S3 B

Hasil primary dan hasil setiap replika dicatat terpisah.
```

## Primary S3 dengan replika SFTP

Plan dengan primary S3 (HCP) memakai alur yang sama ke arah sebaliknya:

```text
Source + dump SQL di Agent
  → repository S3 utama → verifikasi snapshot utama
  → antrean server Pluton → replika SFTP A → replika SFTP B
```

- Pilih storage SFTP pada **+ Add Replication Destination** dan isi folder khusus yang baru atau kosong, misalnya `replicas/app-01`. Folder yang sudah berisi apa pun ditolak; folder yang belum ada dibuat saat inisialisasi.
- Folder relatif dimulai dari home akun SFTP, sedangkan folder berawalan `/` adalah path absolut. Server menganggap keduanya ruang terpisah, jadi tetap pakai satu bentuk yang sama untuk satu server SFTP.
- Server membaca primary S3 dengan credential storage yang sama seperti Browse, lalu menulis ke SFTP dengan credential storage SFTP. Salinan pertama plan besar melewati server Pluton dua kali (unduh dari S3, unggah ke SFTP), sehingga kecepatannya mengikuti jaringan server.
- **Assisted Failover** dan pemulihan dari replika bekerja sama seperti replika S3, dengan sumber replika SFTP.
- Agent tidak perlu di-upgrade; semua langkah berjalan di server.

## Backup failover saat primary tidak terjangkau

**Backup failover** (bagian **Recovery & Failover**, default **Off**) menjaga backup tetap berjalan ketika primary mati. Dengan pilihan **Automatic**:

1. Backup ke primary gagal sebelum upload karena repository tidak terjangkau (Agent melapor sekitar 35 detik).
2. Server Pluton mencoba membaca primary sendiri. Failover hanya terjadi bila server juga gagal; bila server masih bisa, tidak ada perpindahan.
3. Server membuat backup baru **Failover backup** yang ditulis Agent langsung ke replika pertama yang sudah punya salinan terverifikasi dan terjangkau. Karena replika memakai password dan chunker yang sama, hanya data yang berubah yang diunggah.
4. Server memverifikasi snapshot itu di replika (tag, tree, ukuran dan SHA-256 artefak SQL). Sejak saat itu backup bisa dipulihkan lewat **Manual Verified Replica Recovery** di modal mirrors.
5. Setelah primary terjangkau lagi, server **menyalin balik** snapshot ke primary dan memverifikasinya. Badge **Failover → <replika>** berubah hijau saat salin balik selesai.

Hal yang perlu diketahui:

- Berlaku dua arah: primary SFTP dengan replika S3, dan primary S3 dengan replika SFTP. Butuh Agent 0.8.0 atau lebih baru.
- Selama run failover, Agent menerima credential storage replika di dalam field tersegel. Untuk replika HCP, kunci itu berlaku untuk seluruh namespace; gunakan user HCP khusus untuk folder replika bila host lain ikut memakai failover.
- Gangguan **di tengah upload** tidak dideteksi: run itu gagal seperti biasa dan run berikutnya yang pindah ke replika.
- Sebelum salin balik, **Browse** dan restore dari primary belum menemukan snapshot failover; gunakan pemulihan dari replika.
- Replika yang masih menyimpan backup failover menunggu salin balik tidak bisa dilepas dari plan, dan primary/plan tidak bisa dipindah atau dihapus sampai salin balik selesai.
- Bila primary yang kembali ternyata repository lain (identitas berbeda), salin balik ditolak dengan `primary-changed` dan snapshot tetap aman di replika.

## Promote replika menjadi primary

**Promote Replica** (menu aksi di halaman plan) menjadikan replika terverifikasi sebagai primary secara permanen, misalnya untuk memindah plan dari primary S3 ke SFTP atau sebaliknya tanpa membuat plan baru dan tanpa upload ulang dari nol. Primary lama otomatis menjadi replika di slot yang sama; tidak ada yang dihapus.

1. Server memastikan replika memegang semua backup yang bisa disalin. Backup lama yang belum ada disalin lewat antrean replikasi biasa, satu per satu. Plan tetap berjalan selama tahap ini.
2. Plan di-pause sebentar: backup yang selesai di tengah jalan ikut disalin, lalu server memeriksa identitas repository replika dan setiap snapshot (tree, tag, relasi original) tanpa menulis apa pun.
3. Dalam satu transaksi, replika menjadi primary dan primary lama menjadi replika. Plan di-resume. Backup berikutnya dari Agent langsung ke primary baru dan hanya mengunggah data yang berubah.

Hal yang perlu diketahui:

- Berlaku untuk storage SFTP mana pun dan S3/S3-compatible mana pun yang menjadi replika plan, dua arah. Untuk pindah ke storage yang belum menjadi replika, tambahkan dulu sebagai replika, tunggu salinannya, lalu promote.
- Promote ke S3 butuh Agent 0.8.0 atau lebih baru; promote ke SFTP tidak menambah syarat. Agent harus online saat promote dimulai karena plan divalidasi dalam bentuk sesudah switch.
- Hanya untuk plan dengan tepat satu replika. Tidak bisa berjalan bersamaan dengan Move Repository atau failover yang belum selesai; selama promote, pengaturan plan terkunci.
- Backup yang tidak bisa disalin (misalnya `artifact-binding-mismatch` dari backup sebelum database dump dikonfigurasi) tetap di primary lama dan dicantumkan di dialog. Bila server bisa membacanya di sana, backup itu tetap bisa dipulihkan lewat **Manual Verified Replica Recovery**.
- Untuk kembali, promote sisi satunya lagi.

## Prasyarat

- Plan **Managed Agent Backup** tersimpan, memakai primary SFTP atau S3 dedicated, serta Agent/allowed roots yang sesuai. Lihat [plan Managed Agent](/docs/backup-plans/managed-agent) dan [SFTP](/docs/storage/sftp).
- Server dapat membaca snapshot primary dan mengakses S3 API HTTPS. Browser atau Agent yang bisa mengakses endpoint belum membuktikan jalur server.
- Untuk primary SFTP: tujuan bertipe S3 atau S3-compatible dengan bucket/namespace existing dan prefix dedicated. Untuk primary S3: tujuan SFTP dengan folder dedicated. Root, prefix atau folder yang sama, dan parent/child overlap ditolak, termasuk melalui alias storage.
- Untuk **semua S3-compatible atau endpoint non-AWS**, aktifkan **HCP / pre-existing namespace mode** pada storage. Ini prasyarat perlindungan namespace, bukan hanya untuk merek HCP. Jika belum, backend menolak dengan **Enable protected HCP / pre-existing namespace mode before using this managed replica.** Ikuti [HCP/namespace](/docs/replication/hcp); jangan melewati penolakan.
- Gunakan server pada platform yang mendukung executor. Init/copy Managed Agent ditolak pada Windows dengan `platform-not-supported`; keberhasilan menjalankan UI Windows bukan bukti dukungan copy.

## Mengatur plan

1. Tambahkan storage sesuai [S3](/docs/storage/s3) atau [HCP](/docs/storage/hcp). Credential asli hanya di UI/config privat dan CA harus dipercaya runtime server.
2. Buka plan → **Edit**, kemudian bagian **Backup Destination***. Pastikan primary tetap SFTP yang benar.
3. Centang **Enable Replication**, pilih **+ Add Replication Destination**, lalu pilih storage S3 (untuk primary SFTP) atau SFTP (untuk primary S3).
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
evidence tidak tersedia jangan mengisinya dengan asumsi. Recovery primer bukan
bukti recovery replika. Assisted Failover yang diaktifkan operator menyediakan
file/directory/artefak SQL recovery ke staging privat dari replika terverifikasi,
dengan approval sekali pakai dan pemeriksaan integrity. Plan lama tetap Primary Only. Lihat [retention/restore](/docs/replication/retention-restore).

Contoh `app-01` dengan dua tujuan baru dinyatakan redundansinya lengkap bila kedua mirror **Completed** untuk backup yang diperiksa. Simpan bukti exact snapshot dan waktu verifikasi secara privat. RAM server 4 GiB bukan capacity result; ukur workload, queue wait, disk, dan memori tanpa menurunkan guard atau menambah concurrency.

Physical cleanup/prune replika, Agent prune, dan native database import dari replika belum didukung. Assisted Failover hanya menyediakan staging file/direktori/artefak SQL yang diverifikasi; tidak melakukan recovery destruktif ke target produksi. Detach mempertahankan data. Periksa [retention dan restore](/docs/replication/retention-restore) sebelum menghapus plan atau merencanakan recovery saat primary hilang. Interoperabilitas **HCP nyata belum diuji**; konfigurasi dan fixture otomatis tidak menggantikannya.
