"""DynamoDB chat storage. One partition per chat session: CHATSESSION#{id}/META (owner, title, counters) and
CHATSESSION#{id}/MSG#{seq}. Sessions are listed per user through GSI1 (GSI1PK USER#{sub}#CHAT, GSI1SK updatedAt).
Every read goes through the META owner check, so a guessed session id never exposes another user's messages."""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key

from .config import REGION, TABLE_NAME

_table = None


class NotOwner(PermissionError):
    pass


def table():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb", region_name=REGION).Table(TABLE_NAME)
    return _table


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def session_key(session_id: str) -> dict:
    return {"PK": f"CHATSESSION#{session_id}", "SK": "META"}


def get_session(sub: str, session_id: str) -> dict | None:
    """The session META item, or None when it does not exist. Raises NotOwner when it belongs to someone else."""
    item = table().get_item(Key=session_key(session_id)).get("Item")
    if item and item.get("owner") != sub:
        raise NotOwner(session_id)
    return item


def ensure_session(sub: str, session_id: str, meeting_id: str | None, lecture_id: str | None = None, source_type: str | None = None) -> dict:
    existing = get_session(sub, session_id)
    if existing:
        return existing
    now = now_iso()
    item = {**session_key(session_id), "sessionId": session_id, "owner": sub, "title": "", "createdAt": now, "updatedAt": now, "messageCount": 0, "GSI1PK": f"USER#{sub}#CHAT", "GSI1SK": now}
    if meeting_id:
        item["meetingId"] = meeting_id
    if lecture_id:
        item["lectureId"] = lecture_id
    if source_type:
        item["sourceType"] = source_type
    table().put_item(Item=item, ConditionExpression="attribute_not_exists(PK)")
    return item


def next_seq(session_id: str) -> int:
    now = now_iso()
    res = table().update_item(
        Key=session_key(session_id),
        UpdateExpression="ADD messageCount :one SET updatedAt = :now, GSI1SK = :now",
        ExpressionAttributeValues={":one": 1, ":now": now},
        ReturnValues="UPDATED_NEW",
    )
    return int(res["Attributes"]["messageCount"])


def ddb_safe(value: Any) -> Any:
    """DynamoDB rejects Python floats (retrieval scores, costs): convert them to Decimal, recursively."""
    if isinstance(value, float):
        return Decimal(str(round(value, 6)))
    if isinstance(value, dict):
        return {k: ddb_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [ddb_safe(v) for v in value]
    return value


def append_message(session_id: str, role: str, text: str, *, evidence: list[dict] | None = None, steps: list[dict] | None = None, usage: dict | None = None, options: list[str] | None = None) -> int:
    seq = next_seq(session_id)
    item: dict[str, Any] = {"PK": f"CHATSESSION#{session_id}", "SK": f"MSG#{seq:06d}", "seq": seq, "role": role, "text": text, "createdAt": now_iso()}
    if evidence:
        item["evidence"] = evidence
    if steps:
        item["steps"] = steps
    if usage:
        item["usage"] = usage
    if options:
        item["options"] = options
    table().put_item(Item=ddb_safe(item))
    return seq


def list_messages(session_id: str, limit: int = 24) -> list[dict]:
    """Newest `limit` messages in chronological order. Caller must have passed the owner check (get_session/ensure_session)."""
    res = table().query(KeyConditionExpression=Key("PK").eq(f"CHATSESSION#{session_id}") & Key("SK").begins_with("MSG#"), ScanIndexForward=False, Limit=limit)
    return list(reversed(res.get("Items", [])))


def update_session(session_id: str, fields: dict[str, Any]) -> None:
    fields = {k: v for k, v in fields.items() if v is not None}
    if not fields:
        return
    names = {f"#{k}": k for k in fields}
    values = {f":{k}": v for k, v in fields.items()}
    table().update_item(
        Key=session_key(session_id),
        UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in fields),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
