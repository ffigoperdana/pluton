#!/usr/bin/env sh
# Deploy an explicit GHCR release tag or sha256 digest and roll back automatically
# when the new container does not pass its health check.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$SCRIPT_DIR
ENV_FILE="$DEPLOY_DIR/.env"
COMPOSE_FILE="$DEPLOY_DIR/compose.yml"
STATE_FILE="$DEPLOY_DIR/.deploy-state"

. "$SCRIPT_DIR/lib.sh"

usage() {
	printf '%s\n' "Usage: sh deploy.sh <release-tag-or-sha256-digest>" >&2
	exit 2
}

[ "$#" -eq 1 ] || usage
requested_version=$1

case "$requested_version" in
	latest|main) die "Use an immutable release version tag or sha256 digest, never $requested_version." ;;
esac

validate_version "$requested_version"
require_file "$ENV_FILE"
require_file "$COMPOSE_FILE"
chmod 600 "$ENV_FILE"
require_docker
ensure_application_configuration

image_repository=$(read_env_value PLUTON_IMAGE)
target_ref=$(image_ref_for_version "$image_repository" "$requested_version")
current_ref=$(read_env_value PLUTON_IMAGE_REF)
current_version=$(read_env_value PLUTON_VERSION)
previous_ref=
previous_version=

case "$current_ref" in
	"$image_repository":*|"$image_repository"@sha256:*)
		previous_ref=$current_ref
		previous_version=$current_version
		;;
esac

info "Pulling $target_ref."
docker pull "$target_ref"

previous_container=$(service_container_id)
if [ -n "$previous_container" ]; then
	if ! backup_sqlite_after_stop "$previous_container"; then
		die "The existing service could not be stopped and copied safely; its image reference was not changed."
	fi
fi

write_env_value PLUTON_VERSION "$requested_version"
write_env_value PLUTON_IMAGE_REF "$target_ref"

rollback_to_previous() {
	if [ -z "$previous_ref" ]; then
		die "The new container did not become healthy. No previous image is recorded for automatic rollback."
	fi

	info "The new container was unhealthy. Restoring $previous_ref while keeping data and secrets."
	write_env_value PLUTON_VERSION "$previous_version"
	write_env_value PLUTON_IMAGE_REF "$previous_ref"

	if compose up -d --force-recreate && wait_for_healthy; then
		info "Rollback completed and the previous container is healthy."
		exit 1
	fi

	die "The new container was unhealthy and the previous image did not recover. Inspect Docker status before retrying."
}

if ! compose up -d --force-recreate; then
	rollback_to_previous
fi

if ! wait_for_healthy; then
	rollback_to_previous
fi

write_deploy_state "$previous_ref" "$previous_version" "$target_ref" "$requested_version"
info "Deployment completed: $target_ref is healthy."
