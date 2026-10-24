# MCP: token, izin, approval, dan koneksi assistant

MCP menghubungkan assistant ke tool Pluton yang dipilih administrator. Native API Token dapat dipakai tanpa identity provider eksternal. OAuth tetap tersedia sebagai mode terpisah untuk client yang memerlukannya. Token Pluton bukan API key penyedia model dan tidak memberikan langganan AI.

## Siapkan server

Gunakan deployment staging dan resource disposable sebelum rollout. Jangan mencoba fitur ini pada repository production. Konfigurasi operator menggunakan environment yang sudah ada:

```dotenv
MCP_RESOURCE_URL=https://backup.example.internal/mcp
MCP_NATIVE_TOKENS_ENABLED=true
```

Default native token adalah false dan layanan MCP tetap disabled sampai administrator mengaktifkannya di halaman MCP. Endpoint harus HTTPS dengan path tepat `/mcp`, tanpa query, fragment, atau credential pada URL. Optional OAuth menggunakan pasangan MCP_OAUTH_ISSUER dan MCP_OAUTH_JWKS_URL yang lengkap. Perubahan deployment/restart dilakukan oleh operator, bukan oleh tool MCP.

## Buat token melalui UI

1. Login sebagai administrator dan buka **MCP**. Periksa endpoint lalu aktifkan layanan setelah konfigurasi aman.
2. Pada **API Tokens**, pilih **Create API token**. Isi nama dan purpose opsional.
3. Pilih **Read Only**, **Write Only**, atau **Read and Write**.
4. Pilih tool yang boleh digunakan dan resource plan, Agent, serta storage secara eksplisit. Daftar kosong tidak memberikan akses. Wildcard tidak didukung.
5. Untuk write remote, grant harus mencakup plan, Agent pemiliknya dan storage. Write lokal memerlukan plan dan storage.
6. Tentukan TTL 1–2160 jam; default 168 jam. Semua write operasional tetap memerlukan approval manusia.
7. Buat token, lalu salin sekali ke secret manager. Tutup dialog setelah tersimpan. Token lama tidak dapat dilihat lagi.

**Test connection** pada dialog token hanya melakukan MCP initialize tanpa cookie browser. Hasil sukses berarti autentikasi dan protokol bekerja dari browser tersebut. Hasil ini bukan bukti koneksi Claude/Codex atau kesiapan backup/Agent/storage. Jangan memasukkan token pada URL, Git, screenshot, chat publik, atau shell history. Clipboard yang berisi token harus dijaga operator.

## Pilih hak akses

| Mode | Kemampuan |
| --- | --- |
| Read Only | Membaca proyeksi data tersimpan sesuai tool/resource yang diberikan |
| Write Only | Mengajukan action dan membaca status action milik token itu sendiri; tidak dapat membaca data operasional lain |
| Read and Write | Gabungan keduanya, tetap dibatasi tool/resource dan approval |

Read tools mencakup plan, Agent, Source Access, backup, storage, replication, serta recovery test. Daftar backup dengan snapshot receipt membantu memilih kandidat recovery; bukan inventory repository live. Status storage tidak melakukan probe jaringan. Nama, file, password dan error mentah tidak diberikan ke assistant.

Write tools dapat meminta backup sekarang, pause/resume schedule, cancel backup, membuat plan dari template remote yang sudah diizinkan, mengubah judul, schedule/timezone, exclusions, dan recovery test. Create plan tidak menerima arbitrary source/destination; lokasi baru dibuat server dari template dan tidak langsung menjalankan backup. Template dengan database lifecycle, replication aktif atau hook aktif harus dikelola melalui UI biasa.

Perubahan exclusions memakai pola relatif yang dibatasi dan dapat menyebabkan data tidak ikut backup. Periksa setiap pola. Tidak ada tool untuk mengubah delegated roots, menjalankan shell/SQL, membaca file bebas, prune/forget/unlock, menghapus storage, revoke Agent, memutar credential storage, atau restore ke production.

## Approval manusia

1. Assistant mengirim exact action dengan planId dan idempotencyKey yang stabil untuk satu intent.
2. Server memvalidasi izin/state lalu mengembalikan action ID dengan status **pending_approval**. Belum ada operasi backup yang berjalan.
3. Buka **Approvals and action history**. Periksa token, plan, parameter persis, hash, before/after dan peringatan.
4. Pilih **Approve this exact action** atau **Reject action** dari sesi administrator.
5. Server mengecek ulang token, resource, conflict dan expiry. Perubahan izin/resource memerlukan request baru.
6. Assistant dapat memantau action miliknya melalui pluton_get_action_status. Backup/recovery yang terkait menyediakan status terbatas; history domain tetap menjadi bukti penyelesaian.

Approval berlaku maksimal 15 menit atau sampai token expired. Client tidak dapat menyetujui dirinya dengan approved:true. Semua action write berisiko operasional dan selalu memerlukan approval. Maksimum satu action pending/executing/uncertain per plan, sepuluh per token dan seratus global.

Retry dengan key yang sama tidak mengeksekusi ulang. Status **dispatched** berarti domain service menerima operasi, bukan backup selesai. Status **uncertain** berarti hasil harus diperiksa karena error/restart mungkin terjadi setelah side effect. Periksa history backup/recovery dan selesaikan pekerjaan yang masih aktif sebelum **Reconcile uncertain action**. Rekonsiliasi menutup request tanpa menjalankan ulang. Jangan membuat key baru hanya untuk melewati status uncertain.

