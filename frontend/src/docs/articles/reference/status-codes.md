# Mengenali status dan kode error

Catat tahap dan kode error ketika melaporkan gangguan. Pesan yang disanitasi membantu diagnosis tanpa membagikan SQL, password, isi respons receiver, atau inventory internal.

## Source dan repository

| Kode atau kondisi | Pemeriksaan aman |
| --- | --- |
| `source-parent-not-traversable` | Hak melintasi direktori induk oleh account Agent |
| `source-root-not-readable` | Izin membaca allowed source root |
| `source-entry-inaccessible` | File/direktori tertentu tidak dapat dibaca |
| `source-missing` | Path source sudah tidak ada atau berbeda |
| `source-symlink-escape` | Symlink keluar boundary yang diizinkan |
| `repository-target-not-empty` | Tujuan tidak aman untuk inisialisasi baru; jangan menghapusnya secara buta |
| Repository locked | Pastikan pemilik pekerjaan dan jenis repository; Legacy tidak boleh di-unlock otomatis |

## Database dump

`database-auth-failed`, `database-insufficient-privileges`, `database-unavailable`, `database-tls-verification-failed`, `database-dump-timeout`, dan `database-client-missing` memerlukan perbaikan yang berbeda. Login database yang berhasil belum membuktikan akun dapat mengekspor routine/event yang dipilih.

Contoh fiktif: error privilege pada plan latihan ditangani dengan pemeriksaan grant minimum, bukan akun root atau menonaktifkan TLS. Lihat [diagnosis database](/docs/troubleshooting/database).

## Dependency dan lifecycle

HTTP **409** pada penghapusan plan/snapshot dapat berarti masih ada retained Database Restore atau pekerjaan replikasi yang belum selesai. Buka **Database Restores** atau detail replica, selesaikan lifecycle yang berizin, lalu evaluasi kembali penghapusan. Jangan memodifikasi status di SQLite agar Delete lolos.

MySQL admission yang ditolak karena memory, slot, disk, atau operator belum siap harus tetap ditolak. **Cleanup Required** adalah keadaan yang perlu ditangani dan diverifikasi, bukan alasan menghapus resource yang belum terbukti milik aplikasi.

## Delivery

Riwayat delivery memakai hasilnya sendiri. Kode seperti `destination-denied`, `connection-failed`, `tls-failed`, `delivery-timeout`, `smtp-retryable`, `smtp-rejected`, dan `channel-changed` membantu menentukan apakah masalah ada pada policy, jaringan, TLS, atau penerima.

## Penggunaan

Kode dapat ditampilkan sebagai kategori aman atau pesan UI sesuai route; jangan menganggap seluruh kode internal merupakan field API publik yang stabil. Sertakan waktu, jenis operasi, dan ID tersanitasi dalam laporan privat operator.

Lihat [status pekerjaan](/docs/architecture/states), [recovery](/docs/troubleshooting/recovery), dan [notifikasi](/docs/notifications/history).
