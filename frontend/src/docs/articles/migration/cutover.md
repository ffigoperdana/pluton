# Melakukan CUTOVER dan menjaga rollback

CUTOVER memindahkan tanggung jawab backup terjadwal setelah bukti SHADOW diterima. Keputusan ini harus tercatat dengan pemilik, window, perubahan yang diizinkan, dan kondisi rollback. Artikel ini adalah runbook yang diisi serta dijalankan operator berwenang; tidak menjalankan stop cron, perubahan script, service, key, DNS, atau database produksi secara otomatis.

## Gate yang harus sudah diterima

Tinjau [SHADOW](/docs/migration/shadow) dan [checklist keputusan](/docs/operations/cutover). Pastikan beberapa scheduled cycles representatif, seluruh dump, snapshot exact, browse/download yang diperlukan, staged restore, SQL import yang diwajibkan, dan pemeriksaan semantik aplikasi memiliki bukti nyata. Tidak ada kolom kosong yang dianggap lulus.

Primary SUCCESS terpisah dari replica; **Passed with warning** dengan import Disabled tetap SQL **NOT TESTED**. Kapasitas host 4 GiB belum terukur dari spesifikasi. Real HCP belum diuji oleh panduan; bila menjadi syarat operasi, bukti interop uji harus tersedia. Direct mirror file/native database restore dan physical cleanup/prune Managed Agent belum tersedia, sehingga jangan menjadikannya kemampuan rollback yang diasumsikan.

## Isi rencana perubahan

| Keputusan | Isian privat yang ditinjau |
| --- | --- |
| Aplikasi/source/database dalam cakupan | … |
| Pemilik keputusan, operator, DBA, infrastruktur, penerima hasil | … |
| Window dan zona waktu | … |
| Bukti SHADOW serta RPO/RTO yang diterima | … |
| Rincian perubahan jadwal/script/service yang disetujui | … |
| Jalur SYS MON yang dipertahankan dan cara mengaktifkannya kembali | … |
| Snapshot/control plane/config/key/image/volume untuk rollback | … |
| Trigger rollback, batas waktu keputusan, pemiliknya | … |
| Pekerjaan aktif/dependensi serta cara menyelesaikannya dengan aman | … |
| Keputusan eksplisit CUTOVER, persetujuan, tanggal/jam | … |

Contoh fiktif: `app-01` memiliki backup SYS MON terakhir yang masih dapat dipulihkan dan beberapa siklus Pluton yang telah diterima. Operator mencatat snapshot masing-masing serta nama pihak penerima. Contoh ini tidak menyatakan suatu lingkungan nyata sudah disetujui atau diuji.

## Saat window yang disetujui

1. Periksa ulang kesehatan source, Agent, storage, waktu, kapasitas, dan pekerjaan aktif. Tunda bila ada status uncertain atau dependensi yang belum selesai; jangan memaksa lease/binding.
2. Catat backup SYS MON terakhir yang diterima, waktunya, lokasi privat, dan akses recovery. Pertahankan repository serta credential yang diperlukan sesuai kebijakan.
3. Catat backup Pluton terbaru dan snapshot exact. Verifikasi file serta seluruh artefak SQL, warning, replika yang diwajibkan, dan bukti recovery yang relevan. Jangan memilih kata latest tanpa identitas snapshot.
4. Pastikan backup control plane/config/key konsisten serta image/revisi/volume untuk rollback tersedia. Jangan mengganti SECRET, ENCRYPTION_KEY, identitas Agent, atau repository password selama peralihan biasa.
5. Operator melakukan hanya perubahan jadwal/script/service yang tercantum pada persetujuan. Tentukan jalur yang bertanggung jawab atas jadwal berikutnya dan hindari eksekusi ganda yang tidak ditinjau. SYS MON tidak dihentikan hanya karena artikel ini dibuka.
6. Pada Pluton, periksa plan aktif dan **Backup Interval** sesuai zona waktu yang disepakati. **Resume** memengaruhi penjadwalan sesuai plan; jangan menganggapnya bukti pekerjaan sudah berjalan.
7. Amati scheduled run pertama sesudah peralihan hingga terminal. Periksa **Backups**, exact snapshot, seluruh artefak, warning, replika, serta hasil **Delivery History**. Klik Backup Now tidak menggantikan bukti penjadwalan.
8. Catat hasil pascaperalihan dan penerimaan pemilik, termasuk bagian yang belum diuji. Tetapkan periode pengamatan lanjutan dengan [operasi harian](/docs/operations).

Jika dashboard menampilkan 405 berisi HTML saat perubahan, tinjau proxy/metode/content-type melalui [diagnostik HTTP](/docs/troubleshooting). Jangan mengubah DELETE/PUT menjadi POST, melewati proxy, atau menonaktifkan autentikasi/origin guard untuk menyelesaikan window.

## Trigger rollback

Tentukan sebelum CUTOVER, misalnya scheduled run tidak muncul dalam batas yang disetujui, umur data melampaui target, artefak wajib hilang, restore/import tidak memenuhi penerimaan, credential recovery tidak tersedia, atau resource/cleanup/replica gagal memenuhi syarat yang disepakati. Satu notification failed tidak otomatis berarti snapshot gagal; klasifikasikan fakta sebelum mengambil keputusan.

Ketika trigger terpenuhi, pemilik keputusan mencatat **ROLLBACK** beserta waktu dan alasan. Jangan menghapus bukti kegagalan, mengubah status menjadi sukses, atau melakukan maintenance Legacy sebagai jalan keluar.

## Langkah rollback yang dapat diverifikasi

1. Hentikan perubahan tambahan. Catat state pekerjaan, snapshot yang sudah ada, serta proses/lease yang masih aktif. Jangan force kill/reset state untuk mempercepat pergantian.
2. Cegah dispatch baru pada jalur yang perlu dijeda melalui aksi yang disetujui, misalnya **Pause** pada plan. Pause tidak membuktikan semua pekerjaan aktif sudah berhenti; verifikasi pekerjaan aktif secara terpisah.
3. Operator mengaktifkan kembali jadwal SYS MON hanya sesuai rencana yang disetujui setelah dependensi dan risiko eksekusi ganda ditinjau. Pertahankan akses read-only repository lama; jangan init/prune/unlock/migrate/repair.
4. Jika rollback menyangkut rilis Pluton, ikuti [rollback deployment](/docs/deployment/rollback) dengan pasangan volume/database/config/key yang konsisten. Jangan mengatasi ketidakcocokan dengan key baru atau volume kosong.
5. Verifikasi satu scheduled cycle pada jalur authoritative yang dipulihkan dan pemeriksaan data/recovery yang diwajibkan. Catat umur data, cakupan, hasil, serta siapa menerima.
6. Pertahankan data Pluton yang sudah dibuat untuk investigasi sesuai kebijakan. Detach Managed Agent mempertahankan repository; tidak ada physical cleanup/prune otomatis. Jangan hapus storage/plan/database hanya untuk menyederhanakan dashboard.
7. Buka tindak lanjut SHADOW dengan penyebab, tindakan, pemilik, dan gate yang perlu diulang sebelum CUTOVER berikutnya.

## Setelah stabil

Sepakati retensi historis dengan pemilik data, dokumentasikan akses pemulihan, lalu tinjau credential hardcoded serta seluruh consumer secara privat. Rotasi/pencabutan credential adalah perubahan terpisah setelah dependensi terverifikasi; jangan memutus akses repository lama terlalu dini. Lakukan drill berkala sesuai [DR runbook](/docs/operations/disaster-recovery) dan simpan hasil RPO/RTO nyata, bukan perkiraan yang belum diukur.
