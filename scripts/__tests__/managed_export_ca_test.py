"""Public CA mount approval: synthetic protected files only, no production Docker."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("export_ca", ROOT / "deploy/approve-managed-export-ca.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
policy = module.policy


class ExportCaTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name)
        self.ref = "ghcr.io/example/pluton@sha256:" + "a" * 64
        for name in ("compose.yml", "compose.managed-export-ca.yml"):
            self.write(name, "# synthetic approved operator file\n")
        self.write("compose.overlays", "compose.managed-export-ca.yml\n")
        self.ca = self.write("ca.pem", "-----BEGIN CERTIFICATE-----\nsynthetic-policy-fixture\n-----END CERTIFICATE-----\n")
        self.old = {"project": "disposable-app", "mounts": [{"type": "volume", "source": "disposable-data", "target": "/data", "read_only": False, "propagation": ""}]}
        self.write(".deploy-contract.json", json.dumps(self.old))
        self.write(".deploy-compose-files.json", '["compose.yml"]')
        self.write(".deploy-state", "LAST_SUCCESSFUL_IMAGE_REF=" + self.ref + "\n")
        self.config = {"name": "disposable-app", "volumes": {"data": {"name": "disposable-data"}}, "services": {"pluton": {"image": self.ref, "read_only": True, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "environment": dict.fromkeys(("APP_URL", "APP_ALLOWED_ORIGINS", "AGENT_SERVER_URL", "ALLOW_INSECURE_AGENT_HTTP", "TRUST_PROXY"), ""), "healthcheck": {"test": ["CMD", "node", "-e", policy.probe_source(ROOT / "deploy/healthcheck.cjs")]}, "volumes": [{"type": "volume", "source": "data", "target": "/data"}, {"type": "bind", "source": str(self.ca), "target": policy.EXPORT_CA_TARGET, "read_only": True, "bind": {"create_host_path": False}}]}}}
        self.config["services"]["pluton"]["environment"]["MANAGED_EXPORT_CA_FILE"] = policy.EXPORT_CA_TARGET

    def tearDown(self):
        self.scratch.cleanup()

    def write(self, name, content):
        path = self.root / name
        path.write_text(content)
        path.chmod(0o600)
        return path

    def review(self, inspect=None):
        config = self.write("effective.json", json.dumps(self.config))
        return module.approve(self.root, config, inspect)

    def test_review_only_never_writes_contract(self):
        self.assertEqual(self.review(), "export-ca-change-reviewed-no-write")
        self.assertEqual(policy.load(self.root / ".deploy-contract.json"), self.old)

    def test_refuses_writeable_missing_or_directory_ca(self):
        for change in ("writable", "directory", "create", "target", "key", "symlink"):
            with self.subTest(change=change):
                original = json.loads(json.dumps(self.config))
                item = self.config["services"]["pluton"]["volumes"][1]
                if change == "writable": item["read_only"] = False
                if change == "directory": item["source"] = str(self.root)
                if change == "create": item["bind"]["create_host_path"] = True
                if change == "target": item["target"] = "/other"
                if change == "key": self.ca.write_text("-----BEGIN PRIVATE KEY-----\nsynthetic")
                if change == "symlink":
                    link = self.root / "ca-link.pem"
                    link.symlink_to(self.ca)
                    item["source"] = str(link)
                with self.assertRaises(policy.Refused): self.review()
                self.config = original
                self.ca.write_text("-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----")

    def test_other_mount_image_and_project_changes_are_never_approved(self):
        for change in ("data", "project", "image", "readonly"):
            original = json.loads(json.dumps(self.config))
            if change == "data": self.config["volumes"]["data"]["name"] = "other-data"
            if change == "project": self.config["name"] = "other-app"
            if change == "image": self.config["services"]["pluton"]["image"] = self.ref[:-1] + "b"
            if change == "readonly": self.config["services"]["pluton"]["read_only"] = False
            with self.subTest(change=change), self.assertRaises(policy.Refused): self.review()
            self.config = original

    def test_healthy_actual_mounts_required_before_persisting_approval(self):
        config_path = self.write("effective.json", json.dumps(self.config))
        expected = policy.mounts(self.config)
        container = {"Config": {"Image": self.ref, "User": "10001:10001", "Labels": {"com.docker.compose.service": "pluton", "com.docker.compose.project": "disposable-app"}}, "State": {"Status": "running", "Health": {"Status": "healthy"}}, "Mounts": [{"Type": m["type"], "Name": m["source"] if m["type"] == "volume" else "", "Source": m["source"], "Destination": m["target"], "RW": not m["read_only"], "Propagation": m["propagation"]} for m in expected]}
        inspection = self.write("inspect.json", json.dumps([container]))
        container["State"]["Health"]["Status"] = "unhealthy"
        inspection.write_text(json.dumps([container]))
        with self.assertRaisesRegex(policy.Refused, "not-healthy"): self.review(inspection)
        container["State"]["Health"]["Status"] = "healthy"
        inspection.write_text(json.dumps([container]))
        self.assertEqual(self.review(inspection), "export-ca-contract-approved-existing-mounts-preserved")
        self.assertEqual(policy.load(self.root / ".deploy-contract.json.before-export-ca"), self.old)
        self.assertEqual(policy.load(self.root / ".deploy-contract.json")["mounts"], expected)

    def test_actual_environment_comparison_never_emits_private_values(self):
        environment = self.config["services"]["pluton"]["environment"]
        for name in ("ENABLED", "ALLOW_SHARED_NAMESPACE", "ENDPOINT", "REGION", "BUCKET", "PREFIX", "ACCESS_KEY_ID",
                     "SECRET_ACCESS_KEY", "SESSION_TOKEN", "CA_FILE", "TTL_SECONDS"):
            environment["MANAGED_EXPORT_" + name] = "synthetic-private-value"
        environment["MANAGED_EXPORT_CA_FILE"] = policy.EXPORT_CA_TARGET
        config = self.write("effective.json", json.dumps(self.config))
        expected = policy.mounts(self.config)
        container = {"Config": {"User": "10001:10001", "Labels": {"com.docker.compose.service": "pluton", "com.docker.compose.project": "disposable-app"}, "Env": [key + "=" + value for key, value in environment.items()]}, "Mounts": [{"Type": m["type"], "Name": m["source"], "Source": m["source"], "Destination": m["target"], "RW": not m["read_only"], "Propagation": m["propagation"]} for m in expected]}
        inspect = self.write("inspect.json", json.dumps([container]))
        self.assertEqual(policy.verify_export_environment(config, inspect), "export-environment-matches-all-11-fields-no-values-emitted")
        container["Config"]["Env"].remove("MANAGED_EXPORT_SECRET_ACCESS_KEY=synthetic-private-value")
        inspect.write_text(json.dumps([container]))
        with self.assertRaisesRegex(policy.Refused, "export-environment-mismatch-MANAGED_EXPORT_SECRET_ACCESS_KEY"):
            policy.verify_export_environment(config, inspect)

    def test_shared_mode_is_explicit_and_uses_only_the_fixed_export_prefix(self):
        environment = self.config["services"]["pluton"]["environment"]
        environment["MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE"] = "true"
        environment["MANAGED_EXPORT_PREFIX"] = "pluton-temporary-exports"
        self.assertEqual(self.review(), "export-ca-change-reviewed-no-write")
        environment["MANAGED_EXPORT_PREFIX"] = "pluton-temporary-exports/nested"
        with self.assertRaisesRegex(policy.Refused, "export-shared-prefix-fixed"): self.review()
        environment["MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE"] = "yes"
        with self.assertRaisesRegex(policy.Refused, "export-shared-mode-invalid"): self.review()


if __name__ == "__main__":
    unittest.main()
