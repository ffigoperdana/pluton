# Memahami backup incremental dan jumlah file yang berubah

Backup incremental membantu menyimpan versi baru tanpa harus menyimpan ulang semua isi yang sama. Setiap snapshot tetap dapat dipilih untuk browse dan restore. Saat membaca statistik, bedakan perubahan file dari data baru yang benar-benar ditambahkan ke repository.

Contoh di halaman ini memakai source latihan `/srv/example-app` pada `app-01`. Gunakan plan dan repository yang sama selama pengujian, lalu catat hasil setiap backup pada tab **Backups**.

## Dua mekanisme berbeda

Restic memakai deduplikasi untuk menggunakan kembali blok konten yang sudah ada. Parent snapshot membantu mengenali perubahan file berdasarkan path serta metadata. Keduanya berhubungan, tetapi menjawab pertanyaan berbeda.

**New Files** menghitung file yang dianggap baru terhadap parent terpilih. **Data Added** menghitung data baru menurut ringkasan Restic. Jadi, semua file tampak baru tidak otomatis berarti seluruh byte disimpan ulang. Deduplikasi masih dapat bekerja walaupun tidak ada parent yang kompatibel.

## Melakukan pengujian sederhana

1. Jalankan **Backup Now** pada source berisi beberapa file contoh. Tunggu **Complete**, lalu catat statistiknya.
2. Jalankan backup kedua tanpa mengubah file, hostname, source, atau konfigurasi artifact.
3. Periksa **New Files**, **Modified Files**, **Unmodified Files**, **Data Added**, dan **Compressed Data Added** pada baris/detail backup.
4. Ubah isi satu file contoh, jalankan backup ketiga, lalu bandingkan hasil.
5. Buka **Browse** pada snapshot pertama dan ketiga. Pulihkan file yang berubah ke staging berbeda untuk memastikan kedua versinya benar.

Hasil yang diharapkan adalah versi file sesuai tiap snapshot. Bila parent cocok, banyak file yang tidak berubah dapat tercatat sebagai **Unmodified Files**. Data baru tetap bergantung pada isi, metadata, serta deduplikasi; jangan menetapkan jumlah byte tertentu sebagai syarat universal.

Jika plan juga membuat dump SQL, dump dapat berubah pada setiap eksekusi walaupun file aplikasi tetap sama. Pisahkan pengamatan perubahan dump dari file latihan ketika menjelaskan hasil.

## Arti counter

| UI | Sumber ringkasan Restic | Arti |
| --- | --- | --- |
| **Total Files** | `total_files_processed` | File regular yang diproses, termasuk artifact SQL |
| **New Files** | `files_new` | File baru terhadap parent yang dipilih |
| **Modified Files** | `files_changed` | File berubah terhadap parent; metadata dapat berpengaruh |
| **Unmodified Files** | `files_unmodified` | File tidak berubah terhadap parent |
| **Snapshot Size** | `total_bytes_processed` | Ukuran logis isi snapshot |
| **Data Added** | `data_added` | Data baru sebelum kompresi |
| **Compressed Data Added** | `data_added_packed` | Data baru setelah kompresi, bukan total pemakaian disk |

Jumlah file terhapus serta pemakaian fisik repository tidak disediakan oleh backup summary ini. **Not measured** berarti nilai tidak tersedia. Ukur kapasitas aktual melalui filesystem atau provider storage; jangan menghitung rasio deduplikasi dari counter file atau menjumlahkan ukuran logis semua snapshot.

## Parent yang aman

Pada Managed Agent, pemilihan parent harus tetap berada pada repository dan workload yang sama. Untuk pembaca diagnostik lanjutan: agent memakai **successful local completion receipts**, membatasi kandidat hingga 16 ID, lalu memeriksa metadata snapshot dari repository terkait.

Pemeriksaan mencakup ID snapshot/tree lengkap, satu tag pemilik plan, tag backup, hostname, canonical source, nama artifact yang tepat, serta satu historical private job workspace. Waktu hanya membantu memilih di antara kandidat yang sudah kompatibel. ID parent tidak diterima begitu saja dari payload pekerjaan.

Tanpa receipt atau metadata yang cocok, agent tidak memilih parent sembarang. Setelah satu backup sukses menghasilkan receipt yang kompatibel, backup berikutnya dapat memakai optimasi parent. Perubahan hostname, canonical source, state root, atau kumpulan artifact database dapat memulai baseline baru tanpa memodifikasi snapshot lama.

Workspace sementara dump berubah antarkerja. Jalur artifact yang terlihat pada snapshot tidak selalu sama dengan absolute workspace yang dicatat metadata, sehingga pencocokan parent perlu pemeriksaan khusus. Ini alasan label versi saja belum membuktikan patch optimasi telah terpasang; lihat [pembaruan agent](/docs/remote-agent/updates).

Jika lookup parent bermasalah, agent memeriksa kesehatan akses repository sebelum fallback yang aman. Error autentikasi, akses, atau integritas tidak diselesaikan dengan mengabaikan pemeriksaan.

## Jika semua file terus dianggap baru

Pastikan backup pertama benar-benar sukses, source dan hostname konsisten, serta build agent sesuai. Periksa perubahan set database/dump dan jangan menghapus state agent untuk mengulang tes. Kumpulkan tahap serta kode error yang aman melalui [diagnostik incremental](/docs/troubleshooting/incremental).

Jangan membuat ulang storage, mengubah snapshot ID, atau menghapus snapshot hanya untuk memperbaiki tampilan counter. Bukti yang lebih kuat adalah kedua versi file dapat dipulihkan dengan benar, disertai statistik yang dipahami.
