#!/usr/bin/env python3
"""Explicit operator-only approval of ONE additional read-only public CA mount.
Never deploys/restarts a container, changes env, or reads backup/S3 credentials.
Expanded config/inspect inputs remain private files, never printed.
"""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("deployment_policy", ROOT / "compose-tools.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def approve(directory, configuration, inspection=None):
    directory = Path(directory).resolve()
    policy.trusted_directory(directory)
    policy.trusted(configuration)
    for name in (".deploy-contract.json", ".deploy-compose-files.json"):
        policy.trusted(directory / name)
    current = policy.load(directory / ".deploy-contract.json")
    old_files = policy.load(directory / ".deploy-compose-files.json")
    files = policy.selection(directory)
    policy.require(files == old_files + ["compose.managed-export-ca.yml"], "export-ca-only-overlay-addition")
    config = policy.load(configuration)
    policy.trusted(directory / ".deploy-state")
    state = dict(line.split("=", 1) for line in (directory / ".deploy-state").read_text().splitlines()
                 if "=" in line and not line.startswith("#"))
    policy.require(config["services"]["pluton"]["image"] == state.get("LAST_SUCCESSFUL_IMAGE_REF"),
                   "export-ca-image-must-stay-unchanged")
    # Re-run the complete deployment policy with no pre-existing contract, then
    # compare every old mount/project. No generic contract exception is added.
    with tempfile.TemporaryDirectory(prefix="pluton-export-ca-") as workspace:
        desired = policy.validate_config(configuration, config["services"]["pluton"]["image"],
                                         ROOT / "healthcheck.cjs", workspace)
    additions = [m for m in desired["mounts"] if m["target"] == policy.EXPORT_CA_TARGET]
    retained = [m for m in desired["mounts"] if m["target"] != policy.EXPORT_CA_TARGET]
    policy.require(len(additions) == 1 and desired["project"] == current["project"] and
                   retained == current["mounts"] and not any(m["target"] == policy.EXPORT_CA_TARGET for m in current["mounts"]),
                   "export-ca-other-contract-change")
    if inspection is None:
        return "export-ca-change-reviewed-no-write"
    policy.trusted(inspection)
    container = policy.check_container(configuration, inspection)
    policy.require(container["Config"].get("Image") == state["LAST_SUCCESSFUL_IMAGE_REF"], "export-ca-running-image-changed")
    policy.require(container["State"].get("Status") == "running" and
                   container["State"].get("Health", {}).get("Status") == "healthy", "export-ca-container-not-healthy")
    lock = directory / ".deployment-lock"
    lock.mkdir(mode=0o700)  # A live deployment/upgrade prevents approval.
    try:
        policy.require(policy.load(directory / ".deploy-contract.json") == current and
                       policy.load(directory / ".deploy-compose-files.json") == old_files,
                       "export-ca-records-changed-during-review")
        for name in (".deploy-contract.json", ".deploy-compose-files.json"):
            backup = directory / (name + ".before-export-ca")
            policy.require(not backup.exists(), "export-ca-backup-already-exists")
        for name in (".deploy-contract.json", ".deploy-compose-files.json"):
            with (directory / (name + ".before-export-ca")).open("x") as stream:
                os.chmod(stream.name, 0o600)
                stream.write((directory / name).read_text())
        for name, value in ((".deploy-contract.json", desired), (".deploy-compose-files.json", files)):
            temporary = directory / (name + ".export-ca.tmp")
            policy.require(not temporary.exists(), "export-ca-temporary-exists")
            policy.save(temporary, value)
            temporary.replace(directory / name)
    finally:
        lock.rmdir()
    return "export-ca-contract-approved-existing-mounts-preserved"


if __name__ == "__main__":
    try:
        policy.require(len(sys.argv) in (3, 4), "usage-deployment-directory-private-config-optional-private-inspect")
        print(approve(*sys.argv[1:]))
    except policy.Refused as error:
        print("Export CA approval refused: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Export CA approval refused: invalid-or-inaccessible-metadata", file=sys.stderr)
        sys.exit(1)
