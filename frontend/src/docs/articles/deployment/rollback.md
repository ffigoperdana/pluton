# Rollback tanpa kehilangan identitas dan data

Rollback bertujuan memulihkan layanan setelah perubahan gagal. Mengganti image tidak mengembalikan schema SQLite, kepemilikan resource, atau versi Agent secara otomatis. Siapkan rencana sebelum upgrade dilakukan.

## Sebelum perubahan

Catat digest sehat sebelumnya, journal migration, volume, key/config, kontrak overlay, dan status semua resource persisten. Tentukan siapa yang menyetujui rollback dan kondisi pemicunya, misalnya gagal health, mount berbeda, dekripsi gagal, atau worker/operator tidak kompatibel.

## Hentikan operasi baru lebih dahulu

1. Hentikan penerimaan pekerjaan yang terdampak melalui pengaturan dan prosedur normal.
2. Tunggu backup, copy replica, dan SQL import selesai; jangan memulai ulang import dengan hasil yang tidak pasti.
3. Tinjau database retained di **Database Restores**. **Stop** mempertahankan data dan resource; **Delete** adalah tindakan berizin yang berbeda.
4. Pertahankan operator baru sampai target dan pekerjaan lifecycle benar-benar ditangani. Jangan menurunkan controller saat masih memiliki resource yang memerlukan kontrak baru.
5. Verifikasi bahwa image rollback dapat membaca schema yang ada dan tidak akan menghilangkan otorisasi atau cleanup.

## Rollback container

Untuk instalasi yang memang memakai bundle `deploy/` dan mempunyai `.deploy-state` valid, `rollback.sh` memilih digest sebelumnya dan menggunakan kontrak overlay/mount yang sama. Script tidak memulihkan file SQLite lama secara otomatis.

Contoh berikut hanya dijalankan operator setelah kompatibilitas dan izin perubahan diperiksa:

```sh
cd /opt/pluton
sh rollback.sh
sh status.sh
```

Jangan menebak image lama, membuat volume kosong, atau menimpa SQLite dengan salinan sebelum migration. Counter Resume, lease, identitas, dan jurnal kepemilikan harus tetap konsisten.

## Rollback Agent

Gunakan artefak Agent yang direview dengan config, allowed roots, dan identitas mesin yang sama. Installer mempunyai mekanisme pemulihan untuk kegagalan instalasi, tetapi perubahan source Agent yang terencana tetap perlu diverifikasi terpisah dari image server.

## Verifikasi

Cocokkan image, mount, pengguna runtime, GET health, login, dekripsi konfigurasi, dan akses snapshot lama. Periksa pekerjaan yang belum selesai dan cleanup required sebelum membuka dispatch lagi.

Jika rollback otomatis berhasil setelah deployment gagal, perintah deployment tetap dapat berakhir nonzero. Catat kegagalan awal dan hasil pemulihannya; jangan mengubahnya menjadi bukti deployment sukses.

Lihat [pembaruan](/docs/deployment/updates), [persistence](/docs/deployment/persistence), dan [disaster recovery](/docs/operations/disaster-recovery).
