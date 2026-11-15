#!/bin/bash
# Lab test double: records every argument list, then runs the pinned Rclone.
printf '%s\n' "$*" >>/tmp/lab-rclone-argv
exec /opt/lab/rclone "$@"
