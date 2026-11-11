#!/bin/sh
# Run from the repository root:
#   MSYS_NO_PATHCONV=1 docker run --rm --network none --entrypoint sh \
#     -v "$PWD/scripts/diagnostics:/work:ro" <local-pluton-image> /work/test/serve-restic-range-sweep.harness.sh
# Synthetic data only. Scenarios: a healthy loopback S3 (all ranges OK, exit 0),
# then a proxy whose HEAD reports the target pack 8 KiB smaller than its real size
# (sizes differ, full GET and tail ranges fail with a matching prefix, exit 2).
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
sleep 2
export PROBE_ACCESS_KEY_ID=AKSYNTHETIC PROBE_SECRET_ACCESS_KEY=SKSYNTHETICSECRET
S="node /work/serve-restic-range-sweep.mjs --credentials env --allow-loopback-http --path bucket/repo --timeout 5 --step 262144"

echo "===== 1. healthy replica ====="
$S --endpoint http://127.0.0.1:9000 --report /tmp/s1.json; echo "exit=$?"
echo "===== 2. HEAD reports the pack 8 KiB too small ====="
$S --endpoint http://127.0.0.1:9002 --report /tmp/s2.json; echo "exit=$?"
