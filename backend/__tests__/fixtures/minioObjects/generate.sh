#!/usr/bin/env bash
# Regenerates the MinIO object fixtures from a real MinIO server in disposable
# Docker containers. Nothing here touches real infrastructure: the containers
# share a private network, credentials and the static KMS key are random and
# thrown away, and every object holds synthetic content.
#
#   bash backend/__tests__/fixtures/minioObjects/generate.sh
#
# Output (next to this script):
#   xl-single.tar.gz   one-drive deployment: format.json plus the bucket folders
#   erasure-drive1.tar.gz  drive 1 of a four-drive erasure deployment
#   sources.json       size, MD5 and SHA-256 of every uploaded version
#   listing.jsonl      `mc ls --recursive --versions --json` of every bucket
#   minio-version.txt  the MinIO release that wrote the data
set -euo pipefail
export MSYS_NO_PATHCONV=1

MINIO_IMAGE=${MINIO_IMAGE:-cgr.dev/chainguard/minio:latest}
MC_IMAGE=${MC_IMAGE:-cgr.dev/chainguard/minio-client:latest}
TOOLS_IMAGE=${TOOLS_IMAGE:-alpine:3.20}
OUT=$(cd "$(dirname "$0")" && pwd)
RUN=minio-fixture-$$
NET=$RUN-net
SRC=$RUN-src
SINGLE=$RUN-single
DRIVES=$RUN-drives
ACCESS=fixture-admin
SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
KMS_KEY="fixture-key:$(head -c 32 /dev/urandom | base64)"

