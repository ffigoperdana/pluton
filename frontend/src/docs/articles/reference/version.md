# Memastikan versi dan identitas build

Gunakan identitas build ketika membandingkan UI, laporan gangguan, Agent, dan artefak deployment. Nomor versi yang tampak sama belum tentu berarti source dan image-nya sama.

## Metadata lokal

1. Periksa informasi build pada footer aplikasi atau dokumentasi.
2. Catat versi dan potongan revision yang tersedia pada laporan privat.
3. Cocokkan dengan source commit dan digest image yang disetujui operator.
4. Periksa Agent, worker MySQL, dan host operator secara terpisah jika masalah menyangkut komponen tersebut.

Backend menyediakan `X-App-Version` dan `X-App-Revision`. Footer dokumentasi mengambil metadata publik melalui HEAD pada dokumen `/docs/`; ia tidak membaca konfigurasi, credential, maupun inventory administrator.

Versi semantik ditampilkan dengan prefix `v`. Jika versi bukan versi semantik, footer memakai **Development build**, disertai label/revision yang valid bila tersedia. Nama branch tidak diubah menjadi versi rilis baru.

## Image identity

Digest OCI adalah identitas artefak yang digunakan deployment. Label source/revision/version membantu penelusuran, tetapi label sendiri tidak membuktikan image dibangun dari commit yang dimaksud. Operator perlu mencocokkan hasil pipeline dan provenance yang berlaku untuk digest tersebut.

Contoh catatan fiktif: source commit yang direview, platform `linux/amd64`, serta `sha256:<verified-digest>`. Jangan mencatat tag mutable sebagai satu-satunya bukti.

## Agent dan operator

Redeploy server/docs tidak memperbarui Agent pada mesin sumber. Demikian pula, image aplikasi tidak otomatis memasang host operator atau mengaktifkan MySQL. Catat source/artefak tiap komponen, bukan hanya versi yang tertera pada inventory.

## Updates

Fork ini tidak mengandalkan feed komersial upstream untuk mengklaim pembaruan terpercaya. Ikuti [pembaruan manual](/docs/deployment/updates), [artefak image](/docs/deployment/docker), dan [changelog source](/docs/changelog). Riwayat source bukan persetujuan penggunaan produksi.
