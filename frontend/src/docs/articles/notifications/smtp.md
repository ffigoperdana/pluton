# Mengatur SMTP relay dan TLS

Channel SMTP mengirim hasil backup dan recovery melalui relay yang disetujui. Siapkan hostname, port, mode keamanan, pengirim yang diperbolehkan, 1–20 penerima, dan kredensial jika diperlukan. Server Pluton harus dapat mengakses relay; konektivitas dari laptop operator saja belum cukup.

## Channel

1. Buka **Settings → Webhooks & Email → Add SMTP channel**.
2. Isi **Channel name**, misalnya `Email app-01`, **SMTP hostname**, dan **SMTP port**. `mail.example.internal` adalah contoh fiktif, bukan relay siap pakai.
3. Pilih **SMTP security** sesuai layanan: **STARTTLS — required, verified** untuk peningkatan TLS wajib, atau **Implicit TLS — verified** untuk TLS sejak awal. Port awal 587 bukan deteksi otomatis layanan.
4. Isi **SMTP username (optional authentication)** dan **SMTP password** bila relay membutuhkannya. Tanpa username, autentikasi tidak dipaksakan. Masukkan nilai asli melalui UI privat.
5. Isi **Sender email**, **Sender display name**, dan **Recipients (comma-separated, up to 20)**. Contoh sintetis: `backup@example.internal` dan `operator@example.internal`.
6. Isi **Delivery timeout (milliseconds)**, 1000–30000 ms. Untuk tujuan privat, pilih **Network approval → I approve this restricted private LAN destination**, lalu isi **Approved private CIDRs** yang sempit dari inventaris privat yang sudah ditinjau.
7. Pilih **Subscribed terminal events**, centang **Enable this channel**, lalu **Save channel**. Pastikan kartu menampilkan **SMTP email** dan **Enabled**.

## TLS

STARTTLS harus berhasil; tidak ada fallback plain bila peningkatan gagal. CA dan hostname sertifikat diverifikasi, dengan TLS minimum 1.2. **SMTP hostname** harus cocok dengan sertifikat walau DNS menuju alamat privat. CA privat membutuhkan trust yang benar pada runtime server, dipasang administrator.

**Plain SMTP — explicitly trusted LAN only** hanya untuk LAN yang disetujui secara eksplisit dan tidak mengenkripsi isi/kredensial. Jangan memilihnya untuk menghindari error sertifikat atau untuk jaringan publik. Loopback, link-local, dan metadata tetap ditolak; jangan memperluas CIDR sekadar agar tes lolos.

## Test Email

Klik **Send Test Email**, lalu **Refresh history** di **Delivery History**. Baris uji memakai **Test notification**. Tunggu **succeeded** atau **failed**; pending/sending belum akhir. Cocokkan penerimaan di relay dan inbox. **succeeded** hanya berarti relay menerima pesan.

Setelah tes channel, simpan [subscription plan](/docs/notifications/subscriptions) dan gunakan pekerjaan baru untuk menguji event sebenarnya. Saat **Edit** channel, kolom **Saved privately — leave blank to keep** yang dibiarkan kosong mempertahankan password. Isi nilai baru untuk mengganti; **Explicitly clear the saved credential** menghapusnya. Perubahan channel memengaruhi pending lama sehingga history perlu ditinjau.

## Compatibility

SMTP lama di **Settings → Integrations** tetap jalur terpisah dan juga memerlukan TLS terverifikasi sesuai mode. Konfigurasi lama tidak otomatis menjadi durable channel. Dua jalur untuk event/penerima sama dapat membuat pesan ganda.

Untuk error TLS, periksa CA dan hostname; untuk autentikasi, periksa akun relay; untuk penerima, periksa alamat dan kebijakan relay. Gunakan [diagnostik notifikasi](/docs/troubleshooting/notifications), perbaiki penyebab, lalu [retry yang tersedia](/docs/notifications/history). Jangan mengganti password untuk semua kegagalan atau membagikan log berisi rahasia. Live relay/inbox acceptance harus dicatat operator; tidak ada klaim uji infrastruktur nyata dalam panduan ini.
