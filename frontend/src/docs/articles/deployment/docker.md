# Image Docker dan artefak rilis

Gunakan image yang dapat ditelusuri ke source yang direview. Nama tag seperti `main` dapat berubah; digest menunjuk artefak tertentu dan diperlukan oleh alat deployment host.

## Build dari source

`Dockerfile.source` memakai lockfile repository dan membangun aplikasi beserta dokumentasi. `Dockerfile` adalah jalur berbeda yang menerima executable hasil pipeline. Jangan mencampur artefak dari kedua jalur tanpa memverifikasi inputnya.

Contoh berikut hanya untuk build yang disetujui di lingkungan disposable, bukan instruksi deployment produksi:

```sh
docker build -f Dockerfile.source -t pluton:reviewed .
```

Image runtime berjalan sebagai pengguna `pluton`. Compose standar menambahkan filesystem root read-only, tmpfs, penghapusan capabilities, dan volume `/data`.

## Sebelum menggunakan image

1. Catat source commit dan hasil CI yang berlaku untuk commit itu.
2. Ambil digest dari keluaran build/publikasi registry, lalu verifikasi bahwa manifest dan provenance menunjuk source yang sama.
3. Periksa platform image yang sesuai host. Label revision membantu penelusuran, tetapi label sendiri tidak membuktikan provenance.
4. Simpan digest image lama yang sehat dan bundle host yang kompatibel untuk rollback.
5. Jika MySQL dipakai, verifikasi app, worker, dan image database sebagai artefak terpisah. Tag yang sama tidak menjamin ketiganya cocok.

Contoh identitas yang harus dicatat adalah `ghcr.io/example-owner/pluton@sha256:<verified-digest>`. Placeholder bukan digest yang dapat dijalankan dan harus diganti melalui prosedur privat operator.

## Deployment release

Alat `deploy/install.sh` dan `deploy/deploy.sh` hanya menerima digest SHA-256 yang valid. Instalasi yang sudah ada juga memerlukan bundle host terbaru yang telah direview; menarik image tidak memperbarui script host.

Overlay yang disetujui harus terdaftar dalam kontrak deployment. Jalur tersebut mempertahankan mount dan hanya membuat ulang layanan aplikasi yang dimaksud. Jangan menambahkan perintah Compose ad-hoc yang mengabaikan overlay atau memulai ulang layanan lain.

## Verifikasi hasil

Operator membandingkan digest container berjalan, pengguna runtime, volume/mount, dan respons GET health dengan catatan persetujuan. UI yang tampil normal belum membuktikan worker database atau Agent sudah memakai versi yang benar.

Jika digest, platform, kontrak mount, atau identitas tidak cocok, hentikan perubahan dan tinjau penyebabnya. Jangan mengganti digest dengan tag mutable untuk melanjutkan.

Lihat [konfigurasi deployment](/docs/deployment/configuration), [pembaruan](/docs/deployment/updates), dan [rollback](/docs/deployment/rollback).
