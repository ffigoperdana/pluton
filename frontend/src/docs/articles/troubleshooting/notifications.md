# Webhook, SMTP, dan konektivitas HTTPS

Mulai dari **Settings → Webhooks & Email → Delivery History** untuk kegagalan notifikasi. Jika browser HTTPS berhasil tetapi Agent OFFLINE, periksa jalur Agent secara terpisah. Toast queued, login browser, dan hasil akhir delivery adalah bukti yang berbeda.

## Gejala

Contoh fiktif: `app-01` selesai dibackup, **Send Test Email** berhasil mengantre, tetapi history **failed** karena TLS. Snapshot tidak gagal karena email. Contoh lain: channel test sukses, tetapi tidak ada baris event plan karena subscription belum disimpan atau pekerjaan dimulai sebelum aktivasi.

## Penyebab

| Temuan | Pemeriksaan berikutnya |
| --- | --- |
| Tidak ada event plan, test berhasil | Channel enabled, Plan channels, kedua pilihan event, activation time |
| `dns-failed` / `unsafe-destination` | DNS dari server, seluruh jawaban alamat, kebijakan CIDR |
| TLS/certificate failure | Hostname, expiry, intermediate CA, trust runtime |
| Auth/recipient rejection | Akun, pengirim/penerima, dan kebijakan relay |
| Timeout / HTTP 429 atau 5xx yang layak retry | Kapasitas/ketersediaan receiver dan percobaan terjadwal |
| Pending lama setelah perubahan channel | Revision dan kelayakan konfigurasi terkini |

## Diagnostik aman

1. Klik **Refresh history**. Cocokkan **Event / Plan**, **Destination**, waktu, **Status / Attempts**, HTTP status, dan **Last sanitized error**.
2. Tinjau **Edit** channel: endpoint/relay, mode TLS, **Network approval**, CIDR yang disetujui, enabled, dan event. Jangan menampilkan password atau HMAC/signing secret.
3. Pada plan → **Edit Plan → Advanced → Notification**, periksa **Enable durable notifications for this plan**, **Plan channels**, dan event, lalu **Save notification policy** jika diperbaiki.
4. Cocokkan event ID dengan receiver/relay secara privat. **succeeded** berarti HTTP 2xx atau relay menerima, bukan jaminan inbox atau tindakan lanjutan.
5. Untuk Agent OFFLINE setelah perubahan HTTPS, periksa DNS/CA dari host dan trust layanan Agent, bukan hanya browser. Baca [HTTPS](/docs/security/https).

### 405 atau HTML saat mengubah pengaturan

Lihat Network browser untuk metode/URL/status/**Content-Type** tanpa menyalin credential/cookie. 405 dengan HTML dari proxy/login/SPA berbeda dari JSON safe error aplikasi. Administrator perlu meninjau aturan metode dan routing ke API untuk request asli. Untuk 401/403 JSON, tinjau sesi, origin `APP_URL`/origin yang disetujui, dan proxy headers. Jangan mengganti PUT/DELETE menjadi POST, melewati reverse proxy, atau mematikan origin/auth/CSRF. [Diagnostik HTTP](/docs/troubleshooting#http-405-html-dan-json) menjelaskan langkah yang sama untuk fitur lain.

## Resolusi

Perbaiki sertifikat/hostname/trust chain, DNS, kebijakan tujuan, subscription, atau konfigurasi relay sesuai kategori. CIDR LAN harus sempit dan disetujui; loopback/metadata tetap terlarang. Setelah perubahan, tes channel, tunggu history terminal, lalu gunakan pekerjaan baru yang diizinkan untuk memeriksa subscription.

Bila tersedia, gunakan **Retry (review current channel)** setelah meninjau tujuan terkini. Retry dapat mengirim event yang sudah diterima saat respons hilang. Receiver Webhook harus memverifikasi HMAC dan menghapus duplikasi event ID. Batas retry dibahas di [Delivery History](/docs/notifications/history).

## Jangan lakukan

Jangan menonaktifkan verifikasi TLS, downgrade ke plain/HTTP pada jaringan publik, memperluas endpoint sembarangan, atau mengulang backup hanya untuk email. Jangan menganggap automated relay fixture sebagai live inbox acceptance. Simpan bukti aktual receiver/relay serta cakupan yang belum diuji; jalur lama **Integrations** perlu ditinjau bila muncul pesan ganda.
