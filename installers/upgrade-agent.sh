#!/usr/bin/env bash
# Upgrade-only entry point. Does not invoke the install/enroll/config/unit paths.
set -Eeuo pipefail
IFS=$'\n\t'

UPGRADE_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

upgrade_usage() {
	cat <<'EOF'
Usage: sudo bash installers/upgrade-agent.sh [--check | --rollback <upgrade-id>]

Default: build the checked-out committed Agent using the installed private
Node/Corepack and pinned pnpm, drain locally, back up, replace only app, and
restart only pluton-agent.service. No enrollment or configuration writes.

--check       Read-only local preflight; no download, build, heartbeat or restart.
--rollback ID Restore only the recorded previous app after a fresh drain and
              exact preserved-state check. Never restore old identity/receipts.
--help        Show this help.

Pause server plans and settle Source Access requests before upgrading. Running
Agents without upgrade protocol v1 must first be safely drained and stopped by
the operator. Unknown/custom installations fail closed; never use reinstall as
a workaround. See docs/AGENT_UPGRADE.md.
EOF
}

case "${1:-}" in
	--help|-h) [[ $# == 1 ]] || exit 2; upgrade_usage; exit 0 ;;
	'') [[ $# == 0 ]] || exit 2 ;;
	--check) [[ $# == 1 ]] || exit 2 ;;
	--rollback) [[ $# == 2 && "$2" =~ ^[0-9]{14}-[a-f0-9]{12}-[a-f0-9]{12}$ ]] || exit 2 ;;
	*) upgrade_usage >&2; exit 2 ;;
esac

[[ "$(uname -s)" == Linux && $EUID == 0 ]] || { printf '%s\n' 'Upgrade requires Linux and root.' >&2; exit 1; }
# Never permit the installer's fixture switches or Node injection in a root run.
[[ -z "${PLUTON_AGENT_TEST_MODE:-}${PLUTON_AGENT_TEST_ROOT:-}${NODE_OPTIONS:-}${NODE_PATH:-}" ]] || {
	printf '%s\n' 'Remove installer test switches and Node injection variables.' >&2; exit 1;
}
export PATH='/usr/sbin:/usr/bin:/sbin:/bin'
unset BASH_ENV ENV CDPATH GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
# Reuse the reviewed checksum/tree verification and build functions, not main().
# shellcheck source=install-agent.sh
source "$UPGRADE_SCRIPT_DIR/install-agent.sh"
configure_paths
for upgrade_utility in git stat find sort xargs sha256sum cut grep sed realpath readlink systemctl runuser df du tar cp mv sync; do
	command -v "$upgrade_utility" >/dev/null || fail "Required utility missing: $upgrade_utility"
done
[[ -f /etc/os-release && -d /run/systemd/system ]] || fail 'An existing systemd Linux installation is required.'
[[ "$(uname -m)" == x86_64 ]] || fail 'Only the existing Linux x86_64 private toolchain is supported.'
[[ -f "$INSTALL_ROOT/.verified-install" && ! -L "$INSTALL_ROOT/.verified-install" ]] || fail 'Existing verified installer provenance is required; no new installation is permitted.'
upgrade_parent="$INSTALL_ROOT"
while :; do
	[[ ! -L "$upgrade_parent" && "$(stat -c '%u' "$upgrade_parent")" == 0 ]] || fail 'Private installation is not root protected.'
	upgrade_mode="$(stat -c '%a' "$upgrade_parent")"
	(( (8#$upgrade_mode & 0022) == 0 )) || fail 'Private installation is writable by another account.'
	[[ "$upgrade_parent" != / ]] || break
	upgrade_parent="$(dirname -- "$upgrade_parent")"
done
[[ "$(stat -c '%u:%a' "$INSTALL_ROOT/.verified-install")" == '0:644' ]] || fail 'Installer provenance is not protected.'
if [[ "${1:-}" == --rollback && -d "$INSTALL_ROOT/.upgrade-lock" ]]; then
	# A killed transaction can leave app temporarily absent. Authenticate the same
	# private Node without requiring that incomplete application tree to match.
	upgrade_node_receipt="$INSTALL_ROOT/.upgrade-lock/node.sha256"
	[[ ! -L "$INSTALL_ROOT/.upgrade-lock" && "$(stat -c '%u:%a' "$INSTALL_ROOT/.upgrade-lock")" == '0:700' &&
	   -f "$upgrade_node_receipt" && ! -L "$upgrade_node_receipt" && "$(stat -c '%u:%a' "$upgrade_node_receipt")" == '0:600' &&
	   ! -L "$RUNTIME_DIR/bin/node" && "$(stat -c '%u' "$RUNTIME_DIR/bin/node")" == 0 ]] || fail 'Interrupted upgrade lacks protected runtime evidence.'
	upgrade_mode="$(stat -c '%a' "$RUNTIME_DIR/bin/node")"
	(( (8#$upgrade_mode & 0022) == 0 )) && [[ "$(stat -c '%h' "$RUNTIME_DIR/bin/node")" == 1 ]] || fail 'Recovery executable is writable or hard-linked.'
	for upgrade_runtime_parent in "$RUNTIME_DIR" "$RUNTIME_DIR/bin"; do
		[[ ! -L "$upgrade_runtime_parent" && "$(stat -c '%u' "$upgrade_runtime_parent")" == 0 ]] || fail 'Recovery runtime ancestor is not protected.'
		upgrade_mode="$(stat -c '%a' "$upgrade_runtime_parent")"
		(( (8#$upgrade_mode & 0022) == 0 )) || fail 'Recovery runtime ancestor is writable by another account.'
	done
	upgrade_node_hash="$(cat "$upgrade_node_receipt")"
	[[ "$upgrade_node_hash" =~ ^[a-f0-9]{64}$ && "$(sha256sum "$RUNTIME_DIR/bin/node" | cut -d ' ' -f 1)" == "$upgrade_node_hash" ]] || fail 'Recovery runtime integrity mismatch.'
else
	upgrade_tree="$(verified_tree_digest "$INSTALL_ROOT")" || fail 'Existing artifacts failed ownership/integrity checks; use the exact interrupted transaction rollback if applicable.'
	grep -Fx "tree=$upgrade_tree" "$INSTALL_ROOT/.verified-install" >/dev/null || fail 'Installed artifacts differ from their recorded integrity digest.'
fi
grep -Fx "node=$NODE_VERSION" "$INSTALL_ROOT/.verified-install" >/dev/null || fail 'Private Node version differs from the supported installer build contract.'
grep -Fx "restic=$RESTIC_VERSION:$RESTIC_LINUX_AMD64_SHA256" "$INSTALL_ROOT/.verified-install" >/dev/null || fail 'Private Restic differs from the supported build contract.'
grep -Fx "rclone=$RCLONE_VERSION:$RCLONE_LINUX_AMD64_SHA256" "$INSTALL_ROOT/.verified-install" >/dev/null || fail 'Private Rclone differs from the supported build contract.'
[[ "$("$RUNTIME_DIR/bin/node" -v)" == "$NODE_VERSION" ]] || fail 'Private Node could not be verified.'
[[ -f "$RUNTIME_DIR/lib/node_modules/corepack/dist/corepack.js" ]] || fail 'Private Corepack is missing.'
exec "$RUNTIME_DIR/bin/node" "$UPGRADE_SCRIPT_DIR/lib/upgrade-agent.cjs" "$REPOSITORY_ROOT" "$@"
