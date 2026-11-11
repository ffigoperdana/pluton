#!/bin/sh
# Run from the repository root:
#   MSYS_NO_PATHCONV=1 docker run --rm --network none --entrypoint sh \
#     -v "$PWD/scripts/diagnostics:/work:ro" <local-pluton-image> /work/test/serve-restic-range-sweep.harness.sh
# Synthetic data only. Scenarios:
#   1. healthy loopback S3: every range OK, exit 0
#   2. HEAD reports the pack 8 KiB too small: sizes differ, full GET through serve fails, exit 2
#   3. Range GETs with Accept-Encoding: gzip come back gzip-encoded: the range fails with
#      gzip magic, the trace shows Content-Encoding: gzip, exit 2
#   4. the same with --accept-gzip off: the range passes, exit 0
set -u
export RESTIC_PASSWORD=synthetic-test-password
mkdir -p /tmp/src/app-01 /tmp/srv/bucket
head -c 3000000 /dev/urandom > /tmp/src/app-01/large.bin
i=0; while [ $i -lt 20 ]; do echo "row $i" > /tmp/src/app-01/small-$i.txt; i=$((i+1)); done
restic init --repo /tmp/srv/bucket/repo -q
restic backup --repo /tmp/srv/bucket/repo -q /tmp/src
rclone serve s3 /tmp/srv --addr 127.0.0.1:9000 --auth-key AKSYNTHETIC,SKSYNTHETICSECRET --config /dev/null -q &
BIGID=$(basename "$(ls -S /tmp/srv/bucket/repo/data/*/* | head -1)")
node /work/test/holdproxy.mjs 9002 9000 "$BIGID" shorthead &
node /work/test/holdproxy.mjs 9003 9000 "$BIGID" gzip &
sleep 2
export PROBE_ACCESS_KEY_ID=AKSYNTHETIC PROBE_SECRET_ACCESS_KEY=SKSYNTHETICSECRET
S="node /work/serve-restic-range-sweep.mjs --credentials env --allow-loopback-http --path bucket/repo --timeout 5 --step 262144"

echo "===== 1. healthy replica ====="
$S --endpoint http://127.0.0.1:9000 --report /tmp/s1.json; echo "exit=$?"
echo "===== 2. HEAD reports the pack 8 KiB too small ====="
$S --endpoint http://127.0.0.1:9002 --report /tmp/s2.json; echo "exit=$?"
echo "===== 3. gzip-encoded Range responses ====="
$S --endpoint http://127.0.0.1:9003 --range 1000000:13960 --repeat 2 --report /tmp/s3.json; echo "exit=$?"
echo "===== 4. gzip-encoded Range responses, Accept-Encoding gzip off ====="
$S --endpoint http://127.0.0.1:9003 --range 1000000:13960 --repeat 2 --accept-gzip off --report /tmp/s4.json; echo "exit=$?"
echo "===== secret leak check ====="
grep -l "SKSYNTHETICSECRET\|AKSYNTHETIC" /tmp/s1.json /tmp/s2.json /tmp/s3.json /tmp/s4.json || echo "no credentials in reports"
