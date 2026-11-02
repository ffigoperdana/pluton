"""Private key management/mount policy: disposable random secrets, never Docker/S3."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("export_keys", ROOT / "deploy/managed-export-keys.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
policy = module.policy


class ExportKeyTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name)
        self.root.chmod(0o700)
        self.key = self.root / "keys.json"
        module.create(self.key)
        self.ref = "ghcr.io/example/pluton@sha256:" + "a" * 64
        for name in ("compose.yml", "compose.managed-export-keys.yml"):
            self.write(name, "# disposable approved fixture\n")
        self.write("compose.overlays", "compose.managed-export-keys.yml\n")
        self.old = {"project": "disposable-app", "mounts": [{"type": "volume", "source": "disposable-data", "target": "/data", "read_only": False, "propagation": ""}]}
        self.write(".deploy-contract.json", json.dumps(self.old))
        self.write(".deploy-compose-files.json", '["compose.yml"]')
        self.write(".deploy-state", "LAST_SUCCESSFUL_IMAGE_REF=" + self.ref + "\n")
        env = dict.fromkeys(("APP_URL", "APP_ALLOWED_ORIGINS", "AGENT_SERVER_URL", "ALLOW_INSECURE_AGENT_HTTP", "TRUST_PROXY"), "")
        env.update(MANAGED_EXPORT_MODE="application-encrypted-hcp", MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE="true", MANAGED_EXPORT_PREFIX="pluton-temporary-exports", MANAGED_EXPORT_KEYRING_FILE=policy.EXPORT_KEYRING_TARGET)
        self.config = {"name": "disposable-app", "volumes": {"data": {"name": "disposable-data"}}, "services": {"pluton": {"image": self.ref, "user": "10001:10001", "read_only": True, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "environment": env, "healthcheck": {"test": ["CMD", "node", "-e", policy.probe_source(ROOT / "deploy/healthcheck.cjs")]}, "volumes": [{"type": "volume", "source": "data", "target": "/data"}, {"type": "bind", "source": str(self.key), "target": policy.EXPORT_KEYRING_TARGET, "read_only": True, "bind": {"create_host_path": False}}]}}}

    def tearDown(self):
        self.scratch.cleanup()

    def write(self, name, value):
        p = self.root / name
        p.write_text(value)
        p.chmod(0o600)
        return p

    @contextlib.contextmanager
    def runtime_owner(self, uid=10001):
        # Model runtime UID metadata without requiring privileged chown in CI.
        original = Path.lstat
        def info(p, *args, **kwargs):
            value = original(p, *args, **kwargs)
            if p == self.key:
                return SimpleNamespace(st_mode=value.st_mode, st_size=value.st_size, st_uid=uid, st_gid=10001, st_nlink=value.st_nlink)
            return value
        with mock.patch.object(Path, "lstat", info):
            yield

    def review(self):
        config = self.write("effective.json", json.dumps(self.config))
        with self.runtime_owner():
            return module.approve(self.root, config)

    def test_review_only_retains_all_existing_contracts(self):
        self.assertEqual(self.review(), "export-keys-change-reviewed-no-write")
        self.assertEqual(policy.load(self.root / ".deploy-contract.json"), self.old)

    def test_approval_requires_healthy_matching_runtime_and_preserves_original_contract_backups(self):
        expected = policy.mounts(self.config)
        container = {"Config": {"Image": self.ref, "User": "10001:10001", "Labels": {
            "com.docker.compose.service": "pluton", "com.docker.compose.project": "disposable-app"}},
            "State": {"Status": "running", "Health": {"Status": "unhealthy"}},
            "Mounts": [{"Type": m["type"], "Name": m["source"] if m["type"] == "volume" else "",
                        "Source": m["source"], "Destination": m["target"], "RW": not m["read_only"],
                        "Propagation": m["propagation"]} for m in expected]}
        config = self.write("effective.json", json.dumps(self.config))
        inspection = self.write("inspect.json", json.dumps([container]))
        with self.runtime_owner(), self.assertRaisesRegex(policy.Refused, "not-healthy"):
            module.approve(self.root, config, inspection)
        self.assertEqual(policy.load(self.root / ".deploy-contract.json"), self.old)
        container["State"]["Health"]["Status"] = "healthy"
        inspection.write_text(json.dumps([container]))
        with self.runtime_owner():
            self.assertEqual(module.approve(self.root, config, inspection), "export-keys-contract-approved-existing-mounts-preserved")
        self.assertEqual(policy.load(self.root / ".deploy-contract.json.before-export-keys"), self.old)
        self.assertEqual(policy.load(self.root / ".deploy-contract.json")["mounts"], expected)
        self.assertFalse((self.root / ".deployment-lock").exists())

    def test_no_keyring_symlink_or_hardlink_can_be_adopted(self):
        link = self.root / "link.json"
        link.symlink_to(self.key)
        with self.assertRaises(policy.Refused): module.keyring(link)
        hard = self.root / "hard.json"
        os.link(self.key, hard)
        with self.assertRaises(policy.Refused): module.keyring(hard)
        with self.runtime_owner(), self.assertRaises(policy.Refused): policy.validate_export_keys(self.config)

    def test_create_and_rotation_never_overwrite_or_drop_old_keys(self):
        old = module.keyring(self.key)
        new = self.root / "next.json"
        self.assertFalse(old["keys"][old["active"]] in module.create(new, self.key))
        rotated = module.keyring(new)
        self.assertNotEqual(old["active"], rotated["active"])
        self.assertTrue(all(rotated["keys"].get(k) == v for k, v in old["keys"].items()))
        with self.assertRaises(FileExistsError): module.create(new)
        self.assertTrue(module.keyring(self.key) == old)

    def test_private_file_schema_mode_and_runtime_owner_are_mandatory(self):
        for change in ("world-readable", "group-write", "owner", "invalid", "missing-slot", "oversized"):
            with self.subTest(change=change):
                original = self.key.read_text()
                if change == "world-readable": self.key.chmod(0o644)
                if change == "group-write": self.key.chmod(0o620)
                if change == "invalid": self.key.write_text('{"private-invalid-content":true}')
                if change == "missing-slot":
                    value = json.loads(original); value["active"] = "absent"; self.key.write_text(json.dumps(value))
                if change == "oversized": self.key.write_bytes(b"x" * (16 * 1024 + 1))
                with self.runtime_owner(10002 if change == "owner" else 10001), self.assertRaises((policy.Refused, ValueError)):
                    policy.validate_export_keys(self.config)
                self.key.write_text(original); self.key.chmod(0o600)

    def test_only_one_safe_file_mount_and_no_other_contract_change_can_be_approved(self):
        for change in ("writable", "create-path", "target", "data", "image", "project", "sandbox"):
            with self.subTest(change=change):
                original = json.loads(json.dumps(self.config))
                app = self.config["services"]["pluton"]
                item = app["volumes"][1]
                if change == "writable": item["read_only"] = False
                if change == "create-path": item["bind"]["create_host_path"] = True
                if change == "target": item["target"] = "/other"
                if change == "data": self.config["volumes"]["data"]["name"] = "other-data"
                if change == "image": app["image"] = self.ref[:-1] + "b"
                if change == "project": self.config["name"] = "other-app"
                if change == "sandbox": app["read_only"] = False
                with self.assertRaises(policy.Refused): self.review()
                self.config = original

    def test_keyring_is_never_optional_in_encrypted_mode(self):
        app = self.config["services"]["pluton"]
        app["volumes"].pop()
        with self.assertRaises(policy.Refused): policy.validate_export_keys(self.config)
        app["environment"]["MANAGED_EXPORT_KEYRING_FILE"] = ""
        with self.assertRaises(policy.Refused): policy.validate_export_keys(self.config)


if __name__ == "__main__":
    unittest.main()