cleanup() {
	docker rm -f "$RUN-a" "$RUN-b" >/dev/null 2>&1 || true
	docker volume rm -f "$SRC" "$SINGLE" "$DRIVES" >/dev/null 2>&1 || true
	docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker volume create "$SRC" >/dev/null
docker volume create "$SINGLE" >/dev/null
docker volume create "$DRIVES" >/dev/null

# Source files. Large files repeat a short pseudo-random block with a line
# counter so that every MiB differs while the committed archive stays small.
docker run --rm -v "$SRC:/src" "$TOOLS_IMAGE" sh -euc '
cd /src
pattern() { awk -v seed="$1" -v lines="$2" "BEGIN { srand(seed); b = \"\"; for (i = 0; i < 997; i++) b = b sprintf(\"%c\", 35 + int(rand() * 90)); for (i = 0; i < lines; i++) printf \"%08d|%s\\n\", i, b }"; }
printf "Hello from app-01\n" > hello.txt
: > empty.txt
printf "Laporan akhir untuk example.internal\n" > laporan.txt
pattern 11 300 > report.bin              # 300 KiB: one part file, one bitrot block
pattern 12 2640 > large.bin              # 2.5 MiB: three bitrot blocks
pattern 13 11280 > multipart.bin         # 11 MiB: three multipart parts of 5 MiB
pattern 14 1540 > app.log                # S2 compressed part file
pattern 15 20 > small.log                # S2 compressed and inline
pattern 16 11280 > table.csv             # S2 compressed multipart object
pattern 17 10 > sse.bin                  # SSE-S3, must be refused
printf "first version\n" > notes-v1.txt
printf "second version of the notes\n" > notes-v2.txt
printf "written before versioning\n" > legacy-v1.txt
printf "written after versioning\n" > legacy-v2.txt
pattern 18 200 > kept-v1.bin
pattern 19 300 > kept-v2.bin
pattern 20 300 > erasure.bin
'

docker run -d --name "$RUN-a" --network "$NET" --network-alias minio-a --user 0:0 \
	-v "$SINGLE:/data" \
	-e MINIO_ROOT_USER="$ACCESS" -e MINIO_ROOT_PASSWORD="$SECRET" \
	-e MINIO_KMS_SECRET_KEY="$KMS_KEY" \
	-e MINIO_COMPRESSION_ENABLE=on \
	-e MINIO_COMPRESSION_EXTENSIONS=.log,.csv \
	-e MINIO_COMPRESSION_MIME_TYPES=application/x-fixture-compressed \
	"$MINIO_IMAGE" server /data >/dev/null
docker run -d --name "$RUN-b" --network "$NET" --network-alias minio-b --user 0:0 \
	-v "$DRIVES:/drives" \
	-e MINIO_ROOT_USER="$ACCESS" -e MINIO_ROOT_PASSWORD="$SECRET" \
	"$MINIO_IMAGE" server '/drives/d{1...4}' >/dev/null

mc() {
	docker run --rm --network "$NET" -v "$SRC:/src:ro" \
		-e MC_HOST_a="http://$ACCESS:$SECRET@minio-a:9000" \
		-e MC_HOST_b="http://$ACCESS:$SECRET@minio-b:9000" \
		"$MC_IMAGE" "$@"
}
for alias in a b; do
	for attempt in $(seq 1 60); do
		if mc ready "$alias" >/dev/null 2>&1; then break; fi
		sleep 1
	done
done

mc mb -q a/example-bucket a/versioned-bucket >/dev/null
mc put -q /src/hello.txt a/example-bucket/hello.txt >/dev/null
mc put -q /src/empty.txt a/example-bucket/empty.txt >/dev/null
mc put -q /src/laporan.txt "a/example-bucket/dokumen/laporan akhir é.txt" >/dev/null
mc put -q /src/report.bin a/example-bucket/docs/report.bin >/dev/null
mc put -q /src/large.bin a/example-bucket/data/large.bin >/dev/null
mc put -q --part-size 5MiB /src/multipart.bin a/example-bucket/uploads/multipart.bin >/dev/null
mc put -q /src/app.log a/example-bucket/logs/app.log >/dev/null
mc put -q /src/small.log a/example-bucket/logs/small.log >/dev/null
mc put -q --part-size 5MiB /src/table.csv a/example-bucket/exports/table.csv >/dev/null
mc put -q --enc-s3 a/example-bucket/secret/ /src/sse.bin a/example-bucket/secret/sse.bin >/dev/null
mc mb -q a/example-bucket/folder/ >/dev/null

mc put -q /src/legacy-v1.txt a/versioned-bucket/legacy.txt >/dev/null
mc version enable a/versioned-bucket >/dev/null
mc put -q /src/legacy-v2.txt a/versioned-bucket/legacy.txt >/dev/null
mc put -q /src/notes-v1.txt a/versioned-bucket/notes.txt >/dev/null
mc put -q /src/notes-v2.txt a/versioned-bucket/notes.txt >/dev/null
mc rm -q a/versioned-bucket/notes.txt >/dev/null
mc put -q /src/kept-v1.bin a/versioned-bucket/kept.bin >/dev/null
mc put -q /src/kept-v2.bin a/versioned-bucket/kept.bin >/dev/null

mc mb -q b/erasure-bucket >/dev/null
mc put -q /src/erasure.bin b/erasure-bucket/object.bin >/dev/null

for target in a/example-bucket a/versioned-bucket b/erasure-bucket; do
	mc ls --recursive --versions --json "$target" |
		sed -e 's/"url":"[^"]*",\{0,1\}//' -e "s|^{|{\"bucket\":\"${target#*/}\",|"
done > "$OUT/listing.jsonl"

docker exec "$RUN-a" minio --version | head -1 > "$OUT/minio-version.txt"
docker stop "$RUN-a" "$RUN-b" >/dev/null

docker run --rm -v "$SRC:/src:ro" "$TOOLS_IMAGE" sh -euc '
cd /src
first=1
printf "[\n"
for file in *; do
	[ $first = 1 ] || printf ",\n"
	first=0
	printf "  {\"file\": \"%s\", \"size\": %s, \"md5\": \"%s\", \"sha256\": \"%s\"}" \
		"$file" "$(wc -c < "$file" | tr -d " ")" "$(md5sum "$file" | cut -c1-32)" "$(sha256sum "$file" | cut -c1-64)"
done
printf "\n]\n"
' > "$OUT/sources.json"

docker run --rm -v "$SINGLE:/data:ro" "$TOOLS_IMAGE" \
	tar -C /data -czf - .minio.sys/format.json example-bucket versioned-bucket > "$OUT/xl-single.tar.gz"
docker run --rm -v "$DRIVES:/drives:ro" "$TOOLS_IMAGE" \
	tar -C /drives/d1 -czf - .minio.sys/format.json erasure-bucket > "$OUT/erasure-drive1.tar.gz"

ls -l "$OUT"
