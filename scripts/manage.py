#!/usr/bin/env python3
"""Configure, deploy and operate one Meeting Note Analyzer installation."""
from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path(os.environ.get("MEETING_CONFIG_FILE", ROOT / "deploy.local.json")).resolve()
STATE = ROOT / ".deployment" / "state.json"
SUFFIXES = ["Data", "Auth", "Stt", "Agent", "Lecture", "Chat", "Pipeline", "Api", "Web"]


class OperationError(RuntimeError):
    pass


def load_config() -> dict:
    defaults = json.loads((ROOT / "deploy.example.json").read_text())
    if CONFIG.exists():
        defaults.update(json.loads(CONFIG.read_text()))
    return defaults


def private_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def environment(config: dict) -> dict[str, str]:
    return {**os.environ, "AWS_REGION": config["region"], "AWS_DEFAULT_REGION": config["region"], "CDK_DEFAULT_REGION": config["region"], "MEETING_CONFIG_FILE": str(CONFIG), "AWS_PAGER": ""}


def run(command: list[str], config: dict, capture=False) -> str:
    result = subprocess.run(command, cwd=ROOT, env=environment(config), text=True, capture_output=capture)
    if result.returncode:
        raise OperationError(f"{command[0]} failed" + (f": {result.stderr.strip()}" if capture else "; see the output above"))
    return result.stdout if capture else ""


def aws(config: dict, service: str, action: str, payload: dict | None = None, *, missing=False) -> dict | None:
    # Secrets and passwords are passed through a mode-0600 file, never as command-line arguments.
    fd, name = tempfile.mkstemp(prefix="meeting-request-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(payload or {}, stream)
        command = ["aws", service, action, "--region", config["region"], "--output", "json", "--no-cli-pager", "--cli-input-json", f"file://{name}"]
        response = subprocess.run(command, cwd=ROOT, env=environment(config), text=True, capture_output=True)
        if response.returncode:
            error = response.stderr
            absent = "ResourceNotFoundException" in error or "UserNotFoundException" in error or "does not exist" in error or "(404)" in error
            if missing and absent:
                return None
            if payload and any(key in payload for key in ("SecretString", "Password", "TemporaryPassword")):
                code = re.search(r"\(([A-Za-z][A-Za-z0-9]+)\)", error)
                error = (code.group(1) if code else "request failed") + "; secret values omitted"
            raise OperationError(f"aws {service} {action}: {error.strip()}")
        return json.loads(response.stdout) if response.stdout.strip() else {}
    finally:
        Path(name).unlink(missing_ok=True)


def validate_config(config: dict) -> None:
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,30}[a-z0-9]", config["projectName"]):
        raise OperationError("projectName must contain 3-32 lowercase letters, digits or hyphens")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{1,39}", config["stackPrefix"]):
        raise OperationError("stackPrefix must contain 2-40 letters, digits or hyphens")
    if config.get("siteUrl") and not re.fullmatch(r"https://[a-z0-9]+\.cloudfront\.net", config["siteUrl"]):
        raise OperationError("siteUrl must be the CloudFront HTTPS origin without a trailing slash")
    if not 0 <= config["sttMinInstances"] <= config["sttMaxInstances"] <= 10 or config["sttMaxInstances"] < 1:
        raise OperationError("STT instance limits must satisfy 0 <= min <= max <= 10, max >= 1")


def identity(config: dict) -> dict:
    who = aws(config, "sts", "get-caller-identity")
    current = {"account": who["Account"], "region": config["region"], "projectName": config["projectName"], "stackPrefix": config["stackPrefix"]}
    if STATE.exists() and json.loads(STATE.read_text()) != current:
        raise OperationError("This checkout is bound to a different AWS account, region or project. Use a separate checkout for another installation.")
    private_json(STATE, current)
    print(f"Target: {current['account']} / {current['region']} / {current['stackPrefix']}")
    return who


def outputs(config: dict, suffix: str, *, missing=False) -> dict:
    response = aws(config, "cloudformation", "describe-stacks", {"StackName": f"{config['stackPrefix']}-{suffix}"}, missing=missing)
    if response is None:
        return {}
    return {item["OutputKey"]: item["OutputValue"] for item in response["Stacks"][0].get("Outputs", [])}


