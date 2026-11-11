#!/bin/sh
# Run from the repository root:
#   MSYS_NO_PATHCONV=1 docker run --rm --network none --entrypoint sh \
#     -v "$PWD/scripts/diagnostics:/work:ro" <local-pluton-image> /work/test/replica-readback-probe.harness.sh
# Runs inside a disposable Pluton image container with synthetic data only.
# Scenarios: healthy replica (exit 0), one corrupted byte (HASH-MISMATCH, exit 2),
# one held GET body after 64 KiB (STALLED-OR-CUT with a header trace, exit 2).
set -u
export RESTIC_PASSWORD=synthetic-test-password
mkdir -p /tmp/src/app-01 /tmp/srv/bucket
head -c 3000000 /dev/urandom > /tmp/src/app-01/large.bin
head -c 700000 /dev/urandom > /tmp/src/app-01/medium.bin
i=0; while [ $i -lt 40 ]; do echo "row $i $(date +%s%N)" > /tmp/src/app-01/small-$i.txt; i=$((i+1)); done
restic init --repo /tmp/srv/bucket/repo -q
restic backup --repo /tmp/srv/bucket/repo -q /tmp/src
restic backup --repo /tmp/srv/bucket/repo -q --pack-size 4 /tmp/src >/dev/null
rclone serve s3 /tmp/srv --addr 127.0.0.1:9000 --auth-key AKSYNTHETIC,SKSYNTHETICSECRET --config /dev/null -q &
sleep 2
export PROBE_ACCESS_KEY_ID=AKSYNTHETIC PROBE_SECRET_ACCESS_KEY=SKSYNTHETICSECRET
P="node /work/replica-readback-probe.mjs --credentials env --allow-loopback-http --path bucket/repo --timeout 5"

echo "===== 1. healthy replica ====="
$P --endpoint http://127.0.0.1:9000 --report /tmp/r1.json; echo "exit=$?"

PACK=$(ls /tmp/srv/bucket/repo/data/*/* | head -1)
PACKID=$(basename "$PACK")
echo "===== 2. one corrupted data object ====="
cp "$PACK" /tmp/pack.bak; chmod u+w "$PACK"
printf "X" | dd of="$PACK" bs=1 seek=100 conv=notrunc && echo "corrupted one byte of data/.../$PACKID"
$P --endpoint http://127.0.0.1:9000 --only data --report /tmp/r2.json; echo "exit=$?"
cp /tmp/pack.bak "$PACK"

BIG=$(ls -S /tmp/srv/bucket/repo/data/*/* | head -1)
BIGID=$(basename "$BIG")
node /work/test/holdproxy.mjs 9001 9000 "$BIGID" &
sleep 1
echo "===== 3. held response for one object (stall after 64 KiB) ====="
$P --endpoint http://127.0.0.1:9001 --objects "data/$(echo $BIGID | cut -c1-2)/$BIGID" --show-errors --report /tmp/r3.json; echo "exit=$?"
echo "===== report 3 (object record) ====="
node -e 'const r=require("/tmp/r3.json");console.log(JSON.stringify(r.objects[0],null,1))'
echo "===== secret leak check ====="
grep -l "SKSYNTHETICSECRET\|AKSYNTHETIC\|127.0.0.1\|bucket/repo" /tmp/r1.json /tmp/r2.json /tmp/r3.json || echo "no credentials, endpoint or path in reports"
