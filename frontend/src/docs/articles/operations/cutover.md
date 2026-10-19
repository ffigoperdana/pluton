# Checklist cutover dari SYS MON

Halaman ini adalah pintu pemeriksaan operator sebelum menghentikan jalur backup lama. Alur rinci tersedia pada [migrasi](/docs/migration), [SHADOW](/docs/migration/shadow), dan [CUTOVER serta rollback](/docs/migration/cutover). Selama SHADOW, SYS MON tetap jalur yang berwenang; beberapa backup manual sukses belum cukup untuk berpindah.

## Gate sebelum cutover

Catat bukti nyata untuk workload yang mewakili file, database, jadwal, pertumbuhan, dan kondisi pemulihan. Checklist kosong atau pernyataan belum diuji berarti gate belum lulus.

- [ ] Pemilik aplikasi/DBA menentukan cakupan, target RPO/RTO, serta periode pengamatan.
- [ ] Jalur SYS MON, jadwal, lokasi backup, dan prosedur pemulihannya dicatat privat dan tetap dapat dipakai.
- [ ] Managed repository baru terpisah dari Legacy; tidak ada init/write ke repository lama.
- [ ] Beberapa siklus **terjadwal** representatif selesai dengan snapshot exact dan counters yang masuk akal.
- [ ] Semua source serta artefak SQL yang dikonfigurasi ditemukan pada snapshot yang sama; warning dijelaskan.
- [ ] Browse, download yang diperlukan, dan staging restore diverifikasi pada snapshot tersebut.
- [ ] Required import atau Database Restore terisolasi menguji SQL yang diwajibkan; hasil Disabled tetap **NOT TESTED**.
- [ ] Pemilik aplikasi menerima hasil pemeriksaan semantik, termasuk cakupan yang belum diuji.
- [ ] Replika yang diwajibkan selesai dan diverifikasi; primary SUCCESS terpisah dari replica.
- [ ] Kapasitas, cleanup, queue wait, dan resource guard dicatat pada workload representatif; 4 GiB belum klaim kapasitas.
- [ ] DNS/CA/Agent connectivity dan live Webhook/SMTP acceptance selesai bila menjadi kebutuhan operasi.
- [ ] Control plane, key/volume, image/revisi, serta akses recovery lama memiliki backup/rollback yang dapat dipakai.

## Approval

| Keputusan | Isian operator |
| --- | --- |
| Rencana/window dan penanggung jawab | … |
| Link bukti scheduled/dump/restore/recovery | … |
| Persetujuan pemilik aplikasi, DBA, infrastruktur, keamanan | … |
| Waktu CUTOVER dan perubahan yang disetujui | … |
| Kondisi rollback, pemilik keputusan, batas waktu | … |

Panduan dan pekerjaan dokumentasi ini tidak menghentikan cron, mengubah script produksi, merotasi key, menimpa source, atau menghapus database. Peralihan harus berupa keputusan **CUTOVER** eksplisit setelah gate ditinjau, bukan akibat diam-diam menonaktifkan SYS MON.

## Credential dan retention

Inventaris credential hardcoded lama secara privat dan rencanakan rotasi setelah seluruh consumer terverifikasi. Sepakati retensi repository lama dengan pemilik data; Legacy Adapter tidak menyediakan forget/prune/unlock/migrate/repair. Untuk Managed Agent, penghapusan plan/replika berupa detach dan retain; physical cleanup/prune serta direct mirror restore belum didukung. Baca [retention dan restore replika](/docs/replication/retention-restore) sebelum mengambil keputusan kapasitas.

## Sesudah cutover

Amati siklus berikutnya dengan checklist [operasi harian](/docs/operations). Cocokkan umur data, snapshot, SQL, replika, recovery, notifikasi, dan cleanup dengan target. Bila gate pascaperalihan gagal, hentikan perubahan lebih lanjut dan jalankan rollback yang disetujui; pertahankan bukti serta akses ke data lama. Jangan menutup insiden hanya karena dashboard ONLINE atau satu email sukses.
