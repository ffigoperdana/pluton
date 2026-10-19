# Memelihara panduan Pluton

Panduan yang baik mengikuti tugas pengguna dan UI yang benar-benar tersedia. Perubahan source, tombol baru, atau batas operasional baru perlu diikuti pembaruan panduan yang relevan.

## Source dokumentasi

Artikel `/docs` berada pada `frontend/src/docs/articles/<slug>.md`. `frontend/src/docs/manifest.ts` menentukan judul, urutan, kategori, dan penanda dukungan. Build terpisah di `documentation/` mengompilasinya dengan Fumadocs; Markdown engineering dalam `docs/` tidak otomatis menjadi artikel portal.

1. Baca UI dan jalur backend yang relevan sebelum menulis.
2. Pertahankan URL artikel lama bila memungkinkan. Jika struktur berubah, periksa link dan anchor yang sudah dipakai.
3. Tulis satu H1 yang sesuai manifest, lalu awali dengan tujuan dan kapan fitur digunakan.
4. Tambahkan prasyarat, langkah berurutan, contoh fiktif, hasil yang diharapkan, verifikasi, error, dan tautan terkait.
5. Pisahkan keterbatasan implementasi, kebutuhan setup operator, dan bukti runtime. Jangan mengarang PASS, screenshot, atau kontrol UI.

## Links dan rendering

Gunakan `/docs/<slug>` untuk link internal dan anchor yang dihasilkan dari heading. Renderer memakai plain Markdown dengan HTML yang di-escape, pembatasan URL, serta indeks pencarian lokal. Tidak ada eksekusi MDX bebas atau runtime Mermaid; gunakan diagram teks yang dapat dibaca.

Code fence memiliki tombol salin. Gunakan placeholder untuk secret dan jelaskan scope/izin sebelum contoh perintah yang mengubah sistem.

## Screenshot

Screenshot nyata yang sudah disanitasi dapat disimpan sebagai aset lokal `frontend/public/docs-assets/` dan ditautkan melalui `/docs-assets/...`. Jangan memuat inventory asli, token, key, password, isi SQL, atau host/domain privat.

Jika screenshot aman belum tersedia, tulis TODO pada laporan review dan gunakan langkah teks yang akurat. Jangan membuat gambar rekaan yang tampak sebagai UI aplikasi yang sudah ada.

## Validasi dan build

Dari checkout yang telah memiliki dependency versi pinned:

```sh
pnpm test:docs
pnpm test:fumadocs
pnpm --filter @plutonhq/documentation typecheck
pnpm --filter @plutonhq/documentation build:docs
```

Checks memeriksa inventori, rute, link/anchor, source evidence, search, compiler/TOC, URL security, clipboard, serta isolasi runtime. Perluas pemeriksaan cakupan ketika menambah workflow; jangan menonaktifkan assertions agar artikel yang salah lolos.

Review diff dan file privat sebelum publikasi. Commit, push, merge, dan deploy tetap memerlukan izin terpisah. Lihat [keamanan](/docs/security) dan [batasan](/docs/reference/limitations).
