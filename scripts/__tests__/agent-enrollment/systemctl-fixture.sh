#!/usr/bin/env bash
# Disposable container adapter only; this does not prove booted systemd startup.
set -euo pipefail
[[ -f /opt/pluton-disposable-ubuntu-test && $(stat -c '%u:%a' /opt/pluton-disposable-ubuntu-test) == 0:600 ]] || exit 90
case "${1:-}" in
  --version) printf 'systemd 249 (container adapter)\n' ;;
  is-active) [[ -f /tmp/pluton-enrollment-service-active ]] ;;
  show)
    # Standalone installers since 5d5869a query service absence before activation.
    # Mirrors the Agent repository's own fixture: report absence only while it is true.
    [[ ! -e /etc/systemd/system/pluton-agent.service && ! -e /tmp/pluton-enrollment-service-active ]] || exit 91
    printf 'LoadState=not-found\nActiveState=inactive\nMainPID=0\n' ;;
  daemon-reload|enable|disable) : ;;
  restart|start) touch /tmp/pluton-enrollment-service-active ;;
  stop) rm -f /tmp/pluton-enrollment-service-active ;;
  *) exit 91 ;;
esac
