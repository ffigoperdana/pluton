#!/usr/bin/env sh
# Create a VM-local deployment directory, preserve an existing .env, and start
# an explicitly requested release image.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET_DIR=/opt/pluton

usage() {
	printf '%s\n' "Usage: sh install.sh <release-tag-or-sha256-digest> [install-directory]" >&2
	exit 2
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
requested_version=$1
if [ "$#" -eq 2 ]; then
	TARGET_DIR=$2
fi

case "$TARGET_DIR" in
	/*) ;;
	*) printf '%s\n' "ERROR: install-directory must be an absolute path." >&2; exit 2 ;;
esac

. "$SCRIPT_DIR/lib.sh"

require_docker
require_file "$SCRIPT_DIR/compose.yml"
require_file "$SCRIPT_DIR/.env.example"
require_file "$SCRIPT_DIR/deploy.sh"
require_file "$SCRIPT_DIR/rollback.sh"

umask 077
mkdir -p "$TARGET_DIR"
chmod 750 "$TARGET_DIR"

if [ "$SCRIPT_DIR" != "$TARGET_DIR" ]; then
	for deployment_file in compose.yml .env.example lib.sh deploy.sh rollback.sh install.sh; do
		cp "$SCRIPT_DIR/$deployment_file" "$TARGET_DIR/$deployment_file"
	done
fi

DEPLOY_DIR=$TARGET_DIR
ENV_FILE="$DEPLOY_DIR/.env"
COMPOSE_FILE="$DEPLOY_DIR/compose.yml"
STATE_FILE="$DEPLOY_DIR/.deploy-state"

if [ ! -f "$ENV_FILE" ]; then
	cp "$DEPLOY_DIR/.env.example" "$ENV_FILE"
	chmod 600 "$ENV_FILE"
	info "Created $ENV_FILE from the sanitized example."
else
	chmod 600 "$ENV_FILE"
	info "Keeping the existing $ENV_FILE unchanged."
fi

encryption_key=$(read_env_value ENCRYPTION_KEY)
if [ -z "$encryption_key" ]; then
	volume_name=$(read_env_value PLUTON_VOLUME_NAME)
	[ -n "$volume_name" ] || volume_name=pluton-data
	printf '%s' "$volume_name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*$' ||
		die "PLUTON_VOLUME_NAME contains unsupported characters."

	if docker volume inspect "$volume_name" >/dev/null 2>&1; then
		die "ENCRYPTION_KEY is empty but Docker volume $volume_name already exists. Restore the existing key instead of generating a new one."
	fi

	command -v openssl >/dev/null 2>&1 ||
		die "openssl is required to generate a new ENCRYPTION_KEY; install it manually and retry."
	encryption_key=$(openssl rand -hex 32)
	[ -n "$encryption_key" ] || die "Could not generate ENCRYPTION_KEY."
	write_env_value ENCRYPTION_KEY "$encryption_key"
	info "Generated and saved a new ENCRYPTION_KEY without printing it."
fi

exec sh "$DEPLOY_DIR/deploy.sh" "$requested_version"
