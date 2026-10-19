# Retention, detach, dan batas restore replika

Sebelum menghapus tujuan atau mengganti kebijakan penyimpanan, pastikan salinan apa yang masih dibutuhkan dan bagaimana data akan dipulihkan. Detach, penghapusan file fisik, retention snapshot, dan restore adalah tindakan berbeda. Repository yang dipertahankan masih mengonsumsi kapasitas dan perlu akses pemulihan yang terjaga.

## Bedakan lifecycle plan

**Standard Restic Backup** memakai lifecycle standar untuk init/copy dan retention/maintenance sesuai pengaturan plan. Jalur tersebut dapat melakukan unlock dan prune pada repository yang dikelola. Periksa [schedule/retention](/docs/backup-plans/schedule-retention) sebelum perubahan; jangan memakai Standard sebagai adapter repository Legacy.

**Managed Agent Backup** mempunyai batas lebih sempit. Physical cleanup/purge/prune replika belum tersedia. Agent prune dan maintenance generik juga tidak didukung. Menghapus tujuan atau plan dilakukan dengan detach dan retain melalui jalur yang didukung, tanpa menganggap data fisik sudah dibuang. Retention pada namespace/object storage memerlukan peninjauan terpisah; jangan mengaktifkan expiry yang dapat menghilangkan objek Restic yang masih dirujuk.

**Legacy Repositories** tetap read-only. Tidak ada init, copy-into, backup, forget, prune, unlock, repair, re-key, atau migrate sebagai tindakan cleanup maupun error recovery. Hak baca dan kontrak no-lock harus dipertahankan.

## Melepas tujuan Managed Agent

1. Pada plan → **Backups**, tinjau hasil replika dan snapshot terakhir. Catat secara privat tujuan exact, alasan detach, pemilik data, credential recovery, serta kebijakan penyimpanan selanjutnya.
2. Pastikan tidak ada backup/restore terkait dan tidak ada replica pending/running/uncertain. Bila backend menolak dependensi, selesaikan statusnya melalui proses yang didukung; jangan menghapus lease.
3. Buka plan → **Edit**, pada **Replication Destination** yang benar pilih **Remove**.
4. Baca dialog **Detach Replication Destination**. Untuk Managed Agent, tombolnya **Detach and Retain Data**; physical cleanup tidak tersedia.
5. Pastikan tujuan yang dipilih tepat, lalu lakukan detach bila memang diizinkan. Buka kembali pengaturan dan periksa destination tidak lagi terhubung. Bila semua tujuan dilepas, replikasi menjadi disabled.
6. Catat bahwa repository retained tidak lagi diperbarui plan. Verifikasi akses/kebijakan kapasitas secara privat; jangan memberi label data sudah terhapus.

Contoh fiktif: `app-01` melepas `replica-a` setelah penggantian lokasi disetujui. Salinan lama tetap ada dan umur datanya berhenti bertambah baru. Prefix retained tetap dilindungi dari pemakaian overlap; jangan mendaftarkannya melalui alias untuk menghindari pemeriksaan ownership.

Pada Standard, dialog dapat menawarkan **Permanently delete this destination's owned repository data** dan **Delete Owned Data and Detach**. Itu tindakan destruktif terpisah yang membutuhkan exact owned scope dan keputusan eksplisit. Default retain lebih aman untuk review. Opsi tersebut bukan dukungan physical cleanup Managed Agent atau izin menghapus shared/uncertain repository.

## Memilih sumber pemulihan

Pada Standard, browse/download dapat menawarkan **Primary** serta **Mirror** yang Completed. Pilih sumber yang benar, cocokkan backup/snapshot, lalu lakukan [browse](/docs/restore/browse) dan pemulihan staging sesuai kemampuan alur. Mirror gagal/pending tidak layak dipilih sebagai salinan selesai.

Pada **Managed Agent**, file restore, browse/download melalui jalur managed, Recovery Testing, dan native database recovery tetap menggunakan repository utama yang dipercaya. **Direct mirror file restore dan native database restore belum didukung.** UI tidak menyediakan pemilihan mirror sebagai pengganti primary. Completed mirror membuktikan copy/artefak terverifikasi, bukan kemampuan pemulihan langsung melalui plan.

Jika primary hilang, jangan mengedit mirror menjadi primary, mengubah binding, menyalinnya ke repository Legacy secara otomatis, atau menjanjikan tombol restore yang belum tersedia. Pertahankan data, credential, dan bukti snapshot; rencana pemulihan dari salinan tersebut memerlukan runbook terpisah yang ditinjau pada lingkungan uji. [Disaster recovery](/docs/operations/disaster-recovery) menjelaskan bukti yang harus dikumpulkan.

## Verifikasi keputusan retention

Catat snapshot yang dipertahankan, kebutuhan hukum/operasi dari pemilik data, quota/pertumbuhan, durasi penyimpanan, serta pemilik cleanup masa depan. HCP nyata dan kebijakan Object Lock belum terbukti hanya dari mode konfigurasi. Bila muncul retention/access denial, tinjau policy dengan administrator; jangan melemahkan TLS, Object Lock, ownership, atau resource guard. Baca [HCP](/docs/replication/hcp), [status/retry](/docs/replication/status-retry), dan [penghapusan plan](/docs/backup-plans/delete).
