#!/usr/bin/env python3
"""Operator-only deployment JSON/file policy. Stdlib only; never print configuration.

Not imported by Pluton. Expanded Compose/inspect JSON stays in a private host
workspace, is never a CLI argument, and is removed at the end of the transaction.
"""
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys


class Refused(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refused(code)


def load(path):
    require(Path(path).stat().st_size <= 4 * 1024 * 1024, "metadata-too-large")
    return json.loads(Path(path).read_text())


def save(path, value):
    Path(path).write_text(json.dumps(value, sort_keys=True) + "\n")
    os.chmod(path, 0o600)


def trusted(path):
    info = Path(path).lstat()
    require(stat.S_ISREG(info.st_mode), "operator-file-not-regular")
    require(info.st_uid in (0, os.geteuid()) and not info.st_mode & 0o022,
            "operator-file-ownership-or-mode")
    require(info.st_size <= 1024 * 1024, "operator-file-too-large")


def trusted_directory(path):
    info = Path(path).lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.geteuid()) and
            not info.st_mode & 0o022, "operator-directory-ownership-or-mode")


def selection(directory):
    root = Path(directory)
    trusted_directory(root)
    names = ["compose.yml"]
    if (root / "compose.lab.yml").exists():
        names.append("compose.lab.yml")
    configured = root / "compose.overlays"
    if configured.exists():
        trusted(configured)
        for line in configured.read_text().splitlines():
            name = line.strip()
            if not name or name.startswith("#"):
                continue
            require(re.fullmatch(r"compose\.[a-z0-9][a-z0-9.-]*\.ya?ml", name) is not None,
                    "overlay-name-invalid")
            require(name not in names, "overlay-duplicate")
            names.append(name)
    require(len(names) <= 9, "too-many-overlays")
    for name in names:
        require((root / name).exists(), "configured-overlay-missing")
        trusted(root / name)
    recorded = root / ".deploy-compose-files.json"
    if recorded.exists():
        trusted(recorded)
        previous = load(recorded)
        require([name for name in names if name in previous] == previous,
                "previously-approved-overlay-missing-or-reordered")
    return names


def snapshot(directory, workspace):
    names = selection(directory)
    target = Path(workspace) / "compose"
    target.mkdir(mode=0o700)
    for name in names:
        shutil.copyfile(Path(directory) / name, target / name)
        os.chmod(target / name, 0o600)
    trusted(Path(directory) / ".env")
    shutil.copyfile(Path(directory) / ".env", Path(workspace) / ".env")
    os.chmod(Path(workspace) / ".env", 0o600)
    save(Path(workspace) / "files.json", names)


