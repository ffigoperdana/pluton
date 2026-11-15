#!/usr/bin/env bash
# Pluton Agent S3 probe: stage 0 of docs/S3_AGENT_REPOSITORY_DESIGN.md.
#
# Run as a normal user on a future Agent host before an S3 repository is used.
# Inputs come only from S3_PROBE_* environment variables. The keys are never
# printed, written to disk or passed as command arguments. Every check prints
# one closed PASS, FAIL or SKIP line; provider error text is never shown.
# Usage and interpretation: docs/AGENT_S3_PROBE.md
set +o xtrace
set -uo pipefail
IFS=$'\n\t'
umask 077

readonly TOOL='pluton-agent-s3-probe/1'
# Same pinned release as pluton-agent installers/install-agent.sh.
readonly RCLONE_VERSION='1.75.1'
readonly RCLONE_RELEASE_BASE="https://downloads.rclone.org/v${RCLONE_VERSION}"
readonly RCLONE_LINUX_AMD64_SHA256='982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab'
readonly AGENT_RCLONE='/opt/pluton-agent/bin/rclone'
readonly SAFE_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
readonly TRANSFER_LIMIT_SECONDS=3600
readonly REQUEST_LIMIT_SECONDS=60
readonly MIB=1048576

RCLONE_ARGUMENT=''
RCLONE=''
RCLONE_SOURCE=''
RCLONE_FAILURE=''
ENDPOINT=''
HOST=''
PORT=''
DNS_HOST=''
BUCKET=''
PREFIX=''
ACCESS_KEY_ID=''
SECRET_ACCESS_KEY=''
CA_FILE=''
SIZE_MIB=''
SIZE_BYTES=0
WORK_DIR=''
OBJECT_NAME=''
REMOTE_OBJECT=''
PAYLOAD=''
PAYLOAD_SHA256=''
READBACK=''
OBJECT_STATE='none'
REMOVED=''
REMOVE_REASON=''
CA_NEEDED='unknown'
STARTED='no'
RESULT_PRINTED='no'
INTERRUPTED='no'
FAILED='no'
IN_CLEANUP='no'

usage() {
	cat <<'EOF'
Usage: bash agent-s3-probe.sh [--rclone PATH]

Environment (set by the operator; see docs/AGENT_S3_PROBE.md):
  S3_PROBE_ENDPOINT           https:// origin of the S3 endpoint, without a path
  S3_PROBE_BUCKET             bucket (HCP namespace)
  S3_PROBE_PREFIX             prefix inside the bucket (default: probe; never empty)
  S3_PROBE_ACCESS_KEY_ID      access key ID
  S3_PROBE_SECRET_ACCESS_KEY  secret access key
  S3_PROBE_CA_FILE            optional PEM file of a private CA
  S3_PROBE_SIZE_MIB           test object size in MiB, 1 to 192 (default: 64)

Options:
  --rclone PATH  Rclone binary to use. Default: the Agent's private Rclone at
                 /opt/pluton-agent/bin/rclone, otherwise the pinned Rclone 1.75.1
                 release, downloaded to a temporary directory and checked by SHA-256.
  --help         Show this help.

Exit status: 0 every check passed, 1 a check failed, 2 input refused,
129/130/143 interrupted by HUP/INT/TERM.
EOF
}

refuse() {
	printf 'agent-s3-probe: refused: %s\n' "$1" >&2
	exit 2
}

emit() {
	local IFS=' '
	printf '%s\n' "$*"
	if [[ "$1" == FAIL ]]; then FAILED='yes'; fi
}

