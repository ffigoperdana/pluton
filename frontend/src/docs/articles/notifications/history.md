# Membaca Delivery History dan mencoba ulang

**Delivery History** membantu memastikan notifikasi diterima tujuan dan menentukan tindakan ketika gagal. Buka **Settings → Webhooks & Email**, lalu lihat tabel di bawah channel. Hasil delivery tidak mengubah hasil backup atau Recovery Testing.

## History

1. Klik **Refresh history** setelah tes atau setelah pekerjaan berakhir.
2. Cocokkan **Event / Plan**, **Destination**, dan **Queued / Last attempt**. Baris tes memakai **Test notification**, bukan event backup.
3. Baca **Status / Attempts**, HTTP status bila ada, serta **Last sanitized error**. Simpan event ID secara privat untuk mencocokkan receiver.
4. Gunakan **Previous page** dan **Next page**. Satu halaman memuat paling banyak 50 baris; **No deliveries on this page** tidak membuktikan seluruh riwayat kosong.

Contoh sintetis: backup `app-01` sukses pukul 02.00 tetapi channel `Email operator` **failed** pukul 02.01. Snapshot tetap memiliki hasil terpisah. Periksa relay/channel, bukan menjalankan backup ulang demi email.

## Status

| Status UI | Makna | Tindakan |
| --- | --- | --- |
| `pending` | Mengantre atau menunggu percobaan berikutnya; waktu **Next** dapat muncul | Tunggu jadwal lalu refresh |
| `sending` | Pengiriman sedang berjalan | Jangan membuat retry ganda |
| `succeeded` | HTTP 2xx atau relay SMTP menerima pesan | Cocokkan receiver/relay; belum menjamin inbox |
| `failed` | Ditolak, tidak layak lagi, atau batas percobaan tercapai | Baca safe error dan tinjau channel |

Istilah delivered pada penjelasan lama merujuk penerimaan transport; UI saat ini memakai **succeeded**. Sukses transport bukan bukti tindakan lanjutan penerima atau keberhasilan pemulihan data.

## Batas retry

Maksimum lima percobaan otomatis per siklus dengan jeda bertingkat yang dibatasi. Webhook 408/429/500/502/503/504 dapat diulang; banyak 4xx lain perlu perbaikan. `Retry-After` valid juga dibatasi. SMTP membedakan gangguan sementara dari penolakan autentikasi, penerima, atau sertifikat.

Maksimum dua pengiriman bersamaan, lease 60 detik. Lease habis tidak dianggap sukses. Retry manual dibatasi tiga siklus, jeda minimum 30 detik, dan total 20 attempts selama umur delivery. Tombol hanya muncul jika backend menyatakan `canRetry`; permintaan test/retry juga dibatasi laju. Jangan mengulang klik untuk melewati batas.

Riwayat terminal dibatasi 30 hari/20.000 record dan antrean aktif juga dibatasi. Simpan bukti jangka panjang pada catatan operasional privat; history bukan arsip audit tanpa batas.

## Tindakan aman

1. Buka **Edit** channel. Periksa tujuan, TLS, enabled, penerima, dan event. Perubahan channel memengaruhi pending lama.
2. Betulkan penyebab mengikuti [diagnostik notifikasi](/docs/troubleshooting/notifications). Jangan menonaktifkan TLS, memperluas CIDR sembarangan, atau mengubah outbox di SQLite.
3. Jika **Retry (review current channel)** tersedia, pastikan kiriman ulang dengan konfigurasi sekarang memang diinginkan, lalu klik sekali.
4. Refresh sampai hasil akhir dan cocokkan event ID. Kiriman sebelumnya mungkin telah diterima ketika respons hilang; receiver perlu menghapus duplikasi berdasarkan event ID.

Jika tidak ada tombol, gunakan tes baru yang sesuai setelah perbaikan; jangan merekayasa status/lease. Lihat [subscription](/docs/notifications/subscriptions) untuk event yang tidak pernah mengantre dan [Webhook HMAC](/docs/notifications/webhook) untuk verifikasi receiver.
