# Perubahan fitur pada source fork

Halaman ini merangkum fitur yang ada pada source saat panduan ditulis. Halaman ini bukan feed rilis live atau bukti bahwa source tersebut sudah terpasang di suatu server.

## Managed Agent replication

Merge PR #34 pada `e2575cc` memasukkan server-side replication dari primer Managed Agent SFTP ke nol, satu, atau dua tujuan S3/S3-compatible. Ada state durable untuk job/tujuan, status replica tersendiri, dan setup HCP existing-bucket.

Direct managed mirror Restore, native database recovery dari mirror, dan physical cleanup/prune managed replica belum tersedia. Interoperabilitas HCP nyata tetap perlu pengujian terpisah; merge source tidak menutup gate tersebut.

## Delete, Remove, dan tabel

PR #32 dan PR #33 mencakup penguatan penghapusan, pemeriksaan retained database dependency, penanganan respons error, serta perbaikan history/progress dan pengalaman tabel. Penghapusan plan tidak menjadi izin menghapus database retained atau resource yang tidak terkait.

## Database dan recovery

Source mencakup managed MariaDB/MySQL/PostgreSQL backup, Recovery Testing, Database Restore Management, serta jalur MySQL Internal/Custom dengan prasyarat masing-masing. Migration additive `0016` menambahkan explicit Resume sequence; ini bukan persetujuan menjalankan recovery pada host yang belum memenuhi kapasitas/policy.

## Notifikasi dan operasional

Source juga mencakup Legacy Repository read-only, outbound Agent, multi-database/hooks, staged Restore, Webhooks & Email dengan riwayat delivery, configuration backup, dan deployment berbasis digest/kontrak mount.

Dokumentasi `/docs` menggunakan artikel lokal dan pencarian statis, terpisah dari runtime aplikasi. Penulisan ulang panduan ini tidak menambahkan fitur bisnis atau menjalankan deployment.

## Memastikan yang terpasang

Package version checked-in tidak membuktikan publikasi rilis atau kesiapan produksi. Bandingkan informasi footer, source commit, digest image, Agent, worker, dan host operator melalui [identifikasi build](/docs/reference/version). Gunakan [batasan fitur](/docs/reference/limitations) serta [pembaruan aman](/docs/deployment/updates) sebelum merencanakan perubahan.
