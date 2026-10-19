# Cara kerja Pluton

Pluton menghubungkan sumber data, tempat penyimpanan backup, dan alat verifikasi pemulihan. Memahami peran setiap komponen membantu Anda menentukan mesin mana yang perlu diberi akses, tempat SQL dump dibuat, dan lokasi hasil Restore.

## Komponen arsitektur

| Komponen | Pekerjaan | Yang perlu disiapkan operator |
| --- | --- | --- |
| Pluton Server dan Web UI | Menyimpan konfigurasi, menjadwalkan pekerjaan, menampilkan hasil | Volume data persisten, origin HTTPS, akses administrator |
| Agent | Membaca file dan menjalankan backup pada mesin sumber yang dikelola | Identitas Agent, direktori yang diizinkan, akses SFTP primer |
| Primary Storage | Menyimpan repository utama dan snapshot | Ruang, kredensial, prefix yang tidak berbagi dengan plan lain |
| Replication Destination | Menyimpan salinan tambahan sesuai jenis plan | Kredensial dan kapasitas tujuan yang terpisah |
| Target recovery dan host operator | Menyiapkan lingkungan database yang diizinkan | Setup operator, resource, TLS, dan aturan kepemilikan |

Server, Agent, worker MySQL, dan host operator mempunyai peran berbeda. Memperbarui image aplikasi tidak otomatis memasang operator atau memperbarui Agent.

## Contoh penempatan

Contoh fiktif: Agent pada `app-01` membaca `/srv/example-app`, lalu menulis ke repository SFTP primer. Server dapat menyalin snapshot selesai ke S3 jika replikasi dikonfigurasi. Browse dan staged Restore Managed Agent membaca primer melalui server; hasil Restore berada pada staging privat server, bukan langsung menimpa aplikasi di `app-01`.

```text
Sumber aplikasi → Agent → Primary Storage
                              ↓
                         Pluton Server → Replication Destination opsional
                              ↓
                         Staging / target recovery terpisah
```

## Memeriksa penempatan yang benar

1. Buka **Sources** dan pastikan Agent yang dipilih adalah mesin sumber yang dimaksud.
2. Buka **Storages** dan periksa jenis penyimpanan serta lokasi repository.
3. Buka **Backup Plans**, pilih plan, lalu cocokkan source dan destination.
4. Lakukan verifikasi snapshot dan Restore pada data latihan sebelum menyusun cutover.

Jangan menggunakan direktori repository sebagai source atau staging. Repository lama melalui Legacy Repository tetap berada pada jalur read-only yang terpisah.

## Pelajari berikutnya

Ikuti [alur backup sampai recovery](/docs/architecture/workflow), [backup pertama](/docs/getting-started/quick-start), dan [perbedaan Standard dengan Managed Agent](/docs/backup-plans/managed-agent).
