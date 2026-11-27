# Mengunduh satu objek MinIO dari snapshot

MinIO tidak menyimpan objek sebagai file biasa. Di folder datanya, setiap objek berupa folder dengan metadata `xl.meta` dan potongan data `part.1`, `part.2`, dan seterusnya. Isi objek kecil bahkan tersimpan di dalam `xl.meta`. Karena itu, berkas yang terlihat di tampilan **Files** pada **Browse** tidak bisa langsung dibuka. Tab **MinIO objects** membaca struktur tersebut dari snapshot, lalu menampilkan bucket dan objek dengan nama key, ukuran, dan waktu ubahnya. Dari tab ini satu objek dapat diunduh kembali sebagai file aslinya, tanpa memulihkan seluruh folder dan tanpa menjalankan MinIO. Contoh pada halaman ini fiktif: folder data `/srv/example-app/minio` dan bucket `example-bucket`.

## Yang dibutuhkan

- Plan **Managed Agent** yang source-nya memuat folder data MinIO, yaitu folder yang berisi `.minio.sys/format.json`. Folder itu boleh berupa Docker volume, misalnya `/var/lib/docker/volumes/example-minio/_data`, dan boleh dicadangkan bersama dump database atau berkas lain.
- MinIO dalam mode satu drive (`xl-single`), yaitu `minio server /data` dengan satu folder data.
- Backup berstatus **Complete**. GoRecover membaca repository primary plan, sama seperti Browse.

Tidak ada pengaturan tambahan. Folder data MinIO dikenali otomatis dari isi snapshot.

## Membuka daftar objek

1. Buka plan → tab **Backups**, lalu klik **Browse** pada backup **Complete** yang dipilih.
2. Tunggu indeks snapshot selesai disiapkan. Jika snapshot memuat folder data MinIO, tab **MinIO objects** muncul di samping **Files**.
3. Buka tab **MinIO objects**. Bila snapshot memuat lebih dari satu folder data, pilih foldernya terlebih dahulu.
4. Pilih bucket. Saat bucket pertama kali dibuka, GoRecover memulihkan semua berkas `xl.meta` bucket itu ke workspace privat di server, membaca metadatanya, lalu langsung menghapus berkas tersebut. Progresnya tampil di layar. Daftar yang sudah siap disimpan sementara di server sehingga pembukaan berikutnya langsung tampil.
5. Telusuri folder seperti di S3: klik nama folder, atau gunakan breadcrumb di atas tabel untuk naik kembali. Kolom pencarian mencari bagian key di dalam folder yang sedang dibuka.
6. Urutkan berdasarkan **Key**, **Size**, atau **Last modified (UTC)** dengan mengklik judul kolom.

Kolom **Size** adalah ukuran asli objek. Untuk objek yang dikompresi MinIO, angka ini adalah ukuran setelah dekompresi, bukan ukuran di disk.

## Mengunduh objek

1. Pada baris objek berstatus **Available**, klik ikon download.
2. GoRecover membaca ulang `xl.meta` objek itu dari snapshot dan memastikan isinya sama dengan daftar. Server juga memeriksa ukuran setiap `part.N` di snapshot sebelum mulai mengirim data.
3. Browser menerima file dengan nama aslinya, yaitu bagian terakhir dari key, misalnya `laporan akhir.pdf` untuk key `dokumen/laporan akhir.pdf`.

Selama pengiriman, server membuang hash bitrot MinIO, membuka kompresi S2 bila ada, lalu menghitung MD5 isi file. Hasilnya dicocokkan dengan ETag objek. Untuk objek hasil multipart upload yang ETag-nya berbentuk `<md5>-<jumlah part>`, server menghitung MD5 setiap part lalu MD5 gabungannya. Potongan data terakhir baru dikirim setelah pencocokan berhasil. Bila tidak cocok, koneksi diputus sebelum ukuran file lengkap sehingga browser menandai unduhan gagal. Hasil yang tidak lengkap tidak pernah terlihat seperti file utuh.

Objek dengan banyak part dibaca satu per satu dari repository, sehingga unduhannya lebih lambat daripada file biasa dengan ukuran sama.

## Versi dan objek terhapus

- Secara default daftar menampilkan versi terbaru setiap objek. Pilih **All versions** untuk melihat semua versi dan delete marker. Setiap versi dapat diunduh bila statusnya **Available**.
- Objek yang versi terbarunya adalah delete marker tampil sebagai **Deleted**. Pilih **All versions**, lalu unduh versi sebelum objek itu dihapus.
- Versi yang ditulis sebelum versioning diaktifkan mempunyai version ID `null`.
- Objek folder (key yang diakhiri `/`) tampil sebagai **Folder object** dan tidak dapat diunduh karena tidak berisi data.

