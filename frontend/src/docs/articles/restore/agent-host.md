# Memulihkan langsung ke host Agent

Untuk backup Managed Agent, Pluton dapat meminta Agent yang membuat backup itu menjalankan `restic restore` **di host-nya sendiri**. Agent membaca repository plan (SFTP atau S3) secara langsung dan menulis ke folder baru di host tersebut. Data yang dipulihkan tidak pernah melewati server Pluton atau browser, sehingga filestore ratusan GB atau dump PostgreSQL berukuran beberapa GB tetap dapat dipulihkan walaupun server Pluton kecil. Contoh host app-01 dan folder /srv/pluton-restore pada halaman ini fiktif.

## Syarat

- Agent **0.9.0** atau lebih baru di Linux, berjalan sebagai akun `pluton-agent` dengan Restic dan Rclone privat milik root. Server Pluton harus diperbarui lebih dulu, baru kemudian Agent (lihat [memperbarui agent](/docs/remote-agent/updates)).
- Administrator host (pemegang sudo) menyetujui satu **restore root**: folder kosong milik `pluton-agent` dengan mode `0700`, di luar setiap source backup, state Agent dan direktori sistem:

```sh
sudo install -d -o pluton-agent -g pluton-agent -m 0700 /srv/pluton-restore
sudo /opt/pluton-agent/runtime/bin/node /opt/pluton-agent/app/dist/index.js \
  restore-roots approve --config-file /etc/pluton-agent.env \
  --agent-id <agent id> --root /srv/pluton-restore
```

Tidak perlu restart service maupun drop-in systemd. Pluton hanya menawarkan root yang dilaporkan Agent sebagai **writable** pada heartbeat terakhir.

## Langkah di wizard Restore

1. Buka plan → **Backups** → menu backup yang **Complete** → **Restore**.
2. Pada **Restore destination**, pilih **Agent host app-01 (restore directly on the host)**.
3. Pilih **Host-approved restore folder** dan periksa **New folder name** (huruf, angka, titik, garis bawah atau tanda hubung; tidak boleh berakhiran `.partial`).
4. Klik **Next: Select Files to Restore**. Tanpa pilihan berarti seluruh snapshot. Pilih item yang ingin dipulihkan saja; kombinasi memilih folder lalu membatalkan sebagian isinya tidak didukung untuk restore ke host.
5. Klik **Next: Review Restore on Agent Host**, periksa ringkasan, lalu klik **Restore on app-01**.

Untuk dump database, buka **Snapshot Details**, pada bagian **Database backup artifacts** klik **Restore this dump on the Agent host**. Hasilnya diverifikasi terhadap ukuran dan SHA-256 yang tercatat pada backup.

## Apa yang dilakukan Agent

Agent memeriksa ulang kebijakan restore root, menolak folder yang sudah ada, mencocokkan snapshot ID serta tag plan dan backup, memeriksa ruang disk dan inode, lalu memulihkan ke `<nama>.partial` dengan `--overwrite never --verify`. Folder baru diganti nama menjadi `<nama>` **hanya** setelah verifikasi berhasil. Tidak ada overwrite, merge, atau penghapusan. Kemajuan, pembatalan (paling lama sekitar 10 detik) dan lease sama seperti backup; ikuti statusnya di tab **Restores** plan.

Jika gagal atau dibatalkan setelah Restic mulai menulis, `<nama>.partial` tetap ada untuk ditinjau. Hapus folder itu sebelum memakai nama yang sama lagi.

## Setelah selesai: kepemilikan dan pemindahan

Semua berkas hasil restore dimiliki `pluton-agent:pluton-agent`, karena Agent berjalan tanpa hak root. Pluton tidak pernah memindahkan, mengubah owner, atau menghapus hasil restore. Administrator host melanjutkan, misalnya:

```sh
sudo rsync -aH --chown=odoo:odoo /srv/pluton-restore/<nama>/srv/example-app/filestore/ /srv/example-app/filestore/
sudo -u postgres createdb odoo_restore
sudo cat /srv/pluton-restore/<nama>/pluton/database/odoo.sql | sudo -u postgres psql --dbname=odoo_restore
sudo rm -rf --one-file-system /srv/pluton-restore/<nama>
```

Muat dump ke database baru terlebih dahulu dan periksa sebelum mengganti database aplikasi. Rincian desain, kode kegagalan dan batasan pengujian ada di `docs/AGENT_HOST_RESTORE.md` repository server dan `docs/HOST_RESTORE.md` repository Agent.
