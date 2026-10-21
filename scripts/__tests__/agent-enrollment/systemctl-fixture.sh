#!/usr/bin/env bash
# Disposable container adapter only; this does not prove booted systemd startup.
set -euo pipefail
[[ -f /opt/pluton-disposable-ubuntu-test && $(stat -c '%u:%a' /opt/pluton-disposable-ubuntu-test) == 0:600 ]] || exit 90
case "${1:-}" in
  --version) printf 'systemd 249 (container adapter)\n' ;;
  is-active) [[ -f /tmp/pluton-enrollment-service-active ]] ;;
  daemon-reload|enable|disable) : ;;
  restart|start) touch /tmp/pluton-enrollment-service-active ;;
  stop) rm -f /tmp/pluton-enrollment-service-active ;;
  *) exit 91 ;;
esac
