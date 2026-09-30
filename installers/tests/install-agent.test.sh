#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
INSTALLER="$SCRIPT_DIR/../install-agent.sh"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
TEST_ROOT="$(mktemp -d "$REPOSITORY_ROOT/.pluton-agent-test.XXXXXX")"

cleanup() {
	case "$(basename -- "$TEST_ROOT")" in
		.pluton-agent-test.*) rm -rf -- "$TEST_ROOT" ;;
		*) printf 'Refusing to remove a non-temporary test root.\n' >&2; exit 1 ;;
	esac
}
trap cleanup EXIT

fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

assert_file() {
	[[ -f "$1" ]] || fail "Expected file: $1"
}

assert_missing() {
	[[ ! -e "$1" ]] || fail "Expected no path: $1"
}

make_root() {
	local name="$1"
	local root
	root="$(mktemp -d "$TEST_ROOT/.pluton-agent-test.$name.XXXXXX")"
	mkdir -p -- "$root/source"
	printf '%s' "$root"
}

run_installer() {
	local root="$1"
	shift
	PLUTON_AGENT_TEST_MODE=1 PLUTON_AGENT_TEST_ROOT="$root" "$INSTALLER" "$@"
}

base_install() {
	local root="$1"
	run_installer "$root" --server https://pluton.example.internal --allowed-root "$root/source"
}

test_fresh_install_and_generated_files() {
	local root
	root="$(make_root fresh)"
	printf 'host-node-must-not-change' > "$root/system-node"
	local before
	before="$(sha256sum "$root/system-node")"
	base_install "$root"
	[[ "$before" == "$(sha256sum "$root/system-node")" ]] || fail 'The installer changed a simulated host Node runtime.'
	assert_file "$root/opt/pluton-agent/runtime/bin/node"
	assert_file "$root/opt/pluton-agent/app/dist/index.js"
	assert_file "$root/var/lib/pluton-agent/identity.json"
	assert_file "$root/etc/pluton-agent.env"
	assert_file "$root/etc/systemd/system/pluton-agent.service"
	grep -Fx 'PLUTON_SERVER_URL="https://pluton.example.internal"' "$root/etc/pluton-agent.env" >/dev/null
	grep -Fx "PLUTON_AGENT_ALLOWED_ROOTS=\"$root/source\"" "$root/etc/pluton-agent.env" >/dev/null
	grep -Fx 'ALLOW_INSECURE_HTTP="false"' "$root/etc/pluton-agent.env" >/dev/null
	grep -Fx 'User=pluton-agent' "$root/etc/systemd/system/pluton-agent.service" >/dev/null
	grep -Fx "EnvironmentFile=$root/etc/pluton-agent.env" "$root/etc/systemd/system/pluton-agent.service" >/dev/null
	grep -Fx "ExecStart=$root/opt/pluton-agent/runtime/bin/node $root/opt/pluton-agent/app/dist/index.js run" "$root/etc/systemd/system/pluton-agent.service" >/dev/null
	grep -Fx 'NoNewPrivileges=yes' "$root/etc/systemd/system/pluton-agent.service" >/dev/null
	grep -Fx 'PrivateTmp=yes' "$root/etc/systemd/system/pluton-agent.service" >/dev/null
}

test_reinstall_preserves_identity() {
	local root identity before
	root="$(make_root reinstall)"
	base_install "$root"
	identity="$root/var/lib/pluton-agent/identity.json"
	before="$(sha256sum "$identity")"
	base_install "$root"
	[[ "$before" == "$(sha256sum "$identity")" ]] || fail 'A normal reinstall replaced the existing identity.'
}

test_failed_update_restores_previous_installation() {
	local root identity_before config_before
	root="$(make_root failed-update)"
	base_install "$root"
	identity_before="$(sha256sum "$root/var/lib/pluton-agent/identity.json")"
	config_before="$(cat "$root/etc/pluton-agent.env")"
	printf 'previous-installation\n' > "$root/opt/pluton-agent/app/dist/rollback-marker"
	if PLUTON_AGENT_TEST_MODE=1 PLUTON_AGENT_TEST_ROOT="$root" PLUTON_AGENT_TEST_CONTROL_PLANE_FAIL=1 "$INSTALLER" --server https://replacement.example.internal --allowed-root "$root/source" >/dev/null 2>&1; then
		fail 'A simulated control-plane validation failure unexpectedly succeeded.'
	fi
	[[ "$identity_before" == "$(sha256sum "$root/var/lib/pluton-agent/identity.json")" ]] || fail 'A failed update replaced the prior identity.'
	[[ "$config_before" == "$(cat "$root/etc/pluton-agent.env")" ]] || fail 'A failed update did not restore the prior configuration.'
	grep -Fx 'previous-installation' "$root/opt/pluton-agent/app/dist/rollback-marker" >/dev/null || fail 'A failed update did not restore the prior application.'
}

test_failed_reenrollment_restores_previous_installation() {
	local root identity before config_before
	root="$(make_root reenrollment)"
	base_install "$root"
	identity="$root/var/lib/pluton-agent/identity.json"
	before="$(sha256sum "$identity")"
	config_before="$(cat "$root/etc/pluton-agent.env")"
	printf 'previous-installation\n' > "$root/opt/pluton-agent/app/dist/rollback-marker"
	if PLUTON_AGENT_TEST_MODE=1 PLUTON_AGENT_TEST_ROOT="$root" PLUTON_AGENT_TEST_ENROLL_FAIL=1 "$INSTALLER" --server https://replacement.example.internal --allowed-root "$root/source" --re-enroll --force >/dev/null 2>&1; then
		fail 'A simulated re-enrollment failure unexpectedly succeeded.'
	fi
	[[ "$before" == "$(sha256sum "$identity")" ]] || fail 'A failed re-enrollment did not restore the prior identity.'
	[[ "$config_before" == "$(cat "$root/etc/pluton-agent.env")" ]] || fail 'A failed re-enrollment did not restore the prior configuration.'
	grep -Fx 'previous-installation' "$root/opt/pluton-agent/app/dist/rollback-marker" >/dev/null || fail 'A failed re-enrollment did not restore the prior application.'
}

