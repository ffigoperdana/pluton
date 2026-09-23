#!/usr/bin/env sh
# Recreate the service from the last recorded release image without touching
# the persistent Docker volume or VM-only .env file.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$SCRIPT_DIR
ENV_FILE="$DEPLOY_DIR/.env"
COMPOSE_FILE="$DEPLOY_DIR/compose.yml"
STATE_FILE="$DEPLOY_DIR/.deploy-state"

. "$SCRIPT_DIR/lib.sh"

[ "$#" -eq 0 ] || die "Usage: sh rollback.sh"
require_file "$ENV_FILE"
require_file "$COMPOSE_FILE"
require_file "$STATE_FILE"
chmod 600 "$ENV_FILE" "$STATE_FILE"
require_docker
ensure_application_configuration

previous_ref=$(read_key_value "$STATE_FILE" PREVIOUS_IMAGE_REF)
previous_version=$(read_key_value "$STATE_FILE" PREVIOUS_VERSION)
[ -n "$previous_ref" ] || die "No previous image is recorded in $STATE_FILE."
[ -n "$previous_version" ] || die "No previous version is recorded in $STATE_FILE."
validate_version "$previous_version"

image_repository=$(read_env_value PLUTON_IMAGE)
expected_ref=$(image_ref_for_version "$image_repository" "$previous_version")
[ "$expected_ref" = "$previous_ref" ] ||
	die "The recorded previous image does not match PLUTON_IMAGE and is not safe to apply automatically."

info "Rolling back to $previous_ref. Database schema changes are not reversed."
exec sh "$SCRIPT_DIR/deploy.sh" "$previous_version"
