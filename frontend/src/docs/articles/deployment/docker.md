# Docker dan source-built image

## Build dari source

```sh
docker build -f Dockerfile.source -t pluton:reviewed .
```

Build memakai dependency lockfile dan menyalin frontend/docs ke backend public assets. Runtime menjalankan user `pluton`, bukan root, dengan Restic/Rclone pinned. Docker Compose menambahkan read-only root filesystem, tmpfs, dropped capabilities, dan persistent `/data`.

## Deployment release

`deploy/install.sh` menerima release tag atau SHA-256 digest dan optional absolute install directory. `deploy/deploy.sh` dan `deploy/rollback.sh` membaca `.env` lokal; contoh argumen berikut adalah placeholder yang harus diganti dengan digest terverifikasi:

```sh
sh deploy/install.sh 'sha256:<verified-image-digest>' /opt/pluton
```

Placeholder sengaja tidak executable tanpa penggantian. Set `PLUTON_IMAGE` ke registry milik fork, administrator credential, dan environment privat sebelum proses deployment. Script menolak mutable `main`/`latest`, menjaga existing `.env`, dan menunggu healthcheck.

## Jangan lakukan

Jangan mount Docker socket, repository production, atau `/` host untuk smoke test. Jangan menghapus persistent volume untuk mengatasi startup failure. Pembaruan yang melibatkan migration fase sebelumnya membutuhkan backup DB dan keys konsisten; automatic health rollback bukan jaminan down-migration.

Setelah startup, lakukan [smoke validation](/docs/deployment/updates#validasi-setelah-startup).
