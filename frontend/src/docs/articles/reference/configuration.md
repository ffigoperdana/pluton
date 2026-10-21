# Referensi konfigurasi operator

Halaman ini membantu operator mencocokkan konfigurasi dengan komponen yang membacanya. Mengisi environment bukan pengganti konfigurasi UI, pemasangan host operator, atau pengukuran kapasitas.

## Backend environment

| Variable | Fungsi dan kehati-hatian |
| --- | --- |
| `SERVER_PORT` | Port aplikasi; default 5173 |
| `APP_URL`, `APP_ALLOWED_ORIGINS` | Origin browser utama dan tambahan yang disetujui; jangan memuat credential |
| `APP_TITLE` | Judul aplikasi |
| `AGENT_SERVER_URL` | URL yang dipublikasikan untuk akses Agent |
| `AGENT_INSTALL_REPOSITORY_URL`, `AGENT_INSTALL_COMMIT`, `AGENT_INSTALL_VERSION` | Distribusi instalasi baru: Git HTTPS tanpa credential, full reviewed SHA lowercase 40 karakter, versi 0.7.0; kosong/invalid menolak token baru tanpa mengubah Agent existing |
| `AGENT_INSTALL_CA_FILE` | Opsional: path PEM CA yang disetujui pada host Agent; tidak diunggah dari server dan tidak menonaktifkan TLS |
| `ENCRYPTION_KEY`, `SECRET` | Material key yang harus cocok dengan state existing; jangan diganti saat upgrade |
| `USER_NAME`, `USER_PASSWORD` | Bootstrap administrator container melalui saluran privat |
| `APIKEY`, `SESSION_DURATION` | API key dengan batas izin dan masa session; default session 7 hari |
| `MAX_CONCURRENT_BACKUPS` | Batas pekerjaan server, default 2 |
| `PLUTON_DATA_DIR` | Direktori data persisten; `/data` pada container standar |
| `TRUST_PROXY` | Batas kepercayaan proxy yang eksplisit |
| `AGENT_OFFLINE_TIMEOUT_SECONDS` | Batas heartbeat stale; default 90 detik |
| `ALLOW_CUSTOM_RESTORE_PATH`, `ALLOW_FILE_BROWSER`, `FILE_BROWSER_ROOT` | Fitur lokal sesuai policy; tidak mengizinkan bypass staging Managed Agent |
| `DISABLE_EVENT_SCRIPTS` | Pengaturan script lifecycle existing |
| `APP_VERSION`, `VCS_REF` | Metadata build; bukan bukti provenance image |
| `PLUTON_STORAGE_CA_FILE` | File CA storage milik operator yang divalidasi; bukan input path dari UI |

## Agent config

Agent mengenali URL server, data directory, allowed roots, lokasi binary, serta konfigurasi CA/client certificate/key dan hooks yang disetujui. Nama konfigurasi antara lain `PLUTON_SERVER_URL`, `PLUTON_AGENT_DATA_DIR`, `PLUTON_AGENT_ALLOWED_ROOTS`, dan `PLUTON_AGENT_BIN_DIR`.

Jangan mengirim arbitrary path atau database executable melalui request remote untuk mengganti konfigurasi administrator. Exception HTTP Agent yang eksplisit memerlukan persetujuan dua sisi, bukan solusi default untuk TLS.

## Compose

`PLUTON_IMAGE`, `PLUTON_IMAGE_REF`, `PLUTON_VERSION`, `PLUTON_VOLUME_NAME`, dan `PLUTON_PORT` digunakan alat deployment. Template hanya meneruskan subset environment yang ditentukan. Verifikasi file overlay yang cocok dengan source rilis sebelum mengaktifkan fitur tambahan.

MySQL Internal memerlukan worker, policy, image database, host operator, dan admission tersendiri. Flag enabled tidak membuktikan semuanya siap. Lihat [resource database](/docs/database-restores/resources).

## Notifikasi dan kredensial

Channels Webhooks & Email dikonfigurasi melalui UI/API administrator yang melindungi secret. Jangan mengarang environment `SMTP_PASSWORD` atau `WEBHOOK_SECRET` untuk menggantikan kontrak tersebut. Konfigurasi Integrations historis dan channels delivery baru harus dibedakan sesuai [panduan notifikasi](/docs/notifications).

Lanjutkan ke [Compose](/docs/deployment/configuration), [Agent](/docs/remote-agent/enrollment), dan [TLS](/docs/security/https).
