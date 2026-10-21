# Memakai HCP atau namespace S3 yang sudah ada

Mode **HCP / pre-existing namespace mode** memakai endpoint S3 API HTTPS dan bucket/namespace yang sudah disiapkan operator. Pluton tidak membuat bucket dalam mode ini. Untuk Managed Agent, mode tersebut wajib pada setiap storage S3-compatible atau endpoint non-AWS, termasuk layanan yang bukan bermerek HCP.

**Interoperabilitas dengan HCP nyata belum diuji.** Artikel ini menjelaskan kontrak konfigurasi dan langkah validasi yang harus dilakukan pada namespace uji yang disetujui. Fixture otomatis, storage berhasil disimpan, dan DNS berhasil tidak sama dengan bukti copy/restore pada appliance nyata.

## Siapkan sebelum menambahkan storage

Gunakan [storage HCP](/docs/storage/hcp) sebagai referensi tunggal untuk
Tenant/Namespace, S3 protocol, ACL, key, endpoint/path-style, region, TLS/CA,
quota dan retention. Artikel ini berfokus pada acceptance replika Pluton agar
prasyarat vendor tidak diduplikasi dengan instruksi yang berbeda.

Minta administrator menyiapkan HTTPS S3 API endpoint, existing namespace/bucket, credential dengan scope minimum yang diperlukan, prefix kosong dedicated, trust CA, serta kebijakan quota/retention/Object Lock. Jangan memakai URL konsol pengelolaan. Contoh fiktif: endpoint `https://objects.example.internal`, bucket `example-backups`, dan prefix `app-01/replica-a`.

Pastikan server Pluton dapat menjangkau endpoint dan mempercayai sertifikat. CA storage privat dikelola operator melalui `PLUTON_STORAGE_CA_FILE` sesuai [storage HCP](/docs/storage/hcp) dan [konfigurasi](/docs/reference/configuration). File CA harus memenuhi pemeriksaan keamanan server; jangan memasukkan arbitrary CA path/TLS flags melalui field storage atau menonaktifkan verifikasi sertifikat.

## Konfigurasi melalui UI

1. Buka formulir **Add New Remote Storage** melalui **Add Storage** atau **+ Add New Storage** pada picker.
2. Isi **Storage Name*** dengan nama sintetis yang jelas, pilih jenis S3-compatible pada **Storage Type***, lalu isi **Endpoint**, **Access Key ID**, **Secret Access Key**, dan **Bucket Name**. Credential asli hanya dimasukkan melalui UI privat.
3. Pada **Advanced Options**, aktifkan **HCP / pre-existing namespace mode**. Tinjau **Region** bila diwajibkan layanan. Jangan mencoba membuat namespace melalui Location Constraint atau ACL untuk mengatasi bucket yang belum ada.
4. Gunakan endpoint HTTPS murni tanpa credential, path, query, fragment, atau console port 8000. Masukkan bucket terpisah pada **Bucket Name**.
5. Simpan dengan **Add Storage**. Jika mode/format/credential/trust ditolak, perbaiki prasyarat. Mode protected yang sudah aktif tidak dapat dinonaktifkan melalui edit biasa.
6. Pada plan Managed Agent → **Edit → Enable Replication**, pilih storage ini dan isi subfolder dedicated. Bila bucket sudah ditampilkan picker, masukkan `app-01/replica-a`, bukan nama bucket berulang.
7. **Confirm** baris baru pada plan existing, lalu **Update Plan**. Gunakan satu backup uji baru yang diizinkan dan periksa **Mirrors for …** hingga hasil akhir.

Menonaktifkan protected mode bukan workaround untuk penolakan **Enable protected HCP / pre-existing namespace mode before using this managed replica.** Credential dari environment/profile/shared credential file dan download URL tidak menggantikan credential protected yang dipersyaratkan mode ini.

## Validasi pada tujuan uji

Isi bukti, tanpa mengarang hasil yang belum dilakukan:

| Pemeriksaan | Hasil nyata / waktu / penanggung jawab |
| --- | --- |
| Endpoint S3 API, hostname sertifikat, CA dari runtime server | … |
| Namespace existing, quota, grant, scope prefix yang disetujui | … |
| Prefix dedicated kosong dan tidak overlap plan/replika lain | … |
| Backup primary, source snapshot, hasil copy, destination snapshot | … |
| Ukuran/hash artefak sesuai dan warning yang tersisa | … |
| Penolakan yang relevan dan tindakan aman telah ditinjau | … |
| Retention/Object Lock/lifecycle storage serta rencana pemulihan | … |
| Batas cakupan yang belum diuji, termasuk HCP appliance nyata | … |

Untuk `storage-tls-failed`, periksa CA/hostname; untuk `storage-authentication-failed` atau `storage-access-denied`, tinjau credential/policy privat; untuk `repository-unavailable`, tinjau namespace/prefix dan akses. `retention-denied` perlu peninjauan kebijakan storage, bukan mematikan Object Lock atau mencoba purge. Error `destination-not-empty` atau `destination-unowned` harus tetap menahan adopsi target yang tidak jelas.

## Batas retention dan recovery

Tidak ada bucket provisioning, physical cleanup/prune replika Managed Agent, atau direct mirror file/native database restore pada rilis ini. Jangan menjanjikan Object Lock compatibility atau kapasitas dari konfigurasi saja. Simpan primary dan bukti pemulihan terpisah, lalu baca [status/retry](/docs/replication/status-retry) serta [retention/restore](/docs/replication/retention-restore). Jangan menjalankan copy, init, unlock, atau maintenance terhadap repository Legacy sebagai uji HCP.
