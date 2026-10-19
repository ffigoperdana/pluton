# Memilih channel dan event untuk setiap plan

Channel yang berhasil diuji belum otomatis mengirim hasil semua plan. Pilih channel dan jenis event untuk setiap plan agar tujuan menerima pekerjaan yang relevan. Prasyaratnya adalah plan sudah disimpan, channel **Enabled**, dan sesi Web UI yang berwenang.

## Intersection

Event harus dipilih pada **Subscribed terminal events** di channel dan pada plan. Kebijakan plan juga harus enabled serta mencantumkan channel di **Plan channels**. Contoh: channel `Tim app-01` memilih **Backup failed** dan **Recovery test failed**, tetapi plan hanya memilih **Backup failed**. Hanya kegagalan backup yang memenuhi kedua pilihan.

1. Periksa channel pada **Settings → Webhooks & Email**. Gunakan **Edit** untuk status dan event, lalu **Save channel** bila berubah.
2. Buka **Edit Plan → Advanced → Notification** pada plan yang sudah disimpan.
3. Di **Durable Webhook & Email Notifications**, centang **Enable durable notifications for this plan**.
4. Pilih nama channel pada **Plan channels**. Label menunjukkan jenis dan enabled/disabled; pemilihan di sini tidak mengaktifkan channel disabled.
5. Pilih event sesuai tanggung jawab tim, misalnya **Backup completed with warning**, **Backup failed**, dan **Recovery test failed**.
6. Klik **Save notification policy**. Pastikan pesan tersimpan muncul dan pilihan tetap benar ketika dibuka kembali.

## Save terpisah

Kebijakan durable disimpan terpisah dari formulir plan. Menyimpan jadwal atau formulir plan tidak menggantikan **Save notification policy**. Pada plan baru, UI meminta **Save the plan first, then configure durable notifications here.** Simpan plan terlebih dahulu, lalu buka kembali pengaturannya.

Bagian **Existing community notification settings (separate delivery path)** berisi jalur lama email/Slack/Discord/Ntfy. Dua jalur aktif dengan event dan penerima sama dapat menghasilkan pesan ganda. Channel baru tidak memigrasikan konfigurasi lama secara otomatis.

## Activation floor

Aktivasi pertama, pengaktifan kembali, dan perubahan pilihan berlaku untuk pekerjaan yang dibuat sesudahnya. Pekerjaan historis dan yang sudah dimulai tidak diputar ulang. Tidak adanya email untuk backup lama setelah setup adalah perilaku normal. Untuk verifikasi, gunakan pekerjaan baru yang diizinkan dan catat waktu pembuatan serta hasil akhirnya.

## Test actions

**Send Test Webhook** dan **Send Test Email** memeriksa channel secara mandiri. Setelah sukses, gunakan pekerjaan baru lalu cocokkan plan/event/waktu di **Delivery History**. Bila tes channel sukses tetapi event plan tidak muncul, periksa kedua pilihan event, channel enabled, kebijakan plan, dan apakah pekerjaan dimulai sebelum aktivasi. Baca [diagnostik notifikasi](/docs/troubleshooting/notifications).

## Delete/retry

Menonaktifkan/menghapus channel mencegah pending yang tidak lagi memenuhi kebijakan; kiriman yang sudah berjalan mungkin telah diterima. Mengedit konfigurasi/secret menaikkan revision dan membatalkan kelayakan pending lama. Sebelum **Retry (review current channel)**, tinjau tujuan terkini: retry memakai konfigurasi saat ini dan dapat mengirim ulang event yang sudah diterima. Jangan gunakan retry untuk mass replay riwayat. Lihat [history dan batas retry](/docs/notifications/history).
