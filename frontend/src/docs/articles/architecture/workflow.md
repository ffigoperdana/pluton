# Alur backup sampai pemulihan

Backup yang berguna adalah backup yang dapat ditemukan, dibaca, dan dipulihkan. Gunakan alur berikut sebagai urutan kerja, sejak persiapan sampai verifikasi hasil.

## Alur operasional

```text
Storage → Backup Source / Agent → Backup Plan → Backup pertama
  → Verifikasi snapshot → Uji Restore → Pemantauan backup terjadwal
```

1. Tambahkan **Primary Storage** lebih dahulu. Gunakan repository atau prefix khusus agar penghapusan dan Retention tidak menyentuh data lain.
2. Daftarkan **Backup Source**. Untuk Managed Agent, pastikan Agent Online dan direktori sumber berada dalam allowed roots.
3. Buat **Backup Plan**, tentukan jadwal, dan periksa opsi database serta replikasi bila diperlukan.
4. Jalankan **Backup Now**, lalu tunggu hasil terminal di **Backups**.
5. Buka **Browse** untuk memastikan file yang diharapkan ada. Bila memakai managed database backup, periksa hasil database dan SQL artifact yang tercatat.
6. Lakukan staged Restore atau Recovery Testing pada data latihan. Bandingkan hasil dengan kebutuhan aplikasi.

## Sebelum snapshot

Managed Agent memvalidasi source dan alat backup sebelum pekerjaan berjalan. Jika Database & Hooks diaktifkan, pre-hook berjalan sesuai konfigurasi, lalu database di-dump secara berurutan. File aplikasi dan SQL dump yang selesai dimasukkan ke satu snapshot.

```text
File aplikasi + SQL dump yang selesai
  → Satu snapshot di primer → Replikasi opsional
```

SQL yang kebetulan ada dalam direktori sumber tetap merupakan file biasa. Fitur native database recovery memerlukan metadata database tepercaya yang direkam oleh workflow managed database backup.

## Sesudah snapshot

Keberhasilan primer, setiap replica, Recovery Testing, dan notifikasi mempunyai hasil sendiri. Post-hook atau cleanup dapat memberi peringatan setelah snapshot terbentuk; baca detail hasil sebelum mengulangi backup.

Contoh fiktif: plan `app-01-harian` menghasilkan snapshot yang dapat dibrowse, tetapi tujuan S3 gagal karena TLS. Primer tetap tersedia; operator menyelesaikan kegagalan replica tanpa menyimpulkan bahwa kedua salinan sudah berhasil.

## Recovery

| Kebutuhan | Gunakan | Hasil yang harus diverifikasi |
| --- | --- | --- |
| Mengambil file | Browse, Download, atau Restore | File di staging dan isi yang benar |
| Menguji keterpulihan | Recovery Testing | Hasil validasi, hasil import bila dipilih, cleanup |
| Menyimpan database hasil pemulihan sementara | Persistent Restore | Active, Inspect, TTL, dan Delete terverifikasi |
| Membaca backup historis | Legacy Repository | Akses read-only dan staging terpisah |

Import yang tidak dijalankan harus dibaca sebagai **NOT TESTED**. Jangan memindahkan traffic produksi atau menonaktifkan sistem backup lama hanya berdasarkan satu status Complete.

## Langkah berikutnya

Lihat [status pekerjaan](/docs/architecture/states), [Restore file](/docs/restore), [Recovery Testing](/docs/recovery-testing), dan [migrasi bertahap](/docs/migration).
