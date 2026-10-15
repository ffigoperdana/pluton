"""Linux host policy regressions; all files are private, disposable fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("deployment_policy", ROOT / "deploy/compose-tools.py")
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)


class DeploymentPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for name in ("compose.yml", ".env"):
            self.write(name, "# disposable\n")

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name, value):
        path = self.root / name
        path.write_text(value)
        path.chmod(0o600)
        return path

    def test_base_only(self):
        self.assertEqual(POLICY.selection(self.root), ["compose.yml"])

    def test_lab_and_explicit_precedence(self):
        self.write("compose.lab.yml", "# local\n")
        self.write("compose.worker.yml", "# explicit\n")
        self.write("compose.overlays", "# approved\ncompose.worker.yml\n")
        self.assertEqual(POLICY.selection(self.root), ["compose.yml", "compose.lab.yml", "compose.worker.yml"])

    def test_profiles_not_discovered_by_glob(self):
        self.write("compose.internal-recovery.yml", "# not selected\n")
        self.assertEqual(POLICY.selection(self.root), ["compose.yml"])

    def test_missing_explicit_overlay_refused(self):
        self.write("compose.overlays", "compose.missing.yml\n")
        with self.assertRaisesRegex(POLICY.Refused, "missing"):
            POLICY.selection(self.root)

    def test_removed_previously_approved_lab_refused(self):
        self.write(".deploy-compose-files.json", '["compose.yml","compose.lab.yml"]')
        with self.assertRaisesRegex(POLICY.Refused, "missing-or-reordered"):
            POLICY.selection(self.root)

    def test_overlay_injection_refused(self):
        for name in ("../compose.host.yml", "/tmp/compose.host.yml", "compose.a.yml;id", "$(id)", "compose.a.yml --profile all"):
            self.write("compose.overlays", name)
            with self.assertRaisesRegex(POLICY.Refused, "name-invalid"):
                POLICY.selection(self.root)

    def test_duplicate_overlay_refused(self):
        self.write("compose.lab.yml", "# local\n")
        self.write("compose.overlays", "compose.lab.yml")
        with self.assertRaisesRegex(POLICY.Refused, "duplicate"):
            POLICY.selection(self.root)

    def test_symlink_refused(self):
        (self.root / "compose.lab.yml").symlink_to(self.root / "compose.yml")
        with self.assertRaisesRegex(POLICY.Refused, "not-regular"):
            POLICY.selection(self.root)

    def test_group_writable_file_refused(self):
        self.write("compose.lab.yml", "# local").chmod(0o660)
        with self.assertRaisesRegex(POLICY.Refused, "ownership-or-mode"):
            POLICY.selection(self.root)

    def config(self):
        return {"name": "disposable-app", "volumes": {"data": {"name": "disposable-data"}}, "services": {"pluton": {
            "image": "ghcr.io/example/pluton@sha256:" + "a" * 64,
            "read_only": True, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
            "environment": dict.fromkeys(("APP_URL", "APP_ALLOWED_ORIGINS", "AGENT_SERVER_URL", "ALLOW_INSECURE_AGENT_HTTP", "TRUST_PROXY"), ""),
            "healthcheck": {"test": ["CMD", "node", "-e", POLICY.probe_source(ROOT / "deploy/healthcheck.cjs")]},
            "volumes": [{"type": "volume", "source": "data", "target": "/data"},
                        {"type": "bind", "source": str(self.root), "target": "/fixture", "read_only": True}]
        }}}

    def validate(self, config):
        path = self.write("effective.json", json.dumps(config))
        return POLICY.validate_config(path, self.config()["services"]["pluton"]["image"], ROOT / "deploy/healthcheck.cjs", self.root)

    def test_valid_sandbox_and_mount_contract(self):
        self.assertEqual(len(self.validate(self.config())["mounts"]), 2)

    def test_image_override_refused(self):
        config = self.config()
        config["services"]["pluton"]["image"] = "unreviewed:latest"
        with self.assertRaisesRegex(POLICY.Refused, "image-overridden"):
            self.validate(config)

    def test_unsafe_service_settings_refused(self):
        for key, value in (("privileged", True), ("use_api_socket", True), ("user", "root"), ("profiles", ["database"]), ("read_only", False)):
            config = self.config()
            config["services"]["pluton"][key] = value
            with self.subTest(key=key), self.assertRaises(POLICY.Refused):
                self.validate(config)

    def test_missing_supported_environment_refused(self):
        config = self.config()
        del config["services"]["pluton"]["environment"]["APP_ALLOWED_ORIGINS"]
        with self.assertRaisesRegex(POLICY.Refused, "environment-setting"):
            self.validate(config)

    def test_wrong_healthcheck_refused(self):
        config = self.config()
        config["services"]["pluton"]["healthcheck"]["test"] = ["CMD", "true"]
        with self.assertRaisesRegex(POLICY.Refused, "get-healthcheck"):
            self.validate(config)

    def test_missing_bind_source_refused(self):
        config = self.config()
        config["services"]["pluton"]["volumes"][1]["source"] += "/does-not-exist"
        with self.assertRaisesRegex(POLICY.Refused, "bind-source-missing"):
            self.validate(config)

    def test_volume_swap_or_readonly_change_refused(self):
        POLICY.save(self.root / ".deploy-contract.json", self.validate(self.config()))
        for change in ("volume", "mode", "project"):
            config = self.config()
            if change == "volume":
                config["volumes"]["data"]["name"] = "another-volume"
            elif change == "mode":
                config["services"]["pluton"]["volumes"][1]["read_only"] = False
            else:
                config["name"] = "another-project"
            with self.subTest(change=change), self.assertRaisesRegex(POLICY.Refused, "recorded-project-or-mounts"):
                self.validate(config)

    def test_runtime_mount_mismatch_and_wrong_project_refused(self):
        config = self.config()
        config_path = self.write("effective.json", json.dumps(config))
        container = {"Config": {"User": "10001:10001", "Labels": {"com.docker.compose.service": "pluton", "com.docker.compose.project": "disposable-app"}}, "Mounts": []}
        path = self.write("inspect.json", json.dumps([container]))
        with self.assertRaisesRegex(POLICY.Refused, "mounts-mismatch"):
            POLICY.check_container(config_path, path)
        container["Config"]["Labels"]["com.docker.compose.project"] = "other-app"
        path.write_text(json.dumps([container]))
        with self.assertRaisesRegex(POLICY.Refused, "identity-mismatch"):
            POLICY.check_container(config_path, path)

    def test_image_digest_and_nonroot_user_required(self):
        ref = self.config()["services"]["pluton"]["image"]
        path = self.write("image.json", json.dumps([{"Id": "fixture-image", "RepoDigests": [ref], "Config": {"User": "10001:10001"}}]))
        self.assertEqual(POLICY.image_valid(path, ref), "fixture-image")
        with self.assertRaisesRegex(POLICY.Refused, "digest-mismatch"):
            POLICY.image_valid(path, ref[:-1] + "b")
        value = json.loads(path.read_text())
        value[0]["Config"]["User"] = "root"
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(POLICY.Refused, "runtime-user"):
            POLICY.image_valid(path, ref)

    def test_propagation_is_part_of_the_exact_contract(self):
        config = self.config()
        first = POLICY.mounts(config)
        config["services"]["pluton"]["volumes"][1]["bind"] = {"propagation": "rslave"}
        self.assertNotEqual(first, POLICY.mounts(config))

    def test_snapshot_freezes_overlay_for_rollback(self):
        self.write("compose.lab.yml", "# original\n")
        with tempfile.TemporaryDirectory() as workspace:
            POLICY.snapshot(self.root, workspace)
            self.write("compose.lab.yml", "# changed after transaction\n")
            self.assertEqual((Path(workspace) / "compose/compose.lab.yml").read_text(), "# original\n")

    def test_actual_compose_preserves_probe_source(self):
        self.write("compose.yml", (ROOT / "deploy/compose.yml").read_text())
        self.write(".env", "PLUTON_IMAGE_REF=ghcr.io/example/pluton@sha256:" + "a" * 64 + "\nENCRYPTION_KEY=" + os.urandom(32).hex() + "\nUSER_NAME=fixture-admin\nUSER_PASSWORD=" + os.urandom(24).hex() + "\n")
        with tempfile.TemporaryDirectory() as workspace:
            POLICY.snapshot(self.root, workspace)
            result = subprocess.run(["python3", str(ROOT / "deploy/compose-tools.py"), "compose", str(self.root), workspace, "config", "--format", "json"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, "actual Compose validation failed")
            actual = json.loads(result.stdout)["services"]["pluton"]["healthcheck"]["test"]
            self.assertEqual(actual, ["CMD", "node", "-e", POLICY.probe_source(ROOT / "deploy/healthcheck.cjs")])


if __name__ == "__main__":
    unittest.main()
