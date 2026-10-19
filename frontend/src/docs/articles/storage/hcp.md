# Menghubungkan HCP dengan namespace yang sudah tersedia

Gunakan panduan ini bila administrator storage sudah menyediakan namespace/bucket HCP dan endpoint S3 API yang disetujui. Pluton mempunyai mode untuk memakai namespace yang sudah ada tanpa mencoba membuat bucket. Mode ini tetap memerlukan pengujian pada lingkungan Anda.

**Interoperabilitas dengan HCP nyata belum diuji.** Pengujian unit dan fixture membuktikan perilaku konfigurasi serta guard tertentu, bukan kompatibilitas semua versi HCP, kebijakan retensi, atau konfigurasi tenant.

## Sebelum mulai

Minta operator menyiapkan endpoint HTTPS API S3, nama bucket/namespace, region bila diperlukan, access key, dan secret key terbatas. Masukkan rahasia hanya melalui formulir privat. Endpoint console bukan endpoint API; jangan memakai port console `8000`, URL dengan kredensial, path tambahan, query, atau fragmen.

Contoh fiktif: endpoint `https://objects.example.internal`, bucket `example-backups`, dan prefix repository `app-01/replica`. Operator perlu memastikan DNS serta certificate cocok dan dipercaya Pluton. Private CA diatur oleh operator server, bukan melalui bypass TLS pada formulir.

## Mengisi konfigurasi

1. Buka **Storages → + New**.
2. Isi **Storage Name***, misalnya `HCP contoh`, dan pilih **S3 Compatible Storage** pada **Storage Type***.
3. Pada **Account Authentication**, isi **Endpoint**, **Access Key ID**, **Secret Access Key**, **Bucket Name**, dan **Region** sesuai informasi operator.
4. Buka **Advanced Options** dan aktifkan **HCP / pre-existing namespace mode**.
5. Jangan aktifkan **Environment Auth** atau mengandalkan file kredensial eksternal pada mode ini. Gunakan kredensial eksplisit yang dilindungi aplikasi.
6. Klik **Add Storage**. Pluton memeriksa akses namespace dengan listing; keberhasilan tahap ini tidak membuat bucket baru.
7. Pada plan yang sesuai, pilih storage tersebut dan prefix repository yang terpisah. Bila UI sudah menampilkan awalan bucket, isi hanya subfoldernya.

HCP dapat dipakai melalui konfigurasi S3 yang relevan untuk alur standar. Pada Managed Agent, HCP/S3 adalah replika opsional yang dikerjakan server; primer tetap SFTP. Ikuti [replikasi HCP](/docs/replication/hcp) untuk langkah dan batasnya. Agent tidak menerima kredensial HCP/S3.

## Memeriksa hasil

Untuk latihan, gunakan source dan prefix sekali pakai yang disetujui operator. Periksa storage tersimpan, akses listing berhasil, lalu uji pekerjaan yang memang akan digunakan. Untuk replika managed, pastikan snapshot primer terverifikasi dan status replica sesuai; restore langsung dari mirror managed dan physical prune belum didukung.

Catat hasil uji endpoint, penulisan/pembacaan repository, penyalinan, dan prosedur pemulihan yang benar-benar dilakukan. Jangan menyatakan HCP siap produksi hanya berdasarkan **Add Storage** atau status backup primer.

## Bila koneksi ditolak

| Kode diagnostik | Pemeriksaan pertama |
| --- | --- |
| `TLS_HOSTNAME_MISMATCH` | Alamat endpoint harus cocok dengan certificate |
| `TLS_TRUST_INVALID` | Periksa CA trust pada proses server |
| `S3_AUTHENTICATION_DENIED` | Tinjau key, signature/region, dan scope izin |
| `S3_NAMESPACE_UNAVAILABLE` | Pastikan namespace sudah ada dan akun boleh mengaksesnya |
| `S3_NETWORK_UNAVAILABLE` | Periksa DNS, rute, firewall, serta layanan endpoint |

Jangan mematikan verifikasi TLS atau membuat namespace baru untuk menghilangkan error. Jangan menerapkan object lifecycle/WORM secara acak ke blok Restic: kebijakan yang melarang operasi atau menghapus data dapat mengganggu backup dan pemulihan. Tinjau [keamanan storage](/docs/storage/security) dan [status/retry replika](/docs/replication/status-retry) bersama operator.
