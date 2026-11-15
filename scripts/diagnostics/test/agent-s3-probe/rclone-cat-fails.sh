#!/bin/bash
# Lab test double: like rclone-recording.sh, but `cat` fails with provider-like text
# that the probe must classify (server-error) without printing it.
printf '%s\n' "$*" >>/tmp/lab-rclone-argv
if [[ "${1-}" == cat ]]; then
	printf '%s\n' 'ERROR : synthetic-provider-error-text StatusCode: 500' >&2
	exit 1
fi
exec /opt/lab/rclone "$@"
