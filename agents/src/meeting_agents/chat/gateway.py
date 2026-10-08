"""Call the managed Knowledge Base through the AgentCore Gateway (MCP over streamable HTTP, JSON-RPC).

The Gateway accepts only IAM (SigV4) callers, so a user's own Cognito token cannot reach it directly; the owner filter is
built here, in code the model cannot influence, so a user can only ever retrieve their own meetings and lectures.
"""
from __future__ import annotations

import json
import logging
from typing import Any

import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

from .config import GATEWAY_TOOL, GATEWAY_URL, MAX_RESULTS, REGION

log = logging.getLogger("chat.gateway")


def owner_filter(sub: str, meeting_id: str | None, *, source_type: str = "all", lecture_id: str | None = None) -> dict[str, Any]:
    owner = {"equals": {"key": "owner", "value": sub}}
    filters = [owner]
    if source_type == "lecture" or lecture_id:
        filters.append({"equals": {"key": "kind", "value": "lecture"}})
        if lecture_id:
            filters.append({"equals": {"key": "lectureId", "value": lecture_id}})
    elif meeting_id:
        filters.append({"equals": {"key": "meetingId", "value": meeting_id}})
    elif source_type == "meeting":
        # Older meeting sidecars predate the kind attribute.
        filters.append({"notEquals": {"key": "kind", "value": "lecture"}})
    return {"andAll": filters} if len(filters) > 1 else owner


def _parse_tool_result(body: dict[str, Any]) -> list[dict[str, Any]]:
    if "error" in body:
        raise RuntimeError(f"gateway error: {body['error']}")
    result = body.get("result", {})
    if result.get("isError"):
        raise RuntimeError(f"gateway tool error: {result.get('content')}")
    for item in result.get("content", []):
        if item.get("type") == "text":
            try:
                payload = json.loads(item["text"])
            except ValueError:
                continue
            return payload.get("retrievalResults", [])
    return []


def _decode_response(resp: httpx.Response) -> dict[str, Any]:
    ctype = resp.headers.get("content-type", "")
    if "text/event-stream" in ctype:
        last: dict[str, Any] | None = None
        for line in resp.text.splitlines():
            if line.startswith("data:"):
                try:
                    last = json.loads(line[5:].strip())
                except ValueError:
                    continue
        return last or {}
    return resp.json()


def _signed_headers(url: str, raw: bytes) -> dict[str, str]:
    """SigV4 headers for the runtime execution role; the Gateway rejects anything else."""
    credentials = boto3.Session().get_credentials()
    if credentials is None:
        raise RuntimeError("runtime credentials unavailable")
    request = AWSRequest(method="POST", url=url, data=raw, headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    SigV4Auth(credentials.get_frozen_credentials(), "bedrock-agentcore", REGION).add_auth(request)
    return dict(request.headers)


def retrieve(query: str, *, sub: str, meeting_id: str | None = None, k: int | None = None, source_type: str = "all", lecture_id: str | None = None) -> list[dict[str, Any]]:
    """Hybrid search on the user's meetings and lectures; returns raw retrievalResults from the managed KB."""
    if not GATEWAY_URL:
        raise RuntimeError("GATEWAY_URL not configured")
    args = {
        "retrievalQuery": {"text": query[:1000]},
        "retrievalConfiguration": {"managedSearchConfiguration": {"filter": owner_filter(sub, meeting_id, source_type=source_type, lecture_id=lecture_id), "numberOfResults": min(k or MAX_RESULTS, MAX_RESULTS)}},
    }
    raw = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": GATEWAY_TOOL, "arguments": args}}).encode()
    with httpx.Client(timeout=30) as http:
        resp = http.post(GATEWAY_URL, content=raw, headers=_signed_headers(GATEWAY_URL, raw))
    if resp.status_code >= 400:
        raise RuntimeError(f"gateway HTTP {resp.status_code}: {resp.text[:300]}")
    return _parse_tool_result(_decode_response(resp))
