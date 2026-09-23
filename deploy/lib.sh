#!/usr/bin/env sh
# Shared helpers for the versioned Docker Compose deployment scripts.

set -eu

die() {
	printf '%s\n' "ERROR: $*" >&2
	exit 1
}

info() {
	printf '%s\n' "$*"
}

script_dir() {
	CDPATH= cd -- "$(dirname -- "$1")" && pwd
}

require_docker() {
	command -v docker >/dev/null 2>&1 || die "Docker Engine is required."
	docker version >/dev/null 2>&1 || die "Docker Engine is not available to this user."
	docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is required."
}

require_file() {
	[ -f "$1" ] || die "Required file is missing: $1"
}

read_key_value() {
	file=$1
	key=$2
	[ -f "$file" ] || return 0
	awk -v key="$key" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' "$file" | tr -d '\r'
}

read_env_value() {
	read_key_value "$ENV_FILE" "$1"
}

write_env_value() {
	key=$1
	value=$2
	temp_file="$ENV_FILE.tmp.$$"

	umask 077
	awk -v key="$key" -v value="$value" '
		index($0, key "=") == 1 {
			print key "=" value
			found = 1
			next
		}
		{ print }
		END {
			if (!found) print key "=" value
		}
	' "$ENV_FILE" > "$temp_file"
	chmod 600 "$temp_file"
	mv "$temp_file" "$ENV_FILE"
	chmod 600 "$ENV_FILE"
}

validate_image_repository() {
	image_repository=$1
	printf '%s' "$image_repository" | grep -Eq '^ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$' ||
		die "PLUTON_IMAGE must be a lower-case GHCR repository such as ghcr.io/owner/repository."
}

is_digest() {
	printf '%s' "$1" | grep -Eq '^sha256:[A-Fa-f0-9]{64}$'
}

validate_version() {
	version=$1
	if is_digest "$version"; then
		return 0
	fi

	printf '%s' "$version" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' ||
		die "Version must be a Docker tag or a sha256 digest."
}

image_ref_for_version() {
	image_repository=$1
	version=$2
	if is_digest "$version"; then
		printf '%s@%s\n' "$image_repository" "$version"
	else
		printf '%s:%s\n' "$image_repository" "$version"
	fi
}

ensure_application_configuration() {
	image_repository=$(read_env_value PLUTON_IMAGE)
	encryption_key=$(read_env_value ENCRYPTION_KEY)
	user_name=$(read_env_value USER_NAME)
	user_password=$(read_env_value USER_PASSWORD)
	key_length=$(printf '%s' "$encryption_key" | wc -c | tr -d ' ')

	validate_image_repository "$image_repository"
	[ "$key_length" -ge 12 ] || die "ENCRYPTION_KEY must be set and contain at least 12 characters."
	[ -n "$user_name" ] || die "USER_NAME must be set in $ENV_FILE."
	case "$user_password" in
		''|CHANGE_ME*|your-*|example-*) die "Set a strong USER_PASSWORD in $ENV_FILE before starting Pluton." ;;
	esac
}

compose() {
	docker compose --project-directory "$DEPLOY_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

service_container_id() {
	compose ps -q --all pluton 2>/dev/null || true
}

wait_for_healthy() {
	attempts=$(read_env_value PLUTON_HEALTH_ATTEMPTS)
	case "$attempts" in
		'' ) attempts=30 ;;
		*[!0-9]* ) die "PLUTON_HEALTH_ATTEMPTS must be a positive integer." ;;
	esac
	[ "$attempts" -gt 0 ] || die "PLUTON_HEALTH_ATTEMPTS must be a positive integer."

	count=1
	while [ "$count" -le "$attempts" ]; do
		container_id=$(service_container_id)
		if [ -n "$container_id" ]; then
			health_status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || true)
			if [ "$health_status" = "healthy" ]; then
				health_body=$(docker exec "$container_id" wget -qO- --timeout=5 http://127.0.0.1:5173/api/health 2>/dev/null || true)
				case "$health_body" in
					*'"status":"healthy"'*) return 0 ;;
				esac
			fi
		fi
		sleep 2
		count=$((count + 1))
	done

	return 1
}

backup_sqlite_after_stop() {
	container_id=$1
	[ -n "$container_id" ] || return 0

	compose stop --timeout 30 pluton || return 1

	timestamp=$(date -u +%Y%m%dT%H%M%SZ)
	backup_dir="$DEPLOY_DIR/backups/$timestamp"
	umask 077
	mkdir -p "$backup_dir"
	chmod 700 "$backup_dir"

	if docker cp "$container_id:/data/db/pluton.db" "$backup_dir/pluton.db" >/dev/null 2>&1; then
		chmod 600 "$backup_dir/pluton.db"
		docker cp "$container_id:/data/db/pluton.db-wal" "$backup_dir/pluton.db-wal" >/dev/null 2>&1 || true
		docker cp "$container_id:/data/db/pluton.db-shm" "$backup_dir/pluton.db-shm" >/dev/null 2>&1 || true
		chmod 600 "$backup_dir"/pluton.db-* 2>/dev/null || true
		info "Saved a stopped SQLite database copy in $backup_dir."
	else
		info "No existing SQLite database was found; skipping the pre-deploy database copy."
	fi
}

write_deploy_state() {
	previous_ref=$1
	previous_version=$2
	current_ref=$3
	current_version=$4
	temp_file="$STATE_FILE.tmp.$$"

	umask 077
	{
		printf '%s\n' "# Deployment image history; contains no application secrets."
		printf '%s\n' "PREVIOUS_IMAGE_REF=$previous_ref"
		printf '%s\n' "PREVIOUS_VERSION=$previous_version"
		printf '%s\n' "LAST_SUCCESSFUL_IMAGE_REF=$current_ref"
		printf '%s\n' "LAST_SUCCESSFUL_VERSION=$current_version"
	} > "$temp_file"
	chmod 600 "$temp_file"
	mv "$temp_file" "$STATE_FILE"
	chmod 600 "$STATE_FILE"
}
