# Melihat lampiran Odoo dengan nama aslinya

Odoo menyimpan setiap lampiran (PDF, foto, spreadsheet) di filestore dengan nama berupa hash isi file, misalnya `3f/3f9c2a81e0…`. Nama asli, tipe file, dan record pemiliknya hanya tercatat di tabel `ir_attachment` pada database Odoo. Fitur ini memasangkan plan filestore dengan plan database, sehingga **Browse** dapat menampilkan setiap lampiran dengan nama aslinya. Contoh pada halaman ini fiktif: filestore `/srv/example-app/filestore/example_db` dan database `example_db`.

## Yang dibutuhkan

- Plan **Managed Agent** untuk filestore Odoo, dengan source berupa folder filestore satu database Odoo (folder yang berisi folder hash dua karakter).
- Plan **Managed Agent** lain yang mencadangkan database Odoo dengan dump PostgreSQL. Lihat [pencadangan database](/docs/database-backup) dan [engine](/docs/database-backup/engines).
- Kedua plan sebaiknya dijadwalkan berdekatan, misalnya pada jam yang sama. Setiap snapshot filestore dipasangkan dengan backup database yang waktunya paling dekat.

## Mengaktifkan

1. Buka plan filestore, klik **Edit**, lalu pilih **Advanced → Attachments**.
2. Centang **Show Odoo attachment names in Browse**.
3. Pilih **Database plan**, yaitu plan yang mencadangkan database Odoo, lalu pilih **Odoo database**.
4. Kosongkan **Filestore folder in the snapshot** bila source plan adalah folder filestore database itu sendiri. Isi path snapshot lain hanya bila source plan berada satu tingkat di atasnya.
5. Klik **Update Plan**.

GoRecover menolak pengaturan bila plan database tidak mempunyai database PostgreSQL yang dipilih, atau bila plan filestore bukan plan Managed Agent.

## Melihat lampiran

1. Pada riwayat backup plan filestore, buka **Browse** untuk snapshot yang sudah **Complete**.
2. Pilih tab **Odoo attachments**.
3. Pertama kali dibuka, GoRecover menyiapkan daftar: membaca dump database sampai tabel `ir_attachment` selesai, menyiapkan indeks snapshot filestore, lalu mencocokkan keduanya. Progresnya tampil di layar; daftar yang sudah siap disimpan sementara di server sehingga pembukaan berikutnya langsung tampil.
4. Cari berdasarkan nama asli, saring berdasarkan model (misalnya `account.move`) atau status, lalu klik ikon download. File diunduh dengan nama aslinya.

Kolom **Status** menunjukkan apakah file lampiran ada di snapshot ini. **Missing** berarti database mencatat lampiran tersebut, tetapi filenya tidak ada di snapshot filestore. Penyebabnya bisa lampiran yang dibuat setelah snapshot filestore, file yang memang hilang dari server, atau folder filestore yang salah. Daftar ini sekaligus menjadi cek kecocokan antara backup database dan filestore.

## Batas dan keamanan

- Fitur ini hanya membaca. Dump database dibaca lewat jalur download item snapshot yang sudah diverifikasi, dan tidak ada yang ditulis ke repository mana pun.
- GoRecover hanya menyimpan kolom yang dibutuhkan (nama, tipe, ukuran, model, record, tanggal, path hash). Isi lampiran yang tersimpan di database dan teks hasil indeks tidak pernah disimpan.
- Lampiran yang tersimpan di database (bukan di filestore) dan lampiran berupa URL tidak ditampilkan, karena tidak ada filenya di filestore.
- Satu daftar dapat memuat sampai 2.000.000 lampiran. Server menyimpan paling banyak tiga daftar dan menghapusnya setelah 12 jam tidak dipakai atau saat GoRecover dimulai ulang.
- Nama asli dari Odoo dibersihkan dari karakter kontrol dan pemisah path sebelum ditampilkan atau dipakai sebagai nama file download.

## Bila gagal

| Pesan | Arti |
| --- | --- |
| No completed backup of the paired database plan holds this database dump yet | Plan database belum mempunyai backup Complete dengan dump database yang dipilih. Jalankan **Backup Now** pada plan database. |
| The paired database dump has no ir_attachment table | Database yang dipasangkan bukan database Odoo milik filestore ini. Periksa pilihan **Odoo database**. |
| The database dump ends inside the attachment list | Dump terpotong. Gunakan snapshot database lain atau jalankan backup database lagi. |
| The attachment catalog needs more free disk space | Server GoRecover memerlukan ruang kosong minimal 192 MiB untuk mulai menyiapkan daftar. |
| The attachment catalog ran out of disk space or reached its size limit | Disk server penuh saat daftar disiapkan, atau daftar melebihi 512 MiB. Kosongkan ruang disk lalu klik **Retry**. |

Untuk pemulihan penuh, filestore dan database tetap harus dipulihkan berpasangan. Lihat [artefak dan konsistensi](/docs/database-backup/artifacts).
