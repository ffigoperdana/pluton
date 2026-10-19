# Webhook, JSON, dan HMAC

Webhook mengirim hasil akhir pekerjaan sebagai JSON ke receiver yang Anda kelola. Siapkan endpoint, sertifikat tepercaya, penyimpanan event ID, dan penanggung jawab receiver. `https://notify.example.internal/events` adalah contoh fiktif; tujuan nyata harus disetujui secara privat.

## Konfigurasi

1. Buka **Settings → Webhooks & Email → Add Webhook**.
2. Isi **Channel name**, **Webhook URL**, dan **Delivery timeout (milliseconds)** dalam 1000–30000 ms. Gunakan HTTPS tanpa username/password, query, atau fragment dalam URL.
3. Bila receiver mendukung verifikasi, isi **Optional HMAC signing secret** melalui UI privat. Nilainya tidak ditampilkan lagi. Saat mengedit, kolom kosong mempertahankannya; **Explicitly clear the saved credential** menghapusnya.
4. Pilih **Network approval**. Tujuan privat membutuhkan **I approve this restricted private LAN destination** dan **Approved private CIDRs** yang sempit. Nama `example.internal` tidak otomatis memberi izin LAN.
5. Pilih **Subscribed terminal events**, centang **Enable this channel**, lalu **Save channel**.
6. Klik **Send Test Webhook**, periksa **Delivery History**, dan cocokkan event ID pada receiver. Queued belum berarti berhasil.
7. Simpan [subscription plan](/docs/notifications/subscriptions), lalu uji satu pekerjaan baru yang diizinkan untuk memeriksa seluruh alur.

## Payload dan signature

Payload JSON version 1 berisi `event_id`, `event_type`, waktu event, identitas plan, dan ringkasan backup/recovery yang dibatasi. Header mencakup `X-Pluton-Payload-Version`, `X-Pluton-Event-Id`, `X-Pluton-Timestamp`, serta `X-Pluton-Signature` bila secret disimpan. Payload test ditandai terpisah; jangan memperlakukannya sebagai backup baru.

Receiver yang memakai HMAC memverifikasi **raw bytes** sebelum parse/normalisasi JSON. Signature adalah HMAC-SHA256 atas timestamp pengiriman, event ID, dan body UTF-8 persis, dipisahkan titik:

```text
signed_bytes = delivery_timestamp + "." + event_id + "." + raw_json_body
signature = "sha256=" + hex(HMAC_SHA256(secret, signed_bytes))
```

Bandingkan secara timing-safe dan batasi umur timestamp sesuai kebijakan receiver. Setelah valid, cocokkan event ID header/body dan simpan ID untuk menghindari pemrosesan ulang. Uji penolakan signature salah di receiver uji. Jangan mencetak secret/signature pada laporan publik. Panduan ini tidak menyediakan secret contoh atau receiver siap produksi.

## Network guard

Setiap percobaan memeriksa seluruh hasil DNS dan mengunci koneksi ke alamat yang disetujui. Redirect tidak diikuti. Satu jawaban DNS terlarang dapat menolak seluruh tujuan. Loopback, link-local/metadata, unspecified, multicast, dan keluarga alamat tidak aman tetap ditolak. HTTP hanya pengecualian trusted LAN dan tidak memberi kerahasiaan.

Untuk `unsafe-destination`, tinjau DNS dan CIDR, bukan memperluas izin ke seluruh jaringan. Untuk TLS, betulkan sertifikat, hostname, dan trust chain. Untuk 405 berisi HTML, pastikan URL menunjuk API receiver yang menerima metode pengiriman, bukan halaman web/proxy. Jangan mengganti metode atau melewati proxy sebagai jalan pintas; gunakan [diagnostik notifikasi](/docs/troubleshooting/notifications).

## Retry

Body dan event ID stabil antarpercobaan, tetapi timestamp/signature transport baru. Karena pengiriman *at least once*, hapus duplikasi berdasarkan event ID, bukan timestamp. Balas 2xx hanya setelah menerima event sesuai kontrak. **succeeded** membuktikan HTTP 2xx, bukan keberhasilan tindakan lanjutan receiver. [Delivery History](/docs/notifications/history) menampilkan attempts, HTTP status, dan safe error tanpa raw response body.
