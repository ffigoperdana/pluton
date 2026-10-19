# Compose dan konfigurasi privat

Konfigurasi menghubungkan image aplikasi dengan volume, origin web, dan fitur operator yang diizinkan. Gunakan template yang sesuai source rilis; konfigurasi contoh bukan konfigurasi siap produksi.

## File privat

Template utama repository adalah `.env.template`; bundle deployment juga mempunyai `deploy/.env.example` dan `deploy/compose.yml`. Nilai rahasia diisi hanya pada file privat host. Jangan mengunggah `.env`, hasil `compose config`, atau key file ke Git, screenshot, maupun tiket publik.

| Pengaturan | Yang perlu diperiksa |
| --- | --- |
| `PLUTON_IMAGE` dan `PLUTON_IMAGE_REF` | Registry yang disetujui dan referensi digest immutable |
| `PLUTON_VOLUME_NAME` | Nama volume lama yang harus tetap sama saat upgrade |
| `PLUTON_PORT` | Port host; port aplikasi di container standar adalah 5173 |
| `ENCRYPTION_KEY` | Key yang sama dengan instalasi dan backup existing |
| `USER_NAME`, `USER_PASSWORD` | Bootstrap container; gunakan saluran privat |
| `APP_URL`, `APP_ALLOWED_ORIGINS` | Origin browser yang benar dan origin tambahan yang disetujui |
| `AGENT_SERVER_URL` | URL yang dapat dijangkau Agent, bila berbeda dari origin browser |
| `TRUST_PROXY` | Hanya proxy/hop yang benar-benar dipercaya |

## Urutan pemeriksaan

1. Catat volume dan identitas instalasi yang sudah ada sebelum menyiapkan konfigurasi.
2. Cocokkan URL browser dengan origin HTTPS publik/internal yang disetujui. Contoh fiktif: `https://backup.example.internal`.
3. Periksa jalur Agent, DNS, serta kepercayaan CA dari host Agent dan server.
4. Gunakan overlay yang direview dan daftar `compose.overlays` yang disetujui bila instalasi memerlukannya.
5. Validasi kontrak sebelum perubahan dijalankan. Ketidaksesuaian mount/volume harus diperbaiki melalui review kontrak, bukan dengan menghapus seal.
6. Setelah perubahan yang disetujui, verifikasi login dan health melalui jalur yang dipakai pengguna.

## Parameter penting

`MAX_CONCURRENT_BACKUPS` membatasi pekerjaan server, bukan otorisasi menjalankan SQL tanpa batas. Template Compose hanya meneruskan environment yang ditentukan; menambah nilai di file privat tidak otomatis membuat semua service membacanya.

`SECRET` dan material kredensial persisten dikelola CredentialManager. Jangan mengganti key, mereset identitas, atau menyalin key milik instalasi lain saat upgrade.

## Trusted-LAN pilot

Ada exception HTTP Agent dua sisi yang eksplisit pada server dan Agent. Exception tersebut memerlukan persetujuan operator dan tidak cocok dijadikan solusi umum untuk error sertifikat. Utamakan HTTPS dan CA yang dipercaya.

Jika login gagal karena Origin/CSRF atau reverse proxy, periksa pemetaan URL dan header di [troubleshooting](/docs/troubleshooting). Jangan menonaktifkan autentikasi atau mengubah DELETE menjadi POST.

Lihat [referensi konfigurasi](/docs/reference/configuration) dan [TLS](/docs/security/https).
