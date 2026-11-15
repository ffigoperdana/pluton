# S3 Agent Repository, Stage 0 Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator one bash script, `scripts/diagnostics/agent-s3-probe.sh`, that runs on a future Agent host (Ubuntu 22.04 or 24.04, no Node, no Agent yet) and reports, as closed PASS/FAIL facts, whether the HCP S3 endpoint resolves, whether its certificate verifies with the system trust store (which decides `PLUTON_AGENT_STORAGE_CA_FILE`), whether one 64 MiB object can be written, read back, compared and deleted under a dedicated prefix, the upload and download MiB/s, and which Rclone was used. This is stage 0 of `docs/S3_AGENT_REPOSITORY_DESIGN.md` (sections 5 and 6.6).

**Architecture:** A self-contained bash script with no dependencies beyond standard Ubuntu tools. Inputs come only from `S3_PROBE_*` environment variables; the keys are copied into unexported shell variables and reach Rclone only as `RCLONE_CONFIG_PROBE_*` variables of a child that starts from an empty environment (`RCLONE_CONFIG=/dev/null`). Rclone is `--rclone PATH`, else the Agent's private `/opt/pluton-agent/bin/rclone`, else the Agent installer's pinned Rclone 1.75.1 downloaded into a `mktemp` directory and checked by SHA-256. TLS is judged with curl (never `-k`). An EXIT trap deletes the test object and the temporary directory on every exit. A Python lab runner builds an Ubuntu lab image, starts an HTTPS `rclone serve s3` fixture with a throwaway private CA on an internal Docker network, and runs 16 scenarios against the probe with test doubles for Rclone.

**Tech Stack:** bash 5.1+/coreutils/curl/getent (probe); Rclone 1.75.1 (pinned, from `pluton-agent` `installers/install-agent.sh`); Python 3 standard library and Docker (lab runner); OpenSSL in the lab image (throwaway CA); GitHub Actions `container.yml` (CI).

## Global Constraints

- Work only on branch `claude/agent-s3-probe`, created from `origin/main` in a clean worktree; commit locally, never push, merge, open a PR or deploy (the user pushes).
- Synthetic values only in code, tests, docs and commit messages: `s3.example.internal`, `s3-alt.example.internal`, `missing.example.internal`, `bucket-01`, `SYNTHETICKEY01`, `synthetic-secret-key-01`, `wrong-synthetic-secret-01`; never a production endpoint, namespace, host name or key.
- The probe never prints, logs, writes to a file or passes as a command argument `S3_PROBE_ACCESS_KEY_ID` or `S3_PROBE_SECRET_ACCESS_KEY`.
- Rclone is configured only through `RCLONE_CONFIG_PROBE_*` environment variables with `RCLONE_CONFIG=/dev/null`, `provider=Other`, `force_path_style=true`, `use_accept_encoding_gzip=false`, `no_check_bucket=true`, `env_auth=false`.
- Probe output is closed facts only: `PASS|FAIL|SKIP <check> key=value...` and `RESULT PASS|FAIL key=value...`; never provider error text, the endpoint or the bucket.
- curl never runs with `-k`/`--insecure`; the S3 checks never use a proxy (the Agent does not pass proxy variables to Restic and Rclone).
- The bucket root is never written; an empty or `/` prefix is refused before any network access.
- The pinned Rclone version (`1.75.1`), URL pattern (`https://downloads.rclone.org/v1.75.1/rclone-v1.75.1-linux-amd64.zip`) and SHA-256 (`982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab`) must equal `pluton-agent` `installers/install-agent.sh`.
- In Git Bash, `docker` commands with container paths run with `MSYS_NO_PATHCONV=1` (the smoke test exports it; the Python runner calls Docker directly and needs nothing); Python runs as `py -3` on Windows and `python3` on Linux/CI.
- Do not weaken, skip or re-word a test expectation to make it pass; if a scenario fails for an unexplained reason, stop and report it as BLOCKED with the closed output.
- No change to `backend/`, `frontend/`, `agent/`, `deploy/`, migrations or `.githooks/`; no migration, no Agent update or re-enrollment.
- Commits: explicit `git add <paths>` (never `git add .`), `git diff --cached --check` before each commit, Conventional Commit messages, no `Co-Authored-By` or AI attribution lines, do not bypass the local commit hooks.

---

## Before you start

- **Worktree.** The worktree that holds this plan (`.claude/worktrees/goofy-shirley-53b716`, branch `claude/s3-agent-repository-design`) has uncommitted design-document edits, and `docs/S3_AGENT_REPOSITORY_DESIGN.md` is not on `origin/main` yet. Do not switch branches there. Task 1 creates a separate worktree.
- **Downloads during the lab.** Building the lab image pulls `ubuntu:22.04` (and `ubuntu:24.04` in Task 5), runs `apt-get` for `ca-certificates curl openssl unzip`, and downloads the pinned Rclone zip (about 25 MB) from `downloads.rclone.org`, which the Dockerfile checks against the pinned SHA-256 before extracting it.
- **Established while writing this plan** (prototype in a scratch directory, local Docker, Rclone 1.75.1 from a local Pluton image, Ubuntu 22.04.5 with bash 5.1.16): the probe script and the lab runner below passed 15 of 16 scenarios against a stand-in image that had a fake `curl` and no `unzip`; the 16th (`download-unavailable`) needs `unzip`, which the real lab image installs. Also established: `rclone serve s3` rejects `RCLONE_AUTH_KEY=id,secret` (the environment form splits on the comma), so the fixture passes `--auth-key`; `COPY --chmod` also applies its mode to directories it creates, so `/opt/lab` must exist first; `rclone rcat --size` uploads with one PUT; `rclone deletefile` exits 4 for a missing object; a wrong secret on PUT returns `SignatureDoesNotMatch` (403); Rclone with `SSL_CERT_FILE` verifies the lab CA; `kill -INT 0` from a test double reproduces Ctrl-C and the probe's trap deletes the object.
- **Not yet established:** the real curl results that map to `certificate-not-trusted` and `hostname-mismatch` (scenarios `tls-without-ca` and `hostname-mismatch`), the real lab image build, Ubuntu 24.04 and CI. If one of those scenarios fails, use superpowers:systematic-debugging: run curl by hand in the lab image with `--write-out '%{ssl_verify_result} %{errormsg}'` and compare with `tls_reason`. Fix the mapping in the probe, not the expectation.

## File structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `.gitattributes` | Modify | Force LF for the probe and the lab files, which run on Linux |
| `scripts/diagnostics/agent-s3-probe.sh` | Create | The operator probe (stage 0) |
| `scripts/diagnostics/test/agent-s3-probe/Dockerfile` | Create | Lab image: Ubuntu, curl, CA store, unzip, openssl, pinned Rclone at `/opt/lab/rclone` |
| `scripts/diagnostics/test/agent-s3-probe/pki.sh` | Create | Throwaway private CA and server certificate for `s3.example.internal` |
| `scripts/diagnostics/test/agent-s3-probe/serve-fixture.sh` | Create | HTTPS `rclone serve s3` fixture on port 9443 with `bucket-01` and the synthetic keys |
| `scripts/diagnostics/test/agent-s3-probe/run-probe.sh` | Create | Lab entry point: runs the probe, reports leftovers and key leaks to argv |
| `scripts/diagnostics/test/agent-s3-probe/rclone-recording.sh` | Create | Test double: records Rclone argv, then runs the real Rclone |
| `scripts/diagnostics/test/agent-s3-probe/rclone-cat-fails.sh` | Create | Test double: the read fails with provider-like text |
| `scripts/diagnostics/test/agent-s3-probe/rclone-cat-interrupted.sh` | Create | Test double: Ctrl-C during the read |
| `scripts/validate-agent-s3-probe.py` | Create | Lab runner: static checks, image build, fixture, 16 scenarios, cleanup |
| `docs/AGENT_S3_PROBE.md` | Create | Operator steps, result reference, CA-file decision, validation, limitations |
| `.github/workflows/container.yml` | Modify | Static checks in the validate job, the lab in the build job |

---

## Task 1: Lab image and HTTPS S3 fixture

**Files:**
- Modify: `.gitattributes`
- Create: `scripts/diagnostics/test/agent-s3-probe/Dockerfile`
- Create: `scripts/diagnostics/test/agent-s3-probe/pki.sh`
- Create: `scripts/diagnostics/test/agent-s3-probe/serve-fixture.sh`
- Create: `scripts/diagnostics/test/agent-s3-probe/run-probe.sh`
- Create: `scripts/diagnostics/test/agent-s3-probe/rclone-recording.sh`
- Create: `scripts/diagnostics/test/agent-s3-probe/rclone-cat-fails.sh`
- Create: `scripts/diagnostics/test/agent-s3-probe/rclone-cat-interrupted.sh`