def cdk(config: dict, action: str, targets: list[str] | None = None, extra: list[str] | None = None) -> None:
    if not (ROOT / "web/dist/index.html").exists():
        run(["npm", "-w", "web", "run", "build"], config)
    command = ["npm", "-w", "infra", "run", "cdk", "--", action]
    if targets:
        command.extend(f"{config['stackPrefix']}-{suffix}" for suffix in targets)
    elif action in ("deploy", "diff", "destroy"):
        command.append("--all")
    if action == "deploy":
        command += ["--outputs-file", str(ROOT / ".deployment" / "outputs.json"), "--require-approval", "broadening"]
    run(command + (extra or []), config)


def configure(args) -> None:
    config = load_config()
    for field in ("region", "projectName", "stackPrefix"):
        value = getattr(args, field, None)
        if value:
            config[field] = value
    if args.email:
        config["operatorEmail"] = args.email
    if not config.get("operatorEmail"):
        config["operatorEmail"] = input("Operator email (VAPID contact and default first user): ").strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", config["operatorEmail"]):
        raise OperationError("Enter a valid operator email")
    validate_config(config)
    private_json(CONFIG, config)
    print(f"Saved {CONFIG.name}. This file is excluded from Git.")


def doctor(config: dict, offline=False) -> None:
    if sys.version_info < (3, 12):
        raise OperationError("Python 3.12 or newer is required")
    required = ["node", "npm", "python3", "uv", "aws", "docker"]
    missing = [tool for tool in required if not shutil.which(tool)]
    if missing:
        raise OperationError("Install these tools first: " + ", ".join(missing))
    if int(run(["node", "--version"], config, capture=True).lstrip("v").split(".")[0]) < 22:
        raise OperationError("Node.js 22 or newer is required")
    validate_config(config)
    run(["docker", "buildx", "version"], config, capture=True)
    if offline:
        print("Local tools and configuration checked. No AWS calls made.")
        return
    run(["docker", "info", "--format", "{{.ServerVersion}}"], config, capture=True)
    identity(config)
    for name in ("opusModel", "sonnetModel", "haikuModel"):
        aws(config, "bedrock", "get-inference-profile", {"inferenceProfileIdentifier": config[name]})
    print("AWS identity and model profile discovery passed. Model invocation permissions and quotas still require an application test.")


def secrets(config: dict, slack=False) -> None:
    identity(config)
    prefix = config["projectName"]
    if slack:
        if not config["enableSlackAlarms"]:
            raise OperationError("Set enableSlackAlarms=true and deploy the Data stack first")
        webhook = getpass.getpass("Slack incoming webhook URL: ").strip()
        if not webhook.startswith("https://hooks.slack.com/services/"):
            raise OperationError("Expected an HTTPS Slack incoming webhook URL")
        aws(config, "secretsmanager", "put-secret-value", {"SecretId": f"{prefix}/slack-webhook", "SecretString": webhook})
        print("Slack webhook stored. No test message was sent.")
        return
    hf_name, vapid_name = f"{prefix}/hf-token", f"{prefix}/vapid"
    if aws(config, "secretsmanager", "describe-secret", {"SecretId": hf_name}, missing=True) is None:
        token = os.environ.get("HF_TOKEN") or getpass.getpass("Hugging Face read token: ")
        if not token.strip():
            raise OperationError("A Hugging Face token is required")
        aws(config, "secretsmanager", "create-secret", {"Name": hf_name, "SecretString": token.strip()})
        print("Hugging Face token stored.")
    else:
        print("Hugging Face secret already exists; kept its current value.")
    if aws(config, "secretsmanager", "describe-secret", {"SecretId": vapid_name}, missing=True) is None:
        if not config.get("operatorEmail"):
            raise OperationError("Run configure to set the VAPID contact email")
        keys = json.loads(run(["node", "-e", "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"], config, capture=True))
        keys["subject"] = "mailto:" + config["operatorEmail"]
        aws(config, "secretsmanager", "create-secret", {"Name": vapid_name, "SecretString": json.dumps(keys)})
        print("VAPID keys generated and stored.")
    else:
        print("VAPID secret already exists; kept its current keys.")


def endpoint_exists(config: dict) -> bool:
    resources = aws(config, "cloudformation", "list-stack-resources", {"StackName": f"{config['stackPrefix']}-Stt"}, missing=True)
    return bool(resources and any(r["ResourceType"] == "AWS::SageMaker::Endpoint" and r.get("ResourceStatus") != "DELETE_COMPLETE" for r in resources["StackResourceSummaries"]))


