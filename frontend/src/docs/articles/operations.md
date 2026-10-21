# Workflow operator harian

Mulai pemeriksaan dari pekerjaan terbaru setiap plan, lalu pastikan data yang dibutuhkan benar-benar dapat dipulihkan. Dashboard sehat dan notifikasi terkirim hanya memeriksa sebagian alur. Gunakan checklist ini setelah jadwal harian dan setelah perubahan source, Agent, storage, atau database.

## Review backup

1. Buka plan yang benar, pilih **Backups**, dan cocokkan **Date** dengan jadwal serta zona waktu yang diharapkan. Bersihkan filter tanggal bila pekerjaan tampak hilang.
2. Periksa **Status**, **Duration**, **Changes**, dan **Snapshot Size**. Catat backup ID serta snapshot exact di catatan privat. **Not measured** berarti belum ada pengukuran, bukan nol.
3. Tinjau **Complete · Cleanup warning** sebelum menutup pemeriksaan. Snapshot bisa selesai sementara hook atau pembersihan membutuhkan tindakan.
4. Bila replikasi aktif, buka badge **Redundancy incomplete** atau ringkasan mirrors. Pastikan setiap tujuan **Completed** untuk snapshot tersebut; primary SUCCESS tidak memastikan replika sukses.
5. Jika jadwal terlewat/gagal, gunakan **More plan actions → View Logs** dan [diagnostik](/docs/troubleshooting). Jangan menekan **Backup Now** berulang sebelum memahami pekerjaan aktif dan penyebabnya.

Contoh sintetis: plan `app-01` dijadwalkan malam hari. Backup terakhir sukses tetapi hanya satu dari dua mirror selesai. Catat umur snapshot utama dan kekurangan redundansi sebagai dua temuan terpisah; ikuti [status replika](/docs/replication/status-retry).

## Review dependency

Periksa **Remote Agent**, **Last seen**, versi, **Allowed roots configured**, dan **Agent capabilities** pada perangkat. **ONLINE** belum menjamin seluruh source terbaca. Periksa kapasitas storage, permission, mount, expiry sertifikat, dump client, grant database, serta ruang volume Pluton dan staging. Jangan menjalankan aplikasi ke data nyata hanya untuk menguji perubahan dokumentasi.

## Review recovery

Pada plan Managed Agent, bandingkan **Latest Backup**, **Recovery for this backup**, **Latest Recovery Test**, dan **Tested Snapshot**. Pass lama untuk snapshot lain tidak membuktikan backup terbaru. **Passed with warning** dengan import Disabled masih berarti SQL **NOT TESTED**. Untuk bukti pemulihan, lakukan drill [staging](/docs/restore/staging), [Recovery Testing](/docs/recovery-testing), atau [Database Restores](/docs/database-restores) pada target uji yang sesuai, lalu validasi aplikasi secara terpisah.

## Review delivery

Buka **Settings → Webhooks & Email → Delivery History**. Periksa pending/sending yang lama, failed code/attempts, dan hasil aktual di relay/receiver. Perbaiki channel/subscription sebelum retry yang tersedia. Delivery tidak mengubah hasil backup; hindari backup ulang hanya untuk email.

## Perubahan

### Mingguan dan periodik

Setiap minggu, tinjau pertumbuhan primary/replica, quotas, staging/cache serta
root/source drift, exclusions dan credential/CA expiry. Jangan prune Managed
Agent atau memakai object expiry sebagai pengganti retention yang belum tersedia.
Secara periodik dan setelah perubahan, lakukan drill filesystem+SQL+aplikasi pada
snapshot exact dan catat RPO/RTO terukur. Jadwalkan heavy jobs menurut resource
measurement, bukan menambah concurrency agar queue tampak kosong.

[Panduan lengkap](/docs/getting-started/complete-backup-setup#13-scheduling-kapasitas-dan-operasi-rutin)
menyediakan checklist harian/mingguan/periodik dan urutan maintenance.

Gunakan maintenance window, salinan control plane konsisten, image immutable, key/volume preserved, dan rollback yang ditinjau. Ukur kapasitas memakai workload representatif; angka RAM 4 GiB bukan hasil capacity test dan tidak membenarkan penurunan resource guard.

Catatan harian berikut diisi dengan hasil nyata; kolom kosong belum lulus.

| Pemeriksaan | Catatan privat operator |
| --- | --- |
| Tanggal/jam/zona waktu dan pemeriksa | … |
| Plan dan backup/snapshot exact | … |
| Jadwal berikutnya dan umur backup terhadap target RPO | … |
| Warning, replica belum lengkap, tindakan/pemilik | … |
| Recovery terakhir untuk snapshot terkait dan SQL coverage | … |
| Storage/staging/worker capacity dan cleanup | … |
| Delivery gagal atau penerimaan yang belum terverifikasi | … |

Gunakan [monitoring](/docs/operations/monitoring), [DR runbook](/docs/operations/disaster-recovery), dan [CUTOVER](/docs/migration/cutover). Pertahankan SYS MON lama selama SHADOW sampai gate penerimaan dan persetujuan peralihan terpenuhi.
