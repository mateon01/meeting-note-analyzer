import json
import os
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, request):
        self.request = request
        self.bucket = os.environ["DATA_BUCKET"]
        self.s3 = boto3.client("s3")
        interview = request.kind == "interview"
        self.table = boto3.resource("dynamodb").Table(os.environ["INTERVIEW_TABLE_NAME" if interview else "LECTURE_TABLE_NAME"])
        self.prefix = f"{'interview' if interview else 'lecture'}-results/{request.lectureId}/"
        # Result files of one attempt live under runs/{runId}/; the record points at the published run.
        self.run_prefix = f"runs/{request.runId}/"
        self.key = {"PK": f"MEETING#{request.lectureId}", "SK": "META"}

    def record(self):
        rec = self.table.get_item(Key=self.key, ConsistentRead=True).get("Item")
        if not rec or rec.get("owner") != self.request.ownerSub or rec.get("runId") != self.request.runId or rec.get("status") != self.request.expected_status:
            raise RuntimeError("Lecture execution is no longer active")
        return rec

    def update(self, **fields):
        fields["updatedAt"] = now()
        self.table.update_item(Key=self.key, UpdateExpression="SET " + ", ".join(f"#f{i} = :v{i}" for i in range(len(fields))),
            ConditionExpression="#run = :run AND #status = :active AND attribute_exists(PK)",
            ExpressionAttributeNames={"#run": "runId", "#status": "status", **{f"#f{i}": k for i, k in enumerate(fields)}},
            ExpressionAttributeValues={":run": self.request.runId, ":active": self.request.expected_status, **{f":v{i}": json.loads(json.dumps(v, default=float), parse_float=Decimal) for i, v in enumerate(fields.values())}})

    def progress(self, stage: str, completed: int, total: int):
        rec = self.record()
        stages = rec.get("stages", {})
        stages[stage] = {"status": "COMPLETED" if completed == total else "RUNNING", "completed": completed, "total": total}
        self.update(currentStage=stage, stages=stages)

    def read(self, key: str):
        try:
            response = self.s3.get_object(Bucket=self.bucket, Key=key)
            if response["ContentLength"] > 32 * 1024 * 1024:
                raise ValueError("Lecture artifact exceeds 32 MiB")
            return json.loads(response["Body"].read())
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "NoSuchKey":
                return None
            raise

    def save(self, suffix: str, value):
        self.put(suffix, json.dumps(value, ensure_ascii=False).encode(), "application/json")

    def put(self, suffix: str, body: bytes, content_type: str):
        self.record()
        self.s3.put_object(Bucket=self.bucket, Key=self.prefix + suffix, Body=body, ContentType=content_type)

    def upload_file(self, suffix, path, content_type):
        self.record()
        self.s3.upload_file(str(path), self.bucket, self.prefix + suffix, ExtraArgs={"ContentType": content_type})

    def cached(self, suffix: str, build, accept=lambda value: True):
        key = "cache/v2/" + suffix
        value = self.read(self.prefix + key)
        if value is None or not accept(value):
            value = build()
            self.save(key, value)
        return value