## Status yang tidak dapat diunduh

GoRecover hanya mengunduh objek yang formatnya dikenali dan isinya dapat diverifikasi. Objek lain tetap ditampilkan beserta alasannya. Arahkan kursor ke kolom **Status** untuk melihat penjelasan lengkap.

| Status | Arti | Yang dapat dilakukan |
| --- | --- | --- |
| Encrypted (SSE) | Objek dienkripsi server MinIO (SSE-S3, SSE-KMS, atau SSE-C). Kuncinya tidak ada di backup. | Pulihkan folder data, jalankan MinIO dengan KMS yang sama, lalu unduh lewat MinIO. |
| Multi-drive | Objek di-erasure-code ke beberapa drive. | Pulihkan semua drive deployment tersebut dan baca dengan MinIO. |
| Remote tier | Data objek sudah dipindahkan MinIO ke tier lain (ILM transition) dan tidak ada di folder ini. | Ambil dari tier tujuan. |
| Unverifiable | ETag objek bukan checksum MD5, sehingga isi tidak dapat diverifikasi. | Pulihkan folder data dan baca dengan MinIO. |
| Damaged metadata | `xl.meta` rusak (CRC tidak cocok) atau formatnya tidak dikenal. | Coba snapshot lain. |
| Legacy version, xl.json format | Format MinIO lama (sebelum 2020). | Pulihkan folder data dan baca dengan MinIO versi yang sesuai. |
| Unknown layout, Unknown compression | Struktur data yang belum dikenali GoRecover. | Pulihkan folder data dan baca dengan MinIO. |

Bila seluruh folder data berasal dari deployment multi-drive (`format.json` bertipe `xl`) atau mode FS lama, tab menampilkan pesan tersebut tanpa daftar objek. Pada mode FS, objek sudah tersimpan sebagai file biasa sehingga dapat diunduh dari tampilan **Files**.

## Batas dan keamanan

- Fitur ini hanya membaca. Tidak ada yang ditulis ke repository, ke host Agent, atau ke MinIO yang sedang berjalan.
- Metadata yang dipulihkan untuk membuat daftar disimpan di workspace privat server dan dihapus segera setelah dibaca. Berkas `xl.meta` dapat berisi data objek kecil, tetapi data itu tidak pernah disimpan di daftar. Daftar hanya memuat key, version ID, ukuran, waktu, ETag, content type, dan status.
- Metadata satu bucket paling besar 2 GiB, dan server perlu ruang kosong sebesar metadata itu ditambah 256 MiB. Satu daftar memuat paling banyak 2.000.000 versi. Server menyimpan paling banyak tiga daftar dan menghapusnya setelah 12 jam tidak dipakai atau saat GoRecover dimulai ulang.
- Batas indeks snapshot Browse (1.000.000 entri) tetap berlaku. Setiap objek yang disimpan dalam part file memakai sekitar empat entri.
- Backup dibuat ketika MinIO masih berjalan. Objek yang sedang ditulis saat backup berlangsung bisa tercatat di `xl.meta` tanpa part file yang lengkap. Objek seperti itu ditolak dengan pesan yang jelas, bukan diunduh sebagian.
- Untuk memulihkan seluruh bucket atau seluruh deployment, tetap gunakan [restore ke staging](/docs/restore/staging) atau [restore ke host Agent](/docs/restore/agent-host), lalu jalankan MinIO pada hasilnya.

## Bila gagal

| Pesan | Arti |
| --- | --- |
| The metadata of this bucket is too large to list here | Total `xl.meta` bucket melebihi 2 GiB. Pulihkan folder bucket lewat staging. |
| Listing this bucket needs more free disk space | Ruang kosong server tidak cukup untuk memulihkan metadata bucket. Kosongkan ruang disk lalu klik **Retry**. |
| This bucket holds a folder named xl.meta | Struktur bucket tidak biasa sehingga metadata tidak dapat dipilih dengan aman. Pulihkan folder bucket lewat staging. |
| A part file of this object is missing or incomplete in the snapshot | Objek kemungkinan sedang ditulis saat backup berjalan. Coba snapshot lain. |
| The object metadata differs from the catalog | Daftar sudah tidak sesuai dengan snapshot. Buka bucket lagi lalu ulangi unduhan. |
| The restored content does not match the object ETag | Isi hasil pembacaan tidak cocok dengan ETag. Unduhan dihentikan. Coba snapshot lain dan laporkan ke administrator. |
| MinIO object downloads are busy | Sudah ada dua unduhan objek yang berjalan. Tunggu sebentar lalu ulangi. |

Desain teknis dan pilihan pendekatannya ada di `docs/MINIO_OBJECT_BROWSE.md` pada source GoRecover.
