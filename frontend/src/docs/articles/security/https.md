# Memindahkan akses HTTP LAN menuju HTTPS

HTTPS melindungi sesi browser dan komunikasi Agent dari pengamatan jaringan. Siapkan nama domain, sertifikat, jalur proxy, serta trust CA sebelum mengubah origin. Contoh `https://pluton.example.internal` adalah alamat fiktif. Perubahan DNS, proxy, konfigurasi server, atau service Agent dilakukan administrator pada window yang disetujui; membaca panduan tidak menjalankannya.

## Keterbatasan pilot

HTTP LAN tidak melindungi cookie, enrollment, kredensial command, atau dashboard dari pengamat jaringan. HMAC memeriksa integritas tetapi tidak mengenkripsi transport. Pertahankan pengecualian pilot hanya pada LAN tersegmentasi yang disetujui dan jangan mengekspos port langsung ke Internet. Jangan menonaktifkan TLS verification untuk menyamakan lingkungan.

## Reverse proxy

1. Siapkan nama HTTPS dan sertifikat CA tepercaya dengan hostname yang cocok. Split DNS boleh mengarah ke alamat internal selama nama pada sertifikat tetap benar.
2. Pastikan proxy meneruskan API, cookie, header respons, serta route SPA termasuk `/docs/*` ke instance yang sama. Docs tidak memerlukan domain/server kedua.
3. Cocokkan `APP_URL` dengan origin browser. Tinjau `APP_ALLOWED_ORIGINS` jika ada origin tambahan yang memang disetujui dan `AGENT_SERVER_URL` bila Agent memakai URL berbeda.
4. Atur `TRUST_PROXY` hanya untuk proxy/hop/subnet yang benar-benar dipercaya serta dibatasi firewall. Jangan mempercayai forwarded headers dari sembarang client.
5. Ikuti [konfigurasi deployment](/docs/deployment/configuration) agar volume dan key existing tetap dipertahankan pada perubahan yang disetujui.

## Migrasi bertahap

Setelah konfigurasi siap, uji login melalui URL yang akan dipakai pengguna, refresh route docs bertingkat, akses history, serta operasi browse/download/staging yang diizinkan. Pada durable notification, perubahan memerlukan permintaan JSON dari origin yang sah; tes **Save channel** pada channel uji yang disetujui memeriksa jalur mutasi tersebut. Keberhasilan membuka halaman saja belum membuktikan semua metode API diproksikan.

Dari host Agent, periksa DNS dan CA menggunakan trust yang sama dengan service. Browser di laptop dapat percaya sertifikat yang belum dipercaya Agent. Perbarui server origin Agent melalui installer yang didukung sambil mempertahankan identity dan seluruh allowed roots; CA privat memakai `--ca-file` sesuai [panduan Agent](/docs/remote-agent/updates). Jangan memakai `--re-enroll` untuk perubahan URL atau mematikan verifikasi TLS.

Verifikasi **Remote Agent → Last seen**, status **ONLINE**, versi, serta satu pekerjaan baru yang diizinkan. Baru setelah seluruh jalur HTTPS terbukti, administrator dapat menutup allowance HTTP secara terencana. Catat hasil tiap host; satu Agent yang berhasil tidak mewakili semua source.

## Bila muncul error

Untuk sertifikat, periksa expiry, SAN/hostname, intermediate CA, dan trust runtime. Untuk 401/403 JSON, periksa sesi dan origin/proxy sesuai safe error. Untuk 405 berisi HTML, lihat metode/URL/content-type serta routing proxy; jangan mengganti DELETE/PUT menjadi POST atau mengakses backend langsung untuk melewati kebijakan. Simpan konfigurasi lama yang dapat dipulihkan dan gunakan [diagnostik](/docs/troubleshooting) serta [rollback](/docs/deployment/rollback) bila gate verifikasi belum lulus.
