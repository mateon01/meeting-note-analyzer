#!/usr/bin/env python3
"""Verify the public deployment shape after CDK synthesis, without contacting AWS."""
import json
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else "infra/cdk.out")
templates = [json.loads(p.read_text()) for p in root.glob("*.template.json")]
assert templates, "Run npm run synth first"
resources = [r for template in templates for r in template.get("Resources", {}).values()]
data_resources = [resource for path in root.glob("*-Data.template.json") for resource in json.loads(path.read_text()).get("Resources", {}).values()]
data_buckets = [resource["Properties"] for resource in data_resources if resource["Type"] == "AWS::S3::Bucket"]
assert len(data_buckets) == 1, "Expected one application data bucket"
assert data_buckets[0]["VersioningConfiguration"]["Status"] == "Enabled"
tables = [r["Properties"] for r in resources if r["Type"] == "AWS::DynamoDB::Table"]
assert len(tables) == 2 and all(table.get("DeletionProtectionEnabled") for table in tables)
assert not any(r["Type"].startswith(("AWS::Route53::", "AWS::CertificateManager::")) for r in resources), "Unexpected custom domain dependency"
clients = [r["Properties"] for r in resources if r["Type"] == "AWS::Cognito::UserPoolClient"]
assert len(clients) == 1
assert clients[0]["SupportedIdentityProviders"] == ["COGNITO"]
assert clients[0]["AllowedOAuthFlows"] == ["code"]
assert clients[0]["GenerateSecret"] is False
for resource in resources:
    if resource["Type"] == "AWS::CloudFront::Distribution":
        props = resource["Properties"]["DistributionConfig"]
        assert not props.get("Aliases"), "CloudFront must use its generated hostname"
        certificate = props.get("ViewerCertificate", {})
        assert not certificate or certificate.get("CloudFrontDefaultCertificate") is True
        assert "AcmCertificateArn" not in certificate and "IamCertificateId" not in certificate
print(f"Verified {len(templates)} stack templates: CloudFront default certificate, no DNS dependency, Cognito password accounts.")