def foundation(config: dict) -> None:
    if endpoint_exists(config):
        raise OperationError("The STT endpoint already exists. Use deploy to update it; foundation will not remove a running endpoint.")
    cdk(config, "deploy", ["Data", "Stt"], ["-c", "sttDeployEndpoint=false"])


def models_ready(config: dict) -> bool:
    data = outputs(config, "Data", missing=True)
    if not data:
        return False
    prefix = f"models/stt/{config['sttModelVariant']}/"
    return all(aws(config, "s3api", "head-object", {"Bucket": data["DataBucketName"], "Key": prefix + key}, missing=True) is not None for key in ("crisperwhisper/ct2/model.bin", "pyannote/community-1/config.yaml"))


def publish_models(config: dict) -> None:
    publisher = outputs(config, "Stt")["PublisherProject"]
    env = environment(config)
    env["STT_PUBLISHER_PROJECT"] = publisher
    subprocess.run(["bash", str(ROOT / "scripts/stt/publish-model.sh"), config["sttModelVariant"]], cwd=ROOT, env=env, check=True)
    if not models_ready(config):
        raise OperationError("Model files are incomplete. Check the CodeBuild logs and Hugging Face model access.")


def deploy(config: dict) -> None:
    if not CONFIG.exists():
        raise OperationError("Run npm run configure first")
    doctor(config)
    for name in ("hf-token", "vapid"):
        if aws(config, "secretsmanager", "describe-secret", {"SecretId": f"{config['projectName']}/{name}"}, missing=True) is None:
            raise OperationError("Run npm run secrets before deploying")
    run(["npm", "-w", "web", "run", "build"], config)
    if not endpoint_exists(config):
        foundation(config)
    if not models_ready(config):
        publish_models(config)
    config["sttDeployEndpoint"] = True
    private_json(CONFIG, config)
    cdk(config, "diff")
    cdk(config, "deploy")
    site = outputs(config, "Web")["SiteUrl"].rstrip("/")
    if config["siteUrl"] != site:
        config["siteUrl"] = site
        validate_config(config)
        private_json(CONFIG, config)
        print("Connecting the CloudFront URL to Cognito, CORS, uploads and notifications.")
        cdk(config, "diff")
        cdk(config, "deploy")
    check(config)
    print(f"Site: {site}\nCreate a login with npm run user:create")


def check(config: dict) -> None:
    site = outputs(config, "Web")["SiteUrl"].rstrip("/")
    with urllib.request.urlopen(site + "/config.json", timeout=30) as response:
        public = json.load(response)
    auth = outputs(config, "Auth")
    client = aws(config, "cognito-idp", "describe-user-pool-client", {"UserPoolId": auth["UserPoolId"], "ClientId": auth["UserPoolClientId"]})["UserPoolClient"]
    if public.get("appOrigin") != site or public.get("cognitoClientId") != auth["UserPoolClientId"]:
        raise OperationError("Web configuration does not match the current deployment")
    if f"{site}/callback" not in client.get("CallbackURLs", []) or f"{site}/" not in client.get("LogoutURLs", []):
        raise OperationError("Cognito URLs do not match CloudFront. Run deploy to finish URL configuration.")
    if client.get("SupportedIdentityProviders") != ["COGNITO"]:
        raise OperationError("The web client must use the Cognito identity provider")
    print("Web configuration and Cognito callback URLs match. Sign in and upload a short recording to test processing.")


