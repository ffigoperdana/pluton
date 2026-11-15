#!/bin/bash
# Lab S3 fixture: HTTPS `rclone serve s3` with the throwaway lab certificate and the
# synthetic key pair. --auth-key must be a flag: RCLONE_AUTH_KEY splits on the comma.
set -eu
mkdir -p /srv/s3/bucket-01
exec /opt/lab/rclone serve s3 /srv/s3 --config /dev/null --addr :9443 \
	--cert /pki/server-chain.pem --key /pki/server.key \
	--auth-key SYNTHETICKEY01,synthetic-secret-key-01 -q
