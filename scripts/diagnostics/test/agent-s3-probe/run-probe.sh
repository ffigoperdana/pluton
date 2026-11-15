#!/bin/bash
# Lab entry point: runs the probe mounted at /work, then reports on stderr anything
# it left behind (LAB-TEMP-LEFT) or a key that reached an Rclone argument list
# (LAB-ARGV-LEAK, from the argv log the test doubles write).
# Usage: run-probe.sh [--install-agent-rclone] [probe arguments...]
set -u
if [[ "${1-}" == --install-agent-rclone ]]; then
	shift
	install -D -m 0755 /opt/lab/rclone /opt/pluton-agent/bin/rclone
fi
# Process group of the probe, for lab test doubles that signal it.
cut -d " " -f 5 "/proc/$$/stat" >/tmp/lab-probe-pgid
bash /work/agent-s3-probe.sh "$@"
status=$?
if compgen -G '/tmp/pluton-agent-s3-probe.*' >/dev/null; then
	echo 'LAB-TEMP-LEFT' >&2
fi
for value in "${S3_PROBE_ACCESS_KEY_ID-}" "${S3_PROBE_SECRET_ACCESS_KEY-}"; do
	if [[ -n "$value" && -f /tmp/lab-rclone-argv ]] && grep -q -F -- "$value" /tmp/lab-rclone-argv; then
		echo 'LAB-ARGV-LEAK' >&2
	fi
done
exit "$status"
