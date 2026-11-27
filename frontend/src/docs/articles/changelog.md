# Perubahan fitur pada source fork

Halaman ini merangkum fitur yang ada pada source saat panduan ditulis. Halaman ini bukan feed rilis live atau bukti bahwa source tersebut sudah terpasang di suatu server.

## Browse snapshot sangat besar

Cache metadata restic dari perubahan sebelumnya ternyata tidak pernah terpakai pada deployment Docker. Folder sementara container hanya 64 MiB, sehingga syarat ruang kosong 2 GiB selalu gagal dan restic tetap berjalan dengan `--no-cache`. Cache kini disimpan di folder data (`/data/managed-restic-cache`). Jika cache tetap tidak bisa dipakai, server mencatat peringatan `managed_restic_cache` beserta alasannya.

Index Browse kini kira-kira setengah ukuran sebelumnya untuk path yang panjang. Batasnya dinaikkan dari 1 GiB dan 1.000.000 entri menjadi 4 GiB dan 2.000.000 entri, sehingga snapshot ratusan GB dengan ratusan ribu file tidak lagi gagal karena `database-size`. Selama index dibangun, ruang kosong diperiksa berkala, dan pembangunan dihentikan sebelum disk server penuh. Urutan file di Browse tidak berubah.

## Browse snapshot besar

Browse pada snapshot Managed Agent yang besar tidak lagi berhenti di menit ke-15. Indexing kini hanya dihentikan jika restic tidak mengirim data selama 10 menit, atau jika total waktunya mencapai 2 jam. Server juga menyimpan cache metadata restic per repository (index, daftar snapshot, dan pack struktur folder, semuanya tetap terenkripsi). Isi file tidak ikut disimpan. Hasilnya, indexing berikutnya dan **Retry indexing** jauh lebih cepat dan tidak lagi mengunduh ulang semuanya dari storage. Cache hanya dipakai bila ruang kosong minimal 2 GiB dan dihapus otomatis setelah 30 hari tidak dipakai. Selama indexing berjalan lama, Browse memeriksa status makin jarang (1, 3, lalu 5 detik).

## Browse objek MinIO

Browse pada snapshot Managed Agent kini mengenali folder data MinIO mode satu drive (`xl-single`) dan menampilkan tab **MinIO objects**: bucket, folder, key, ukuran, waktu ubah, ETag, versi, dan delete marker. Satu versi objek dapat diunduh sebagai file aslinya. Server membaca `xl.meta` dan part file langsung dari snapshot, membuka kompresi S2, lalu mencocokkan isi dengan ETag (MD5 atau MD5 multipart) sebelum potongan terakhir dikirim. Objek SSE, erasure multi-drive, tier remote, dan format lama ditampilkan beserta alasan tanpa dapat diunduh. Fitur ini hanya membaca dan tidak memerlukan perubahan Agent. Lihat [mengunduh satu objek MinIO](/docs/restore/minio-objects).

Fitur ini diuji dengan data yang ditulis MinIO asli dalam container sekali pakai, tetapi belum divalidasi pada deployment produksi.

## Jadwal saat Agent sibuk

Jadwal plan Managed Agent yang jatuh saat Agent masih menjalankan backup plan lain kini masuk antrean dan berjalan setelah backup itu selesai. Sebelumnya, pada Agent dengan Source Access, laporan Source Access terakhir dianggap kedaluwarsa selama backup lain berjalan sehingga jadwal ditolak: tidak ada baris riwayat, hanya log `remote_backup_not_queued`. Antrean kini memakai laporan sehat terakhir hanya selama Agent memegang lease yang masih berlaku. Saat dijalankan, Agent tetap wajib mengirim laporan baru yang sehat. Perubahan ini hanya pada server dan tidak memerlukan pembaruan Agent.

## Managed Agent replication

Merge PR #34 pada `e2575cc` memasukkan server-side replication dari primer Managed Agent SFTP ke nol, satu, atau dua tujuan S3/S3-compatible. Ada state durable untuk job/tujuan, status replica tersendiri, dan setup HCP existing-bucket.

Direct managed mirror Restore, native database recovery dari mirror, dan physical cleanup/prune managed replica belum tersedia. Interoperabilitas HCP nyata tetap perlu pengujian terpisah; merge source tidak menutup gate tersebut.

## Delete, Remove, dan tabel

PR #32 dan PR #33 mencakup penguatan penghapusan, pemeriksaan retained database dependency, penanganan respons error, serta perbaikan history/progress dan pengalaman tabel. Penghapusan plan tidak menjadi izin menghapus database retained atau resource yang tidak terkait.

## Database dan recovery

Source mencakup managed MariaDB/MySQL/PostgreSQL backup, Recovery Testing, Database Restore Management, serta jalur MySQL Internal/Custom dengan prasyarat masing-masing. Migration additive `0016` menambahkan explicit Resume sequence; ini bukan persetujuan menjalankan recovery pada host yang belum memenuhi kapasitas/policy.

## Notifikasi dan operasional

Source juga mencakup Legacy Repository read-only, outbound Agent, multi-database/hooks, staged Restore, Webhooks & Email dengan riwayat delivery, configuration backup, dan deployment berbasis digest/kontrak mount.

Dokumentasi `/docs` menggunakan artikel lokal dan pencarian statis, terpisah dari runtime aplikasi. Penulisan ulang panduan ini tidak menambahkan fitur bisnis atau menjalankan deployment.

## Memastikan yang terpasang

### Digest Agent deterministik dan panduan operasional

Source installer/upgrader menetapkan locale C hanya dalam perhitungan tree/source
fingerprint, mempertahankan format=1 dan penolakan mismatch nyata. Tidak ada
update global locale, rewrite provenance atau re-enrollment. Hosted Linux CI dan
rollout existing Agent tetap perlu verifikasi pada exact commit.

[Complete Backup Setup](/docs/getting-started/complete-backup-setup) menyatukan
15 langkah dari deployment sampai verified recovery/cutover, dengan referensi
Source Access/history, exclusions 0.7.0, SFTP/S3/HCP dan batas mirror recovery.

Package version checked-in tidak membuktikan publikasi rilis atau kesiapan produksi. Bandingkan informasi footer, source commit, digest image, Agent, worker, dan host operator melalui [identifikasi build](/docs/reference/version). Gunakan [batasan fitur](/docs/reference/limitations) serta [pembaruan aman](/docs/deployment/updates) sebelum merencanakan perubahan.
