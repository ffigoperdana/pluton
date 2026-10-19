# New Files berulang dan progress yang belum pasti

Counter backup menjelaskan perubahan yang dilaporkan Restic; angka itu berbeda dari pertumbuhan fisik repository. Gunakan artikel ini bila backup berturut-turut tampak menghitung semua file sebagai baru, atau progress belum menunjukkan persentase pasti.

## Gejala

Contoh sintetis: dua backup `app-01` sama-sama menampilkan banyak **New Files**, tetapi data fisik repository bertambah sedikit. Progress dapat tetap indeterminate sebelum total ukuran yang valid tersedia. Kedua gejala tersebut perlu bukti metadata/progress dan tidak otomatis menunjukkan deduplikasi rusak atau pekerjaan macet.

## Penyebab

Pemilihan parent Restic bergantung pada identitas host dan input paths. Workspace SQL privat yang berubah dapat memengaruhi metadata path walaupun layout artefak logis stabil. Perubahan hostname, canonical source, atau daftar artefak juga dapat memulai baseline baru dengan sengaja. Content deduplication tetap berbeda dari klasifikasi file baru.

Agent yang sudah memuat perbaikan parent memakai receipt sebelumnya yang diverifikasi terhadap repository, plan, host, source, dan artefak yang sama. Receipt hilang atau kandidat tidak kompatibel dapat mengakibatkan satu baseline aman sebelum reuse berikutnya. Jangan memilih arbitrary newest snapshot sebagai parent.

## Diagnostik aman

1. Pada plan → **Backups**, bandingkan dua pekerjaan yang berurutan. Baca **Changes** dan detail **New Files**, **Modified Files**, **Unmodified Files**, **Snapshot Size**, serta durasi.
2. Bedakan total file yang diproses dari `files_new`; **Not measured** tidak sama dengan nol. Counter logical bukan ukuran repository fisik.
3. Catat apakah source path, hostname, daftar database, dump filename, atau versi Agent berubah di antara pekerjaan.
4. Periksa **Remote Agent → Agent version**, **Restic**, dan **Rclone**. Server-only deployment tidak memperbarui proses Agent lama.
5. Jika perlu pemeriksaan metadata repository, lakukan pada repository disposable/copy yang memang diizinkan atau jalur inspeksi yang didukung. Cocokkan owning plan, canonical source, snapshot paths, dan receipt secara privat; jangan meminta password/inventaris repository untuk laporan publik.

## Resolusi

Perbarui Agent ke revisi yang ditinjau melalui [updates](/docs/remote-agent/updates), pertahankan identity dan seluruh roots, lalu gunakan dua backup baru yang diizinkan dengan input stabil. Verifikasi bahwa parent yang dipakai cocok dengan binding dan counters berikutnya masuk akal. Jangan menjanjikan angka New Files selalu nol; perubahan nyata atau baseline baru tetap sah.

Untuk progress, bandingkan stage, waktu, dan counter yang benar-benar tersedia. Bila total belum valid, UI tidak boleh mengarang persentase. Jika tidak ada kemajuan melewati durasi yang wajar untuk workload, periksa timeout/source/dump/transport dan log pekerjaan yang sama sebelum melakukan tindakan pembatalan yang didukung.

## Jangan lakukan

Jangan rewrite snapshot lama, memaksa parent asing, mengubah counter agar tampak kecil, atau menghitung dedup ratio dari logical snapshot size dan physical repository size yang tidak sebanding. Jangan restart Agent/server berulang untuk progress yang belum diketahui. Baca [incremental](/docs/backup-plans/incremental), [history](/docs/backup-plans/history), dan [monitoring](/docs/operations/monitoring) untuk interpretasi hasil yang benar.
