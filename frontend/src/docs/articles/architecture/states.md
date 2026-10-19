# Membaca status backup, replica, dan recovery

Satu Backup Plan dapat memiliki backup primer yang berhasil, replica yang gagal, dan Recovery Test yang belum dijalankan. Baca setiap hasil secara terpisah agar tindakan berikutnya tepat.

## Backup

Buka **Backup Plans → pilih plan → Backups**. Cocokkan waktu, pekerjaan, dan detail error sebelum melakukan retry atau pembatalan.

| Status atau kondisi | Artinya bagi operator | Langkah berikutnya |
| --- | --- | --- |
| Queued / initializing | Pekerjaan menunggu atau sedang disiapkan | Periksa antrean dan kesiapan Agent/storage |
| Started / progress berjalan | Backup sedang membaca atau mengirim data | Pantau progress dan jangan mulai penghapusan |
| Retrying | Percobaan ulang sesuai kebijakan | Cari penyebab awal dan batas retry |
| Complete | Backup primer selesai | Verifikasi isi snapshot, lalu replica dan recovery |
| Failed / cancelled | Pekerjaan tidak selesai sebagai backup sukses | Baca tahap/kode error sebelum mencoba lagi |

Status internal dapat ditampilkan dengan kapitalisasi berbeda pada detail API dan UI. Progress 100% sendiri belum menggantikan hasil terminal.

## Replica

Periksa detail **Mirrors** pada backup yang sama. Hasil S3 tidak mengubah keberhasilan primer. Untuk Managed Agent, `uncertain` berarti server belum dapat membuktikan eksekusi sebelumnya sudah selesai; operator perlu meninjau, bukan menghapus antrean untuk memaksa copy baru.

Lihat [status dan retry replica](/docs/replication/status-retry). Retry replikasi tidak sama dengan menjalankan ulang backup sumber.

## Recovery

Recovery Testing mempunyai hasil `passed`, `passed_with_warning`, `failed`, atau `cancelled`. Baca bagian import database dan cleanup: pemeriksaan file/SQL yang lolos dengan import Disabled belum membuktikan database dapat dipakai aplikasi.

Persistent Restore mempunyai lifecycle tersendiri. **Stopped** menyimpan resource dan belum berarti slot Internal bebas; **Deleted** perlu disertai cleanup terverifikasi. TTL dapat mengakhiri masa retensi meskipun target tidak sedang aktif.

## Notification

Riwayat pengiriman terpisah dari backup dan recovery. `succeeded` berarti penerima HTTP atau SMTP menerima pengiriman menurut kontraknya; itu bukan bukti email sudah dibaca. Respons yang hilang dapat menimbulkan pengiriman ulang, sehingga receiver perlu mengenali event ID yang sama.

## Tindakan operator

Contoh fiktif: backup `app-01-harian` Complete, replica Failed, import NOT TESTED. Catat ketiga hasil tersebut, selesaikan akses S3, dan jadwalkan pengujian database terpisah. Jangan menyebutnya disaster recovery yang sudah teruji.

Jangan mengedit status, lease, atau identitas di SQLite. Gunakan tindakan yang tersedia dan ikuti [kode error](/docs/reference/status-codes), [hasil Recovery Testing](/docs/recovery-testing/results), serta [Database Restore Management](/docs/database-restores).
