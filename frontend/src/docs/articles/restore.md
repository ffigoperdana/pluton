# Memulihkan berkas dari snapshot yang dipilih

Mulailah pemulihan dengan menentukan data dan waktu yang dibutuhkan. Untuk kehilangan berkas aplikasi, gunakan **Restore** atau **Download** pada backup yang sesuai. Untuk menjalankan database hasil import, gunakan **Restore Database**. Untuk menguji backup tanpa mempertahankan database hasil import, gunakan **Run Recovery Test**.

## Memilih jalur pemulihan

| Tujuan | Tindakan | Hasil yang diharapkan |
| --- | --- | --- |
| Melihat berkas yang tersimpan | Browse | Daftar isi snapshot |
| Mengambil seluruh snapshot managed remote | Download | Arsip TAR pada perangkat pengunduh |
| Memulihkan berkas atau direktori terpilih | Restore | Berkas pada staging privat Pluton Server untuk managed remote |
| Mempertahankan satu database native | Restore Database | Database terpisah dengan TTL dan pengelolaan ownership |
| Menguji pemulihan snapshot | Run Recovery Test | Hasil validasi dan cleanup target sementara |

Contoh fiktif: gunakan snapshot app-01 dari sebelum berkas /srv/example-app/config/example.conf terhapus. Jangan memilih snapshot hanya karena paling baru.

## Binding

1. Buka plan dan pilih tab **Backups**.
2. Cari pekerjaan dengan status **Complete**, lalu cocokkan tanggal, waktu, dan data yang diperlukan.
3. Buka menu titik tiga pada baris tersebut. Gunakan **Browse** untuk memastikan path tersedia.
4. Pilih **Restore** untuk memulai wizard **Restore Backup**.
5. Lanjutkan **Settings → Select Files → Preview → Restore** sesuai [panduan staging](/docs/restore/staging).

Untuk managed remote, pekerjaan terikat pada plan, backup, repository primary, dan full snapshot ID yang dipilih. Snapshot yang hilang tidak diganti otomatis dengan snapshot terbaru. Hasil pemulihan lama juga tidak membuktikan backup baru dapat dipulihkan.

## Mode restore

Managed remote selalu menulis ke staging privat baru pada Pluton Server. Tidak ada penulisan kembali ke source agent. Repository primary adalah sumber recovery yang didukung; mirror managed tidak menyediakan Browse/Restore/Download atau recovery database melalui jalur ini.

Plan lokal mempunyai pengaturan berbeda, termasuk original path dan overwrite. Untuk latihan pemulihan, pilih **Restore to a Custom Path**, tujuan kosong yang disetujui, **Never Overwrite**, dan biarkan penghapusan berkas tidak aktif. Jangan menerapkan perlindungan staging remote sebagai asumsi pada dialog lokal.

[Legacy Repository](/docs/legacy-repositories/restore) mempunyai alur staging tersendiri melalui registrasi read-only.

## Akses

Anda perlu masuk ke Pluton, mempunyai akses backup, dan memastikan storage masih dapat dijangkau server dengan credential yang benar. Source agent managed remote tidak perlu dihubungi untuk recovery. Periksa kapasitas berdasarkan data logical yang dipulihkan, bukan hanya ukuran repository terkompresi.

## Verifikasi

Tunggu hasil pekerjaan pada tab **Restores**, periksa **Complete**, Restore Path, jumlah berkas, dan **View Changes**. Cocokkan berkas yang diharapkan bersama administrator sebelum memindahkannya ke lingkungan aplikasi terpisah.

Restore berkas tidak menjalankan aplikasi, mengganti DNS, mengimpor SQL, atau menyetujui cutover. Jika gagal, catat tahap dan pesan aman; jangan mengganti snapshot atau menghapus repository untuk memaksa hasil. Lanjutkan ke [Browse dan Download](/docs/restore/browse), [pemilihan isi](/docs/restore/selection), [Persistent Restore](/docs/database-restores), atau [Recovery Test](/docs/recovery-testing).