parse_arguments() {
	while (($#)); do
		case "$1" in
			--rclone)
				(($# >= 2)) || refuse '--rclone needs a path.'
				RCLONE_ARGUMENT="$2"
				shift 2
				;;
			--help | -h)
				usage
				exit 0
				;;
			*) refuse 'unknown argument; see --help.' ;;
		esac
	done
}

require_tools() {
	local tool
	for tool in curl cut date df getent grep head mktemp realpath rm sha256sum stat tail timeout tr uname; do
		command -v "$tool" >/dev/null 2>&1 || refuse "required tool missing: $tool."
	done
}

read_inputs() {
	ENDPOINT="${S3_PROBE_ENDPOINT-}"
	BUCKET="${S3_PROBE_BUCKET-}"
	PREFIX="${S3_PROBE_PREFIX-probe}"
	ACCESS_KEY_ID="${S3_PROBE_ACCESS_KEY_ID-}"
	SECRET_ACCESS_KEY="${S3_PROBE_SECRET_ACCESS_KEY-}"
	CA_FILE="${S3_PROBE_CA_FILE-}"
	SIZE_MIB="${S3_PROBE_SIZE_MIB:-64}"
	# From here on the keys live only in unexported shell variables.
	unset S3_PROBE_ACCESS_KEY_ID S3_PROBE_SECRET_ACCESS_KEY
}

validate_inputs() {
	local endpoint_pattern='^https://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:([0-9]{1,5}))?/?$'
	local bucket_pattern='^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
	local prefix_pattern='^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
	local size_pattern='^[1-9][0-9]{0,2}$'
	local unsafe_pattern='[[:space:][:cntrl:]]'

	[[ -n "$ENDPOINT" ]] || refuse 'S3_PROBE_ENDPOINT is not set.'
	[[ "$ENDPOINT" =~ $endpoint_pattern ]] || refuse 'S3_PROBE_ENDPOINT must be an https:// origin without a path, query or user name.'
	HOST="${BASH_REMATCH[1]}"
	PORT="${BASH_REMATCH[4]}"
	[[ "$HOST" != *..* ]] || refuse 'S3_PROBE_ENDPOINT has an invalid host name.'
	if [[ -n "$PORT" ]] && ((10#$PORT < 1 || 10#$PORT > 65535)); then
		refuse 'S3_PROBE_ENDPOINT has an invalid port.'
	fi
	ENDPOINT="${ENDPOINT%/}"
	DNS_HOST="${HOST#\[}"
	DNS_HOST="${DNS_HOST%\]}"

	[[ "$BUCKET" =~ $bucket_pattern && "$BUCKET" != *..* ]] || refuse 'S3_PROBE_BUCKET must be 3 to 63 lower-case letters, digits, dots or hyphens.'

	PREFIX="${PREFIX#/}"
	PREFIX="${PREFIX%/}"
	[[ -n "$PREFIX" ]] || refuse 'S3_PROBE_PREFIX must name a prefix inside the bucket; the bucket root is never written.'
	[[ "$PREFIX" =~ $prefix_pattern && ${#PREFIX} -le 200 ]] || refuse 'S3_PROBE_PREFIX may use letters, digits, dots, hyphens, underscores and slashes only (200 characters at most).'
	[[ "/$PREFIX/" != *'/./'* && "/$PREFIX/" != *'/../'* ]] || refuse 'S3_PROBE_PREFIX must not contain . or .. segments.'

	[[ -n "$ACCESS_KEY_ID" ]] || refuse 'S3_PROBE_ACCESS_KEY_ID is not set.'
	[[ -n "$SECRET_ACCESS_KEY" ]] || refuse 'S3_PROBE_SECRET_ACCESS_KEY is not set.'
	if [[ "$ACCESS_KEY_ID$SECRET_ACCESS_KEY" =~ $unsafe_pattern ]] || ((${#ACCESS_KEY_ID} > 256 || ${#SECRET_ACCESS_KEY} > 256)); then
		refuse 'the S3 keys must not contain spaces or control characters and must be at most 256 characters.'
	fi

	if [[ -n "$CA_FILE" ]]; then
		[[ -f "$CA_FILE" && -r "$CA_FILE" ]] || refuse 'S3_PROBE_CA_FILE is not a readable file.'
		grep -q -e '-----BEGIN CERTIFICATE-----' -- "$CA_FILE" || refuse 'S3_PROBE_CA_FILE contains no PEM certificate.'
		CA_FILE="$(realpath -- "$CA_FILE")"
	fi

	if ! [[ "$SIZE_MIB" =~ $size_pattern ]] || ((SIZE_MIB > 192)); then
		# Above Rclone's 200 MiB upload cutoff rcat would use a multipart upload.
		refuse 'S3_PROBE_SIZE_MIB must be a whole number from 1 to 192.'
	fi
	SIZE_BYTES=$((SIZE_MIB * MIB))

	if [[ -n "$RCLONE_ARGUMENT" ]]; then
		# A bare name would be validated against the current directory but run through a PATH search.
		[[ "$RCLONE_ARGUMENT" == */* ]] || refuse '--rclone must be a path that contains a /, for example ./rclone.'
		[[ -f "$RCLONE_ARGUMENT" && -x "$RCLONE_ARGUMENT" ]] || refuse '--rclone must name an executable file.'
	fi
}

# Child processes get only what the Agent gives its own children: no proxy and
# no inherited RCLONE_*, SSL_* or CURL_* settings from the operator's shell.
clear_environment() {
	local name
	for name in $(compgen -e); do
		unset "$name" 2>/dev/null || true
	done
	export PATH="$SAFE_PATH" HOME="$WORK_DIR" TMPDIR="$WORK_DIR" LC_ALL=C
}

run_clean() {
	(
		clear_environment
		exec "$@"
	)
}

# Rclone is configured through RCLONE_CONFIG_PROBE_* variables only; nothing is
# written to a configuration file and the keys never appear in an argument list.
run_rclone() {
	local limit="$1"
	shift
	(
		clear_environment
		export RCLONE_CONFIG=/dev/null RCLONE_CACHE_DIR="$WORK_DIR/rclone-cache" \
			RCLONE_CONTIMEOUT=30s RCLONE_TIMEOUT=120s RCLONE_LOW_LEVEL_RETRIES=1 RCLONE_RETRIES=1 \
			RCLONE_CONFIG_PROBE_TYPE=s3 RCLONE_CONFIG_PROBE_PROVIDER=Other \
			RCLONE_CONFIG_PROBE_ENDPOINT="$ENDPOINT" RCLONE_CONFIG_PROBE_ENV_AUTH=false \
			RCLONE_CONFIG_PROBE_FORCE_PATH_STYLE=true RCLONE_CONFIG_PROBE_USE_ACCEPT_ENCODING_GZIP=false \
			RCLONE_CONFIG_PROBE_NO_CHECK_BUCKET=true
		export RCLONE_CONFIG_PROBE_ACCESS_KEY_ID="$ACCESS_KEY_ID" RCLONE_CONFIG_PROBE_SECRET_ACCESS_KEY="$SECRET_ACCESS_KEY"
		if [[ -n "$CA_FILE" ]]; then export SSL_CERT_FILE="$CA_FILE"; fi
		if [[ "$IN_CLEANUP" == yes ]]; then
			# Without --foreground timeout moves Rclone into its own process group, so a
			# terminal Ctrl-C or a job-control HUP aimed at the probe cannot abort the delete.
			exec timeout --kill-after=10 "$limit" "$RCLONE" "$@" </dev/null
		fi
		exec timeout --foreground --kill-after=10 "$limit" "$RCLONE" "$@"
	)
}

now_ms() {
	local ns
	ns="$(date +%s%N)"
	printf '%s' "$((ns / 1000000))"
}

mib_per_s() {
	local bytes="$1" ms="$2" hundredths
	((ms > 0)) || ms=1
	hundredths=$((bytes * 100000 / (ms * MIB)))
	printf '%d.%02d' "$((hundredths / 100))" "$((hundredths % 100))"
}

# Maps an Rclone exit status and its in-memory error text to a closed reason.
# The text itself is never printed or stored.
classify_failure() {
	local status="$1" text="$2"
	if ((status == 124 || status == 137)); then
		printf 'timeout'
		return
	fi
	case "$text" in
		*SignatureDoesNotMatch* | *InvalidAccessKeyId* | *InvalidToken* | *AuthorizationHeaderMalformed*) printf 'authentication' ;;
		*AccessDenied* | *'StatusCode: 403'*) printf 'access-denied' ;;
		*NoSuchBucket*) printf 'bucket-not-found' ;;
		*'x509:'* | *'tls:'*) printf 'tls' ;;
		*'dial tcp: lookup'* | *'no such host'*) printf 'dns' ;;
		*'i/o timeout'* | *'deadline exceeded'* | *'handshake timeout'* | *'Client.Timeout'*) printf 'timeout' ;;
		*'connection refused'* | *'connection reset'* | *'no route to host'* | *'network is unreachable'* | *'broken pipe'* | *EOF*) printf 'connection' ;;
		*'StatusCode: 5'[0-9][0-9]*) printf 'server-error' ;;
		*) printf 'other' ;;
	esac
}

download_rclone() {
	local archive="$WORK_DIR/rclone-v${RCLONE_VERSION}-linux-amd64.zip"
	local url="$RCLONE_RELEASE_BASE/rclone-v${RCLONE_VERSION}-linux-amd64.zip"
	if [[ "$(uname -m)" != x86_64 ]]; then
		RCLONE_FAILURE='unsupported-architecture'
		return 1
	fi
	if ! command -v unzip >/dev/null 2>&1; then
		RCLONE_FAILURE='unzip-missing'
		return 1
	fi
	# --disable MUST be first so a curlrc cannot weaken TLS. This download may use
	# the operator's proxy settings; the S3 checks never do.
	if ! curl --disable --silent --fail --location --max-redirs 5 --proto '=https' --proto-redir '=https' \
		--tlsv1.2 --connect-timeout 30 --max-time 300 --output "$archive" "$url" 2>/dev/null; then
		RCLONE_FAILURE='download-failed'
		return 1
	fi
	if ! printf '%s  %s\n' "$RCLONE_LINUX_AMD64_SHA256" "$archive" | sha256sum --check --status -; then
		RCLONE_FAILURE='checksum-mismatch'
		return 1
	fi
	if ! unzip -q "$archive" -d "$WORK_DIR/rclone-release" 2>/dev/null; then
		RCLONE_FAILURE='extract-failed'
		return 1
	fi
	rm -f -- "$archive"
	RCLONE="$WORK_DIR/rclone-release/rclone-v${RCLONE_VERSION}-linux-amd64/rclone"
	if [[ ! -f "$RCLONE" ]]; then
		RCLONE_FAILURE='extract-failed'
		return 1
	fi
	if [[ ! -x "$RCLONE" ]]; then
		# Typically TMPDIR on a noexec mount; see docs/AGENT_S3_PROBE.md.
		RCLONE_FAILURE='not-executable'
		return 1
	fi
}

check_rclone() {
	local output version status=0 pinned='no' version_pattern='^rclone (v[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.-]*)$'
	if [[ -n "$RCLONE_ARGUMENT" ]]; then
		RCLONE="$RCLONE_ARGUMENT"
		RCLONE_SOURCE='argument'
	elif [[ -f "$AGENT_RCLONE" && -x "$AGENT_RCLONE" ]]; then
		RCLONE="$AGENT_RCLONE"
		RCLONE_SOURCE='agent'
	else
		RCLONE_SOURCE='download'
		if ! download_rclone; then
			emit FAIL rclone 'source=download' "reason=$RCLONE_FAILURE"
			return 1
		fi
	fi
	output="$(run_rclone 30 version 2>/dev/null)" || status=$?
	if ((status == 126)); then
		# Found but not runnable: a noexec mount or a binary for another architecture.
		emit FAIL rclone "source=$RCLONE_SOURCE" 'reason=not-executable'
		return 1
	fi
	version="${output%%$'\n'*}"
	if ! [[ "$version" =~ $version_pattern ]]; then
		emit FAIL rclone "source=$RCLONE_SOURCE" 'reason=no-version'
		return 1
	fi
	version="${BASH_REMATCH[1]}"
	if [[ "$version" == "v$RCLONE_VERSION" ]]; then pinned='yes'; fi
	if [[ "$RCLONE_SOURCE" == download && "$pinned" != yes ]]; then
		emit FAIL rclone "version=$version" 'source=download' 'reason=version-mismatch'
		return 1
	fi
	emit PASS rclone "version=$version" "source=$RCLONE_SOURCE" "pinned=$pinned"
}

check_dns() {
	local start elapsed output status=0 address total=0 ipv4=0 ipv6=0
	local -A seen=()
	start="$(now_ms)"
	output="$(run_clean timeout 20 getent ahosts "$DNS_HOST" 2>/dev/null)" || status=$?
	elapsed=$(($(now_ms) - start))
	if ((status != 0)) || [[ -z "$output" ]]; then
		if ((status == 124)); then
			emit FAIL dns 'reason=timeout' "elapsed_ms=$elapsed"
		else
			emit FAIL dns 'reason=not-found' "elapsed_ms=$elapsed"
		fi
		return 1
	fi
	while IFS=' ' read -r address _; do
		[[ -n "$address" && -z "${seen[$address]+x}" ]] || continue
		seen[$address]=1
		total=$((total + 1))
		if [[ "$address" == *:* ]]; then ipv6=$((ipv6 + 1)); else ipv4=$((ipv4 + 1)); fi
	done <<<"$output"
	emit PASS dns "addresses=$total" "ipv4=$ipv4" "ipv6=$ipv6" "elapsed_ms=$elapsed"
}

# One HTTPS request to the endpoint origin with curl, never with -k. Prints
# "<curl exit status> <OpenSSL verify result> <curl error message>" for
# tls_reason; the caller keeps it in memory and never prints it.
tls_attempt() {
	local ca_file="$1" outcome status=0
	local -a trust=()
	if [[ -n "$ca_file" ]]; then trust=(--cacert "$ca_file"); fi
	outcome="$(run_clean curl --disable --silent --output /dev/null --noproxy '*' --proto '=https' \
		--tlsv1.2 --connect-timeout 15 --max-time 30 "${trust[@]}" \
		--write-out '%{ssl_verify_result} %{errormsg}' "$ENDPOINT/" 2>/dev/null)" || status=$?
	printf '%s %s' "$status" "${outcome:-0}"
}

tls_reason() {
	local status="$1" verify="$2" message="$3"
	case "$status" in
		0) printf 'ok' ;;
		6) printf 'dns' ;;
		7) printf 'connection' ;;
		28) printf 'timeout' ;;
		35) printf 'handshake' ;;
		51) printf 'hostname-mismatch' ;;
		60)
			# curl checks the host name after a verified handshake, so the verify
			# result does not name that case; its error message does.
			case "$message" in
				*'subject name'* | *'does not match target host'*) printf 'hostname-mismatch' ;;
				*)
					case "$verify" in
						9) printf 'certificate-not-yet-valid' ;;
						10) printf 'certificate-expired' ;;
						2 | 18 | 19 | 20 | 21 | 27) printf 'certificate-not-trusted' ;;
						62) printf 'hostname-mismatch' ;;
						*) printf 'certificate-rejected' ;;
					esac
					;;
			esac
			;;
		77) printf 'ca-file-unreadable' ;;
		*) printf 'other' ;;
	esac
}

check_tls() {
	local status verify message system_reason reason system_trust='no' ca_state='not-set'
	IFS=' ' read -r status verify message <<<"$(tls_attempt '')"
	system_reason="$(tls_reason "$status" "$verify" "$message")"
	if [[ "$system_reason" == ok ]]; then system_trust='yes'; fi
	reason="$system_reason"
	if [[ -n "$CA_FILE" ]]; then
		IFS=' ' read -r status verify message <<<"$(tls_attempt "$CA_FILE")"
		reason="$(tls_reason "$status" "$verify" "$message")"
		if [[ "$reason" == ok ]]; then ca_state='yes'; else ca_state='no'; fi
	fi
	if [[ "$system_trust" == yes ]]; then
		CA_NEEDED='no'
	elif [[ "$system_reason" == certificate-not-trusted && ("$ca_state" == not-set || "$ca_state" == yes) ]]; then
		CA_NEEDED='yes'
	else
		CA_NEEDED='unknown'
	fi
	if [[ "$system_trust" == yes || "$ca_state" == yes ]]; then
		emit PASS tls "system_trust=$system_trust" "ca_file=$ca_state"
		return 0
	fi
	emit FAIL tls "system_trust=$system_trust" "ca_file=$ca_state" "reason=$reason"
	return 1
}

# Read-only credential check before anything is written: a non-recursive listing
# of the prefix. A missing prefix is fine (an empty listing or Rclone status 3).
# Without it a 403 sent while the body is still uploading can surface as a
# connection reset, which would hide an authentication failure.
check_auth() {
	local status=0 err
	err="$(run_rclone "$REQUEST_LIMIT_SECONDS" lsf --max-depth 1 "probe:$BUCKET/$PREFIX/" 2>&1 >/dev/null)" || status=$?
	if ((status == 0 || status == 3)); then
		emit PASS auth
		return 0
	fi
	emit FAIL auth "reason=$(classify_failure "$status" "$err")"
	err=''
	return 1
}

check_write() {
	local start elapsed status=0 err avail_kib need_kib reason
	avail_kib="$(df --output=avail -k -- "$WORK_DIR" 2>/dev/null | tail -n 1 | tr -d ' ')"
	need_kib=$((2 * SIZE_MIB * 1024 + 16 * 1024))
	if ! [[ "$avail_kib" =~ ^[0-9]+$ ]] || ((avail_kib < need_kib)); then
		emit FAIL write 'reason=insufficient-temp-space'
		return 1
	fi
	PAYLOAD="$WORK_DIR/payload.bin"
	if ! head -c "$SIZE_BYTES" /dev/urandom >"$PAYLOAD"; then
		emit FAIL write 'reason=payload-failed'
		return 1
	fi
	PAYLOAD_SHA256="$(sha256sum -- "$PAYLOAD" | cut -d ' ' -f 1)"
	OBJECT_STATE='maybe'
	start="$(now_ms)"
	err="$(run_rclone "$TRANSFER_LIMIT_SECONDS" rcat --size "$SIZE_BYTES" "$REMOTE_OBJECT" <"$PAYLOAD" 2>&1 >/dev/null)" || status=$?
	elapsed=$(($(now_ms) - start))
	if ((status == 0)); then
		OBJECT_STATE='present'
		emit PASS write "bytes=$SIZE_BYTES" "elapsed_ms=$elapsed" "mib_per_s=$(mib_per_s "$SIZE_BYTES" "$elapsed")"
		return 0
	fi
	reason="$(classify_failure "$status" "$err")"
	err=''
	case "$reason" in
		# The endpoint refused the request before storing anything.
		authentication | access-denied | bucket-not-found | tls | dns) OBJECT_STATE='none' ;;
	esac
	emit FAIL write "reason=$reason"
	return 1
}

check_read() {
	local start elapsed status=0 err bytes
	READBACK="$WORK_DIR/readback.bin"
	start="$(now_ms)"
	err="$(run_rclone "$TRANSFER_LIMIT_SECONDS" cat "$REMOTE_OBJECT" 2>&1 >"$READBACK")" || status=$?
	elapsed=$(($(now_ms) - start))
	if ((status != 0)); then
		emit FAIL read "reason=$(classify_failure "$status" "$err")"
		err=''
		return 1
	fi
	bytes="$(stat -c %s -- "$READBACK")"
	emit PASS read "bytes=$bytes" "elapsed_ms=$elapsed" "mib_per_s=$(mib_per_s "$bytes" "$elapsed")"
}

check_compare() {
	local bytes digest
	bytes="$(stat -c %s -- "$READBACK")"
	digest="$(sha256sum -- "$READBACK" | cut -d ' ' -f 1)"
	rm -f -- "$PAYLOAD" "$READBACK"
	if ((bytes != SIZE_BYTES)); then
		emit FAIL compare 'reason=size-mismatch'
		return 1
	fi
	if [[ "$digest" != "$PAYLOAD_SHA256" ]]; then
		emit FAIL compare 'reason=sha256-mismatch'
		return 1
	fi
	emit PASS compare 'sha256=match'
}

# Deletes the test object and confirms it is no longer listed. Sets REMOVED to
# removed or absent, or REMOVE_REASON on failure.
remove_test_object() {
	local status=0 err listing
	REMOVED=''
	REMOVE_REASON=''
	err="$(run_rclone "$REQUEST_LIMIT_SECONDS" deletefile "$REMOTE_OBJECT" 2>&1 >/dev/null)" || status=$?
	case "$status" in
		0) REMOVED='removed' ;;
		4) REMOVED='absent' ;; # Rclone exit status 4: object not found.
		*)
			REMOVE_REASON="$(classify_failure "$status" "$err")"
			return 1
			;;
	esac
	err=''
	status=0
	listing="$(run_rclone "$REQUEST_LIMIT_SECONDS" lsf --files-only --max-depth 1 --include "/$OBJECT_NAME" "probe:$BUCKET/$PREFIX/" 2>/dev/null)" || status=$?
	# Status 3 (directory not found) proves the object is absent, as in check_auth.
	if ((status != 0 && status != 3)); then
		REMOVE_REASON='listing-failed'
		return 1
	fi
	if [[ -n "$listing" ]]; then
		REMOVE_REASON='still-listed'
		return 1
	fi
	OBJECT_STATE='none'
}

check_delete() {
	if remove_test_object; then
		emit PASS delete "object=$REMOVED"
		return 0
	fi
	# Reported once here; the exit trap does not try again.
	OBJECT_STATE='none'
	emit FAIL delete "reason=$REMOVE_REASON" "object_key=$PREFIX/$OBJECT_NAME"
	return 1
}

check_object_round_trip() {
	if ! check_write; then
		emit SKIP read 'reason=earlier-failure'
		emit SKIP compare 'reason=earlier-failure'
		if [[ "$OBJECT_STATE" == none ]]; then
			emit SKIP delete 'reason=not-created'
		else
			check_delete
		fi
		return
	fi
	if check_read; then
		check_compare
	else
		emit SKIP compare 'reason=earlier-failure'
	fi
	check_delete
}

run_checks() {
	local can_write='yes'
	check_rclone || can_write='no'
	if check_dns; then
		check_tls || can_write='no'
	else
		emit SKIP tls 'reason=earlier-failure'
		can_write='no'
	fi
	if [[ "$can_write" != yes ]]; then
		emit SKIP write 'reason=earlier-failure'
		emit SKIP read 'reason=earlier-failure'
		emit SKIP compare 'reason=earlier-failure'
		emit SKIP delete 'reason=earlier-failure'
		return
	fi
	if ! check_auth; then
		emit SKIP write 'reason=auth-failed'
		emit SKIP read 'reason=earlier-failure'
		emit SKIP compare 'reason=earlier-failure'
		emit SKIP delete 'reason=not-created'
		return
	fi
	check_object_round_trip
}

result_line() {
	local -a facts=("storage_ca_file_needed=$CA_NEEDED")
	if [[ "$INTERRUPTED" == yes ]]; then facts+=('interrupted=yes'); fi
	emit RESULT "$1" "${facts[@]}"
	RESULT_PRINTED='yes'
}

on_exit() {
	local status=$?
	trap - EXIT
	# Cleanup is bounded by REQUEST_LIMIT_SECONDS per call; do not let a second
	# interrupt leave the test object or the temporary directory behind. The
	# cleanup Rclone calls also leave the terminal's process group (IN_CLEANUP).
	# PIPE: a closed output pipe (tee died on Ctrl-C) must not stop the cleanup.
	trap '' INT TERM HUP PIPE
	IN_CLEANUP='yes'
	if [[ "$OBJECT_STATE" != none ]]; then
		if remove_test_object; then
			emit PASS cleanup "object=$REMOVED"
		else
			emit FAIL cleanup "reason=$REMOVE_REASON" "object_key=$PREFIX/$OBJECT_NAME"
		fi
		((status != 0)) || status=1
	fi
	if [[ "$STARTED" == yes && "$RESULT_PRINTED" != yes ]]; then
		result_line FAIL
		((status != 0)) || status=1
	fi
	if [[ "$WORK_DIR" == */pluton-agent-s3-probe.* && -d "$WORK_DIR" ]]; then
		rm -rf -- "$WORK_DIR"
	fi
	exit "$status"
}

main() {
	parse_arguments "$@"
	require_tools
	read_inputs
	validate_inputs
	trap on_exit EXIT
	trap 'INTERRUPTED=yes; exit 130' INT
	trap 'INTERRUPTED=yes; exit 143' TERM
	trap 'INTERRUPTED=yes; exit 129' HUP
	WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pluton-agent-s3-probe.XXXXXXXX")" || refuse 'cannot create a temporary directory.'
	OBJECT_NAME="pluton-probe-$(date -u +%Y%m%dT%H%M%SZ)-$(head -c 16 /dev/urandom | sha256sum | cut -c 1-16)"
	REMOTE_OBJECT="probe:$BUCKET/$PREFIX/$OBJECT_NAME"
	STARTED='yes'
	emit "$TOOL" "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" "size_mib=$SIZE_MIB"
	run_checks
	if [[ "$FAILED" == yes ]]; then
		result_line FAIL
		exit 1
	fi
	result_line PASS
	exit 0
}

main "$@"
