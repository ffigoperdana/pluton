#!/usr/bin/env bash
# Disposable local tests only: no systemd service, enrollment, network or sudo.
set -Eeuo pipefail
test_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bash -n "$test_directory/../upgrade-agent.sh"
bash "$test_directory/../upgrade-agent.sh" --help >/dev/null
for upgrade_flag in --re-enroll --token uninstall --server --purge --force; do
	if bash "$test_directory/../upgrade-agent.sh" "$upgrade_flag" >/dev/null 2>&1; then
		printf 'FAIL: upgrade accepted an installation/enrollment option\n' >&2
		exit 1
	else
		upgrade_status=$?
		[[ "$upgrade_status" == 2 ]] || { printf 'FAIL: option was not refused at argument parsing\n' >&2; exit 1; }
	fi
done
node --test "$test_directory/upgrade-agent.test.cjs" "$test_directory/upgrade-agent.provenance.test.cjs"
