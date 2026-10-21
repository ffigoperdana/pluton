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

### Excluded versus included

Pada Agent 0.7.0, exclusions nonempty memerlukan capability v1 dan payload v4.
Pola valid diterapkan sebelum scanner membuka child dan dikompilasi ke Restic
anchored canonical source. Jika direktori excluded masih memicu permission
failure, cek versi/capability authenticated, setting yang tersimpan, case,
`.cache` versus `cache`, anchoring dan request yang diantrekan sebelum edit.
Pola `*/cache` tidak mencakup root `cache`; gunakan nama bare atau `**/cache`
bila memang diotorisasi. Source root/parent tidak dapat dikecualikan dari guard.

Ulangi local preflight dengan `--scan --exclude .git --exclude node_modules`
hanya jika itu cakupan yang benar, lalu satu backup baru setelah setting tersimpan.
Pola invalid menghasilkan penolakan 400; old Agent dengan pola nonempty ditolak
409. Jangan mencoba negation, absolute glob atau wildcard yang diperluas shell.
CLI flags tidak menyimpan plan; periksa field **Backup Exclusions** sendiri.

Included unreadable file tetap gagal `source-entry-inaccessible`; jangan
menambahkan exclusion hanya untuk menutupi file penting. Pemilik aplikasi harus
menerima kehilangan coverage atau administrator memperbaiki izin minimum yang
sesuai. Hasil scan partial karena entry/deadline tidak membuktikan seluruh tree;
backup Restic nonzero tetap kegagalan. Eskalasi ke pemilik source/maintainer jika
native snapshot tidak sesuai kontrak [exclusions](/docs/backup-plans/managed-agent#backup-exclusions).

Administrator meninjau parent yang diblok serta ACL efektif. Berikan traverse minimum pada parent, read/traverse direktori source, dan read file yang diperlukan. Perhatikan ACL mask/default untuk file baru. Source tidak perlu writable, diubah owner-nya ke Agent, atau dibuka untuk semua pengguna.

Jika canonical destination symlink memang source yang dimaksud, tinjau allowed root yang sempit secara eksplisit melalui prosedur Agent. Jika mount hilang atau tipe node tidak didukung, perbaiki kondisi itu; menambah izin tidak menyelesaikan penyebab. Installer tidak otomatis chmod/chown/setfacl source.

Ulangi preflight dengan akun yang sama, lalu satu backup baru yang diizinkan. Verifikasi completion, snapshot, dan isi yang memang tercakup. Perubahan symlink di antara validation dan backup tetap diperiksa fail-closed.

## Jangan lakukan

Jangan mengizinkan seluruh `/home`, menjalankan daemon sebagai root, chmod 777, memberi broad-write group, atau mematikan symlink/containment guard. Jangan memperbaiki error permission dengan password baru. Gunakan [allowed roots](/docs/remote-agent/permissions), [batas isolasi](/docs/security/boundaries), dan [diagnostik Agent](/docs/remote-agent/troubleshooting) untuk langkah berikutnya.
