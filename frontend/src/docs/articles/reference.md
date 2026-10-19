# Cakupan fitur dan cara membaca panduan

Gunakan halaman ini ketika menentukan apakah sebuah fitur sesuai kebutuhan Anda. Ketersediaan tombol, implementasi source, hasil pengujian, dan persetujuan penggunaan produksi merupakan hal yang berbeda.

## Membaca badge

| Penanda | Cara menggunakannya |
| --- | --- |
| Diimplementasikan | Jalur fitur ada pada source; tetap periksa prasyarat dan batasannya |
| Memerlukan setup operator | Host, worker, CA, account, atau policy perlu disiapkan terpisah |
| Validasi pilot terbatas | Bukti hanya mencakup scope pilot yang disebutkan |
| Belum divalidasi operasional | Jangan menyimpulkan vendor atau lingkungan Anda sudah diterima |
| Tidak didukung | Workflow tersebut tidak tersedia; jangan mencari jalan memintas guard |

## Pilih panduan sesuai tujuan

1. Belum pernah memakai Pluton: ikuti [backup pertama](/docs/getting-started/quick-start).
2. Menyiapkan server sumber: ikuti [Managed Agent](/docs/remote-agent).
3. Perlu mengambil file: mulai dari [Browse dan Restore](/docs/restore).
4. Perlu menguji database: baca [Recovery Testing](/docs/recovery-testing) atau [Persistent Restore](/docs/database-restores).
5. Menambah salinan: baca [Replication](/docs/replication), termasuk batas restore dari mirror.
6. Beralih dari sistem lama: gunakan [migrasi SYS MON](/docs/migration).

## Source of truth

Panduan ini mengikuti UI dan source public fork. Dokumen engineering dan laporan fase lama tetap menjadi bukti historis; roadmap bukan daftar fitur yang otomatis sudah selesai. Contoh memakai infrastruktur fiktif, bukan konfigurasi organisasi yang siap disalin ke produksi.

## Referensi lanjutan

Gunakan [configuration](/docs/reference/configuration), [API](/docs/reference/api), [kode error](/docs/reference/status-codes), [identitas build](/docs/reference/version), [batasan](/docs/reference/limitations), dan [FAQ](/docs/reference/faq) setelah memahami workflow utama. Attribution dan lisensi tersedia di [About](/docs/reference/acknowledgements).