test_http_requires_explicit_opt_in() {
	local root
	root="$(make_root http-reject)"
	if run_installer "$root" --server http://192.0.2.10:5173 --allowed-root "$root/source" >/dev/null 2>&1; then
		fail 'HTTP installation succeeded without --allow-insecure-http.'
	fi
	root="$(make_root http-allow)"
	run_installer "$root" --server http://192.0.2.10:5173 --allowed-root "$root/source" --allow-insecure-http
	grep -Fx 'ALLOW_INSECURE_HTTP="true"' "$root/etc/pluton-agent.env" >/dev/null
}

test_quick_enrollment_token_is_accepted_without_persistence() {
	local root quick_token
	root="$(make_root quick-token)"
	quick_token='quick-enrollment-token-for-test'
	run_installer "$root" --server https://pluton.example.internal --allowed-root "$root/source" --token "$quick_token"
	if grep -R --fixed-strings -- "$quick_token" "$root" >/dev/null 2>&1; then
		fail 'A quick-install enrollment token was persisted to disk.'
	fi
}

test_conflicting_enrollment_token_inputs_are_rejected() {
	local root
	root="$(make_root conflicting-token-inputs)"
	if run_installer "$root" --server https://pluton.example.internal --allowed-root "$root/source" --token quick-enrollment-token-for-test --token-stdin >/dev/null 2>&1; then
		fail 'The installer accepted both --token and --token-stdin.'
	fi
}

test_multiple_roots_and_private_ca_configuration() {
	local root ca_file
	root="$(make_root multiple-roots)"
	mkdir -p -- "$root/second-source"
	ca_file="$root/private-ca.pem"
	printf 'test-ca' > "$ca_file"
	run_installer "$root" --server https://pluton.example.internal --allowed-root "$root/source" --allowed-root "$root/second-source" --allowed-root "$root/source" --ca-file "$ca_file"
	grep -Fx "PLUTON_AGENT_ALLOWED_ROOTS=\"$root/source,$root/second-source\"" "$root/etc/pluton-agent.env" >/dev/null
	grep -Fx "PLUTON_AGENT_CA_FILE=\"$ca_file\"" "$root/etc/pluton-agent.env" >/dev/null
	run_installer "$root" --server https://pluton.example.internal --allowed-root "$root/source" --allowed-root "$root/second-source"
	grep -Fx "PLUTON_AGENT_CA_FILE=\"$ca_file\"" "$root/etc/pluton-agent.env" >/dev/null
}

test_platform_rejections() {
	local root
	root="$(make_root unsupported-arch)"
	if PLUTON_AGENT_TEST_MODE=1 PLUTON_AGENT_TEST_ROOT="$root" PLUTON_AGENT_TEST_ARCH=arm64 "$INSTALLER" --server https://pluton.example.internal --allowed-root "$root/source" >/dev/null 2>&1; then
		fail 'Unsupported architecture was accepted.'
	fi
	root="$(make_root missing-systemd)"
	if PLUTON_AGENT_TEST_MODE=1 PLUTON_AGENT_TEST_ROOT="$root" PLUTON_AGENT_TEST_SYSTEMD=missing "$INSTALLER" --server https://pluton.example.internal --allowed-root "$root/source" >/dev/null 2>&1; then
		fail 'Missing systemd was accepted.'
	fi
}

test_checksum_mismatch_is_rejected() {
	local checksum_root archive checksums
	checksum_root="$(make_root checksum)"
	archive="$checksum_root/node.tar.xz"
	checksums="$checksum_root/SHASUMS256.txt"
	printf 'not-the-expected-archive' > "$archive"
	printf '%064d  %s\n' 0 "$(basename -- "$archive")" > "$checksums"
	# shellcheck disable=SC1090
	source "$INSTALLER"
	if verify_node_checksum "$archive" "$checksums"; then
		fail 'A checksum mismatch was accepted.'
	fi
}

test_uninstall_and_purge() {
	local root identity
	root="$(make_root uninstall)"
	base_install "$root"
	identity="$root/var/lib/pluton-agent/identity.json"
	run_installer "$root" uninstall
	assert_missing "$root/opt/pluton-agent"
	assert_missing "$root/etc/systemd/system/pluton-agent.service"
	assert_file "$identity"
	assert_file "$root/etc/pluton-agent.env"
	if run_installer "$root" uninstall --purge >/dev/null 2>&1; then
		fail 'Purge succeeded without confirmation or --force.'
	fi
	assert_file "$identity"
	run_installer "$root" uninstall --purge --force
	assert_missing "$root/var/lib/pluton-agent"
	assert_missing "$root/etc/pluton-agent.env"
}

test_fresh_install_and_generated_files
test_reinstall_preserves_identity
test_failed_update_restores_previous_installation
test_failed_reenrollment_restores_previous_installation
test_http_requires_explicit_opt_in
test_quick_enrollment_token_is_accepted_without_persistence
test_conflicting_enrollment_token_inputs_are_rejected
test_multiple_roots_and_private_ca_configuration
test_platform_rejections
test_checksum_mismatch_is_rejected
test_uninstall_and_purge
printf 'PASS: install-agent installer tests\n'