def compose(directory, workspace, arguments):
    names = load(Path(workspace) / "files.json")
    command = ["docker", "compose", "--project-directory", directory,
               "--env-file", str(Path(workspace) / ".env")]
    for name in names:
        command += ["-f", str(Path(workspace) / "compose" / name)]
    # The host shell must not override .env, enable profiles, or inject files.
    keep = ("PATH", "HOME", "USER", "TMPDIR", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR")
    environment = {key: value for key, value in os.environ.items()
                   if key in keep or key.startswith("DOCKER_")}
    environment.update(COMPOSE_REMOVE_ORPHANS="false", COMPOSE_IGNORE_ORPHANS="true", COMPOSE_PROFILES="")
    return subprocess.call(command + arguments, env=environment)


def mounts(config):
    result = []
    for item in config["services"]["pluton"].get("volumes", []):
        kind = item["type"]
        require(kind in ("bind", "volume", "tmpfs"), "mount-type-unsupported")
        if kind == "tmpfs":
            continue
        source = item.get("source", "")
        require(source and not item.get("volume", {}).get("subpath"), "anonymous-or-subpath-volume")
        if kind == "volume":
            source = config.get("volumes", {}).get(source, {}).get("name", "")
            require(source, "volume-name-unresolved")
        else:
            require(os.path.isabs(source) and os.path.exists(source), "bind-source-missing")
        result.append({"type": kind, "source": source, "target": item["target"],
                       "read_only": bool(item.get("read_only", False)),
                       "propagation": (item.get("bind", {}).get("propagation") or "rprivate") if kind == "bind" else ""})
    require(len({item["target"] for item in result}) == len(result), "mount-target-duplicate")
    require(any(item["target"] == "/data" and item["type"] == "volume" and not item["read_only"]
                for item in result), "persistent-data-volume-required")
    return sorted(result, key=lambda item: item["target"])


def contract(config):
    return {"project": config["name"], "mounts": mounts(config)}


def probe_source(path):
    return "\n".join(line for line in Path(path).read_text().splitlines()
                     if not line.startswith("//")).strip() + "\n"


def validate_config(path, ref, health_file, directory):
    config = load(path)
    service = config.get("services", {}).get("pluton", {})
    require(service.get("image") == ref, "application-image-overridden")
    require(not service.get("build") and not service.get("privileged") and
            not service.get("use_api_socket") and not service.get("devices") and
            not service.get("volumes_from"), "application-privilege-not-allowed")
    require(service.get("user", "10001:10001") in ("10001", "10001:10001", "pluton", "pluton:pluton"),
            "application-runtime-user")
    require(not service.get("profiles"), "application-must-not-require-profile")
    require(service.get("read_only") is True and service.get("cap_drop") == ["ALL"] and
            "no-new-privileges:true" in service.get("security_opt", []), "application-sandbox-required")
    environment = service.get("environment", {})
    for key in ("APP_URL", "APP_ALLOWED_ORIGINS", "AGENT_SERVER_URL", "ALLOW_INSECURE_AGENT_HTTP", "TRUST_PROXY"):
        require(key in environment, "supported-environment-setting-missing")
    require(service.get("healthcheck", {}).get("test") == ["CMD", "node", "-e", probe_source(health_file)],
            "reviewed-get-healthcheck-required")
    value = contract(config)
    for item in value["mounts"]:
        require(not re.search(r"(?:docker|podman)\.sock", item["source"] + item["target"]),
                "application-engine-socket-not-allowed")
    recorded = Path(directory) / ".deploy-contract.json"
    if recorded.exists():
        trusted(recorded)
        require(load(recorded) == value, "recorded-project-or-mounts-changed")
    return value


def actual_mounts(container):
    result = []
    for item in container["Mounts"]:
        if item["Type"] not in ("bind", "volume"):
            continue
        result.append({"type": item["Type"], "source": item.get("Name") if item["Type"] == "volume" else item["Source"],
                       "target": item["Destination"], "read_only": not item["RW"],
                       "propagation": (item.get("Propagation") or "rprivate") if item["Type"] == "bind" else ""})
    return sorted(result, key=lambda item: item["target"])


def check_container(config_file, inspect_file):
    config, container = load(config_file), load(inspect_file)[0]
    labels = container["Config"].get("Labels", {})
    require(labels.get("com.docker.compose.service") == "pluton" and
            labels.get("com.docker.compose.project") == config["name"], "container-identity-mismatch")
    require(container["Config"].get("User") in ("10001", "10001:10001", "pluton", "pluton:pluton") and
            not container.get("HostConfig", {}).get("Privileged"), "container-runtime-user-or-privilege")
    actual, expected = actual_mounts(container), mounts(config)
    if actual != expected:
        fields = [key for key in ("type", "source", "target", "read_only", "propagation")
                  if [item[key] for item in actual] != [item[key] for item in expected]]
        raise Refused("container-mounts-mismatch-" + "-".join(fields))
    return container


def previous_ref(config_file, inspect_file, image_file, repository):
    container = check_container(config_file, inspect_file)
    image = load(image_file)[0]
    require(container["Image"] == image["Id"], "current-image-identity-mismatch")
    prefix = repository + "@sha256:"
    refs = [value for value in image.get("RepoDigests", []) if value.startswith(prefix)]
    configured = container["Config"]["Image"]
    if configured in refs:
        return configured
    require(len(refs) == 1, "previous-immutable-image-unavailable")
    return refs[0]


def image_valid(image_file, ref):
    image = load(image_file)[0]
    require(ref in image.get("RepoDigests", []), "pulled-image-digest-mismatch")
    require(image["Config"].get("User") in ("10001", "10001:10001", "pluton", "pluton:pluton"),
            "image-runtime-user-mismatch")
    return image["Id"]


def main(args):
    action, *values = args
    if action == "snapshot":
        snapshot(*values)
    elif action == "compose":
        return compose(values[0], values[1], values[2:])
    elif action == "validate":
        save(values[4], validate_config(*values[:4]))
    elif action == "previous":
        print(previous_ref(*values))
    elif action == "image":
        print(image_valid(*values))
    elif action == "check-container":
        container = check_container(*values[:2])
        require(container["Image"] == values[2], "new-container-image-mismatch")
    elif action == "field":
        value = load(values[0])[0]
        for field in values[1].split("."):
            value = value.get(field, "") if isinstance(value, dict) else ""
        require(isinstance(value, (str, bool)), "field-not-scalar")
        print(str(value).lower() if isinstance(value, bool) else value)
    elif action == "record":
        directory, workspace = map(Path, values)
        for source, target in (("files.json", ".deploy-compose-files.json"), ("contract.json", ".deploy-contract.json")):
            temporary = directory / (target + ".tmp")
            save(temporary, load(workspace / source))
            temporary.replace(directory / target)
    elif action == "private-directory":
        path = Path(values[0])
        trusted_directory(path.parent)
        if not path.exists() and not path.is_symlink():
            path.mkdir(mode=0o700)
        trusted_directory(path)
        require(not path.stat().st_mode & 0o077, "private-directory-mode-required")
    else:
        raise Refused("unsupported-operation")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Refused as error:
        print("Deployment policy refused: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Deployment policy refused: invalid-or-inaccessible-metadata", file=sys.stderr)
        sys.exit(1)
