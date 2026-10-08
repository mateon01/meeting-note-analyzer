#!/usr/bin/env python3
"""Check tracked and unignored source files for deployment data and common credential formats."""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_ACCOUNTS = {"000000000000", "111111111111", "123456789012"}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")
ACCOUNT = re.compile(r"(?<![\w.])[0-9]{12}(?![\w.])")
SECRET = re.compile(r"(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|hf_[A-Za-z0-9]{25,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
PERSONAL_PATH = re.compile(r"/(?:home|Users)/([A-Za-z0-9._-]+)")
BUILT_IN_USERS = {"agent", "lecturer", "runner", "user", "example"}
FORBIDDEN_PARTS = {".aws", ".ssh", ".deployment", ".omc", "node_modules", ".venv", "graphify-out", ".claude"}
PRIVATE_ROOTS = {"uploads", "transcripts", "results", "lecture-uploads", "lecture-results", "interview-uploads", "interview-results", "tmp", "temp"}


def content_findings(text: str, dependency_lock=False) -> list[tuple[int, str]]:
    findings = []
    for number, line in enumerate(text.splitlines(), 1):
        if SECRET.search(line): findings.append((number, "credential pattern"))
        if any(m.group() not in EXAMPLE_ACCOUNTS for m in ACCOUNT.finditer(line)):
            findings.append((number, "non-example AWS account number"))
        for match in ([] if dependency_lock else EMAIL.finditer(line)):
            domain = match.group(1).lower()
            if domain not in {"example.com", "example.org", "example.net", "users.noreply.github.com"} and not domain.endswith((".example.com", ".test", ".invalid")):
                findings.append((number, "non-example email address"))
        if any(m.group(1) not in BUILT_IN_USERS for m in PERSONAL_PATH.finditer(line)):
            findings.append((number, "workstation home path"))
        if re.search(r"https?://[^/\s]+:[^/\s]+@", line): findings.append((number, "credentials in URL"))
    return findings


def main() -> int:
    result = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT, check=True, capture_output=True)
    files = sorted(set(result.stdout.decode().split("\0")) - {""})
    findings = []
    for name in files:
        path = ROOT / name
        parts = Path(name).parts
        private_env = path.name == ".env" or (path.name.startswith(".env.") and path.name != ".env.example")
        if FORBIDDEN_PARTS.intersection(parts) or parts[0] in PRIVATE_ROOTS or path.name.startswith("deploy.local.") or path.name.startswith("cdk-outputs") or path.name == "cdk.context.json" or name == "web/public/config.json" or private_env:
            findings.append(f"{name}: private/generated file must not be tracked")
            continue
        if not path.is_file(): continue
        try: text = path.read_text(encoding="utf-8")
        except UnicodeError: continue
        findings.extend(f"{name}:{number}: {reason}" for number, reason in content_findings(text, dependency_lock=path.name == "package-lock.json" or path.suffix == ".lock"))
        if path.suffix == ".md" and "\u2014" in text:
            findings.append(f"{name}: em dash in documentation")
    if findings:
        print("\n".join(findings))
        print(f"Public source check failed: {len(findings)} finding(s). Values have been omitted.")
        return 1
    print(f"Public source check passed: {len(files)} files. Run Gitleaks as well before publishing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
