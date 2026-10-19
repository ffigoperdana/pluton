# Memilih berkas dan direktori untuk restore

Pilih hanya data yang diperlukan agar hasil pemulihan mudah diperiksa dan kebutuhan ruang dapat diperkirakan. Pada langkah **Select Files**, pilihan mencakup snapshot yang sedang dibuka, bukan filesystem aplikasi yang sedang berjalan.

## Semantics

1. Buka plan → **Backups**, pilih menu backup **Complete**, lalu klik **Restore**.
2. Selesaikan **Settings** dan klik **Next: Select Files to Restore**.
3. Buka direktori yang diperlukan, lalu centang berkas atau direktori. Untuk contoh fiktif, pilih /srv/example-app/uploads/example.txt.
4. Baca **Summary** di atas daftar: berkas, direktori, jumlah entries, dan byte yang dipilih.
5. Klik **Next: Preview Restore**, buat pratinjau dengan **Generate Preview**, lalu periksa konfirmasi sebelum menjalankan restore.

Regular file dan direktori dihitung terpisah. Contoh 12 files + 3 directories berarti 15 entries; bukan 15 berkas berisi data. Angka progress berkas dapat berbeda dari entries tanpa menunjukkan data hilang.

## Select All

Tombol saat ini bernama **Select all entries**. Tombol tersebut memilih seluruh listing snapshot, termasuk item yang tidak sedang terlihat karena pencarian atau posisi daftar. Gunakan hanya bila memang ingin memulihkan semua isi.

Untuk mulai dari pilihan kosong, klik **Clear selection**, kemudian pilih kembali path yang diperlukan. Search membantu menemukan isi; ia tidak membatasi tindakan Select all entries menjadi hasil pencarian saja.

## Partial selection

Memilih sebuah direktori memasukkan subtree-nya. Membatalkan parent membuang pilihan subtree; memilih child kembali mempertahankan direktori induk yang diperlukan. Tampilan centang sebagian menunjukkan bahwa isi parent tidak dipilih seluruhnya.

Coba contoh fiktif berikut saat berlatih: pilih folder uploads, batalkan satu berkas di dalamnya, lalu lihat perubahan Summary. Direktori kosong yang dipilih juga merupakan data struktur yang perlu dipertahankan. Jangan menilai pilihan hanya dari jumlah baris yang terlihat.

## Backend boundary

Server memvalidasi path terhadap snapshot yang terikat pekerjaan. Path tidak aman, traversal, node tidak didukung, atau tujuan yang melanggar aturan staging akan ditolak. Managed remote hanya mendukung regular file dan direktori, tanpa overwrite dan penghapusan berkas tujuan.

Jika Summary menunjukkan **other entries (unsupported by remote staged restore)**, tinjau isi sebelum konfirmasi. Jangan mengubah payload atau path untuk melewati pembatasan; pilih data yang didukung atau minta administrator meninjau kebutuhan pemulihan.

## Setelah restore

Pada tab **Restores**, periksa status **Complete**, jumlah regular files, byte, dan **View Changes**. Bersama administrator, pastikan direktori serta berkas yang dipilih ada pada hasil staging. Jika angka berbeda, bandingkan dulu kategori files dan directories dengan entries pada konfirmasi.

Simpan bukti privat tentang snapshot, selection, dan hasil pemeriksaan. Jangan menghapus direktori dari snapshot untuk menyamakan hitungan. Lihat [staging dan verifikasi](/docs/restore/staging) untuk langkah sesudah pemulihan dan batas cleanup.
