# Batasan fitur dan validasi yang masih diperlukan

Halaman ini membantu Anda memilih workflow yang benar dan menghindari asumsi bahwa fitur yang tersedia sudah memenuhi semua kebutuhan operasional.

## Implementasi versus acceptance

Test otomatis, build, dan fixture sintetis memberi bukti dalam scope-nya. Hasil tersebut tidak menggantikan pengukuran host, uji vendor, review operator, atau persetujuan produksi. Dokumentasi ini tidak mengubah acceptance ledger maupun historical failure menjadi PASS.

| Kebutuhan | Batas saat ini | Tindakan operator |
| --- | --- | --- |
| Managed Agent primary | Subset SFTP terkontrol; bukan Agent-local primary baru | Siapkan SFTP dan mapping path yang benar |
| Managed Agent replica | 0–2 S3/S3-compatible, eksekusi mutasi server Linux, copy serialized | Verifikasi per-replica result dan kapasitas |
| Restore file dari managed S3 mirror | Belum didukung | Pertahankan akses Primary Storage |
| Native database recovery dari mirror | Belum didukung | Gunakan primer dan metadata database yang valid |
| Physical cleanup/prune managed replica | Belum diimplementasikan; detach/retain saja | Siapkan kebijakan retensi vendor/operator terpisah tanpa blind deletion |
| Hitachi HCP nyata | Interoperabilitas vendor belum dibuktikan oleh implementasi umum S3 | Uji namespace/prefix disposable setelah persetujuan terpisah |
| Legacy Repository | Read-only, repository lokal dalam scope adapter saat ini | Tidak ada init, forget, prune, atau unlock |
| Managed dan Legacy file Restore | Staging terpisah | Verifikasi dan pindahkan hasil melalui perubahan aplikasi yang disetujui |
| Recovery Testing | Structural/file/SQL checks dan optional native import sesuai mode | Import Disabled tetap NOT TESTED |
| Persistent Restore | Resource retained sementara, TTL dan authorized Delete | Bukan penggantian database produksi secara otomatis |

## Kapasitas MySQL Internal

Guard memory available 2.944 MiB, SQL 128 MiB, CPU/disk, TLS, serta host-operator policy tetap berlaku. Host 4 GiB dapat menjalankan aplikasi tetapi belum tentu lolos admission recovery nyata. Aktivasi fitur dan kecukupan kapasitas adalah dua penilaian terpisah.

## Agent dan platform

Jalur installer Agent berfokus pada Linux Debian-family x86_64/systemd. Jangan menganggap Windows, macOS, atau arm64 mempunyai validasi operasional yang setara. Source dan policy membatasi path, tool, hook, serta transport yang boleh digunakan.

## Statistik dan konsistensi

Ukuran logical snapshot bukan pemakaian disk fisik. Restic summary tidak menyediakan seluruh metrik file terhapus atau kapasitas repository. Snapshot file+SQL tidak otomatis menjamin transaksi konsisten lintas aplikasi dan banyak database; operator tetap menentukan strategi konsistensi.

## Operasional

Tidak ada automatic production SQL cutover, PITR, database cluster failover, atau shared-volume multi-server scheduling yang ditambahkan oleh panduan ini. Penerima webhook/SMTP dan endpoint S3 nyata perlu acceptance lingkungannya sendiri.

Lihat [replica](/docs/replication/retention-restore), [database resources](/docs/database-restores/resources), dan [cutover](/docs/migration/cutover).
