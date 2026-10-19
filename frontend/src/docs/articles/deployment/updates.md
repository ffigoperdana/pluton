# Memperbarui Pluton dengan aman

Pembaruan aplikasi perlu menjaga plan, repository, kredensial, identitas Agent, dan database hasil Restore yang masih ditahan. Perlakukan upgrade sebagai perubahan operasional yang mempunyai bukti sebelum dan sesudahnya.

## Sebelum perubahan

1. Catat versi dan commit source, digest image berjalan, bundle host, overlay, volume, dan journal migration.
2. Simpan configuration backup yang konsisten serta key yang diperlukan pada penyimpanan privat.
3. Periksa pekerjaan backup, replication, Recovery Testing, dan Persistent Restore. Hentikan dispatch baru dan tunggu operasi selesai atau batalkan melalui jalur normal yang didukung.
4. Pastikan image tujuan serta jalur rollback cocok dengan schema dan resource yang masih ada.
5. Jadwalkan perubahan dan minta persetujuan operator yang berwenang sebelum deployment.

## Periksa komponen yang berubah

| Komponen | Apa yang harus diverifikasi |
| --- | --- |
| Aplikasi | Digest, source commit, migration, dan hasil CI |
| Agent | Versi/source yang dipasang pada mesin sumber; identitas tetap |
| Host operator | Kode root yang direview dan kontrak instalasi lama |
| Worker MySQL | Digest dan policy/CA yang cocok dengan aplikasi dan target |
| Database Internal | Image database yang disetujui dan resource yang cukup |

Migration `0016` menambahkan sequence explicit Resume. Aplikasi dan root operator harus kompatibel; request legacy tanpa sequence tidak boleh dijadikan alasan untuk melonggarkan pemeriksaan. Migration `0018` menambahkan state replikasi Managed Agent. Menukar image lama tidak otomatis membatalkan migration tersebut.

## Prosedur operator

Gunakan bundle `deploy/` yang telah direview, dengan digest tujuan yang diverifikasi. Upgrade bundle host terpisah dari penarikan image. Alat deployment memeriksa kontrak overlay/mount, menyiapkan backup SQLite yang sesuai, membuat ulang aplikasi, lalu menilai health dan identitas.

Jangan menjalankan `init` pada instalasi yang sudah ada, membuat ulang volume, merotasi `SECRET`/`ENCRYPTION_KEY`, atau memaksa seal baru agar upgrade diterima.

## Verifikasi sesudah perubahan

- Login dan buka plan, riwayat, Storage, serta `/docs` yang sudah ada.
- Cocokkan metadata build dengan artefak yang disetujui.
- Periksa Agent Online dan status pekerjaan yang sudah berjalan sebelum maintenance.
- Lakukan smoke test sintetis yang disetujui untuk fitur yang berubah, termasuk cleanup.
- Verifikasi worker/operator dan admission secara terpisah bila memakai recovery database.

Tidak ada klaim production GO hanya karena UI dapat dibuka. Jika schema, key, mount, atau kepemilikan tidak cocok, hentikan perubahan dan ikuti [rollback](/docs/deployment/rollback).

Lihat [identifikasi build](/docs/reference/version), [persistence](/docs/deployment/persistence), dan [monitoring](/docs/operations/monitoring).
