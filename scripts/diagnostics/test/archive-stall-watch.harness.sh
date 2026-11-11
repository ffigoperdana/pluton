#!/bin/sh
# Run from the repository root:
#   MSYS_NO_PATHCONV=1 docker run --rm --network none --entrypoint sh \
#     -v "$PWD/scripts/diagnostics:/work:ro" <local-pluton-image> /work/test/archive-stall-watch.harness.sh
# Synthetic data only. A real restic dump over rclone/S3 is held by a proxy, the
# same way the production archive stalls, and the watcher must show restic and
# rclone idle with rclone's TCP connection open and silent, plus DNS failures for
# an unresolvable host.
set -u
export RESTIC_PASSWORD=synthetic-test-password
mkdir -p /tmp/src/app-01 /tmp/srv/bucket
head -c 3000000 /dev/urandom > /tmp/src/app-01/large.bin
i=0; while [ $i -lt 20 ]; do echo "row $i" > /tmp/src/app-01/small-$i.txt; i=$((i+1)); done
restic init --repo /tmp/srv/bucket/repo -q
restic backup --repo /tmp/srv/bucket/repo -q /tmp/src
rclone serve s3 /tmp/srv --addr 127.0.0.1:9000 --auth-key AKSYNTHETIC,SKSYNTHETICSECRET --config /dev/null -q &
BIGID=$(basename "$(ls -S /tmp/srv/bucket/repo/data/*/* | head -1)")
node /work/test/holdproxy.mjs 9001 9000 "$BIGID" any &
sleep 2

export RCLONE_CONFIG=/dev/null RCLONE_CONFIG_X_TYPE=s3 RCLONE_CONFIG_X_PROVIDER=Other \
  RCLONE_CONFIG_X_ENDPOINT=http://127.0.0.1:9001 RCLONE_CONFIG_X_ACCESS_KEY_ID=AKSYNTHETIC \
  RCLONE_CONFIG_X_SECRET_ACCESS_KEY=SKSYNTHETICSECRET RCLONE_CONFIG_X_FORCE_PATH_STYLE=true
restic --no-lock --no-cache --repo rclone:x:bucket/repo -o rclone.program=/usr/local/bin/rclone \
  dump --archive tar latest / > /tmp/out.tar 2>/tmp/restic.err &
DUMP=$!

echo "===== watcher (held data pack, unresolvable DNS name) ====="
node /work/archive-stall-watch.mjs --host hcp.example.invalid --duration 22 --interval 5 --report /tmp/w.json
echo "exit=$?"
echo "TAR bytes before the hold: $(wc -c < /tmp/out.tar)"
kill "$DUMP" 2>/dev/null
node -e 'const r=require("/tmp/w.json");const s=r.samples.filter(x=>x.processes.length).pop();console.log("last sample:",JSON.stringify(s))'