def user(config: dict, email: str | None, reset=False) -> None:
    identity(config)
    email = email or config.get("operatorEmail")
    if not email:
        raise OperationError("Pass --email or set operatorEmail with configure")
    pool = outputs(config, "Auth")["UserPoolId"]
    existing = aws(config, "cognito-idp", "admin-get-user", {"UserPoolId": pool, "Username": email}, missing=True)
    if existing and not reset:
        print("Account already exists. Use user:password to set a new password.")
        return
    if reset and not existing:
        raise OperationError("Account does not exist. Use user:create first.")
    password = getpass.getpass("New password (12+ characters, upper/lowercase, number, symbol): ")
    if password != getpass.getpass("Repeat password: "):
        raise OperationError("Passwords do not match")
    if len(password) < 12 or not all(re.search(pattern, password) for pattern in (r"[a-z]", r"[A-Z]", r"[0-9]", r"[^A-Za-z0-9]")):
        raise OperationError("Password does not meet the user pool policy")
    if not existing:
        aws(config, "cognito-idp", "admin-create-user", {"UserPoolId": pool, "Username": email, "UserAttributes": [{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"}], "MessageAction": "SUPPRESS"})
    aws(config, "cognito-idp", "admin-set-user-password", {"UserPoolId": pool, "Username": email, "Password": password, "Permanent": True})
    print("Cognito account is ready. No invitation email was sent.")


def user_access(config: dict, email: str | None, *, enabled: bool, dry_run=False) -> None:
    if not email or not email.strip():
        raise OperationError("Pass --email to select the account to enable or disable")
    identity(config)
    pool = outputs(config, "Auth")["UserPoolId"]
    payload = {"UserPoolId": pool, "Username": email.strip()}
    existing = aws(config, "cognito-idp", "admin-get-user", payload, missing=True)
    if not existing:
        raise OperationError("Account does not exist in this installation")
    verb = "enable" if enabled else "disable"
    if existing.get("Enabled") is enabled:
        print(f"Account is already {verb}d: {email}")
        return
    if dry_run:
        print(f"Would {verb} account: {email}")
        return
    # Resolve an email alias once, then target the same Cognito user for the update.
    payload = {"UserPoolId": pool, "Username": existing["Username"]}
    # AdminDisableUser also revokes the user's refresh and access tokens in Cognito.
    aws(config, "cognito-idp", f"admin-{verb}-user", payload)
    print(f"Cognito account {verb}d: {email}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["configure", "doctor", "secrets", "bootstrap", "foundation", "models", "deploy", "diff", "synth", "status", "check", "dev-config", "user-create", "user-password", "user-disable", "user-enable", "destroy"])
    parser.add_argument("--email")
    parser.add_argument("--region")
    parser.add_argument("--project", dest="projectName")
    parser.add_argument("--stack-prefix", dest="stackPrefix")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--slack", action="store_true")
    parser.add_argument("--confirm-project")
    parser.add_argument("--dry-run", action="store_true", help="Preview user-disable or user-enable without changing the account")
    args = parser.parse_args()
    if args.dry_run and args.command not in ("user-disable", "user-enable"):
        parser.error("--dry-run is only supported for user-disable and user-enable")
    try:
        if args.command == "configure":
            configure(args)
            return
        config = load_config()
        validate_config(config)
        if args.command == "doctor": doctor(config, args.offline)
        elif args.command == "secrets": secrets(config, args.slack)
        elif args.command == "synth": cdk(config, "synth", extra=["--quiet"])
        elif args.command == "deploy": deploy(config)
        elif args.command in ("user-create", "user-password"): user(config, args.email, args.command == "user-password")
        elif args.command in ("user-disable", "user-enable"): user_access(config, args.email, enabled=args.command == "user-enable", dry_run=args.dry_run)
        else:
            who = identity(config)
            if args.command == "bootstrap": cdk(config, "bootstrap", extra=[f"aws://{who['Account']}/{config['region']}"])
            elif args.command == "foundation":
                run(["npm", "-w", "web", "run", "build"], config)
                foundation(config)
            elif args.command == "models": publish_models(config)
            elif args.command == "diff": cdk(config, "diff")
            elif args.command == "status":
                print(json.dumps({suffix: outputs(config, suffix, missing=True) for suffix in SUFFIXES}, indent=2))
            elif args.command == "check": check(config)
            elif args.command == "dev-config":
                site = outputs(config, "Web")["SiteUrl"].rstrip("/")
                with urllib.request.urlopen(site + "/config.json", timeout=30) as response:
                    private_json(ROOT / "web/public/config.json", json.load(response))
                config["siteUrl"] = site
                private_json(CONFIG, config)
                print("Wrote ignored web/public/config.json. Start the local app with npm -w web run dev.")
            elif args.command == "destroy":
                if args.confirm_project != config["projectName"]:
                    raise OperationError("Pass --confirm-project with the exact projectName. Data buckets, tables, user pools and setup secrets are retained.")
                cdk(config, "destroy", extra=["--force"])
    except (OperationError, subprocess.CalledProcessError, OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
