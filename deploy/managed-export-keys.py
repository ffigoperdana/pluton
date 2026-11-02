#!/usr/bin/env python3
"""Explicit local key provisioning and approval of ONE private read-only mount.
Never deploys, restarts, contacts S3, reads backup credentials or prints keys.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("deployment_policy", ROOT / "compose-tools.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def keyring(source):
    source = Path(source)
    policy.require(source.is_absolute() and source.resolve() == source, "keyring-source-unsafe")
    info = source.lstat()
    policy.require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 16 * 1024 and
                   info.st_uid in (0, 10001, os.geteuid()) and not info.st_mode & 0o037,
                   "keyring-source-permissions")
    value = json.loads(source.read_text())
    policy.require(isinstance(value, dict) and set(value) == {"version", "active", "keys"} and type(value["version"]) is int and value["version"] == 1 and
                   isinstance(value["keys"], dict) and 1 <= len(value["keys"]) <= 16 and
                   isinstance(value["active"], str) and value["active"] in value["keys"], "keyring-invalid")
    for name, encoded in value["keys"].items():
        policy.require(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name) and isinstance(encoded, str) and
                       re.fullmatch(r"[A-Za-z0-9+/]{43}=", encoded) and
                       base64.b64encode(base64.b64decode(encoded, validate=True)).decode() == encoded,
                       "keyring-invalid")
    return value


def create(output, previous=None):
    output = Path(output)
    policy.require(output.is_absolute() and output.parent.resolve() == output.parent, "keyring-output-path")
    policy.trusted_directory(output.parent)
    value = keyring(previous) if previous else {"version": 1, "active": "", "keys": {}}
    policy.require(len(value["keys"]) < 16, "keyring-retirement-review-required")
    name = "key-" + secrets.token_hex(8)
    policy.require(name not in value["keys"], "keyring-slot-collision")
    value["keys"][name] = base64.b64encode(secrets.token_bytes(32)).decode()
    value["active"] = name
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    return "keyring-created-private-no-values-emitted-retain-independent-backup"


def approve(directory, configuration, inspection=None):
    directory = Path(directory).resolve()
    policy.trusted_directory(directory)
    policy.trusted(configuration)
    for name in (".deploy-contract.json", ".deploy-compose-files.json", ".deploy-state"):
        policy.trusted(directory / name)
    current = policy.load(directory / ".deploy-contract.json")
    old_files = policy.load(directory / ".deploy-compose-files.json")
    files = policy.selection(directory)
    policy.require(files == old_files + ["compose.managed-export-keys.yml"], "export-keys-only-overlay-addition")
    config = policy.load(configuration)
    state = dict(line.split("=", 1) for line in (directory / ".deploy-state").read_text().splitlines()
                 if "=" in line and not line.startswith("#"))
    policy.require(config["services"]["pluton"]["image"] == state.get("LAST_SUCCESSFUL_IMAGE_REF"),
                   "export-keys-image-must-stay-unchanged")
    with tempfile.TemporaryDirectory(prefix="pluton-export-keys-") as workspace:
        desired = policy.validate_config(configuration, config["services"]["pluton"]["image"], ROOT / "healthcheck.cjs", workspace)
    additions = [m for m in desired["mounts"] if m["target"] == policy.EXPORT_KEYRING_TARGET]
    retained = [m for m in desired["mounts"] if m["target"] != policy.EXPORT_KEYRING_TARGET]
    policy.require(len(additions) == 1 and desired["project"] == current["project"] and retained == current["mounts"] and
                   not any(m["target"] == policy.EXPORT_KEYRING_TARGET for m in current["mounts"]), "export-keys-other-contract-change")
    if inspection is None:
        return "export-keys-change-reviewed-no-write"
    policy.trusted(inspection)
    container = policy.check_container(configuration, inspection)
    policy.require(container["Config"].get("Image") == state["LAST_SUCCESSFUL_IMAGE_REF"], "export-keys-running-image-changed")
    policy.require(container["State"].get("Status") == "running" and container["State"].get("Health", {}).get("Status") == "healthy",
                   "export-keys-container-not-healthy")
    lock = directory / ".deployment-lock"
    lock.mkdir(mode=0o700)
    try:
        policy.require(policy.load(directory / ".deploy-contract.json") == current and
                       policy.load(directory / ".deploy-compose-files.json") == old_files, "export-keys-records-changed")
        for name in (".deploy-contract.json", ".deploy-compose-files.json"):
            policy.require(not (directory / (name + ".before-export-keys")).exists(), "export-keys-backup-already-exists")
        for name in (".deploy-contract.json", ".deploy-compose-files.json"):
            with (directory / (name + ".before-export-keys")).open("x") as stream:
                os.chmod(stream.name, 0o600)
                stream.write((directory / name).read_text())
        for name, value in ((".deploy-contract.json", desired), (".deploy-compose-files.json", files)):
            temporary = directory / (name + ".export-keys.tmp")
            policy.require(not temporary.exists(), "export-keys-temporary-exists")
            policy.save(temporary, value)
            temporary.replace(directory / name)
    finally:
        lock.rmdir()
    return "export-keys-contract-approved-existing-mounts-preserved"


if __name__ == "__main__":
    try:
        args = sys.argv[1:]
        if len(args) == 2 and args[0] == "create":
            print(create(args[1]))
        elif len(args) == 3 and args[0] == "rotate":
            print(create(args[2], args[1]))
        elif len(args) in (3, 4) and args[0] == "approve":
            print(approve(*args[1:]))
        else:
            raise policy.Refused("usage-create-output-or-rotate-old-new-or-approve-directory-private-config-optional-inspect")
    except policy.Refused as error:
        print("Export key operation refused: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Export key operation refused: invalid-or-inaccessible-private-input", file=sys.stderr)
        sys.exit(1)