## Hubungkan client

Instruksi berikut diverifikasi dari dokumentasi resmi pada 24 Oktober 2026. Akun provider nyata belum diuji. Ketersediaan UI, plan, kebijakan organisasi, egress dan TLS eksternal harus diuji di staging.

### Codex CLI atau IDE

Gunakan config yang menyimpan nama environment variable:

```toml
[mcp_servers.pluton]
url = "https://backup.example.internal/mcp"
bearer_token_env_var = "PLUTON_MCP_ACCESS_TOKEN"
```

Isi environment tersebut melalui secret manager sebelum menjalankan client. Jangan menulis nilai token pada config atau shell history. Lihat [panduan resmi Codex](https://learn.chatgpt.com/docs/extend/mcp).

### Claude custom remote connector

Buka Settings → Connectors → Add custom connector. Masukkan endpoint. Jika **Request headers** tersedia, tambahkan nama Authorization dengan nilai Bearer diikuti token native. Periksa kebijakan workspace dan akses jaringan provider. Lihat [panduan Anthropic](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

### ChatGPT dan OpenAI API

ChatGPT custom connector memakai flow autentikasi yang didukung plan/UI. Manual native bearer entry belum diverifikasi; jangan menganggap fitur tersebut tersedia. Gunakan external OAuth yang sebenarnya dan grant subject/client read di Pluton. Lihat [autentikasi OpenAI](https://developers.openai.com/plugins/build/auth).

OpenAI Responses API mendokumentasikan field authorization untuk remote MCP. Aplikasi client memasok token Pluton di memory pada setiap request; API key OpenAI adalah credential terpisah dan tidak disimpan di Pluton. Approval dari provider merupakan kontrol tambahan dan tidak menggantikan approval manusia di Pluton. Lihat [panduan remote MCP OpenAI](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).

## Proxy dan troubleshooting

Cloudflare/BunkerWeb harus meneruskan Authorization, Host, Accept, Content-Type, MCP-Protocol-Version dan body JSON dengan aman. Jangan cache machine/admin routes atau log header credential/response token. Gunakan TRUST_PROXY hanya untuk peer terakhir yang ditinjau. Jangan menonaktifkan WAF global atau memakai wildcard CORS; aturan challenge/method harus sempit untuk endpoint MCP.

Browser GET `/mcp` dengan HTML Accept membuka dashboard. Machine menggunakan POST Streamable HTTP; GET/DELETE machine menghasilkan405. Revisi protokol yang didukung adalah 2025-11-25, 2025-06-18, dan 2025-03-26 dengan SDK1.32.1. Legacy SSE dan revisi terbaru yang belum diimplementasikan tidak dijanjikan.

| Hasil | Periksa |
| --- | --- |
| 401 | Bearer header, native flag, expiry/revoke atau grant/profile OAuth |
| 403 | HTTPS/Host/Origin, cookie tidak boleh untuk machine, tool/resource grants, same-origin admin |
| 404 | Layanan/config belum aktif, detail tidak diberikan; discovery OAuth sengaja tidak ada pada native-only |
| 405 | Gunakan POST Streamable HTTP, bukan SSE lama |
| 406/415 | Accept application/json dan text/event-stream, Content-Type JSON |
| 400/JSON-RPC | Protokol/schema salah, field tambahan, batch atau body terlalu besar |
| 409 | Conflict, resource/token berubah, expired atau action sudah diputuskan |
| 429 | Batas IP/token/admin atau pending action; jangan mengganti retry key |
| HTML | WAF challenge, redirect atau routing fallback; bukan JSON sukses |

## Audit, insiden dan rollback

Audit mencatat principal/token reference, action/resource ID, outcome aman, waktu dan trace. Raw token, Authorization, credential storage/database dan error service mentah tidak disimpan di audit. Exact arguments hanya tersedia pada record action administrator. Izin/token/approval dan audit dipersist secara atomik sebelum dispatch.

Jika token bocor, revoke segera dan periksa action/audit/domain history. Reject request yang belum berjalan. Revoke tidak membatalkan pekerjaan yang sudah dispatched. Untuk insiden luas gunakan **Disable service** dan **Emergency revoke all native tokens**; OAuth grant harus direvoke terpisah. Rotate setelah sumber kebocoran diperbaiki. Agent identity dan schedule SYS MON tidak berubah.

Rollout memerlukan backup konfigurasi/data, validasi migration0021 pada copy disposable, build/test, TLS/proxy, account provider, dan job staging yang disetujui. Rollback dimulai dengan disable MCP, revoke token dan rekonsiliasi pekerjaan. Kembali ke image v1 yang ditinjau sambil mempertahankan tabel tambahan/history/journal. Jangan menghapus journal atau menimpa database baru dengan backup lama yang menghilangkan state Agent/backup. Downgrade schema fisik tidak otomatis.

Fitur siap untuk validasi staging terisolasi, belum production acceptance. Linux/Docker, provider account, proxy eksternal serta Agent/storage/recovery disposable masih memerlukan bukti deployment. Lihat [keamanan](/docs/security), [status API](/docs/reference/api), dan [rollback deployment](/docs/deployment/rollback).
