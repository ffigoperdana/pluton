# Mengenal Pluton mandiri

Pluton membantu Anda menjadwalkan backup, menyimpan beberapa versi data, dan mengambilnya kembali melalui Web UI. Mulailah dari satu folder contoh sampai Anda berhasil memulihkannya. Setelah alur itu dipahami, tambahkan database, salinan kedua, dan notifikasi sesuai kebutuhan.

Panduan ini ditujukan kepada administrator yang sudah memiliki atau akan menyiapkan Pluton Server. Semua nama mesin, alamat, dan folder contoh bersifat fiktif. Fork ini dipelihara secara independen; nama, lisensi Apache-2.0, dan atribusi upstream Pluton tetap dipertahankan.

## Kemampuan utama

Alur kerja sehari-hari adalah: **Sources → Storages → Backup Plans → backup selesai → pemeriksaan isi → pemulihan ke tempat aman**.

| Kebutuhan Anda | Mulai dari sini |
| --- | --- |
| Mencadangkan folder yang dapat dibaca host Pluton | [Backup Plan filesystem](/docs/backup-plans) dan [storage lokal](/docs/storage/local) |
| Mencadangkan aplikasi pada mesin Linux lain | [Remote Agent](/docs/remote-agent), lalu [plan Managed Agent](/docs/backup-plans/managed-agent) |
| Menambahkan dump database ke backup mesin remote | [Backup database](/docs/database-backup) |
| Menyimpan salinan tambahan di S3 atau HCP | [Replikasi](/docs/replication) dan [HCP](/docs/storage/hcp) |
| Membaca repository Restic yang sudah ada | [Legacy Repositories](/docs/legacy-repositories) |
| Mengambil kembali file atau database | [Pemulihan file](/docs/restore) atau [Database Restore Management](/docs/database-restores) |

## Mulai dengan aman

1. Periksa [persyaratan](/docs/getting-started/requirements), lalu ikuti [deployment](/docs/deployment) bila server belum tersedia.
2. Masuk ke Web UI dan kenali [halaman utama](/docs/getting-started/dashboard).
3. Siapkan source contoh `/srv/example-app` pada mesin `app-01`, berisi beberapa file yang aman untuk diuji.
4. Pilih tujuan khusus backup. Untuk Managed Agent, tujuan primer wajib SFTP; layanan SFTP boleh berada pada VM Pluton bila administrator menyiapkannya. Tujuan lokal atau S3 sebagai primer mengikuti alur filesystem pada host Pluton.
5. Ikuti [Quick Start](/docs/getting-started/quick-start), jalankan backup, buka **Browse**, lalu pulihkan satu file ke staging terpisah.

Hasil awal yang diharapkan adalah satu backup berstatus **Complete**, isi snapshot sesuai source, dan file hasil pemulihan dapat dibaca. Catat waktu backup serta snapshot yang diperiksa agar hasil dapat diulang.

## Batas dukungan

**Complete** membuktikan pekerjaan snapshot selesai. Status itu belum membuktikan database dapat diimpor, aplikasi dapat hidup kembali, atau replika berhasil. Periksa hasil [Recovery Testing](/docs/recovery-testing) dan status setiap replika secara terpisah.

Managed Agent mendukung source filesystem yang dibatasi administrator, SFTP primer, serta 0–2 replika S3 opsional yang dikerjakan server. Pemulihan langsung dari mirror managed dan physical prune belum didukung. Interoperabilitas pada HCP nyata **belum diuji**; pengujian kode atau fixture tidak menggantikannya.

Jika backup awal gagal, gunakan [pemecahan masalah](/docs/troubleshooting) sesuai tahap yang gagal. Jangan menghapus data tujuan, mengganti kunci, atau mematikan backup lama untuk menghilangkan pesan error. Repository lama didaftarkan melalui jalur read-only, dan perpindahan layanan mengikuti [cutover](/docs/migration/cutover).
