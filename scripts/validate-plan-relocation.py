#!/usr/bin/env python3
"""Disposable loopback plan repository relocation lab; no production endpoint or configuration input."""
import argparse
import os
import pathlib
import re
import subprocess
import uuid


def run(image):
    if not re.fullmatch(r"[a-z0-9-]+:local", image):
        raise RuntimeError("Use a reviewed local fixture image.")

    def local_endpoint(value):
        return value.startswith("unix:///") or value.startswith("npipe:////./pipe/")

    if os.environ.get("DOCKER_HOST") and not local_endpoint(os.environ["DOCKER_HOST"]):
        raise RuntimeError("Only a local Docker endpoint is allowed.")
    context = subprocess.run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], capture_output=True, text=True, timeout=15, check=True).stdout.strip()
    if not local_endpoint(context):
        raise RuntimeError("Only a local Docker context is allowed.")
    root = pathlib.Path(__file__).resolve().parent.parent
    name = "pluton-relocation-" + uuid.uuid4().hex
    args = ["docker", "run", "--rm", "--name", name, "--init", "--network", "none", "--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--cpus", "2", "--memory", "4g", "--memory-swap", "4g", "--pids-limit", "256", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000", "--tmpfs", "/lab:rw,nosuid,nodev,size=1g,uid=1000,gid=1000"]
    for source, target in [(root / "backend/src", "/app/backend/src"), (root / "backend/__tests__", "/app/backend/__tests__"), (root / "backend/drizzle", "/reviewed/drizzle")]:
        args += ["--mount", "type=bind,source=" + str(source) + ",target=" + target + ",readonly"]
    args += ["-e", "NODE_ENV=test", "-e", "PLUTON_DATA_DIR=/lab/app", "-e", "USER_NAME=fixture-admin"]
    for key in ["ENCRYPTION_KEY", "SECRET", "APIKEY", "USER_PASSWORD"]:
        args += ["-e", key + "=" + uuid.uuid4().hex]
    args += ["--entrypoint", "node", image, "/app/backend/node_modules/tsx/dist/cli.mjs", "/app/backend/__tests__/integration/planRelocation.lab.ts"]
    try:
        subprocess.run(args, timeout=900, check=True)
    finally:
        # The only mutable resource is this exact locally generated container name.
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=30, check=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", nargs="?", default="pluton-replica-recovery:local")
    options = parser.parse_args()
    try:
        run(options.image)
    except (RuntimeError, subprocess.SubprocessError, OSError):
        # Never print subprocess argv/environment or raw provider output.
        raise SystemExit("FAIL disposable plan relocation lab; inspect the safe lab phase above.")
