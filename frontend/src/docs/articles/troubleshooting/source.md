# Source tidak terbaca atau symlink ditolak

Agent membaca source sebagai akun layanannya, bukan sebagai administrator yang membuka terminal. Direktori dapat terlihat sehat bagi root tetapi tidak dapat dibaca layanan. Mulai dari realpath, permission parent, dan mount sebelum mengubah allowed roots atau akun.

## Gejala

Contoh fiktif: `/srv/example-app` berada pada source yang disetujui, tetapi backup `app-01` gagal `source-parent-not-traversable`. Root dapat membaca directory; akun Agent tidak mendapat traverse pada parent. Kasus lain ialah unreadable descendant, mount hilang, atau symlink yang keluar dari canonical allowed root.

## Penyebab

| Kategori | Pemeriksaan |
| --- | --- |
| Parent not traversable | Execute/traverse setiap parent untuk akun layanan |
| Root not readable | Read + traverse directory source |
| Entry inaccessible | Permission/ACL descendant, termasuk file baru |
| Missing | Mount dan path aktual, bukan hanya konfigurasi |
| Symlink escape | Tujuan realpath berada di luar root yang disetujui |
| Unsupported type / policy violation | Jenis node dan kontrak source yang didukung |

Agent **ONLINE** dan **Allowed roots configured: Yes** hanya memeriksa konektivitas/konfigurasi, bukan seluruh subtree.

## Diagnostik aman

1. Buka plan → **Backups**, catat stage/code dan waktu; korelasikan dengan journal Agent secara privat.
2. Tinjau canonical source dan daftar allowed roots yang memang disetujui. Symlink `/var/www/example-app` dapat mengarah ke `/srv/example-app`; containment memakai hasil resolve.
3. Jalankan preflight read-only sebagai akun layanan mengikuti [permissions](/docs/remote-agent/permissions). Pada instalasi standar dengan path yang sesuai, contoh sintetisnya:

```sh
sudo -u pluton-agent /opt/pluton-agent/runtime/bin/node \
  /opt/pluton-agent/app/dist/index.js preflight \
  --source /srv/example-app --allowed-roots /srv/example-app --scan
```

Sesuaikan hanya dengan instalasi yang disetujui. Tanpa `--scan`, pemeriksaan root/parent lebih ringan; scan descendant bersifat eksplisit dan tidak perlu ditambahkan ke setiap heartbeat. Output lokal masih dapat berisi path internal, jadi sanitasi sebelum dibagikan.

## Resolusi

Administrator meninjau parent yang diblok serta ACL efektif. Berikan traverse minimum pada parent, read/traverse direktori source, dan read file yang diperlukan. Perhatikan ACL mask/default untuk file baru. Source tidak perlu writable, diubah owner-nya ke Agent, atau dibuka untuk semua pengguna.

Jika canonical destination symlink memang source yang dimaksud, tinjau allowed root yang sempit secara eksplisit melalui prosedur Agent. Jika mount hilang atau tipe node tidak didukung, perbaiki kondisi itu; menambah izin tidak menyelesaikan penyebab. Installer tidak otomatis chmod/chown/setfacl source.

Ulangi preflight dengan akun yang sama, lalu satu backup baru yang diizinkan. Verifikasi completion, snapshot, dan isi yang memang tercakup. Perubahan symlink di antara validation dan backup tetap diperiksa fail-closed.

## Jangan lakukan

Jangan mengizinkan seluruh `/home`, menjalankan daemon sebagai root, chmod 777, memberi broad-write group, atau mematikan symlink/containment guard. Jangan memperbaiki error permission dengan password baru. Gunakan [allowed roots](/docs/remote-agent/permissions), [batas isolasi](/docs/security/boundaries), dan [diagnostik Agent](/docs/remote-agent/troubleshooting) untuk langkah berikutnya.
