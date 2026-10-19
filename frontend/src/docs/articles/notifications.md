# Notifikasi backup dan pemulihan

Notifikasi membantu operator mengetahui hasil pekerjaan tanpa terus membuka plan. Channel Webhook dan SMTP menyimpan antrean pengiriman. Hasil delivery terpisah dari backup dan recovery: kegagalan email tidak membatalkan snapshot, sedangkan email sukses tidak membuktikan data dapat dipulihkan.

## Interface

Buka **Settings → Webhooks & Email** (`/settings?t=notifications`). Nama tab yang tampil adalah **Webhooks & Email**. Tersedia **Add Webhook**, **Add SMTP channel**, pengujian channel, dan **Delivery History**. Siapkan tujuan yang Anda kelola, aturan jaringan, dan sertifikat tepercaya sebelum aktivasi.

1. Tambahkan channel mengikuti [SMTP](/docs/notifications/smtp) atau [Webhook](/docs/notifications/webhook). Beri nama, misalnya `Peringatan app-01`.
2. Pilih **Subscribed terminal events**, centang **Enable this channel**, lalu **Save channel**. Tombol **Update** milik pengaturan umum tidak digunakan untuk formulir ini.
3. Klik **Send Test Email** atau **Send Test Webhook**. Pesan queued berarti baru mengantre; periksa hasil di **Delivery History**.
4. Pada plan yang sudah disimpan, buka **Edit Plan → Advanced → Notification**. Di **Durable Webhook & Email Notifications**, aktifkan kebijakan, pilih **Plan channels** dan event, lalu **Save notification policy**.
5. Gunakan pekerjaan uji baru yang diizinkan. Cocokkan event, nama plan, waktu, dan hasil pengiriman. Tes channel saja belum menguji subscription plan.

## Event

Pilihan mencakup **Backup successful**, **Backup completed with warning**, **Backup failed**, **Backup cancelled**, serta empat hasil **Recovery test**: passed, passed with warning, failed, dan cancelled. Channel dan plan harus sama-sama memilih event tersebut. Event berasal dari hasil akhir tersimpan dan terikat pekerjaan/snapshot terkait; ringkasan tidak memuat SQL, keluaran proses, atau kredensial.

Contoh: channel `Peringatan app-01` memilih semua kegagalan, tetapi plan hanya memilih **Backup failed**. Kegagalan recovery tidak terkirim sampai pilihan recovery juga diaktifkan di plan. **Recovery test passed with warning** dapat berarti integritas artefak lulus tetapi SQL import **NOT TESTED**. Baca hasil recovery sebelum menutup insiden.

## Delivery

Antrean bertahan saat layanan dimulai ulang. Pengiriman eksternal bersifat *at least once*: penerima dapat menerima event yang sama lagi bila respons hilang. Webhook harus menghapus duplikasi berdasarkan event ID. SMTP memakai Message-ID stabil, tetapi inbox tetap dapat menampilkan duplikat. **succeeded** berarti HTTP 2xx atau relay SMTP menerima pesan, bukan jaminan inbox atau tindakan lanjutan receiver.

## Activation

Channel/kebijakan baru atau yang diaktifkan kembali berlaku untuk pekerjaan yang dibuat sesudahnya. Pekerjaan historis dan yang sudah dimulai tidak diputar ulang. Perubahan channel membatalkan kelayakan pending dengan konfigurasi lama; tinjau [history dan retry](/docs/notifications/history). Penghapusan channel mencegah pending delivery, tetapi kiriman yang sudah berjalan mungkin telah mencapai tujuan.

## Acceptance

Catat bukti uji sendiri: waktu, channel, event ID privat, hasil UI, serta penerimaan relay/receiver. Panduan ini tidak menyatakan live SMTP atau Webhook Anda sudah diuji. Jalur lama di **Settings → Integrations** dan **Existing community notification settings (separate delivery path)** tetap terpisah; periksa keduanya bila satu event menghasilkan dua pesan.

Jika pesan tidak sampai, gunakan [diagnostik notifikasi](/docs/troubleshooting/notifications), bukan backup berulang hanya untuk memperoleh email.
