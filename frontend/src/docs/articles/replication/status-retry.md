# Membaca status replika dan melakukan retry

Periksa replica pada backup yang tepat, karena hasil primary dan hasil salinan tidak sama. **Complete** pada backup utama tetap dapat disertai **Redundancy incomplete**. Menyimpan konfigurasi, membuat antrean, atau menekan Retry belum membuktikan salinan selesai.

## Membuka rincian

1. Buka plan → **Backups**. Periksa tanggal/zona waktu dan backup yang ingin diverifikasi.
2. Klik badge mirrors, termasuk **Redundancy incomplete** bila muncul. Dialog berjudul **Mirrors for …**.
3. Catat tujuan serta status **Completed**, **Failed**, **In progress**, atau **Pending**. Ringkasan dapat menampilkan `1/2 mirrors complete` atau replication pending.
4. Pada Managed Agent, periksa **Source snapshot**, **Last replicated snapshot**, **Attempts**, **Verified**, dan **Decision** bila tersedia. Metadata historis yang tidak dicatat tidak boleh dilengkapi dengan tebakan.

Contoh fiktif: backup `app-01` sukses, mirror A Completed dan mirror B Failed. Nyatakan satu dari dua salinan selesai, bukan dua salinan sukses karena primary berhasil. Verifikasi snapshot dan waktu sebelum mengandalkan salinan yang lebih lama.

## Memahami status Managed Agent

| Kondisi | Makna dan tindakan |
| --- | --- |
| Pending | Menunggu antrean server; salinan diserialkan secara global. Periksa pekerjaan lain dan kemajuan, jangan menambah concurrency |
| In progress | Executor sedang menyalin/memeriksa. Tunggu hasil; jangan membuat replay atau mengubah storage/binding |
| Completed | Snapshot tujuan dan artefak yang diwajibkan diverifikasi. Ini belum membuktikan SQL import/aplikasi pulih |
| Failed / cancelled yang dapat diulang | Tinjau safe code dan penyebab, lalu retry eksplisit yang diizinkan backend |
| Uncertain | Tidak ada kepastian proses/initialization selesai. UI dapat menampilkannya sebagai Failed dengan **Decision** terkait; replay/perubahan sumber tetap ditolak |

Interupsi server dapat menjadikan running sebagai uncertain. Claim yang uncertain tidak otomatis dianggap kedaluwarsa dan aman; guard sengaja menahan operasi. Tidak ada prosedur operator UI pada panduan ini untuk melepas fence tersebut. Simpan state dan eskalasi pemeriksaan ownership/proses kepada administrator/maintainer dengan bukti privat; jangan edit SQLite, lease, init state, atau melakukan unlock.

## Retry yang aman

1. Pastikan pekerjaan backup serta tujuan yang dimaksud benar dan tindakan pengiriman ulang memang disetujui. Periksa juga apakah primary masih tersedia.
2. Baca **Decision**/safe error. Perbaiki jaringan, CA, credential, kapasitas, atau konfigurasi sesuai penyebab melalui jalur yang didukung.
3. Jika UI menampilkan **Retry**, klik sekali untuk mirror gagal yang sudah ditinjau. Pada Managed Agent, backend hanya menerima terminal failed/cancelled yang eligible; active/uncertain tetap ditolak. Admission yang belum membentuk job juga dapat ditolak bila binding belum sah.
4. **Replication retry queued!** berarti baru mengantre. Kembali periksa dialog hingga terminal dan cocokkan snapshot, attempts, serta verifikasi.
5. Jika 409 mengatakan **Only failed or cancelled replication can be retried.** atau **Uncertain or active replication cannot be replayed.**, pertahankan guard dan selesaikan kondisi tersebut melalui review; jangan mengulang klik atau mengubah request.

Rekonsiliasi pending/admission setelah restart berbeda dari retry failed/cancelled. Standard Restic mempunyai kebijakan retry plan sendiri; jangan menerapkannya sebagai janji retry otomatis untuk Managed Agent.

## Membaca kode keputusan

| Kode/kategori | Langkah berikutnya |
| --- | --- |
| `source-binding-changed`, `source-binding-mismatch`, `snapshot-id-incomplete` | Cocokkan plan/Agent/repository/snapshot; jangan mengganti identitas agar cocok |
| `artifact-binding-mismatch`, `artifact-checksum-mismatch` | Tinjau metadata/hasil artefak dan backup sumber, jangan abaikan verifikasi |
| `destination-not-empty`, `destination-unowned`, `destination-binding-changed` | Tinjau exact prefix dan ownership; pilih tujuan baru melalui rencana yang disetujui, jangan purge/adopt |
| `storage-tls-failed`, `storage-authentication-failed`, `storage-access-denied` | Betulkan CA/hostname atau policy/credential privat |
| `repository-locked`, `retention-denied` | Tinjau proses/kebijakan storage; tidak ada automatic unlock/prune/purge Managed Agent |
| `platform-not-supported` | Init/copy Managed Agent tidak didukung di Windows; gunakan deployment yang mendukung melalui proses terpisah |
| `execution-interrupted`, `execution-uncertain`, `initialization-uncertain`, `claim-lost` | Jangan replay atau melepas state manual; kepastian proses/ownership perlu ditinjau |

Tindakan detach/removal juga ditahan saat pending/running/uncertain. Setelah hasil sah, ikuti [detach dan retention](/docs/replication/retention-restore). Laporan publik hanya memuat contoh sintetis serta safe code; jangan menyertakan credential, raw process output, atau inventaris repository.
