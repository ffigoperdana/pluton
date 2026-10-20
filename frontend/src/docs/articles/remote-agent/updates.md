# Memperbarui agent sambil mempertahankan identity

Gunakan artifact dari revision fork yang telah ditinjau untuk memperbarui binary Agent. Pada Agent 0.6.0, perubahan pilihan folder memakai **Source Access** tanpa reinstall: Host-Approved mempertahankan persetujuan host lokal, sedangkan Server-Managed mengizinkan Validate dan Apply di dalam delegasi yang telah disahkan host satu kali. Pertahankan identity dan state agar mesin yang sama tetap terkait dengan plan yang ada. Contoh di halaman ini memakai source `/srv/example-app`.

Sebelum mulai, catat **Agent ID**, **Agent version**, versi Restic/Rclone, dan **Last seen** pada panel **Remote Agent**. Catat pula revision/build yang sedang terpasang secara privat. Hindari pembaruan ketika backup aktif; pilih jendela pemeliharaan setelah pekerjaan selesai.

## Urutan pembaruan Source Access

Pasang server yang mendukung migration additive 0019 terlebih dahulu. Server baru tetap menerima Agent lama dan konfigurasi statisnya. Agent 0.6.0 tidak boleh dipasang lebih dahulu pada server lama yang belum memahami kontraknya.

Pause jadwal terkait dan drain semua pekerjaan sebelum mengganti binary. Simpan backup root-private atas aplikasi, EnvironmentFile, unit, identity/state, dan host policy. Pertahankan seluruh konfigurasi CA/mTLS, Database & Hooks, SFTP serta roots lama. Bandingkan Agent ID, device, dan secret secara lokal tanpa mencetak secret. Setelah pembaruan, periksa ONLINE, versi/capability, root efektif, lalu validasi source sintetis yang disetujui sebelum workload nyata.

Jangan langsung mengulang installer pada existing host: installer menulis EnvironmentFile dan unit baru, hanya mempertahankan sebagian opsi existing secara eksplisit, serta melakukan restart. Operator perlu memakai prosedur penggantian artifact yang mempertahankan konfigurasi lengkap, sebagaimana runbook `docs/AGENT_SOURCE_ACCESS_UPGRADE.md` pada repository yang ditinjau.

## Installer pada konfigurasi statis lama

1. Periksa revision target dan kompatibilitas server/agent.
2. Tinjau seluruh allowed roots yang masih dibutuhkan plan. Instalasi ulang harus menyertakan kumpulan root yang memang ingin dipertahankan.
3. Jalankan installer dari checkout yang ditinjau dengan server origin yang sama dan konfigurasi CA yang sesuai.
4. Bila identity existing sehat, gunakan kembali identity itu; pembaruan biasa tidak memerlukan token baru.
5. Periksa service dan inventory sesudah pemasangan, lalu lakukan backup serta restore contoh.

```sh
sudo bash installers/install-agent.sh \
  --server https://pluton.example.internal \
  --allowed-root /srv/example-app
```

Opsi `--allowed-root` dapat diulang bila ada beberapa root yang disetujui. Jangan menghilangkan root yang masih dipakai plan atau memperluasnya ke seluruh filesystem untuk memudahkan konfigurasi.

Mengganti server origin atau memakai `--re-enroll` adalah keputusan identity terpisah. Jangan melakukannya hanya karena UI menunjukkan OFFLINE atau versi lama. Gunakan [diagnostik agent](/docs/remote-agent/troubleshooting) dahulu.

## Cache dan pinning

Installer dapat memakai kembali private Node, Restic, dan Rclone hanya bila manifest, checksum, versi, mode, serta ownership memenuhi pemeriksaan. Runtime privat tidak mengganti Node.js global host. Executable arbitrary dari PATH atau binary yang dapat ditulis service account bukan pengganti yang aman.

Jika validasi toolchain gagal, tinjau error dan paket yang dipakai. Jangan melewati checksum atau membuat direktori runtime dapat ditulis agent. Installer memeriksa eksekusi sebagai pengguna service untuk menghindari instalasi yang hanya bekerja sebagai root.

## Rollback

Drain kembali sebelum rollback. Agent lama mengabaikan pilihan Source Access yang lebih sempit; downgrade hanya aman bila akses efektif sama persis dengan roots statis lama dan tidak ada command policy yang pending. Jika berbeda, hentikan proses dan minta tinjauan konfigurasi host; jangan hapus policy state untuk memaksakan rollback. Identity dan receipt command terbaru harus dipertahankan, bukan ditimpa snapshot lama.

Installer mempunyai transaksi untuk menyimpan instalasi kerja sebelumnya dan memulihkannya bila validasi gagal. Setelah kegagalan, tetap periksa status service, inventory, dan konfigurasi root. Jangan berasumsi semua perubahan operasional di luar installer ikut dibatalkan.

Jangan menghapus `/var/lib/pluton-agent` sebagai cara rollback. Direktori itu menyimpan identity dan state pekerjaan. Gunakan revision sebelumnya melalui prosedur pembaruan yang ditinjau apabila rollback aplikasi diperlukan, dengan origin dan roots yang konsisten.

## Patch parent

Optimasi incremental dikerjakan pada agent. Memperbarui server saja tidak memasang patch eksekusi agent. Label **Agent version** dapat tetap sama pada build yang berbeda; catatan revision/build diperlukan untuk membuktikan patch mana yang terpasang.

Setelah pembaruan, jalankan dua backup disposable berurutan pada source yang sama tanpa perubahan, lalu ubah satu file dan ulangi. Periksa **New Files**, **Modified Files**, **Unmodified Files**, dan jumlah data baru sesuai [panduan incremental](/docs/backup-plans/incremental). Tidak perlu membuat ulang plan atau storage hanya untuk pengujian ini.

Hasil yang diharapkan adalah **Agent ID** tetap, heartbeat kembali **ONLINE**, backup mencapai **Complete**, dan file contoh dapat dipulihkan. Jika capability atau source berubah, tinjau [izin source](/docs/remote-agent/permissions) sebelum meneruskan workload penting.
