import importlib.util
import contextlib
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("public_scan", Path(__file__).parents[1] / "scripts/check-public.py")
scan = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scan)


class PublicScanTests(unittest.TestCase):
    def test_detects_non_example_account_without_flagging_decimal_scores(self):
        self.assertTrue(scan.content_findings('"account": "' + "4" * 12 + '"'))
        self.assertFalse(scan.content_findings('"score": 0.553123456789'))
        self.assertFalse(scan.content_findings('"account": "000000000000"'))

    def test_detects_credentials_and_non_example_email_without_printing_them(self):
        credential = "gh" + "p_" + "A" * 36
        findings = scan.content_findings(credential)
        self.assertEqual(findings, [(1, "credential pattern")])
        email = "person" + "@" + "personal.example"
        self.assertTrue(scan.content_findings(email))
        self.assertFalse(scan.content_findings("you@example.com"))

    def test_lock_metadata_exception_does_not_disable_credential_detection(self):
        email = "author" + "@" + "upstream.example"
        self.assertFalse(scan.content_findings(email, dependency_lock=True))
        self.assertTrue(scan.content_findings("AKIA" + "A" * 16, dependency_lock=True))

    def test_force_added_runtime_data_is_rejected_even_without_a_recognizable_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            names = [".omc/state.json", "web/.omc/state.json", "interview-results/private.json",
                     ".env.production", "deploy.local.backup.json", "web/public/config.json"]
            for name in names:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("private runtime data")
            (root / ".gitignore").write_text("\n".join(names) + "\n")
            subprocess.run(["git", "add", "-f", "--", *names], cwd=root, check=True)
            output = io.StringIO()
            with patch.object(scan, "ROOT", root), contextlib.redirect_stdout(output):
                self.assertEqual(scan.main(), 1)
            for name in names:
                self.assertIn(f"{name}: private/generated file must not be tracked", output.getvalue())
            self.assertNotIn("private runtime data", output.getvalue())

    def test_public_example_configuration_and_documentation_remain_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            for name in [".env.example", "deploy.example.json", "docs/architecture.json", "tests/fixtures/results/example.json"]:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("public example")
            subprocess.run(["git", "add", "--all"], cwd=root, check=True)
            with patch.object(scan, "ROOT", root), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scan.main(), 0)


if __name__ == "__main__": unittest.main()
