"""Historical deployment input must remain immutable as the current bundle evolves."""
import hashlib
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VALIDATION = load("deployment_acceptance", "scripts/validate-deployment.py")
BUNDLE = load("deployment_bundle", "deploy/bundle-tools.py")
EXPECTED = "85cd8b7fe1e2d66a72d9d0a1c4adfc3bae5a8ed0c504f8ae309c37017b4bc34d"


class HistoricalDeploymentFixture(unittest.TestCase):
    def test_exact_prior_public_template_remains_recognized_by_real_bundle_policy(self):
        content = VALIDATION.previous_compose_template()
        self.assertEqual(hashlib.sha256(content.encode()).hexdigest(), EXPECTED)
        self.assertIn(EXPECTED, BUNDLE.PREVIOUS_BASES)
        self.assertIn('test: ["CMD-SHELL", "wget ', content)
        self.assertNotIn("AGENT_INSTALL_", content)

    def test_current_template_is_never_read_or_used_to_reconstruct_history(self):
        self.assertIn("AGENT_INSTALL_REPOSITORY_URL", (ROOT / "deploy/compose.yml").read_text())
        with patch.object(Path, "read_text", side_effect=AssertionError("mutable-template-read")):
            content = VALIDATION.previous_compose_template()
        self.assertEqual(hashlib.sha256(content.encode()).hexdigest(), EXPECTED)

    def test_any_fixture_drift_fails_closed_with_original_assertion(self):
        original = VALIDATION.previous_compose_template().encode()
        for content in (original + b"# changed\n", original.replace(b"CMD-SHELL", b"CMD"), b""):
            with self.subTest(content_length=len(content)):
                with patch.object(Path, "read_bytes", return_value=content):
                    with self.assertRaisesRegex(AssertionError, "old-template-fixture-drift"):
                        VALIDATION.previous_compose_template()


if __name__ == "__main__":
    unittest.main()
