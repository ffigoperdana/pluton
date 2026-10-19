# Memantau backup, storage, dan Agent

Pemantauan operasional menjawab tiga hal: kapan data terakhir berhasil dibackup, apakah salinannya tersedia, dan bukti pemulihan apa yang sudah ada. Tentukan target umur backup/RPO dan waktu pemulihan/RTO dengan pemilik aplikasi; panduan ini tidak menetapkan SLA universal atau mengarang pengukuran kapasitas.

## Indikator minimum

1. Buka setiap plan → **Backups**. Cocokkan pekerjaan terjadwal terbaru dengan zona waktu, hasil akhir, snapshot, dan warning.
2. Periksa **Changes** dan **Snapshot Size**. Unchanged file dapat menambah data fisik sedikit; ukuran logical snapshot berbeda dari pemakaian disk repository. **Not measured** tidak berarti kosong.
3. Untuk replika, buka badge mirrors. Catat jumlah **Completed**, **Pending**, **In progress**, atau **Failed**, **Source snapshot**, **Last replicated snapshot**, **Attempts**, dan **Decision** bila tersedia.
4. Pada Managed Agent, cocokkan **Recovery for this backup** dengan **Tested Snapshot**. Catat apakah SQL import benar-benar passed atau **NOT TESTED**.
5. Buka **Settings → Webhooks & Email → Delivery History** untuk hasil pengiriman, bukan hanya toast queued.

Contoh: `app-01` memiliki backup utama baru, replica pending, dan Recovery Test lulus kemarin untuk snapshot berbeda. Status pemeriksaan hari ini adalah backup utama tersedia, redundansi belum lengkap, serta snapshot baru belum diuji. Jangan merangkum ketiganya sebagai seluruh proteksi sehat.

## Health dan logs

Public `/api/health` hanya menyatakan status umum. `/api/health/details` memerlukan autentikasi. **Settings → App Logs**, **View Logs** pada plan, dan journal Agent membantu korelasi stage/code, waktu, backup/test/command ID. Simpan detail dalam catatan privat dan ganti hostname, domain, akun, path, serta inventaris dengan contoh sintetis sebelum publikasi.

Perangkat menampilkan **Remote Agent**, **Last seen**, **Agent version**, **Restic**, **Rclone**, **Allowed roots configured**, dan **Agent capabilities**. Verifikasi setelah upgrade Agent; deploy server saja tidak mengganti executable Agent. Status ONLINE tidak membuktikan descendant source dapat dibaca atau dump client kompatibel.

## Queued/slow

Bandingkan pekerjaan aktif, waktu mulai, stage terakhir, counters, source ONLINE, capabilities, dan batas timeout. Persentase yang belum diketahui bisa normal sebelum total valid. Jika stage/counter tidak berubah melewati jangka yang wajar untuk workload, ambil safe code/log yang relevan dan gunakan [troubleshooting](/docs/troubleshooting).

Replika Managed Agent berbagi antrean server dan berjalan satu per satu secara global. Pending tidak otomatis gagal, tetapi antrean yang terus tumbuh memerlukan tinjauan throughput/jadwal. Hasil uncertain setelah interupsi menahan guard; jangan reset status, menghapus lease, atau menambah concurrency. Ikuti [status dan retry](/docs/replication/status-retry).

## Capacity

Ukur volume data aplikasi, repository utama, replika, staging restore, temporary dump, serta database recovery/worker secara terpisah. Database yang dipertahankan pada **Database Restores** mengonsumsi ruang sampai lifecycle pembersihannya selesai. Lihat [resources](/docs/database-restores/resources) dan [TTL cleanup](/docs/database-restores/ttl-cleanup).

Server dengan RAM 4 GiB belum memiliki kapasitas terukur hanya dari spesifikasinya. Catat durasi, puncak memori/disk, pertumbuhan repository, queue wait, serta perilaku guard pada workload representatif. Jika resource ditolak, kurangi cakupan/jadwal yang diizinkan atau sediakan kapasitas setelah review; jangan menurunkan batas pengaman disk/memori/CPU.

## Tanpa automation baru

Panduan ini tidak membuat polling, metric service, webhook-driven backup, atau automatic remediation. Notifikasi opt-in melengkapi monitoring infrastruktur, bukan menggantikan verifikasi relay/receiver. Gunakan catatan dengan kolom waktu, plan/snapshot, indikator, ambang yang disepakati, tindakan, pemilik, dan hasil verifikasi ulang. Warning cleanup harus ditinjau berdasarkan kepemilikan, bukan diatasi dengan penghapusan direktori/database secara luas.
