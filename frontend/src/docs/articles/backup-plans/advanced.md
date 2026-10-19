# Menyesuaikan pengaturan lanjutan setelah backup dasar berhasil

Gunakan **Advanced** setelah source, destination, dan backup contoh terbukti bekerja. Mulailah dari pengaturan bawaan, lalu ubah satu kebutuhan pada satu waktu. Contoh pada halaman ini adalah plan `Backup contoh app-01` yang sudah menghasilkan snapshot dan file hasil restore yang sesuai.

Sebelum mengubah lifecycle database atau hook, tunggu backup aktif selesai. Perubahan tertentu juga ditolak ketika replikasi masih pending, berjalan, atau belum pasti hasilnya.

## Mode berbeda

1. Buka plan dan klik **Edit**.
2. Pilih **Advanced**. Pada layar kecil, pilih bagian yang sama melalui dropdown.
3. Tinjau **General**, **Performance**, **Notification**, dan **Misc.**.
4. Untuk source Managed Agent, tersedia **Database & Hooks** dan **Recovery Testing**. Arbitrary **Scripts** tidak tersedia pada alur remote ini.
5. Simpan perubahan form lewat **Update Plan**, lalu jalankan satu backup contoh dan periksa hasilnya.

Form standar dan Managed Agent berbagi beberapa komponen UI. Keberadaan field bukan bukti bahwa semua opsi dijalankan dengan cara yang sama pada kedua mode. Pertahankan nilai default untuk pengaturan yang belum Anda verifikasi pada mode tersebut; jangan melewati penolakan backend melalui raw payload atau perubahan database.

## Encryption dan compression

Pada **General**, periksa **Encryption** dan **Compression**. Encryption tidak dapat diubah melalui edit biasa sesudah plan dibuat. Managed Agent memerlukan enkripsi serta password repository yang dikelola server; jangan mematikannya untuk mengatasi error akses.

**Compression** memengaruhi penyimpanan data sesuai format repository yang digunakan. **Snapshot Size** tetap merupakan ukuran logis, walaupun kompresi aktif. Untuk melihat data baru setelah kompresi, periksa **Compressed Data Added** pada statistik backup.

**Retries** dan **Retries Delay** berkaitan dengan percobaan ulang; delay ditampilkan dalam detik. Pada pembuatan plan, **Run Backup Now** menentukan apakah backup awal langsung diminta. Matikan bila Anda perlu meninjau plan tersimpan dahulu. Pada alur standar, hal itu tidak menunda inisialisasi repository saat plan dibuat.

**Performance** menyediakan field seperti **Max Processor Cores**, **Read Concurrency**, dan **Scan Before Backup** pada form bersama. Uji perubahan pada data disposable dan amati beban host. Pengaturan ini bukan pengganti diagnosis sumber yang tidak terbaca atau koneksi storage yang gagal.

## Database dan hooks

Pada Managed Agent, **Database & Hooks** dapat menambahkan 0–8 dump MariaDB/MySQL/PostgreSQL dan hook terbatas. File aplikasi serta dump masuk satu snapshot; dump beberapa database dikerjakan berurutan dan bukan distributed transaction.

1. Pastikan [client database](/docs/database-backup/engines), [izin dump](/docs/database-backup/dump-options), dan kesiapan agent sudah sesuai.
2. Aktifkan **Enable database backup** bila dibutuhkan, lalu isi satu database contoh dahulu.
3. Gunakan nama file dump yang berbeda untuk setiap database. Masukkan password hanya pada field privat yang disediakan.
4. Jika memakai hook, gunakan executable yang disiapkan administrator sesuai [panduan hooks](/docs/database-backup/hooks). UI menerima deklarasi terbatas, bukan shell arbitrary.
5. Simpan plan, jalankan backup, lalu periksa artifact yang terikat pada snapshot itu.

Jika agent tidak mengiklankan engine atau hooks yang diperlukan, perbaiki persiapan lokal dan perbarui inventory. Jangan memalsukan capability. Backup filesystem yang berhasil tidak membuktikan dump database atau pemulihan SQL sudah benar.

## Notification dan recovery

Pada **Notification**, bagian **Durable Webhook & Email Notifications** memakai kanal dari **Settings → Webhooks & Email**. Simpan plan terlebih dahulu, pilih kanal dan event, lalu klik **Save notification policy**. Penyimpanan ini terpisah dari **Update Plan** dan berlaku pada job yang dibuat setelahnya. Lihat [subscriptions](/docs/notifications/subscriptions).

Pada **Recovery Testing**, simpan policy serta target melalui tombolnya sendiri. **Save recovery policy** berbeda dari menyimpan form plan. Import database hanya ke target recovery yang memang disediakan; jangan memakai database aplikasi aktif sebagai tujuan percobaan.

Hasil yang diharapkan sesudah perubahan adalah backup **Complete**, artifact sesuai, dan hasil recovery/notifikasi diperiksa secara terpisah. **Passed with Warning** dapat berarti integritas artifact lolos tetapi SQL import belum diuji. Ikuti [hasil recovery](/docs/recovery-testing/results) dan [riwayat delivery](/docs/notifications/history) untuk mengetahui apa yang benar-benar selesai.
