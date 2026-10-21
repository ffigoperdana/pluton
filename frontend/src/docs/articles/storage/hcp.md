# Menghubungkan HCP dengan namespace yang sudah tersedia

Gunakan panduan ini bila administrator storage sudah menyediakan namespace/bucket HCP dan endpoint S3 API yang disetujui. Pluton mempunyai mode untuk memakai namespace yang sudah ada tanpa mencoba membuat bucket. Mode ini tetap memerlukan pengujian pada lingkungan Anda.

**Interoperabilitas dengan HCP nyata belum diuji.** Pengujian unit dan fixture membuktikan perilaku konfigurasi serta guard tertentu, bukan kompatibilitas semua versi HCP, kebijakan retensi, atau konfigurasi tenant.

## Sebelum mulai

### Tenant, Namespace dan protokol yang berbeda

HCP Tenant membatasi administrasi/akun/namespace. Pada API S3, Namespace disebut
bucket dan service endpoint berada dalam konteks tenant. Endpoint HCP REST
untuk objek, S3 API dan management console tidak dapat dipertukarkan hanya
karena berada pada appliance yang sama. Vendor mendokumentasikan pemisahan ini
pada [namespace access protocols](https://docs.hitachivantara.com/r/en-us/mk-95hcph001-20/administering-hcp/introduction-to-hitachi-content-platform/about-the-hitachi-content-platform/data-access-methods/namespace-access-protocols)
dan [URLs for access to HCP](https://docs.hitachivantara.com/r/en-us/mk-95hcph002-18/using-the-hitachi-api-for-amazon-s3/access-and-authentication/urls-for-access-to-hcp).

Operator HCP harus memastikan S3 protocol (**Hitachi API for Amazon S3**) enabled pada namespace
dan ACL sesuai. Pada HCP 9.7, S3 membutuhkan ACL enabled; dukungan multipart
tergantung cloud-optimized namespace, dan sebagian bucket-level operations juga
memerlukan tenant management API. Itu prasyarat vendor/version-specific, bukan
izin Pluton mengubah protokol/namespace. Koordinasikan perubahan dengan owner
infrastruktur berdasarkan [S3 considerations](https://docs.hitachivantara.com/r/en-us/mk-95hcph001-20/managing-a-tenant-and-its-namespaces/managing-namespaces/configuring-namespace-access-protocols/configuring-the-rest-s3-compatible-and-webdav-apis/considerations-for-the-s3-compatible-api).

Login console bukan pasangan S3 Access Key ID/Secret Access Key. Minta operator
menyediakan credential yang benar untuk API dan versi HCP tersebut dengan izin
terbatas pada namespace/prefix yang disetujui. Panduan ini tidak mengonversi
password console, menjanjikan format signature, atau meminta secret lewat chat.

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

### Endpoint, path-style dan trust

Tinjau **Force Path Style** pada Advanced Options bersama operator: path-style
mengirim bucket pada path API relatif endpoint, berbeda dari virtual-host style
yang menambahkan bucket/namespace ke hostname. Contoh tenant endpoint sintetis
`https://tenant.objects.example.internal` dan bucket `example-backups` tidak
berarti hostname namespace `example-backups.tenant.objects.example.internal`
otomatis tercakup sertifikat. Gunakan endpoint vendor yang disetujui, DNS yang
benar dan certificate SAN yang cocok. Jangan memasukkan path bucket ke field
Endpoint; bucket tetap pada field sendiri. Region/signature harus sesuai layanan;
tidak ada jaminan universal bahwa region kosong atau `us-east-1` valid.

CA privat dipasang operator server melalui kontrak `PLUTON_STORAGE_CA_FILE`,
bukan field arbitrary CA path. File harus dipercaya dan terbaca proses yang
benar; periksa [referensi config](/docs/reference/configuration). Menyimpan CA pada
host saja belum membuktikan container/worker menggunakannya.

Contoh read-only dari host yang memang berwenang mengakses endpoint:

```sh
curl --proto '=https' --tlsv1.2 --cacert /path/to/approved-ca.pem \
  --connect-timeout 5 --max-time 15 -I https://tenant.objects.example.internal
```

Ganti path/host contoh lewat terminal privat. Tidak ada key/header Authorization
pada perintah itu. HTTP 403 atau 405 dari request tanpa signature hanya membuktikan
respons endpoint tertentu; **bukan** keberhasilan/kegagalan autentikasi S3, listing,
copy atau recovery. HEAD juga dapat tidak didukung. Uji authenticated namespace
melalui **Add Storage** dan disposable plan yang disetujui, bukan curl dengan key
di argumen. Jangan menggunakan `-k`, `--insecure` atau alternate hostname untuk
menyembunyikan certificate mismatch.

Mode protected memaksa `no_check_bucket=true` serta explicit credentials, lalu
memeriksa namespace existing melalui listing. Itu mencegah bucket creation;
listing tetap dapat ditolak karena ACL/protocol/key/namespace/kuota.

## Memeriksa hasil

### Quota, retention dan failure domain

Tinjau quota namespace, usage fisik, object/request limits, multipart support dan
retention/immutability bersama operator. Restic memakai blok, indexes, snapshot
dan locks; kebijakan yang melarang operasi diperlukan atau menghapus blok hidup
dapat membuat pekerjaan/restore gagal. Pluton tidak menurunkan WORM/Object Lock
atau meminta privilege bypass retention. HCP DPL adalah perlindungan dalam storage
dan cluster replication adalah mekanisme antar-HCP; keduanya bukan receipt copy
Pluton ataupun uji restore aplikasi. Lihat [vendor replication](https://docs.hitachivantara.com/r/en-us/mk-95hcph002/latest/managing-a-tenant-and-its-namespaces/tenant-and-namespace-properties/replication?contentId=IwazrQb7XT0mDBfHcbCefQ)
dan konfigurasi service plan/version yang berlaku, bukan asumsi nama bucket.

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
