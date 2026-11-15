#!/bin/bash
# Lab test double: `cat` acts like an operator pressing Ctrl-C during the read,
# by sending SIGINT to the whole foreground process group.
printf '%s\n' "$*" >>/tmp/lab-rclone-argv
if [[ "${1-}" == cat ]]; then
	kill -INT 0
	sleep 5
	exit 130
fi
exec /opt/lab/rclone "$@"
