# Mencadangkan mesin lain dengan Remote Agent

Remote Agent memungkinkan Pluton mencadangkan folder pada mesin Linux lain tanpa membuka port inbound untuk protokol agent. Anda memasang satu service pada mesin sumber, mengizinkan folder tertentu, lalu memilih mesin itu saat membuat Backup Plan.

Contoh penggunaan: aplikasi fiktif berada pada `app-01` di `/srv/example-app`, sementara Pluton berjalan pada VM pengelola. Mulailah dengan folder contoh sebelum menambahkan database atau hooks.

## Komunikasi

Agent menghubungi Pluton secara outbound untuk heartbeat, mengambil pekerjaan, dan mengirim progress serta hasil. Browser administrator berkomunikasi dengan server. Untuk data backup, agent mengakses SFTP primer yang dipilih plan; server juga perlu mengakses primer untuk verifikasi dan pekerjaan lanjutan.

Layanan SFTP dapat berada di VM Pluton bila operator menyediakannya. Pada mode ini primer tetap bertipe SFTP. Salinan opsional ke S3/HCP dikerjakan oleh server sesudah snapshot diverifikasi, dan kredensial S3 tidak dikirim ke agent.

## Menyiapkan mesin

1. Periksa [persyaratan agent](/docs/getting-started/requirements), akses HTTPS ke server, dan folder source.
2. Buka **Sources → + Add Remote Machine**. Buat token lalu ikuti [enrollment](/docs/remote-agent/enrollment).
3. Pasang service dengan satu **Allowed source root** yang spesifik, misalnya `/srv/example-app`.
4. Periksa **ONLINE**, **Last seen**, versi Restic/Rclone, **Allowed roots configured**, dan **Agent capabilities** pada panel **Remote Agent**.
5. Jalankan [pemeriksaan izin source](/docs/remote-agent/permissions), lalu buat [plan Managed Agent](/docs/backup-plans/managed-agent).
6. Jalankan backup contoh, buka **Browse**, dan pulihkan satu file ke staging.

Hasil yang diharapkan adalah mesin terdaftar, backup mencapai **Complete**, dan file hasil pemulihan sesuai. Status ONLINE saja belum menjamin agent dapat membaca seluruh source atau melakukan dump database.

## Execution

Service `pluton-agent` berjalan non-root. Allowed roots membatasi source setelah path dan symlink diselesaikan ke lokasi sebenarnya. Source memerlukan akses baca/traverse; agent tidak perlu menjadi pemilik atau mempunyai akses menulis ke aplikasi.

Runtime privat, Restic, Rclone, serta aplikasi agent disiapkan installer dengan ownership dan mode yang diperiksa. State identity, temporary config, dan workspace pekerjaan disimpan pada area privat. Jangan menyalin state atau kredensial sementara ke dokumentasi publik.

## Compatibility

Server memeriksa capability agent sebelum menjalankan alur yang diminta. Dump MariaDB/MySQL/PostgreSQL dan hooks membutuhkan dukungan serta persiapan tambahan di mesin agent. Mengaktifkan kartu database pada UI tidak memasang client database secara otomatis.

Saat memperbarui, simpan catatan revision/build yang dipasang. Label **Agent version** saja dapat sama pada dua build dengan patch berbeda. Ikuti [pembaruan agent](/docs/remote-agent/updates) sambil mempertahankan identity dan allowed roots.

## Batas support

Jalur installer yang diuji adalah Linux Debian/Ubuntu x86_64 dengan systemd. Primer Managed Agent hanya SFTP dengan konfigurasi yang dibatasi. Arbitrary shell/script, agent prune, dan pemulihan langsung dari mirror managed belum tersedia.

Jika mesin OFFLINE atau capability tidak sesuai, gunakan [diagnostik agent](/docs/remote-agent/troubleshooting). Jangan melakukan re-enrollment atau menghapus state sebagai langkah pemecahan masalah pertama.