**Interfaces:**
- Image tag `pluton-agent-s3-probe-lab:ubuntu-22.04` (build arg `BASE_IMAGE`, default `ubuntu:22.04`; `ARG RCLONE_VERSION` and `ARG RCLONE_LINUX_AMD64_SHA256` lines are read by the runner's static check).
- `/opt/lab/rclone`: pinned Rclone 1.75.1.
- `/opt/lab/pki.sh`: needs volumes at `/pki` and `/ca`; writes `/pki/server-chain.pem` (0644), `/pki/server.key` (0600), `/ca/ca.pem` (0644).
- `/opt/lab/serve-fixture.sh`: needs `/pki` (read-only) and a writable `/srv/s3`; serves HTTPS on `:9443`, bucket `bucket-01`, key pair `SYNTHETICKEY01`/`synthetic-secret-key-01`.
- `/opt/lab/run-probe.sh [--install-agent-rclone] [probe arguments...]`: runs `/work/agent-s3-probe.sh`, exits with its status, prints `LAB-TEMP-LEFT` or `LAB-ARGV-LEAK` on stderr when applicable.
- Test doubles append each argument list to `/tmp/lab-rclone-argv`.

- [ ] **Step 1: Create the worktree and the branch**

Run in Git Bash:

```bash
cd /c/laragon/www/pluton
git fetch origin
git worktree add --detach .claude/worktrees/agent-s3-probe origin/main
cd /c/laragon/www/pluton/.claude/worktrees/agent-s3-probe
git switch -c claude/agent-s3-probe --no-track origin/main
git status --short --branch
```

Expected: `Switched to a new branch 'claude/agent-s3-probe'`, then `## claude/agent-s3-probe` and nothing else. All later commands run in this directory.

- [ ] **Step 2: Write the failing fixture smoke test**

This is the test for Task 1. It lives in `tmp/`, which `.gitignore` excludes, and is not committed; the Task 2 runner covers the same ground. Create `tmp/agent-s3-probe-smoke.sh`:

```bash
#!/usr/bin/env bash
# Task 1 smoke test for the Agent S3 probe lab fixture. Not committed: tmp/ is ignored.
set -u
export MSYS_NO_PATHCONV=1
IMAGE='pluton-agent-s3-probe-lab:ubuntu-22.04'
N='pluton-s3probe-smoke01'
cleanup() {
	docker rm -f "$N-s3" >/dev/null 2>&1
	docker volume rm "$N-pki" "$N-ca" >/dev/null 2>&1
	docker network rm "$N" >/dev/null 2>&1
}
trap cleanup EXIT
docker build -t "$IMAGE" scripts/diagnostics/test/agent-s3-probe || exit 1
docker network create --internal "$N" >/dev/null || exit 1
docker volume create "$N-pki" >/dev/null || exit 1
docker volume create "$N-ca" >/dev/null || exit 1
docker run --rm --network none --mount "type=volume,source=$N-pki,target=/pki" --mount "type=volume,source=$N-ca,target=/ca" "$IMAGE" /opt/lab/pki.sh || exit 1
docker run -d --name "$N-s3" --network "$N" --network-alias s3.example.internal --read-only --cap-drop ALL --tmpfs /tmp --tmpfs /srv/s3:rw,size=64m --mount "type=volume,source=$N-pki,target=/pki,readonly" "$IMAGE" /opt/lab/serve-fixture.sh >/dev/null || exit 1
docker run --rm --network "$N" --user 1000:1000 --mount "type=volume,source=$N-ca,target=/ca,readonly" "$IMAGE" bash -c 'for i in $(seq 1 60); do curl --silent --output /dev/null --cacert /ca/ca.pem https://s3.example.internal:9443/ && break; sleep 0.5; done; curl --silent --output /dev/null --cacert /ca/ca.pem https://s3.example.internal:9443/; echo "with-ca=$?"; curl --silent --output /dev/null https://s3.example.internal:9443/; echo "system-trust=$?"; /opt/lab/rclone version | head -n 1'
```

- [ ] **Step 3: Run the smoke test and see it fail**

```bash
bash tmp/agent-s3-probe-smoke.sh; echo "exit=$?"
```

Expected: `docker build` fails with `unable to prepare context: path "scripts/diagnostics/test/agent-s3-probe" not found`, then `exit=1`.

- [ ] **Step 4: Force LF line endings for the probe and the lab files**

Append these lines to the end of `.gitattributes`:

```gitattributes
# The Agent S3 probe and its lab files run on Linux
scripts/diagnostics/*.sh text eol=lf
scripts/diagnostics/test/agent-s3-probe/* text eol=lf
```

- [ ] **Step 5: Create the lab Dockerfile**

Create `scripts/diagnostics/test/agent-s3-probe/Dockerfile`:

```dockerfile
# Disposable lab image for scripts/validate-agent-s3-probe.py. Synthetic data only.
# An Ubuntu host like a future Agent host (curl, the system CA store, unzip) plus
# the Rclone release the Agent installer pins, checked against the same SHA-256.
ARG BASE_IMAGE=ubuntu:22.04
FROM ${BASE_IMAGE}
ARG RCLONE_VERSION=1.75.1
ARG RCLONE_LINUX_AMD64_SHA256=982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab
RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl openssl unzip \
	&& rm -rf /var/lib/apt/lists/*
RUN set -eu; \
	curl --disable --silent --show-error --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
		--output /tmp/rclone.zip "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-amd64.zip"; \
	printf '%s  %s\n' "${RCLONE_LINUX_AMD64_SHA256}" /tmp/rclone.zip | sha256sum --check --status -; \
	unzip -q /tmp/rclone.zip -d /tmp/rclone; \
	install -d -m 0755 /opt/lab; \
	install -m 0755 "/tmp/rclone/rclone-v${RCLONE_VERSION}-linux-amd64/rclone" /opt/lab/rclone; \
	rm -rf /tmp/rclone /tmp/rclone.zip; \
	/opt/lab/rclone version | head -n 1
# /opt/lab exists already: COPY --chmod would also apply the mode to directories it creates.
COPY --chmod=0755 pki.sh serve-fixture.sh run-probe.sh rclone-recording.sh rclone-cat-fails.sh rclone-cat-interrupted.sh /opt/lab/
```

- [ ] **Step 6: Create the PKI script and the fixture**

Create `scripts/diagnostics/test/agent-s3-probe/pki.sh`:

```sh
#!/bin/sh
# Lab only: a throwaway private CA and a server certificate for s3.example.internal.
# /pki (fixture side) receives the server key and chain, /ca (probe side) only the
# public CA certificate. The CA key never leaves this container.
set -eu
umask 077
work="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=pluton-probe-lab-ca' \
	-keyout "$work/ca.key" -out /ca/ca.pem \
	-addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=s3.example.internal' \
	-keyout /pki/server.key -out "$work/server.csr" 2>/dev/null
printf '%s\n' 'subjectAltName=DNS:s3.example.internal' 'basicConstraints=critical,CA:FALSE' \
	'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' >"$work/server.ext"
openssl x509 -req -in "$work/server.csr" -CA /ca/ca.pem -CAkey "$work/ca.key" -set_serial 1 -days 2 \
	-extfile "$work/server.ext" -out "$work/server.pem" 2>/dev/null
cat "$work/server.pem" /ca/ca.pem >/pki/server-chain.pem
chmod 0644 /ca/ca.pem /pki/server-chain.pem
chmod 0600 /pki/server.key
rm -rf "$work"
```

Create `scripts/diagnostics/test/agent-s3-probe/serve-fixture.sh`:

```bash
#!/bin/bash
# Lab S3 fixture: HTTPS `rclone serve s3` with the throwaway lab certificate and the
# synthetic key pair. --auth-key must be a flag: RCLONE_AUTH_KEY splits on the comma.
set -eu
mkdir -p /srv/s3/bucket-01
exec /opt/lab/rclone serve s3 /srv/s3 --config /dev/null --addr :9443 \
	--cert /pki/server-chain.pem --key /pki/server.key \
	--auth-key SYNTHETICKEY01,synthetic-secret-key-01 -q
```

- [ ] **Step 7: Create the lab entry point and the Rclone test doubles**

Create `scripts/diagnostics/test/agent-s3-probe/run-probe.sh`:

```bash
#!/bin/bash
# Lab entry point: runs the probe mounted at /work, then reports on stderr anything
# it left behind (LAB-TEMP-LEFT) or a key that reached an Rclone argument list
# (LAB-ARGV-LEAK, from the argv log the test doubles write).
# Usage: run-probe.sh [--install-agent-rclone] [probe arguments...]
set -u
if [[ "${1-}" == --install-agent-rclone ]]; then
	shift
	install -D -m 0755 /opt/lab/rclone /opt/pluton-agent/bin/rclone
fi
bash /work/agent-s3-probe.sh "$@"
status=$?
if compgen -G '/tmp/pluton-agent-s3-probe.*' >/dev/null; then
	echo 'LAB-TEMP-LEFT' >&2
fi
for value in "${S3_PROBE_ACCESS_KEY_ID-}" "${S3_PROBE_SECRET_ACCESS_KEY-}"; do
	if [[ -n "$value" && -f /tmp/lab-rclone-argv ]] && grep -q -F -- "$value" /tmp/lab-rclone-argv; then
		echo 'LAB-ARGV-LEAK' >&2
	fi
done
exit "$status"
```

Create `scripts/diagnostics/test/agent-s3-probe/rclone-recording.sh`:

```bash
#!/bin/bash
# Lab test double: records every argument list, then runs the pinned Rclone.
printf '%s\n' "$*" >>/tmp/lab-rclone-argv
exec /opt/lab/rclone "$@"
```

Create `scripts/diagnostics/test/agent-s3-probe/rclone-cat-fails.sh`:

```bash
#!/bin/bash
# Lab test double: like rclone-recording.sh, but `cat` fails with provider-like text
# that the probe must classify (server-error) without printing it.
printf '%s\n' "$*" >>/tmp/lab-rclone-argv
if [[ "${1-}" == cat ]]; then
	printf '%s\n' 'ERROR : synthetic-provider-error-text StatusCode: 500' >&2
	exit 1
fi
exec /opt/lab/rclone "$@"
```

Create `scripts/diagnostics/test/agent-s3-probe/rclone-cat-interrupted.sh`:

```bash
#!/bin/bash
# Lab test double: `cat` acts like an operator pressing Ctrl-C during the read,
# by sending SIGINT to the whole foreground process group.
printf '%s\n' "$*" >>/tmp/lab-rclone-argv
if [[ "${1-}" == cat ]]; then
	kill -INT 0
	sleep 5
	exit 130
fi
exec /opt/lab/rclone "$@"
```

Check syntax:

```bash
for f in scripts/diagnostics/test/agent-s3-probe/*.sh; do bash -n "$f" || echo "SYNTAX $f"; done
```

Expected: no output.

- [ ] **Step 8: Run the smoke test and see it pass**

```bash
bash tmp/agent-s3-probe-smoke.sh; echo "exit=$?"
```

Expected, after the Docker build output:

```text
with-ca=0
system-trust=60
rclone v1.75.1
exit=0
```

`with-ca=0` proves the fixture serves HTTPS with the lab CA; `system-trust=60` (curl's "peer certificate cannot be authenticated") proves the system trust store does not know that CA. If the build fails in the `openssl`, `sha256sum --check` or `unzip` step, stop: the image must not be used with an unverified Rclone. Then check that the smoke test left nothing behind:

```bash
docker ps -a --filter name=pluton-s3probe-smoke01 --format '{{.Names}}'; docker volume ls --filter name=pluton-s3probe-smoke01 --format '{{.Name}}'; docker network ls --filter name=pluton-s3probe-smoke01 --format '{{.Name}}'
```

Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add .gitattributes scripts/diagnostics/test/agent-s3-probe/Dockerfile scripts/diagnostics/test/agent-s3-probe/pki.sh scripts/diagnostics/test/agent-s3-probe/serve-fixture.sh scripts/diagnostics/test/agent-s3-probe/run-probe.sh scripts/diagnostics/test/agent-s3-probe/rclone-recording.sh scripts/diagnostics/test/agent-s3-probe/rclone-cat-fails.sh scripts/diagnostics/test/agent-s3-probe/rclone-cat-interrupted.sh
git diff --cached --check
git commit -m "test(diagnostics): add an HTTPS S3 lab fixture for the Agent S3 probe"
```

Expected: `git diff --cached --check` prints nothing; the commit lists 8 files.

---

## Task 2: Probe script and Docker lab runner

**Files:**
- Create: `scripts/validate-agent-s3-probe.py`
- Create: `scripts/diagnostics/agent-s3-probe.sh`

**Interfaces:**
- Probe command: `bash agent-s3-probe.sh [--rclone PATH] [--help]`.
- Probe inputs: `S3_PROBE_ENDPOINT` (`https://host[:port]`, no path), `S3_PROBE_BUCKET`, `S3_PROBE_PREFIX` (unset means `probe`; empty or `/` is refused), `S3_PROBE_ACCESS_KEY_ID`, `S3_PROBE_SECRET_ACCESS_KEY`, optional `S3_PROBE_CA_FILE`, optional `S3_PROBE_SIZE_MIB` (1 to 1024, default 64).
- Probe output, in this order: header `pluton-agent-s3-probe/1 started=<UTC> size_mib=<n>`; one line each for `rclone`, `dns`, `tls`, `write`, `read`, `compare`, `delete` (`PASS`, `FAIL ... reason=<token>` or `SKIP ... reason=earlier-failure|not-created`); `cleanup` only when the exit trap removed or tried to remove the object; last `RESULT PASS|FAIL storage_ca_file_needed=yes|no|unknown [interrupted=yes]`.
- Probe exit status: 0 all passed, 1 a check failed, 2 input refused (message on stderr, nothing on stdout), 130/143/129 interrupted by INT/TERM/HUP.
- Runner: `py -3 scripts/validate-agent-s3-probe.py [--base-image ubuntu:22.04|ubuntu:24.04] [--image TAG] [--skip-build] [--static-only] [--with-download] [--only NAME,...]`; last line `PASS agent-s3-probe lab: <n>/<n> scenarios`, exit 0 only when all pass.

- [ ] **Step 1: Write the lab runner (the failing test)**

Create `scripts/validate-agent-s3-probe.py`:

```python
#!/usr/bin/env python3
"""Disposable Docker lab for scripts/diagnostics/agent-s3-probe.sh.

Synthetic values only (s3.example.internal, bucket-01, SYNTHETICKEY01). The lab
never reads production configuration and removes only the Docker network,
volumes and containers it created under one random name.
"""
import argparse
import os
import pathlib
import re
import subprocess
import sys
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROBE = ROOT / "scripts" / "diagnostics" / "agent-s3-probe.sh"
LAB = ROOT / "scripts" / "diagnostics" / "test" / "agent-s3-probe"
ENDPOINT = "https://s3.example.internal:9443"
ACCESS_KEY = "SYNTHETICKEY01"
SECRET_KEY = "synthetic-secret-key-01"
WRONG_SECRET = "wrong-synthetic-secret-01"
KEY_VARIABLES = ("S3_PROBE_ACCESS_KEY_ID", "S3_PROBE_SECRET_ACCESS_KEY")
BASE_ENV = {
    "S3_PROBE_ENDPOINT": ENDPOINT,
    "S3_PROBE_BUCKET": "bucket-01",
    "S3_PROBE_ACCESS_KEY_ID": ACCESS_KEY,
    "S3_PROBE_SECRET_ACCESS_KEY": SECRET_KEY,
    "S3_PROBE_CA_FILE": "/ca/ca.pem",
    "S3_PROBE_SIZE_MIB": "8",
}
# Closed facts only: never a key, an endpoint host name, the bucket or provider
# error text (the rclone-cat-fails.sh test double emits the last one).
NEVER_PRINTED = (ACCESS_KEY, SECRET_KEY, WRONG_SECRET, "example.internal", "bucket-01", "synthetic-provider-error-text")
LINE = re.compile(r"(pluton-agent-s3-probe/1|(PASS|FAIL|SKIP) [a-z]+|RESULT (PASS|FAIL))( [a-z0-9_]+=[A-Za-z0-9._:/-]+)*")
LAB_MARKERS = ("LAB-TEMP-LEFT", "LAB-ARGV-LEAK")
NAME = re.compile(r"pluton-s3probe-[0-9a-f]{12}")

RCLONE_ARGUMENT = r"PASS rclone version=v1\.75\.1 source=argument pinned=yes"
DNS_PASS = r"PASS dns addresses=\d+ ipv4=\d+ ipv6=\d+ elapsed_ms=\d+"
TLS_WITH_CA = r"PASS tls system_trust=no ca_file=yes"
WRITE_8_MIB = r"PASS write bytes=8388608 elapsed_ms=\d+ mib_per_s=\d+\.\d\d"
READ_8_MIB = r"PASS read bytes=8388608 elapsed_ms=\d+ mib_per_s=\d+\.\d\d"
NOT_RUN = [r"SKIP write reason=earlier-failure", r"SKIP read reason=earlier-failure", r"SKIP compare reason=earlier-failure", r"SKIP delete reason=earlier-failure"]
ROUND_TRIP_8_MIB = [WRITE_8_MIB, READ_8_MIB, r"PASS compare sha256=match", r"PASS delete object=removed"]


def refusal(name, variable, value, message):
    return {"name": name, "env": {variable: value}, "exit": 2, "stdout": [], "stdout_empty": True, "stderr": r"agent-s3-probe: refused: " + message}


SCENARIOS = [
    refusal("refuse-empty-prefix", "S3_PROBE_PREFIX", "", r"S3_PROBE_PREFIX must name a prefix inside the bucket"),
    refusal("refuse-root-prefix", "S3_PROBE_PREFIX", "/", r"S3_PROBE_PREFIX must name a prefix inside the bucket"),
    refusal("refuse-dot-segment", "S3_PROBE_PREFIX", "probe/../other", r"S3_PROBE_PREFIX must not contain"),
    refusal("refuse-http-endpoint", "S3_PROBE_ENDPOINT", "http://s3.example.internal:9443", r"S3_PROBE_ENDPOINT must be an https:// origin"),
    refusal("refuse-endpoint-path", "S3_PROBE_ENDPOINT", ENDPOINT + "/bucket-01", r"S3_PROBE_ENDPOINT must be an https:// origin"),
    refusal("refuse-size", "S3_PROBE_SIZE_MIB", "2048", r"S3_PROBE_SIZE_MIB must be a whole number"),
    refusal("refuse-missing-secret", "S3_PROBE_SECRET_ACCESS_KEY", None, r"S3_PROBE_SECRET_ACCESS_KEY is not set"),
    {
        "name": "tls-without-ca",
        "env": {"S3_PROBE_CA_FILE": None},
        "args": ["--rclone", "/opt/lab/rclone"],
        "exit": 1,
        "stdout": [RCLONE_ARGUMENT, DNS_PASS, r"FAIL tls system_trust=no ca_file=not-set reason=certificate-not-trusted", *NOT_RUN, r"RESULT FAIL storage_ca_file_needed=yes"],
    },
    {
        "name": "hostname-mismatch",
        "env": {"S3_PROBE_ENDPOINT": "https://s3-alt.example.internal:9443"},
        "args": ["--rclone", "/opt/lab/rclone"],
        "exit": 1,
        "stdout": [RCLONE_ARGUMENT, DNS_PASS, r"FAIL tls system_trust=no ca_file=no reason=hostname-mismatch", *NOT_RUN, r"RESULT FAIL storage_ca_file_needed=unknown"],
    },
    {
        "name": "dns-failure",
        "env": {"S3_PROBE_ENDPOINT": "https://missing.example.internal:9443"},
        "args": ["--rclone", "/opt/lab/rclone"],
        "exit": 1,
        "stdout": [RCLONE_ARGUMENT, r"FAIL dns reason=(not-found|timeout) elapsed_ms=\d+", r"SKIP tls reason=earlier-failure", *NOT_RUN, r"RESULT FAIL storage_ca_file_needed=unknown"],
    },
    {
        "name": "success-default-size",
        "env": {"S3_PROBE_SIZE_MIB": None},
        "args": ["--rclone", "/opt/lab/rclone"],
        "exit": 0,
        "stdout": [
            r"pluton-agent-s3-probe/1 started=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ size_mib=64",
            RCLONE_ARGUMENT,
            DNS_PASS,
            TLS_WITH_CA,
            r"PASS write bytes=67108864 elapsed_ms=\d+ mib_per_s=\d+\.\d\d",
            r"PASS read bytes=67108864 elapsed_ms=\d+ mib_per_s=\d+\.\d\d",
            r"PASS compare sha256=match",
            r"PASS delete object=removed",
            r"RESULT PASS storage_ca_file_needed=yes",
        ],
    },
    {
        "name": "wrong-secret",
        "env": {"S3_PROBE_SECRET_ACCESS_KEY": WRONG_SECRET},
        "args": ["--rclone", "/opt/lab/rclone-recording.sh"],
        "exit": 1,
        "stdout": [RCLONE_ARGUMENT, DNS_PASS, TLS_WITH_CA, r"FAIL write reason=authentication", r"SKIP read reason=earlier-failure", r"SKIP compare reason=earlier-failure", r"SKIP delete reason=not-created", r"RESULT FAIL storage_ca_file_needed=yes"],
    },
    {
        "name": "read-failure-cleans-up",
        "args": ["--rclone", "/opt/lab/rclone-cat-fails.sh"],
        "exit": 1,
        "stdout": [WRITE_8_MIB, r"FAIL read reason=server-error", r"SKIP compare reason=earlier-failure", r"PASS delete object=removed", r"RESULT FAIL storage_ca_file_needed=yes"],
    },
    {
        "name": "interrupt-cleans-up",
        "args": ["--rclone", "/opt/lab/rclone-cat-interrupted.sh"],
        "exit": 130,
        "stdout": [WRITE_8_MIB, r"PASS cleanup object=removed", r"RESULT FAIL storage_ca_file_needed=yes interrupted=yes"],
    },
    {
        "name": "agent-private-rclone",
        "root": True,
        "args": ["--install-agent-rclone"],
        "exit": 0,
        "stdout": [r"PASS rclone version=v1\.75\.1 source=agent pinned=yes", DNS_PASS, TLS_WITH_CA, *ROUND_TRIP_8_MIB, r"RESULT PASS storage_ca_file_needed=yes"],
    },
]
# Without Internet access the pinned download must fail closed.
OFFLINE_SCENARIOS = [
    {
        "name": "download-unavailable",
        "exit": 1,
        "stdout": [r"FAIL rclone source=download reason=download-failed", DNS_PASS, TLS_WITH_CA, *NOT_RUN, r"RESULT FAIL storage_ca_file_needed=yes"],
    },
]
# --with-download: the lab network has Internet access and the pinned release is fetched.
DOWNLOAD_SCENARIOS = [
    {
        "name": "download-pinned-rclone",
        "exit": 0,
        "stdout": [r"PASS rclone version=v1\.75\.1 source=download pinned=yes", DNS_PASS, TLS_WITH_CA, *ROUND_TRIP_8_MIB, r"RESULT PASS storage_ca_file_needed=yes"],
    },
]


def docker(*args, check=True, timeout=120, env=None, capture=True):
    return subprocess.run(["docker", *args], capture_output=capture, text=True, timeout=timeout, check=check, env=env)


def require_local_docker():
    def local_endpoint(value):
        return value.startswith("unix:///") or value.startswith("npipe:////./pipe/")
    if os.environ.get("DOCKER_HOST") and not local_endpoint(os.environ["DOCKER_HOST"]):
        raise RuntimeError("only a local Docker endpoint is allowed")
    context = docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}", timeout=15).stdout.strip()
    if not local_endpoint(context):
        raise RuntimeError("only a local Docker context is allowed")


def static_checks():
    if not PROBE.is_file():
        return ["probe script missing: scripts/diagnostics/agent-s3-probe.sh"]
    problems = []
    text = PROBE.read_bytes().decode("utf-8")
    if "\r" in text:
        problems.append("probe script has CR line endings")
    commands = text.replace("\\\n", " ").splitlines()
    if any("curl " in line and re.search(r"\s(-k|--insecure)(\s|$)", line) for line in commands):
        problems.append("probe script disables curl TLS verification")
    dockerfile = (LAB / "Dockerfile").read_text(encoding="utf-8")
    for name in ("RCLONE_VERSION", "RCLONE_LINUX_AMD64_SHA256"):
        probe_value = re.search(r"^readonly " + name + r"='([^']+)'$", text, re.MULTILINE)
        lab_value = re.search(r"^ARG " + name + r"=(\S+)$", dockerfile, re.MULTILINE)
        if not probe_value or not lab_value or probe_value.group(1) != lab_value.group(1):
            problems.append(name + " differs between the probe and the lab image")
    return problems


def start_fixture(name, image, internal):
    docker("network", "create", *(["--internal"] if internal else []), name)
    for volume in (name + "-pki", name + "-ca"):
        docker("volume", "create", volume)
    docker("run", "--rm", "--network", "none", "--mount", "type=volume,source=" + name + "-pki,target=/pki", "--mount", "type=volume,source=" + name + "-ca,target=/ca", image, "/opt/lab/pki.sh")
    docker("run", "-d", "--name", name + "-s3", "--network", name, "--network-alias", "s3.example.internal", "--network-alias", "s3-alt.example.internal", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", "512m", "--pids-limit", "64", "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m", "--tmpfs", "/srv/s3:rw,nosuid,nodev,size=256m", "--mount", "type=volume,source=" + name + "-pki,target=/pki,readonly", image, "/opt/lab/serve-fixture.sh")
    # Bounded readiness probe instead of a fixed sleep.
    docker("exec", name + "-s3", "bash", "-c", "for i in $(seq 1 60); do (exec 3<>/dev/tcp/127.0.0.1/9443) 2>/dev/null && exit 0; sleep 0.5; done; exit 1", timeout=60)


def stored_objects(name):
    return [line for line in docker("exec", name + "-s3", "find", "/srv/s3", "-type", "f", "-print").stdout.splitlines() if line]


def run_scenario(name, image, scenario, index):
    container = name + "-probe-" + str(index)
    values = dict(BASE_ENV)
    values.update(scenario.get("env", {}))
    env = dict(os.environ)
    args = ["run", "--rm", "--init", "--name", container, "--network", name, "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", "768m", "--memory-swap", "768m", "--pids-limit", "128", "--tmpfs", "/tmp:rw,nosuid,nodev,size=320m,mode=1777", "--mount", "type=bind,source=" + str(PROBE) + ",target=/work/agent-s3-probe.sh,readonly", "--mount", "type=volume,source=" + name + "-ca,target=/ca,readonly"]
    if not scenario.get("root"):
        args += ["--user", "1000:1000", "--read-only"]
    for variable, value in values.items():
        if value is None:
            continue
        if variable in KEY_VARIABLES:
            # Keys travel by name from this process environment, never in argv.
            env[variable] = value
            args += ["-e", variable]
        else:
            args += ["-e", variable + "=" + value]
    args += [image, "/opt/lab/run-probe.sh", *scenario.get("args", [])]
    try:
        return docker(*args, check=False, timeout=600, env=env)
    finally:
        docker("rm", "-f", container, check=False, timeout=30)


def check_scenario(name, scenario, result):
    problems = []
    if result.returncode != scenario["exit"]:
        problems.append("exit status " + str(result.returncode) + ", expected " + str(scenario["exit"]))
    lines = result.stdout.splitlines()
    if scenario.get("stdout_empty") and lines:
        problems.append("stdout is not empty")
    for line in lines:
        if not LINE.fullmatch(line):
            problems.append("line is not a closed fact: " + line)
    position = 0
    for pattern in scenario["stdout"]:
        regex = re.compile(pattern)
        while position < len(lines) and not regex.fullmatch(lines[position]):
            position += 1
        if position == len(lines):
            problems.append("missing line (in order): " + pattern)
            break
        position += 1
    if "stderr" in scenario and not re.search(scenario["stderr"], result.stderr):
        problems.append("stderr does not match: " + scenario["stderr"])
    output = result.stdout + result.stderr
    if any(value in output for value in NEVER_PRINTED):
        problems.append("output contains a key, endpoint host, bucket or provider text")
    problems += [marker for marker in LAB_MARKERS if marker in result.stderr]
    if stored_objects(name):
        problems.append("the test object is still stored in the bucket")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-image", default="ubuntu:22.04", choices=["ubuntu:22.04", "ubuntu:24.04"])
    parser.add_argument("--image", help="lab image tag (default: pluton-agent-s3-probe-lab:<base image>)")
    parser.add_argument("--skip-build", action="store_true", help="reuse an already built lab image")
    parser.add_argument("--static-only", action="store_true", help="run only the checks that need no Docker")
    parser.add_argument("--with-download", action="store_true", help="give the lab network Internet access and test the pinned Rclone download")
    parser.add_argument("--only", default="", help="comma-separated scenario names")
    options = parser.parse_args()
    image = options.image or "pluton-agent-s3-probe-lab:" + options.base_image.replace(":", "-")
    scenarios = SCENARIOS + (DOWNLOAD_SCENARIOS if options.with_download else OFFLINE_SCENARIOS)
    if options.only:
        wanted = set(options.only.split(","))
        unknown = wanted - {scenario["name"] for scenario in scenarios}
        if unknown:
            raise SystemExit("unknown scenario: " + ", ".join(sorted(unknown)))
        scenarios = [scenario for scenario in scenarios if scenario["name"] in wanted]

    problems = static_checks()
    for problem in problems:
        print("FAIL static: " + problem)
    if problems:
        return 1
    print("PASS static")
    if options.static_only:
        return 0
    require_local_docker()
    if not options.skip_build:
        docker("build", "--build-arg", "BASE_IMAGE=" + options.base_image, "-t", image, str(LAB), timeout=900, capture=False)
    name = "pluton-s3probe-" + uuid.uuid4().hex[:12]
    failures = 0
    try:
        start_fixture(name, image, internal=not options.with_download)
        for index, scenario in enumerate(scenarios):
            result = run_scenario(name, image, scenario, index)
            problems = check_scenario(name, scenario, result)
            if not problems:
                print("PASS " + scenario["name"])
                continue
            failures += 1
            print("FAIL " + scenario["name"] + ": " + "; ".join(problems))
            # Synthetic values only, so the raw output is safe to show for debugging.
            print("  stdout:\n    " + "\n    ".join(result.stdout.splitlines()))
            print("  stderr:\n    " + "\n    ".join(result.stderr.splitlines()))
    finally:
        if not NAME.fullmatch(name):
            raise RuntimeError("unsafe lab name")
        docker("rm", "-f", name + "-s3", check=False, timeout=30)
        docker("volume", "rm", name + "-pki", name + "-ca", check=False, timeout=30)
        docker("network", "rm", name, check=False, timeout=30)
    print(("PASS" if failures == 0 else "FAIL") + " agent-s3-probe lab: " + str(len(scenarios) - failures) + "/" + str(len(scenarios)) + " scenarios")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        # Name the Docker step only; never print argv values or the environment.
        raise SystemExit("FAIL agent-s3-probe lab: docker " + str(error.cmd[1]) + " exited with " + str(error.returncode))
    except RuntimeError as error:
        # Only this file's own fixed messages.
        raise SystemExit("FAIL agent-s3-probe lab: " + str(error))
    except (subprocess.SubprocessError, OSError) as error:
        raise SystemExit("FAIL agent-s3-probe lab: " + type(error).__name__)
```

- [ ] **Step 2: Run the runner and see it fail**

```bash
py -3 scripts/validate-agent-s3-probe.py; echo "exit=$?"
```

Expected:

```text
FAIL static: probe script missing: scripts/diagnostics/agent-s3-probe.sh
exit=1
```

- [ ] **Step 3: Create the probe, part 1 (inputs and validation)**

Create `scripts/diagnostics/agent-s3-probe.sh` with exactly this content:

```bash
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
  S3_PROBE_SIZE_MIB           test object size in MiB, 1 to 1024 (default: 64)

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
	local size_pattern='^[1-9][0-9]{0,3}$'
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

	if ! [[ "$SIZE_MIB" =~ $size_pattern ]] || ((SIZE_MIB > 1024)); then
		refuse 'S3_PROBE_SIZE_MIB must be a whole number from 1 to 1024.'
	fi
	SIZE_BYTES=$((SIZE_MIB * MIB))

	if [[ -n "$RCLONE_ARGUMENT" && ! (-f "$RCLONE_ARGUMENT" && -x "$RCLONE_ARGUMENT") ]]; then
		refuse '--rclone must name an executable file.'
	fi
}
```

Run: `bash -n scripts/diagnostics/agent-s3-probe.sh; echo "syntax=$?"`. Expected: `syntax=0`.

- [ ] **Step 4: Append part 2 (clean child environment, Rclone, DNS, TLS)**

Append one empty line and then this block to the end of `scripts/diagnostics/agent-s3-probe.sh`:

```bash
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
```

Run: `bash -n scripts/diagnostics/agent-s3-probe.sh; echo "syntax=$?"`. Expected: `syntax=0`.

- [ ] **Step 5: Append part 3 (object round trip, exit trap, main)**

Append one empty line and then this block to the end of `scripts/diagnostics/agent-s3-probe.sh`:

```bash
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
	if ((status != 0)); then
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
	# interrupt leave the test object or the temporary directory behind.
	trap '' INT TERM HUP
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
```

Run:

```bash
bash -n scripts/diagnostics/agent-s3-probe.sh; echo "syntax=$?"
grep -c $'\r' scripts/diagnostics/agent-s3-probe.sh
wc -l < scripts/diagnostics/agent-s3-probe.sh
```

Expected: `syntax=0`, `0`, `607`.

- [ ] **Step 6: Run the static checks**

```bash
py -3 scripts/validate-agent-s3-probe.py --static-only; echo "exit=$?"
```

Expected:

```text
PASS static
exit=0
```

- [ ] **Step 7: Run the full lab and see it pass**

```bash
py -3 scripts/validate-agent-s3-probe.py; echo "exit=$?"
```

Expected: `PASS static`, then the Docker build output, then exactly these lines in this order:

```text
PASS refuse-empty-prefix
PASS refuse-root-prefix
PASS refuse-dot-segment
PASS refuse-http-endpoint
PASS refuse-endpoint-path
PASS refuse-size
PASS refuse-missing-secret
PASS tls-without-ca
PASS hostname-mismatch
PASS dns-failure
PASS success-default-size
PASS wrong-secret
PASS read-failure-cleans-up
PASS interrupt-cleans-up
PASS agent-private-rclone
PASS download-unavailable
PASS agent-s3-probe lab: 16/16 scenarios
exit=0
```

Then confirm the lab removed its Docker objects:

```bash
docker ps -a --filter name=pluton-s3probe- --format '{{.Names}}'; docker volume ls --filter name=pluton-s3probe- --format '{{.Name}}'; docker network ls --filter name=pluton-s3probe- --format '{{.Name}}'
```

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add scripts/validate-agent-s3-probe.py scripts/diagnostics/agent-s3-probe.sh
git diff --cached --check
git commit -m "feat(diagnostics): add the Agent S3 probe for stage 0 and its Docker lab"
```

Expected: `git diff --cached --check` prints nothing; the commit lists 2 files.

---

## Task 3: Operator documentation, kept in sync by the static checks

**Files:**
- Modify: `scripts/validate-agent-s3-probe.py`
- Create: `docs/AGENT_S3_PROBE.md`

**Interfaces:**
- `static_checks()` additionally requires every closed reason token the probe can print (`reason=...` literals, `RCLONE_FAILURE`/`REMOVE_REASON` values, and `printf '<token>'` in the classifiers, except the internal `ok`) to appear in `docs/AGENT_S3_PROBE.md` as `` `token` ``.

- [ ] **Step 1: Add the documentation check (the failing test)**

In `scripts/validate-agent-s3-probe.py`, replace:

```python
LAB = ROOT / "scripts" / "diagnostics" / "test" / "agent-s3-probe"
```

with:

```python
LAB = ROOT / "scripts" / "diagnostics" / "test" / "agent-s3-probe"
DOC = ROOT / "docs" / "AGENT_S3_PROBE.md"
```

Then replace:

```python
            problems.append(name + " differs between the probe and the lab image")
    return problems
```

with:

```python
            problems.append(name + " differs between the probe and the lab image")
    # Every closed reason the probe can print must be explained to the operator.
    tokens = set(re.findall(r"reason=([a-z][a-z0-9-]+)", text))
    tokens |= set(re.findall(r"(?:RCLONE_FAILURE|REMOVE_REASON)='([a-z][a-z0-9-]+)'", text))
    tokens |= set(re.findall(r"printf '([a-z][a-z0-9-]+)'", text))
    tokens.discard("ok")
    doc = DOC.read_text(encoding="utf-8") if DOC.is_file() else ""
    missing = sorted(token for token in tokens if "`" + token + "`" not in doc)
    if missing:
        problems.append("docs/AGENT_S3_PROBE.md does not document: " + ", ".join(missing))
    return problems
```

- [ ] **Step 2: Run the static checks and see them fail**

```bash
py -3 scripts/validate-agent-s3-probe.py --static-only; echo "exit=$?"
```

Expected:

```text
FAIL static: docs/AGENT_S3_PROBE.md does not document: access-denied, authentication, bucket-not-found, ca-file-unreadable, certificate-expired, certificate-not-trusted, certificate-not-yet-valid, certificate-rejected, checksum-mismatch, connection, dns, download-failed, earlier-failure, extract-failed, handshake, hostname-mismatch, insufficient-temp-space, listing-failed, no-version, not-created, not-executable, not-found, other, payload-failed, server-error, sha256-mismatch, size-mismatch, still-listed, timeout, tls, unsupported-architecture, unzip-missing, version-mismatch
exit=1
```

- [ ] **Step 3: Write the operator documentation**

Create `docs/AGENT_S3_PROBE.md`:

````markdown
# Agent S3 probe (stage 0)

Stage 0 of [S3_AGENT_REPOSITORY_DESIGN.md](S3_AGENT_REPOSITORY_DESIGN.md) (section 5). Before an
S3-compatible store (Hitachi Content Platform) is used as a Managed Agent repository, the operator
runs `scripts/diagnostics/agent-s3-probe.sh` on the future Agent host, the ERP host first. It answers
four questions with closed facts: does the endpoint resolve, does its certificate verify, can this
host write, read back and delete an object, and how fast.

Nothing is deployed. No migration, no server or Agent change, no Agent update or re-enrollment, and
no deploy order. The probe needs neither Node nor the Pluton Agent.

## What the probe does

1. **Rclone.** Uses `--rclone PATH` when given, otherwise the Agent's private Rclone at
   `/opt/pluton-agent/bin/rclone`, otherwise downloads the release the Agent installer pins
   (Rclone 1.75.1, `linux-amd64`, from `downloads.rclone.org`) into its temporary directory and
   checks the installer's SHA-256 before running it. It reports the version.
2. **DNS.** Resolves the endpoint host with the system resolver (`getent ahosts`) and reports the
   number of addresses and the time taken. Rclone resolves with its own resolver over the same
   `/etc/hosts` and `/etc/resolv.conf`.
3. **TLS.** Sends one unauthenticated HTTPS request to the endpoint origin with `curl`, first with
   the system trust store, then with `S3_PROBE_CA_FILE` when set. Certificate checks are never
   switched off. Any HTTP status counts: only the handshake and the certificate are judged.
4. **Write.** Uploads one random object of `S3_PROBE_SIZE_MIB` MiB (default 64) to
   `<bucket>/<prefix>/pluton-probe-<UTC time>-<random>` as a single PUT of known size
   (`rclone rcat --size`), the way Restic hands a pack to Rclone. It reports MiB/s.
5. **Read.** Reads the object back in full (`rclone cat`) and reports MiB/s.
6. **Compare.** Compares the size and SHA-256 of both copies.
7. **Delete.** Deletes the object (`rclone deletefile`) and confirms it is no longer listed.

Rclone runs with the settings stage 1 uses for HCP: `provider = Other`, path-style addressing,
`use_accept_encoding_gzip = false` (see [HCP_RANGE_GZIP_FIX.md](HCP_RANGE_GZIP_FIX.md)),
`no_check_bucket = true` and `env_auth = false`. It is configured only through
`RCLONE_CONFIG_PROBE_*` environment variables with `RCLONE_CONFIG=/dev/null`, with one low-level
retry, a 30-second connect timeout, a 120-second I/O idle timeout and at most one hour per transfer.

Child processes start from an empty environment, like the Agent's own children: no proxy variables
and no inherited `RCLONE_*`, `SSL_*` or `CURL_*` settings. When `S3_PROBE_CA_FILE` is set, Rclone
gets it as `SSL_CERT_FILE`, which is how stage 1 passes `PLUTON_AGENT_STORAGE_CA_FILE`.

**On the host** the probe creates one temporary directory (`mktemp`, mode 0700, under `TMPDIR` or
`/tmp`) for the random payload, its read-back copy and, when downloaded, Rclone. The directory is
removed on every exit. It needs twice the object size plus 16 MiB free, and about 100 MiB more when
Rclone is downloaded. The keys stay in memory and in the environment of the Rclone child: never
printed, never written to a file and never passed as an argument, so other non-root users cannot
see them in `ps`.

**In the bucket** the probe writes only the one test object under the prefix, and never the bucket
root. It deletes the object on success, after any failed check and after Ctrl-C, `TERM` or `HUP`.
If the deletion fails, it prints the object key so you can remove it.

## Running it (operator)

Requirements: Ubuntu 22.04 or 24.04 on amd64 with `bash`, `curl` and `ca-certificates` (present on
Ubuntu Server). `unzip` is needed only when Rclone has to be downloaded
(`sudo apt-get install unzip`; the Agent installer needs it anyway), and outbound HTTPS to
`downloads.rclone.org` only for that download. Run as a normal user; no `sudo`.

1. Copy the script from the reviewed commit and check that the copy is intact. On a workstation with
   a checkout of the repository:

   ```sh
   git show <reviewed-commit>:scripts/diagnostics/agent-s3-probe.sh > agent-s3-probe.sh
   sha256sum agent-s3-probe.sh
   scp agent-s3-probe.sh <user>@<agent-host>:
   ```

   On the Agent host, `sha256sum ~/agent-s3-probe.sh` must print the same digest.

2. In the shell on the Agent host, enter the values with `read`. `read` is a shell builtin, so what
   you type is not stored in the shell history; `-s` hides the keys while you type:

   ```sh
   read -r -p 'S3 endpoint (https://...): ' S3_PROBE_ENDPOINT
   read -r -p 'Bucket (HCP namespace): ' S3_PROBE_BUCKET
   read -rs -p 'Access key ID: ' S3_PROBE_ACCESS_KEY_ID; echo
   read -rs -p 'Secret access key: ' S3_PROBE_SECRET_ACCESS_KEY; echo
   export S3_PROBE_ENDPOINT S3_PROBE_BUCKET S3_PROBE_ACCESS_KEY_ID S3_PROBE_SECRET_ACCESS_KEY
   ```

   Use the key pair of the shared HCP storage that stage 1 will use. Optional:
   `export S3_PROBE_PREFIX=probe` (the default; an empty prefix is refused),
   `export S3_PROBE_CA_FILE=/path/to/ca.pem` and `export S3_PROBE_SIZE_MIB=64` (1 to 1024).

3. Run it:

   ```sh
   bash ~/agent-s3-probe.sh
   ```

   If `/tmp` is mounted `noexec` and Rclone has to be downloaded, give it a temporary directory on
   an executable filesystem: `mkdir -m 700 ~/probe-tmp && TMPDIR=~/probe-tmp bash ~/agent-s3-probe.sh`,
   then `rmdir ~/probe-tmp`.

4. Remove the values from the shell, or close it:

   ```sh
   unset S3_PROBE_ENDPOINT S3_PROBE_BUCKET S3_PROBE_ACCESS_KEY_ID S3_PROBE_SECRET_ACCESS_KEY S3_PROBE_CA_FILE
   ```

5. Share the output. It contains no key, endpoint or bucket; only the prefix appears, in an
   `object_key` fact when a deletion failed.

Exit status: `0` every check passed, `1` a check failed, `2` the input was refused before anything
was contacted, `130`, `143` or `129` interrupted by `INT`, `TERM` or `HUP`.

## Reading the result

Example (synthetic):

```text
pluton-agent-s3-probe/1 started=2026-11-15T09:30:00Z size_mib=64
PASS rclone version=v1.75.1 source=download pinned=yes
PASS dns addresses=2 ipv4=2 ipv6=0 elapsed_ms=12
PASS tls system_trust=no ca_file=yes
PASS write bytes=67108864 elapsed_ms=5120 mib_per_s=12.50
PASS read bytes=67108864 elapsed_ms=2010 mib_per_s=31.84
PASS compare sha256=match
PASS delete object=removed
RESULT PASS storage_ca_file_needed=yes
```

Each check prints one line: `PASS`, `FAIL` with a `reason`, or `SKIP`. `SKIP` means the check was
not run: `earlier-failure` (a check it depends on failed) or, for `delete`, `not-created` (the
endpoint refused the write, so there is nothing to delete).

| Check | `PASS` facts | `FAIL` reasons and what to do |
| --- | --- | --- |
| `rclone` | `version`; `source` is `argument`, `agent` or `download`; `pinned=yes` when it is the installer's 1.75.1 | `download-failed`: no HTTPS to `downloads.rclone.org`; copy the binary and use `--rclone`. `checksum-mismatch`: the download is not the pinned release; stop and do not use it. `unzip-missing`: install `unzip`. `unsupported-architecture`: the Agent supports amd64 only. `extract-failed`: the archive did not contain Rclone. `not-executable`: the temporary directory is `noexec` (see step 3) or the binary is for another architecture. `no-version`: the binary did not report a version. `version-mismatch`: the download reported another version |
| `dns` | `addresses`, `ipv4`, `ipv6`, `elapsed_ms` | `not-found` or `timeout`: the host's resolver cannot resolve the endpoint. A public resolver may not know an internal HCP name; use the site resolver. Fix this first |
| `tls` | `system_trust` (`yes` or `no`) and `ca_file` (`not-set`, `yes` or `no`) | `certificate-not-trusted`: the issuer is unknown; rerun with `S3_PROBE_CA_FILE`. `hostname-mismatch`: the certificate does not name the endpoint host; a CA file does not help. `certificate-expired`, `certificate-not-yet-valid`, `certificate-rejected`: the certificate itself is wrong. `ca-file-unreadable`: curl could not load `S3_PROBE_CA_FILE`. `handshake`, `connection`, `timeout`, `dns`, `other`: the HTTPS connection failed before the certificate was judged |
| `write` | `bytes`, `elapsed_ms`, `mib_per_s` | `authentication`: wrong key pair. `access-denied`: the key may not write under this prefix. `bucket-not-found`: wrong bucket. `tls`: Rclone rejected a certificate that curl accepted (for example one without a subjectAltName); the Agent would fail the same way. `dns`, `connection`, `timeout`, `server-error`, `other`: transport or endpoint failure; rerun once, then escalate with the UTC time. `insufficient-temp-space`, `payload-failed`: the temporary directory is too small or not writable |
| `read` | `bytes`, `elapsed_ms`, `mib_per_s` | Same reasons as `write` |
| `compare` | `sha256=match` | `size-mismatch` or `sha256-mismatch`: the endpoint returned different bytes. Stop and escalate; stage 1 must not start |
| `delete` | `object=removed`, or `object=absent` when it was already gone | Any reason above, `listing-failed` (the check listing failed) or `still-listed`, with `object_key`: delete that one object by hand. A key without delete permission cannot be used, because Restic deletes its lock files |
| `cleanup` | `object=removed` or `object=absent` | Printed only after an interruption; reasons and action as for `delete` |
| `RESULT` | `PASS` only when every check passed; `storage_ca_file_needed`; `interrupted=yes` after `INT`, `TERM` or `HUP` | |

## Is `PLUTON_AGENT_STORAGE_CA_FILE` needed?

The `tls` line decides it, and `RESULT` repeats the answer as `storage_ca_file_needed`:

| `storage_ca_file_needed` | Meaning | Action for stage 1 |
| --- | --- | --- |
| `no` | `system_trust=yes`: the host's trust store verifies the endpoint | Leave `PLUTON_AGENT_STORAGE_CA_FILE` unset |
| `yes` | `system_trust=no` with `certificate-not-trusted`, and either no CA file was given or it verified (`ca_file=yes`) | Install the CA file that gave `ca_file=yes` on the Agent host (root-owned, mode 0644) and set `PLUTON_AGENT_STORAGE_CA_FILE` to its path in the Agent environment file. If you have not yet run with `S3_PROBE_CA_FILE`, do so first to prove the file |
| `unknown` | TLS failed for a reason a CA file does not fix, the given CA file did not verify either, or DNS failed first | Fix the certificate, the name or the network, then rerun |

## From upload rate to first-backup time

hours ≈ GB × 1,000,000,000 ÷ (`mib_per_s` × 1,048,576) ÷ 3,600. For 300 GB: about 6.4 hours at
12.5 MiB/s, about 5.5 days at 0.6 MiB/s.

Treat this as an estimate. The probe measures one stream; Restic uploads up to five packs at once
through Rclone, which helps when one stream is limited by latency but not when the link is full.
Restic also compresses and deduplicates, which helps little for files that are already compressed
(images, PDF, archives), and the first backup also reads the whole source disk.

## Validation

`scripts/validate-agent-s3-probe.py` (Windows: `py -3 scripts/validate-agent-s3-probe.py`; Linux and
CI: `python3 ...`) builds `pluton-agent-s3-probe-lab:ubuntu-22.04` from
`scripts/diagnostics/test/agent-s3-probe/`: Ubuntu with `curl`, `ca-certificates`, `unzip` and
`openssl`, plus Rclone 1.75.1 checked against the Agent installer's SHA-256. It creates an internal
Docker network, a throwaway private CA and an HTTPS `rclone serve s3` fixture at
`s3.example.internal:9443` with the synthetic key pair `SYNTHETICKEY01`. The probe runs as UID 1000
on a read-only root filesystem, in most scenarios with `--rclone` pointing at the fixture's Rclone.

Scenarios (16): seven refused inputs (empty prefix, `/` prefix, `..` segment, `http://` endpoint,
endpoint with a path, size 2048, missing secret), TLS without the CA file, a host name the
certificate does not name, an unknown host, success with the default 64 MiB, a wrong secret key,
a failed read after a successful write, Ctrl-C during the read (the test double sends `SIGINT` to
the probe's process group), the Agent's private Rclone found at `/opt/pluton-agent/bin/rclone`, and
the pinned download failing closed without Internet access. `--with-download` replaces the last one
with a real download and checksum check of the pinned release.

Every scenario also checks that each output line is a closed fact; that no key, endpoint host name,
bucket or provider error text appears in stdout or stderr; that Rclone never received a key as an
argument; that the probe's temporary directory is gone; and that the bucket holds no object
afterwards. Expected last line: `PASS agent-s3-probe lab: 16/16 scenarios`.
`--base-image ubuntu:24.04` runs the same scenarios on Ubuntu 24.04. `--static-only` runs only the
checks that need no Docker (line endings, no disabled TLS verification in curl calls, the Rclone pin
matching the lab image, and every `reason` documented here). The lab is run manually; CI does not run
it unless Task 4 was approved and done, in which case replace this sentence with the CI description.

## Limitations

- One object, one stream, one run: no concurrency, no multipart upload (64 MiB is below Rclone's
  200 MiB upload cutoff) and no long-run stability.
- The probe sets no region; Rclone then signs requests for `us-east-1`.
- The TLS check uses curl (OpenSSL) and Rclone uses Go. A difference shows as `write` with
  `reason=tls`.
- No proxy is used for the S3 checks. If the host can reach the endpoint only through a proxy, the
  probe fails, as the Agent would, because the Agent does not pass proxy variables to Restic and
  Rclone.
- The lab does not reproduce HCP, its certificate chain or production network behavior.

## Rollback

Nothing is deployed. Delete `agent-s3-probe.sh` from the Agent host. If the probe printed
`FAIL delete` or `FAIL cleanup` with an `object_key`, delete that one object in the HCP namespace.
````

- [ ] **Step 4: Run the static checks and see them pass**

```bash
py -3 scripts/validate-agent-s3-probe.py --static-only; echo "exit=$?"
```

Expected:

```text
PASS static
exit=0
```

- [ ] **Step 5: Commit**

```bash
git add scripts/validate-agent-s3-probe.py docs/AGENT_S3_PROBE.md
git diff --cached --check
git commit -m "docs(diagnostics): explain how to run and read the Agent S3 probe"
```

Expected: `git diff --cached --check` prints nothing; the commit lists 2 files.

---

## Task 4 (optional, only with the user's explicit approval): Run the probe checks in CI

> `container.yml` is the workflow that builds and publishes the GHCR image. Skip this task unless
> the user approves changing it; the lab is then run manually (Task 2) and Task 3's documentation
> must not claim that CI runs it.

**Files:**
- Modify: `.github/workflows/container.yml`

**Interfaces:**
- Job `validate`, step "Check deployment probe, overlay policy and POSIX shell syntax": adds `bash -n` on the probe and `--static-only`.
- Job `build-pr`: new step "Verify the Agent S3 probe against a private-CA HTTPS S3 fixture" after the replica recovery step, running the full lab with a 10-minute limit.

- [ ] **Step 1: Write the failing check**

```bash
grep -c "validate-agent-s3-probe.py" .github/workflows/container.yml; echo "exit=$?"
```

Expected: `0` and `exit=1`.

- [ ] **Step 2: Add the static checks to the validate job**

In `.github/workflows/container.yml`, replace:

```yaml
          python3 scripts/__tests__/deployment_fixture_test.py
          for script in deploy/*.sh; do sh -n "$script"; done
```

with:

```yaml
          python3 scripts/__tests__/deployment_fixture_test.py
          for script in deploy/*.sh; do sh -n "$script"; done
          bash -n scripts/diagnostics/agent-s3-probe.sh
          python3 scripts/validate-agent-s3-probe.py --static-only
```

- [ ] **Step 3: Add the lab to the build job**

In `.github/workflows/container.yml`, replace:

```yaml
        run: python3 scripts/validate-replica-recovery.py pluton-replica-recovery:local

```

with:

```yaml
        run: python3 scripts/validate-replica-recovery.py pluton-replica-recovery:local

      - name: Verify the Agent S3 probe against a private-CA HTTPS S3 fixture
        timeout-minutes: 10
        run: python3 scripts/validate-agent-s3-probe.py

```

- [ ] **Step 4: Run the check and see it pass**

```bash
grep "agent-s3-probe" .github/workflows/container.yml
git diff --check
```

Expected, with the indentation shown (10 spaces in the validate step, 8 for the new `run:`), and nothing from `git diff --check`:

```text
          bash -n scripts/diagnostics/agent-s3-probe.sh
          python3 scripts/validate-agent-s3-probe.py --static-only
        run: python3 scripts/validate-agent-s3-probe.py
```

Hosted CI runs only when the user opens the pull request; do not claim it passed.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/container.yml
git diff --cached --check
git commit -m "ci(container): run the Agent S3 probe checks and lab"
```

Expected: `git diff --cached --check` prints nothing; the commit lists 1 file.

---

## Task 5: Cross-checks before handing over

No new files. Commit only if a check finds a defect, and then only the fix, with its own test.

- [ ] **Step 1: Confirm the Rclone pin against the Agent installer**

```bash
MSYS_NO_PATHCONV=1 git -C /c/laragon/www/pluton-agent fetch origin
MSYS_NO_PATHCONV=1 git -C /c/laragon/www/pluton-agent show origin/main:installers/install-agent.sh | grep -E "^readonly RCLONE_(VERSION|RELEASE_BASE|LINUX_AMD64_SHA256)="
grep -E "^readonly RCLONE_(VERSION|RELEASE_BASE|LINUX_AMD64_SHA256)=" scripts/diagnostics/agent-s3-probe.sh
```

Expected: both commands print the same three lines:

```text
readonly RCLONE_VERSION='1.75.1'
readonly RCLONE_RELEASE_BASE="https://downloads.rclone.org/v${RCLONE_VERSION}"
readonly RCLONE_LINUX_AMD64_SHA256='982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab'
```

If the installer's values differ, update the probe constants and the two `ARG` lines in the lab Dockerfile together, rerun Task 2 Step 7, and commit as `fix(diagnostics): follow the Agent installer's Rclone pin`.

- [ ] **Step 2: Run the lab on Ubuntu 24.04**

```bash
py -3 scripts/validate-agent-s3-probe.py --base-image ubuntu:24.04; echo "exit=$?"
```

Expected: last lines `PASS agent-s3-probe lab: 16/16 scenarios` and `exit=0`.

- [ ] **Step 3: Run the lab with the real pinned download**

```bash
py -3 scripts/validate-agent-s3-probe.py --skip-build --with-download; echo "exit=$?"
```

Expected: `PASS download-pinned-rclone` instead of `PASS download-unavailable`, then `PASS agent-s3-probe lab: 16/16 scenarios` and `exit=0`.

- [ ] **Step 4: Review the branch**

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git status --short
docker ps -a --filter name=pluton-s3probe- --format '{{.Names}}'; docker volume ls --filter name=pluton-s3probe- --format '{{.Name}}'; docker network ls --filter name=pluton-s3probe- --format '{{.Name}}'
```

Expected: four commits (`test(diagnostics)`, `feat(diagnostics)`, `docs(diagnostics)`, `ci(container)`); exactly the 12 paths of the file structure table; `git diff --check` and `git status --short` print nothing; no Docker objects left. Do not push.

- [ ] **Step 5: Report to the user**

Reply in Indonesian, short: branch `claude/agent-s3-probe`, the four commit SHAs, the exact file list, the lab results (Ubuntu 22.04, Ubuntu 24.04, with download), that hosted CI has not run (it runs on the pull request), that nothing needs a migration, an Agent update or a deploy, and the limitations from `docs/AGENT_S3_PROBE.md`. The user pushes with GitHub Desktop.

---

## Self-review against the design, section 5

| Section 5 requirement | Where it is met |
| --- | --- |
| Run on one Agent host before stage 1 code is merged | `docs/AGENT_S3_PROBE.md`, "Running it (operator)"; no Node or Agent needed |
| A script in `scripts/diagnostics/` | `scripts/diagnostics/agent-s3-probe.sh` |
| Endpoint, bucket and keys from environment variables set in the operator's shell | `read_inputs` reads only `S3_PROBE_*`; the docs use `read -rs` so nothing reaches the shell history |
| Writes nothing else to disk | No configuration, report, log or key is written. The only files are the random payload, its read-back copy and a downloaded Rclone, all inside one 0700 `mktemp` directory that the EXIT trap removes; the lab checks that the directory is gone |
| Prints only closed facts | Fixed `key=value` facts and reason tokens; the lab checks every line against a closed pattern and that no key, host name, bucket or provider text is printed |
| DNS: resolves or not, with the time taken | `check_dns`: `addresses`, `ipv4`, `ipv6`, `elapsed_ms`, or `reason=not-found` / `reason=timeout` |
| TLS with the system trust store decides `PLUTON_AGENT_STORAGE_CA_FILE` | `check_tls` reports `system_trust`; `RESULT` repeats it as `storage_ca_file_needed` (`yes`, `no` or `unknown`); decision table in the docs |
| Write, read back, compare, delete one 64 MiB object under a dedicated `probe/` prefix | Default `S3_PROBE_SIZE_MIB=64`, default prefix `probe`, empty prefix refused; `check_write`, `check_read`, `check_compare`, `check_delete`; the trap also deletes on failure and on Ctrl-C |
| MiB/s for upload and download | `mib_per_s` on the `write` and `read` lines |
| Rclone version used, the Agent's private binary when present | `check_rclone`: `version`, `source` (`argument`, `agent` or `download`), `pinned` |
| Section 6.6: the probe runs against the lab fixture in CI-like conditions first | Task 2 lab (internal network, private CA, read-only root, UID 1000) and Task 4 CI step |

Issues found in review and fixed inline:

- The request asks for one PASS or FAIL line per check, but a check that cannot run after an earlier failure would print a misleading `FAIL`. It prints `SKIP <check> reason=earlier-failure` (or `reason=not-created` for `delete` when the endpoint refused the write) instead. A `SKIP` only ever appears together with `RESULT FAIL`, so "exit 0 only when every check passes" still holds, and `cleanup` appears only after an interruption.
- "Writes nothing else to disk" is read as: nothing besides the transient test data. The 64 MiB payload and its read-back copy need a place to be hashed; streaming both through pipes would hide the byte count and add races. They stay in the 0700 `mktemp` directory and are removed right after the comparison and again by the trap.
- A failed TLS check alone cannot say whether a CA file helps (an expired or misnamed certificate fails the same way), so `storage_ca_file_needed` is `yes` only for `certificate-not-trusted` and `unknown` otherwise.
- curl does not report a host-name mismatch in `%{ssl_verify_result}`, so `tls_reason` also reads `%{errormsg}`, in memory only.
- The first version of the "no `-k`" static check matched `df -k`; it now looks only at curl command lines.
- `COPY --chmod` also sets the mode of directories it creates, which locked the non-root lab user out; the Dockerfile copies into the existing `/opt/lab`.
- `RCLONE_AUTH_KEY=id,secret` is split on the comma by Rclone, so the fixture passes `--auth-key` as a flag (synthetic values only).
- Placeholder scan: every step has complete code and exact commands; the only angle-bracket values are operator inputs inside `docs/AGENT_S3_PROBE.md` (`<reviewed-commit>`, `<user>@<agent-host>`), which the operator fills in.

Open questions for the user (none blocks the tasks):

1. `docs/AGENT_S3_PROBE.md` links to `docs/S3_AGENT_REPOSITORY_DESIGN.md`, which is only on `claude/s3-agent-repository-design`. Merge the design pull request first, or accept a dangling link until it lands.
2. Task 4 adds about two minutes to the `build-pr` job. Drop Task 4 if the lab should stay local only.
3. The probe sends no region (`S3_PROBE_REGION` was not requested), so Rclone signs for `us-east-1`. Add a region input only if the operator run fails with `authentication` although the key pair is correct.
