# About dan Open Source Acknowledgements

GoRecover adalah fork independen dari proyek open-source Pluton (`plutonhq/pluton`) yang dirilis dengan Apache License, Version 2.0. Fork ini memakai nama dan logo sendiri pada antarmuka, sedangkan attribution upstream tetap dipertahankan. GoRecover tidak berafiliasi dengan proyek Pluton dan tidak mengklaim layanan resmi maupun endorsement upstream.

## Fork independen

Panduan operasional ini ditulis untuk perilaku public source yang tersedia. Riwayat authorship, copyright, dan license notices existing tetap menjadi bagian distribusi; pengembangan fork tidak mengalihkan kepemilikan karya upstream.

## Lisensi

File `LICENSE` repository memuat Apache License, Version 2.0. Pertahankan attribution, copyright, license, dan NOTICE yang berlaku ketika mendistribusikan source atau artefak. Panduan ini tidak menggantikan teks lisensi yang disertakan bersama source.

Nama package/import yang memakai namespace upstream dipertahankan untuk kompatibilitas, bukan sebagai klaim integrasi komersial. Hal yang sama berlaku untuk identifier teknis bernama `pluton`, misalnya service dan user `pluton-agent`, path `/etc/pluton-agent`, tag Restic, header webhook `X-Pluton-*`, dan key penyimpanan browser: semuanya tetap agar instalasi, backup, dan Agent yang sudah berjalan tetap kompatibel.

## Komponen open-source

GoRecover dibangun di atas source Pluton dan memakai komponen seperti Restic, Rclone, Node.js, React, SQLite/better-sqlite3, Express, Drizzle, marked, dan Nodemailer. Dokumentasi memakai Fumadocs serta dependency open-source dengan license notices yang dibundel pada hasil build.

Tidak ada dependency baru yang dipasang oleh penulisan ulang panduan ini. Runtime docs tetap terpisah dari runtime React aplikasi.

## Batas proprietary

Fork dan panduan tidak memakai, menyalin, mereproduksi, atau bergantung pada source/binary proprietary Pluton PRO/Business. Ekstensi dikembangkan dari public code serta interface publik Restic/Rclone. Referensi upstream historis bukan tombol aktivasi produk berbayar.

Lihat [cakupan fitur](/docs/reference), [identitas build](/docs/reference/version), dan [cara memelihara dokumentasi](/docs/reference/contributing).
