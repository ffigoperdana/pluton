# Memeriksa kapasitas sebelum pemulihan database

Pemulihan database membutuhkan RAM, CPU, disk, dan ruang sementara di luar kebutuhan backup biasa. Backup yang sukses belum membuktikan SQL dapat diimpor dalam kapasitas host yang tersedia. Periksa ukuran artefak dan pengukuran aktual sebelum mengonfirmasi pekerjaan.

Panduan ini tidak mengukur kapasitas workload nyata. Ketersediaan fitur atau deployment tidak membuktikan bahwa host 4 GiB mampu melakukan recovery data aplikasi Anda.

## Membaca pemeriksaan di antarmuka

1. Buka plan → **Backups** → menu backup **Complete** → **Restore Database**.
2. Pilih **Recorded database** dan **Destination**.
3. Pada **Resources and isolation**, baca ukuran SQL, estimasi ekspansi, SQL budget, dan pengukuran RAM/disk.
4. Untuk Internal, tinjau **Internal database resource warning**: engine, batas SQL, RAM host/operator, CPU, pressure/swap, storage, dan reservasi workload.
5. Gunakan **Refresh verification** setelah kondisi host berubah. Konfirmasi tetap tidak tersedia selama checking atau penolakan.

**Ready** dan **Warning** berarti pengukuran saat itu mengizinkan proses dilanjutkan dengan persetujuan eksplisit; backend serta host operator tetap memeriksa ulang. **Blocked**, **Checking**, atau **Capacity unknown** bukan izin menjalankan import.

## Batas admission Internal

| Pemeriksaan | Batas yang tetap berlaku |
| --- | --- |
| RAM efektif total | Minimal 3.800 MiB pada envelope yang diperiksa |
| RAM tersedia MariaDB/PostgreSQL | Minimal 2.560 MiB |
| RAM tersedia MySQL | Minimal 2.944 MiB, termasuk headroom worker |
| CPU Pluton / host operator | Minimal 1 CPU pada Pluton dan 2 CPU pada envelope operator yang diperiksa |
| Swap | Host/operator maksimal 128 MiB; penggunaan swap cgroup harus nol |
| Memory pressure | Maksimal 1% pada pengukuran yang diperiksa |
| Cgroup server | Batas RAM minimal 768 MiB dan pemakaian maksimal 85% batas |
| Staging bebas | Minimal ukuran SQL ditambah cadangan 2 GiB |
| Recovery storage host | Minimal 3 GiB bebas sebelum provisioning; pemeriksaan backend pada fase import/Resume mensyaratkan cadangan minimal 1 GiB |
| Estimasi ekspansi | Ukuran SQL × 4 + 256 MiB harus muat dalam quota target |

Pengukuran operator/cgroup penting: host fisik dapat terlihat longgar sementara envelope proses operator tidak cukup. MySQL Internal memerlukan pengamatan operator yang masih valid. Resource tidak diketahui membuat proses ditolak dengan aman.

Budget Internal awal adalah 128 MiB SQL. Kebijakan operator dapat mengatur engine lain dalam batas yang didukung, tetapi **MySQL Internal tetap dibatasi maksimal 128 MiB**. Jangan menurunkan threshold atau memindahkan pekerjaan ke Custom otomatis untuk melewati penolakan.

## Batas runtime dan storage

Database Internal dibatasi **2 GiB RAM, 1 CPU, 128 PIDs, dan 128 MiB temporary filesystem**. Storage persistent memakai filesystem ext4 terpisah dengan quota tetap 2 GiB serta ownership yang diverifikasi.

Worker Oracle MySQL terpisah dibatasi **384 MiB RAM, 0,5 CPU, 64 PIDs, dan 160 MiB temporary filesystem**. Itulah sebabnya kebutuhan RAM tersedia MySQL lebih tinggi.

Estimasi ekspansi bukan jaminan semua SQL muat: indeks, temporary files, dan perilaku engine dapat menambah kebutuhan. Batas dump backup, logical snapshot, dan ukuran repository terkompresi mempunyai arti berbeda.

## Kebutuhan operator dan keamanan

Internal memerlukan host Linux dan profile/operator yang disetujui. Approval serta kode/berkas terkait harus memenuhi ownership root dan pembatasan penulisan. Aplikasi dan worker tetap berjalan non-root dengan kewenangan terbatas; wizard bukan sarana memasang profile atau memberikan akses Docker.

MySQL memerlukan worker Oracle asli dan target MySQL 8.4 yang disetujui; MariaDB alias tidak menggantikannya. TLS identity, CA, marker tujuan, grant minimum, database kosong, snapshot, SQL hash, serta ownership tetap diperiksa.

Custom membutuhkan target dedicated dan quota yang disediakan serta diverifikasi operator secara independen. Mengisi angka quota pada approval tidak menciptakan pembatasan storage eksternal.

## Jika diblokir

Tunggu workload lain selesai, periksa ukuran SQL dan ruang disk, lalu minta operator meninjau batas host/cgroup yang ditunjukkan. Jangan menaikkan SQL budget atau batas resource tanpa persetujuan dan pengukuran yang relevan.

Checkbox resource adalah acknowledgement, bukan override. Alarm resource juga tidak memberi izin menghapus database retained yang sudah tervalidasi atau mengendalikan workload lain.

Setelah masalah diperbaiki, lakukan **Refresh verification** dan baca hasil baru. Untuk test sementara, prinsip yang sama berlaku pada [Recovery Test](/docs/recovery-testing/import). Lanjutkan ke [troubleshooting](/docs/database-restores/troubleshooting) jika penolakan tetap muncul.
