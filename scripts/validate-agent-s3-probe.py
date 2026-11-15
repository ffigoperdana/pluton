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
DOC = ROOT / "docs" / "AGENT_S3_PROBE.md"
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
AUTH_PASS = r"PASS auth"
WRITE_8_MIB = r"PASS write bytes=8388608 elapsed_ms=\d+ mib_per_s=\d+\.\d\d"
READ_8_MIB = r"PASS read bytes=8388608 elapsed_ms=\d+ mib_per_s=\d+\.\d\d"
NOT_RUN = [r"SKIP write reason=earlier-failure", r"SKIP read reason=earlier-failure", r"SKIP compare reason=earlier-failure", r"SKIP delete reason=earlier-failure"]
ROUND_TRIP_8_MIB = [AUTH_PASS, WRITE_8_MIB, READ_8_MIB, r"PASS compare sha256=match", r"PASS delete object=removed"]


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
            AUTH_PASS,
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
        "stdout": [RCLONE_ARGUMENT, DNS_PASS, TLS_WITH_CA, r"FAIL auth reason=authentication", r"SKIP write reason=auth-failed", r"SKIP read reason=earlier-failure", r"SKIP compare reason=earlier-failure", r"SKIP delete reason=not-created", r"RESULT FAIL storage_ca_file_needed=yes"],
    },
    {
        "name": "read-failure-cleans-up",
        "args": ["--rclone", "/opt/lab/rclone-cat-fails.sh"],
        "exit": 1,
        "stdout": [AUTH_PASS, WRITE_8_MIB, r"FAIL read reason=server-error", r"SKIP compare reason=earlier-failure", r"PASS delete object=removed", r"RESULT FAIL storage_ca_file_needed=yes"],
    },
    {
        "name": "interrupt-cleans-up",
        "args": ["--rclone", "/opt/lab/rclone-cat-interrupted.sh"],
        "exit": 130,
        "stdout": [AUTH_PASS, WRITE_8_MIB, r"PASS cleanup object=removed", r"RESULT FAIL storage_ca_file_needed=yes interrupted=yes"],
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
