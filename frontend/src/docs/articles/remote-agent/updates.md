# Memperbarui agent sambil mempertahankan identity

Pemasangan pertama baru mengikuti [enrollment standalone](/docs/remote-agent/enrollment) dengan root-level `install-agent.sh` pada repository Agent tersendiri yang dipin ke reviewed commit. Existing **monorepo** Agent
tetap memakai `installers/upgrade-agent.sh` dari checkout monorepo, **app-only**: bukan reinstall, re-enrollment,
update Restic/Rclone, migrasi server atau perubahan Source Access. Referensi teknis
authoritative adalah `docs/AGENT_UPGRADE.md` pada checkout yang direview.

Agent yang memang dipasang dari standalone memakai root-level `upgrade-agent.sh` dan prosedur dari repository standalone yang direview. Jangan menukar checkout/updater berdasarkan versi dashboard saja. Migrasi monorepo ke standalone memerlukan rencana serta persetujuan terpisah; konfigurasi distribusi server hanya berlaku untuk instalasi baru, tidak menulis provenance/identity/policy existing.

## Urutan pembaruan Source Access

1. Review source commit, hasil hosted Linux CI dan kompatibilitas server/Agent.
   Server dengan migration 0019 mendukung Source Access; exclusions memerlukan
   server v4/capability baru dan Agent 0.7.0. Deploy server kompatibel lebih dahulu.
2. Simpan control-plane backup konsisten, configuration/key dan rollback privat.
   Catat Agent ID, versi/client, effective roots/revision, serta transaksi aktif.
3. Pause plan terkait dan drain backup, copy/recovery serta request Source Access.
   Jangan run `/poll` atau `run --once` untuk membuktikan idle: itu dapat
   menjalankan command pending. Local upgrade fence bukan server queue inventory.
4. Jalankan preflight dari checkout instalasi standar yang ditinjau:

```sh
cd /srv/pluton
git pull --ff-only origin main
sudo bash installers/upgrade-agent.sh --check
sudo bash installers/upgrade-agent.sh
systemctl is-active pluton-agent
```

`/srv/pluton` adalah path checkout contoh. `--check` tidak build/download,
heartbeat, restart, membuat transaksi atau memperbarui Git index. Standard
Linux x86_64/systemd/cgroup v2 dan exact installer paths/provenance wajib.
Private Node/Corepack serta pinned pnpm/frozen lockfile dipakai tanpa global pnpm.
Minimal disk 2 GiB + dua ukuran app pada filesystem staging dan backup; jumlah
backup historis dan dependency build dapat memerlukan lebih banyak.

5. Periksa service serta **Remote Agent**: Agent ID tetap, ONLINE/Last seen baru,
   versi/client/capability authenticated, TLS/config, effective scope dan
   Database & Hooks tetap. Baru uji shadow cycle yang disetujui dan resume jadwal.

## Installer pada konfigurasi statis lama

Agent sebelum 0.6.1 belum mendukung local upgrade-hold. Upgrader menolak Agent
lama yang masih running. Operator harus membuktikan server/host drain, lalu stop
aman melalui prosedur yang disetujui sebelum update pertama. Jangan stop backup
aktif atau menganggap tidak ada child process sebagai bukti cukup.

Instalasi custom, provenance missing, unit drop-in/paths tidak cocok atau runtime
pin berbeda memerlukan review terpisah. Mengulang `install-agent.sh` bukan
workaround: installer dapat menulis unit/EnvironmentFile dan restart. Perubahan
identity/server origin atau `--re-enroll` adalah keputusan berbeda. Menambah
folder dilakukan melalui [Source Access](/docs/remote-agent/permissions), bukan
reinstall. Root delegation tetap host-authorized; update tidak memperluasnya.

## Cache dan pinning

Upgrader mempertahankan `/etc/pluton-agent.env`, unit, `/var/lib/pluton-agent`,
identity, TLS, roots/policy, DB/hooks config dan command receipts. Hanya aplikasi
diganti. Root-private versioned backups, lock, staging dan receipt mendukung
preservation/rollback; jangan menghapus evidence untuk mencoba ulang.

`.verified-install` merekam format=1, pin dan tree hash. Perhitungan tree serta
source fingerprint kini menetapkan `LC_ALL=C` **dalam subshell hash saja**:
LANG, LC_ALL dan LC_COLLATE administrator tidak mengubah canonical ordering.
Mode service/global locale tidak diubah dan existing C-locale provenance tetap
cocok. Hash konten, mode, ownership, symlink dan protected ancestor tetap diperiksa.

Jika masih mismatch, berhenti dan gunakan [diagnostik Agent](/docs/remote-agent/troubleshooting#integrity-dan-upgrade-preflight).
Tidak ada auto-rewrite metadata, force integrity bypass atau migrasi non-C record
secara diam-diam. Versi pada dashboard bukan pengganti provenance checkout/app.

## Rollback

Gagal upgrade dapat diikuti rollback sukses; itu tetap **upgrade gagal**.
Output aman menampilkan Failed stage, Error code, Rollback dan Previous Agent
preserved. BACKUP, ACTIVATE, PROVENANCE dan HEALTH_CHECK adalah tahap berbeda.
Jangan menyimpulkan sebab hanya dari timeout/kode umum; simpan receipt privat
dan gunakan prosedur troubleshooting yang sesuai.

Untuk rollback eksplisit yang memang disetujui, gunakan
`sudo bash installers/upgrade-agent.sh --rollback <exact-upgrade-id>` setelah
drain/preservation checks. Script menolak receipt/ownership/state yang tidak
cocok. Ia memulihkan app dan provenance yang tercatat, bukan state identity atau
command receipts lama. Verifikasi service, scope dan server compatibility lagi.

Downgrade ke Agent yang mengabaikan Source Access selection atau exclusions v4
tidak aman. Review/remove konfigurasi fitur baru hanya melalui perubahan yang
diotorisasi dan drain; jangan hapus policy/receipt/revision agar downgrade lolos.
Pertahankan rollback artifacts sampai kebijakan owner mengizinkan cleanup exact.

## Patch parent

Setelah update, periksa satu backup unchanged lalu satu perubahan contoh di
window terpisah yang disetujui. Identity/repository/paths dan receipt parent harus
tetap terikat; tidak perlu membuat ulang plan/storage. Periksa snapshot dan staged
restore, bukan hanya counter New Files. [Incremental](/docs/backup-plans/incremental)
menjelaskan deduplikasi versus parent hint. Tidak ada janji upgrade tidak pernah
gagal, dan dokumentasi tidak memberi izin production retry otomatis.
