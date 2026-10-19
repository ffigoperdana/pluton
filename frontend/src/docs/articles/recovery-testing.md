# Menguji apakah backup dapat dipulihkan

Jalankan Recovery Test untuk memeriksa snapshot sebelum Anda membutuhkannya saat insiden. Hasilnya terpisah dari keberhasilan backup: **Complete** berarti pekerjaan backup selesai, sedangkan **Passed** menjelaskan pengujian pada satu snapshot tertentu. Pengujian tidak mengaktifkan aplikasi produksi.

## Tujuan

Recovery Test memulihkan isi snapshot managed remote ke workspace privat, memeriksa struktur berkas dan artefak SQL yang tercatat, lalu membersihkan data sementara. Jika mode native diwajibkan, setiap database native yang tercatat juga harus berhasil diimpor ke target recovery terisolasi.

Contoh fiktif: satu snapshot app-01 berisi /srv/example-app dan database example_app serta example_audit. Native test mencakup keduanya; tidak ada pilihan untuk menguji hanya database yang paling mudah.

## Cara menjalankan

1. Buka plan managed agent dan pilih tab **Backups**.
2. Pada pekerjaan **Complete** yang ingin diuji, buka menu titik tiga → **Run Recovery Test**.
3. Pada **Confirm Recovery Test**, periksa **Plan**, **Backup**, dan **Exact snapshot**.
4. Pada **Validation mode**, pilih **Native import — every recorded database required** jika target siap. **Artifact-only — SQL import NOT TESTED** hanya memeriksa artefak, dan tidak tersedia bila policy mewajibkan import.
5. Tinjau daftar database, pilihan Internal yang tersedia, resource terukur, dan kesiapan target. Jangan menyimpulkan engine dari filename SQL.
6. Jika pemeriksaan sudah sesuai, centang **I understand the additional resource usage and required cleanup. This is not a resource override.**
7. Klik **Run Recovery Test**, lalu ikuti **Recovery Test Result** sampai selesai.

Gunakan **Refresh snapshot and resource checks** jika data pemeriksaan sudah berubah. Permintaan satu kali ini tidak mengubah policy plan atau menyalakan otomatisasi.

## Menyimpan policy

Untuk plan yang sudah disimpan, buka **Edit → Advanced → Recovery Testing**. Pilih **Database import validation**, lalu klik **Save recovery policy**. Pengaturan ini disimpan terpisah dari tombol Update Plan.

**After every successful backup (opt-in)** mengaktifkan pengujian setelah backup sukses berikutnya; bukan pengujian ulang semua snapshot lama atau jadwal periodik baru. Untuk target Internal, ikuti batas saat ini: matikan opsi after-backup dan simpan policy; gunakan pengujian manual. Hanya satu engine Internal per test, sedangkan engine lain memerlukan target Custom yang disetujui.

## Binding

Hasil memuat backup ID dan snapshot ID yang benar-benar diuji. Passed dari snapshot lama tidak mengesahkan snapshot baru. Metadata historis yang tidak lengkap tidak diisi dengan tebakan engine, nama database, atau identitas.

## Tahap

Alurnya: baca repository primary → restore workspace privat → validasi filesystem → ukuran dan SHA-256 SQL → import opsional → cleanup database, workspace, dan infrastruktur Internal.

Server tidak menulis ke source agent. Mirror managed bukan sumber recovery yang didukung. Untuk database yang ingin dipertahankan, gunakan [Persistent Restore](/docs/database-restores), bukan target disposable ini.

## Acceptance

Periksa [hasil dan cleanup](/docs/recovery-testing/results), lalu tentukan validasi bisnis aplikasi secara terpisah. Passed tidak menjamin aplikasi dapat boot atau semua transaksi bisnis benar. Pelajari [cakupan validasi](/docs/recovery-testing/validation) dan [target import](/docs/recovery-testing/import) sebelum menyatakan backup siap untuk kebutuhan pemulihan Anda.
