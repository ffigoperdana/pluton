#!/bin/bash
# Lab test double: `cat` acts like a first Ctrl-C during the read (SIGINT to the whole
# foreground process group). `deletefile` acts like a second Ctrl-C during cleanup:
# SIGINT to the probe's process group (recorded by run-probe.sh) before the real
# Rclone runs. A cleanup call that stays in that group dies here and the object stays.
printf '%s\n' "$*" >>/tmp/lab-rclone-argv
case "${1-}" in
	cat)
		kill -INT 0
		sleep 5
		exit 130
		;;
	deletefile)
		kill -INT -- "-$(cat /tmp/lab-probe-pgid)"
		sleep 1
		;;
esac
exec /opt/lab/rclone "$@"
