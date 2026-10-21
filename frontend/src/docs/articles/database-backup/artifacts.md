# Memeriksa artefak SQL dan konsistensi snapshot

Setelah backup selesai, pastikan snapshot berisi berkas aplikasi dan dump setiap database yang diharapkan. Pemeriksaan ini membantu menemukan cakupan yang kurang sebelum insiden. Semua contoh di halaman ini fiktif: /srv/example-app, example_app, dan example_audit.

## Layout stable

Dump native disimpan sebagai /pluton/database/nama-berkas.sql. **Dump filename** example-app.sql menghasilkan /pluton/database/example-app.sql. Workspace sementara agent tidak menjadi nama logical SQL yang perlu dicari saat restore.

Hasil backup mencatat database ID, engine, nama logical database, path, byte, dan SHA-256. Password serta credential sementara tidak menjadi artefak snapshot. Filename dan identitas setiap entri harus unik.

## Memeriksa hasil melalui antarmuka

1. Buka plan dan cari pekerjaan berstatus **Complete** pada **Backups**.
2. Buka menu titik tiga baris tersebut, lalu klik **Browse**.
3. Telusuri hierarki berkas aplikasi dan /pluton/database. Pastikan filename setiap database yang dikonfigurasi ada.
4. Untuk melihat database yang tercatat, buka **Restore Database** dari menu backup yang sama. Tinjau **Recorded database**, engine, ukuran SQL, path, dan SHA-256; tutup jika hanya memeriksa.
5. Simpan catatan privat tentang waktu backup dan snapshot yang diperiksa.

Pratinjau tidak menjalankan import. Konfirmasi [Persistent Restore](/docs/database-restores) adalah tindakan terpisah.

## Validasi

Empat bukti minimum harus dibaca terpisah: **dikonfigurasi**, dump berhasil
dibuat, artifact benar-benar termasuk snapshot exact, dan SQL berhasil diimpor
pada recovery target. Label DB pada card/detail plan hanya configuration summary,
tanpa database name atau password; receipt kosong/backup failed tidak berubah
menjadi verified database backup. Bahkan SQL import lulus belum membuktikan
aplikasi dapat menggunakan role/extensions atau transaksi bisnisnya.

Penyelesaian backup memeriksa full snapshot ID, ikatan plan/backup, pohon sumber, dan ukuran artefak. Sebelum import recovery, ukuran dan SHA-256 SQL diperiksa lagi dari data yang dipulihkan.

Hash yang cocok membuktikan artefak sesuai catatan. Ia belum membuktikan transaksi bisnis, ekstensi, hak aplikasi, atau aplikasi dapat berjalan. Berkas .sql biasa pada folder sumber juga tidak mendapat identitas database native hanya karena ekstensinya.

## Konsistensi beberapa database

Urutan contoh adalah: dump example_app → dump example_audit → snapshot berkas aplikasi dan seluruh SQL. Bila dump kedua gagal, pekerjaan tidak berlanjut sebagai backup sukses.

Waktu setiap dump berbeda. Satu snapshot menyatukan hasil untuk pemulihan, tetapi bukan transaksi atomik lintas database dan filesystem. Jika aplikasi menulis data terkait di beberapa tempat, tentukan prosedur konsistensi bersama DBA dan pemilik aplikasi; lihat [hooks](/docs/database-backup/hooks).

## Incremental

Dump dapat berubah setiap pekerjaan karena isi, header, timestamp, atau metadata berkas. SQL dapat tampil Modified meskipun berkas aplikasi tidak berubah. Restic tetap mendeduplikasi blok identik; jumlah berkas berubah bukan pengukuran langsung pertumbuhan fisik repository.

## Recovery manual

Gunakan [Restore ke staging](/docs/restore/staging) atau Download untuk mengambil SQL secara privat. SQL berisi data sensitif, sehingga staging dan tujuan unduh perlu kontrol akses serta cleanup.

[Recovery Test](/docs/recovery-testing) menguji sementara seluruh database native yang tercatat. [Restore Database](/docs/database-restores) mempertahankan satu database hasil import. Jalur recovery managed menggunakan repository primary; keberhasilan mirror belum menyediakan dukungan pemulihan native dari mirror.
