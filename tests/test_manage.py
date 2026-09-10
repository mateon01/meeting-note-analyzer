import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import call, patch

SPEC = importlib.util.spec_from_file_location("manage", Path(__file__).parents[1] / "scripts/manage.py")
manage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manage)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((manage.ROOT / "deploy.example.json").read_text())
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config_path = Path(self.temp.name) / "deploy.local.json"
        self.config_path.write_text(json.dumps(self.config))
        self.state = Path(self.temp.name) / "state.json"

    def test_private_files_are_written_with_private_permissions(self):
        manage.private_json(self.state, {"key": "local-value"})
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o600)

    def test_password_is_not_in_process_arguments_and_temporary_file_is_removed(self):
        captured = {}
        def execute(command, **kwargs):
            self.assertNotIn("not-a-real-password", " ".join(command))
            path = Path(command[-1].removeprefix("file://"))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(json.loads(path.read_text())["Password"], "not-a-real-password")
            captured["path"] = path
            return subprocess.CompletedProcess(command, 0, stdout="{}", stderr="")
        with patch.object(manage.subprocess, "run", side_effect=execute):
            manage.aws(self.config, "cognito-idp", "admin-set-user-password", {"Password": "not-a-real-password"})
        self.assertFalse(captured["path"].exists())

    def test_access_denied_is_not_treated_as_a_missing_resource(self):
        result = subprocess.CompletedProcess([], 1, stdout="", stderr="AccessDeniedException")
        with patch.object(manage.subprocess, "run", return_value=result):
            with self.assertRaises(manage.OperationError):
                manage.aws(self.config, "cloudformation", "describe-stacks", missing=True)

    def test_checkout_cannot_silently_switch_aws_accounts(self):
        with patch.object(manage, "STATE", self.state), patch.object(manage, "aws", side_effect=[{"Account": "000000000000"}, {"Account": "111111111111"}]):
            manage.identity(self.config)
            with self.assertRaises(manage.OperationError): manage.identity(self.config)

    def test_foundation_refuses_to_remove_an_existing_endpoint(self):
        with patch.object(manage, "endpoint_exists", return_value=True), patch.object(manage, "cdk") as cdk:
            with self.assertRaises(manage.OperationError): manage.foundation(self.config)
            cdk.assert_not_called()

    def test_first_deploy_reapplies_the_assigned_cloudfront_url(self):
        calls = []
        with patch.object(manage, "CONFIG", self.config_path), patch.object(manage, "doctor"), patch.object(manage, "run"), patch.object(manage, "aws", return_value={}), patch.object(manage, "endpoint_exists", return_value=True), patch.object(manage, "models_ready", return_value=True), patch.object(manage, "outputs", return_value={"SiteUrl": "https://dexample.cloudfront.net"}), patch.object(manage, "check"), patch.object(manage, "cdk", side_effect=lambda config, action: calls.append((action, config["siteUrl"]))):
            manage.deploy(self.config)
        self.assertEqual(calls, [("diff", ""), ("deploy", ""), ("diff", "https://dexample.cloudfront.net"), ("deploy", "https://dexample.cloudfront.net")])
        saved = json.loads(self.config_path.read_text())
        self.assertTrue(saved["sttDeployEndpoint"])
        self.assertEqual(saved["siteUrl"], "https://dexample.cloudfront.net")

    def test_invalid_origin_and_capacity_are_rejected(self):
        for change in ({"siteUrl": "https://example.com"}, {"sttMinInstances": 3, "sttMaxInstances": 2}):
            with self.assertRaises(manage.OperationError): manage.validate_config({**self.config, **change})

    def test_account_access_requires_an_explicit_target(self):
        config = {**self.config, "operatorEmail": "operator@example.test"}
        with patch.object(manage, "identity") as identity, patch.object(manage, "aws") as aws:
            for email in (None, "", " "):
                with self.assertRaises(manage.OperationError):
                    manage.user_access(config, email, enabled=False)
            identity.assert_not_called()
            aws.assert_not_called()

    def test_account_access_uses_the_resolved_user_in_this_installation(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled), patch.object(manage, "identity") as identity, patch.object(manage, "outputs", return_value={"UserPoolId": "pool"}) as outputs, patch.object(manage, "aws", side_effect=[{"Username": "resolved-user", "Enabled": not enabled}, {}]) as aws:
                manage.user_access(self.config, "teammate@example.test", enabled=enabled)
                identity.assert_called_once_with(self.config)
                outputs.assert_called_once_with(self.config, "Auth")
                self.assertEqual(aws.call_args_list, [
                    call(self.config, "cognito-idp", "admin-get-user", {"UserPoolId": "pool", "Username": "teammate@example.test"}, missing=True),
                    call(self.config, "cognito-idp", "admin-enable-user" if enabled else "admin-disable-user", {"UserPoolId": "pool", "Username": "resolved-user"}),
                ])

    def test_account_preview_and_repeated_updates_do_not_modify_users(self):
        for enabled in (False, True):
            for current, dry_run in ((not enabled, True), (enabled, False)):
                with self.subTest(enabled=enabled, current=current, dry_run=dry_run), patch.object(manage, "identity"), patch.object(manage, "outputs", return_value={"UserPoolId": "pool"}), patch.object(manage, "aws", return_value={"Username": "resolved-user", "Enabled": current}) as aws:
                    manage.user_access(self.config, "teammate@example.test", enabled=enabled, dry_run=dry_run)
                    aws.assert_called_once_with(self.config, "cognito-idp", "admin-get-user", {"UserPoolId": "pool", "Username": "teammate@example.test"}, missing=True)

    def test_missing_accounts_and_aws_failures_are_reported(self):
        for responses in ([None], [manage.OperationError("AccessDeniedException")], [{"Username": "resolved-user", "Enabled": True}, manage.OperationError("AccessDeniedException")]):
            with self.subTest(responses=responses), patch.object(manage, "identity"), patch.object(manage, "outputs", return_value={"UserPoolId": "pool"}), patch.object(manage, "aws", side_effect=responses) as aws:
                with self.assertRaises(manage.OperationError):
                    manage.user_access(self.config, "teammate@example.test", enabled=False)
                self.assertEqual(aws.call_count, len(responses))

    def test_preview_flag_cannot_be_mistaken_for_a_deployment_preview(self):
        with patch.object(manage.sys, "argv", ["manage.py", "deploy", "--dry-run"]), patch.object(manage, "load_config") as load:
            with self.assertRaises(SystemExit) as error:
                manage.main()
            self.assertEqual(error.exception.code, 2)
            load.assert_not_called()


if __name__ == "__main__": unittest.main()
