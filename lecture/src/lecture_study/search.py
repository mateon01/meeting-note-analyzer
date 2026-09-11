"""AgentCore managed web-search connector, accessed only through an IAM-authenticated MCP Gateway."""
import json
import os
import threading
from urllib.parse import urlsplit

import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


def decode_rpc(body: dict) -> dict:
    if body.get("error"):
        raise RuntimeError("Web Search Gateway returned an RPC error")
    result = body.get("result")
    if not isinstance(result, dict) or result.get("isError"):
        raise RuntimeError("Web Search Gateway tool failed")
    return result


def search_results(result: dict) -> list[dict]:
    if result.get("isError"):
        raise RuntimeError("Web Search tool failed")
    data = result.get("structuredContent")
    if not isinstance(data, dict) or "results" not in data:
        for block in result.get("content", []):
            if block.get("type") == "text":
                try:
                    candidate = json.loads(block["text"])
                except (ValueError, TypeError):
                    continue
                if isinstance(candidate, dict) and "results" in candidate:
                    data = candidate
                    break
    if not isinstance(data, dict) or not isinstance(data.get("results"), list):
        raise ValueError("Web Search returned an unsupported response; this is not an empty search")
    found, seen = [], set()
    for row in data["results"][:25]:
        url = str(row.get("url") or "")
        parsed = urlsplit(url)
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or any(c.isspace() for c in url):
            continue
        if not row.get("title") or url in seen:
            continue
        seen.add(url)
        found.append({"title": str(row["title"])[:500], "url": url, "snippet": str(row.get("text") or "")[:1500], **({"publishedDate": str(row["publishedDate"])[:50]} if row.get("publishedDate") else {})})
    return found


class GatewaySearch:
    def __init__(self, url: str | None = None, session=None):
        self.url = url or os.environ.get("LECTURE_SEARCH_GATEWAY_URL", "")
        self.region = os.environ.get("AWS_REGION", "us-east-1")
        self.session = session or boto3.Session()
        self.tool: str | None = None
        self.calls = 0
        self._lock = threading.Lock()  # searches run from page worker threads; the cap and cache must stay exact
        self.max_calls = int(os.environ.get("LECTURE_MAX_SEARCH_CALLS", "240"))
        if not 1 <= self.max_calls <= 720:
            raise ValueError("LECTURE_MAX_SEARCH_CALLS must be between 1 and 720")
        self.unavailable: str | None = None
        self.failures = 0
        self.parameters: dict = {}
        self.cache: dict[str, list[dict]] = {}

    def metrics(self):
        return {"searchCalls": self.calls, "searchCallLimit": self.max_calls}

    def discover(self) -> str:
        if self.unavailable:
            raise RuntimeError(self.unavailable)
        if self.tool:
            return self.tool
        try:
            tools = self.rpc("tools/list", {}).get("tools", [])
            matching = [t for t in tools if t.get("name", "").split("___")[-1] == "WebSearch"]
            if len(matching) != 1:
                raise RuntimeError("Expected one managed WebSearch MCP tool")
            parameters = matching[0].get("inputSchema", {}).get("properties", {})
            if parameters.get("query", {}).get("type") != "string":
                raise RuntimeError("WebSearch does not expose a string query parameter")
            self.tool, self.parameters = matching[0]["name"], parameters
            return self.tool
        except Exception:
            self.unavailable = "Lecture WebSearch is unavailable; run the Gateway deployment check before retrying paper search."
            raise RuntimeError(self.unavailable) from None

    def rpc(self, method: str, params: dict) -> dict:
        if not self.url.startswith("https://"):
            raise RuntimeError("Lecture search Gateway is not configured")
        raw = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        credentials = self.session.get_credentials()
        if credentials is None:
            raise RuntimeError("Runtime IAM credentials unavailable")
        request = AWSRequest(method="POST", url=self.url, data=raw, headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
        SigV4Auth(credentials.get_frozen_credentials(), "bedrock-agentcore", self.region).add_auth(request)
        with httpx.Client(timeout=60, follow_redirects=False) as client:
            with client.stream("POST", self.url, content=raw, headers=dict(request.headers)) as response:
                response.raise_for_status()
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > 2 * 1024 * 1024:
                        raise ValueError("Gateway response exceeds 2 MiB")
                    chunks.append(chunk)
                text = b"".join(chunks).decode()
                if "text/event-stream" in response.headers.get("content-type", ""):
                    # MCP responses may have multi-line data fields and intermediate notifications.
                    bodies = ["\n".join(line[5:].lstrip() for line in block.splitlines() if line.startswith("data:")) for block in text.replace("\r\n", "\n").split("\n\n")]
                    for body in reversed(bodies):
                        if body:
                            value = json.loads(body)
                            if value.get("id") == 1:
                                return decode_rpc(value)
                    raise ValueError("Missing MCP response")
                return decode_rpc(json.loads(text))

    def search(self, query: str) -> list[dict]:
        query = query.strip()[:200]
        if not query:
            return []
        with self._lock:
            if query in self.cache:
                return self.cache[query]
            tool = self.discover()
            if self.calls >= self.max_calls:
                raise RuntimeError("Lecture search-call limit exceeded")
            arguments = {"query": query}
            if "maxResults" in self.parameters:
                arguments["maxResults"] = 8
            self.calls += 1
        try:
            result = search_results(self.rpc("tools/call", {"name": tool, "arguments": arguments}))
            self.failures = 0
            self.cache[query] = result
            return result
        except Exception as exc:
            self.failures += 1
            permanent = isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (400, 401, 403, 404)
            if permanent or self.failures >= 3:
                self.unavailable = "Lecture WebSearch failed repeatedly; remaining searches are paused until a manual retry."
            raise RuntimeError("Lecture WebSearch request failed") from None


def gateway_check(query: str | None = None, search=None) -> dict:
    """Used inside the deployed runtime so the check exercises its actual IAM role."""
    if query is not None and (not isinstance(query, str) or not 1 <= len(query) <= 200):
        raise ValueError("Probe query must be 1 to 200 characters")
    search = search or GatewaySearch()
    tool = search.discover()
    result = {"status": "ready", "tool": tool, "parameters": sorted(search.parameters), "searchExecuted": query is not None}
    if query is not None:
        results = search.search(query)
        result["resultCount"] = len(results)
        result["sources"] = [{"title": r["title"], "url": r["url"]} for r in results[:3]]
    return result


def selected_papers(choices, sources: list[dict]) -> list[dict]:
    """Copy source titles/URLs verbatim from MCP; the model supplies only the reading guidance."""
    papers, used = [], set()
    for choice in choices.papers[:3]:
        if choice.sourceId >= len(sources):
            raise ValueError("Paper choice references an unknown search result")
        if choice.sourceId in used:
            raise ValueError("Duplicate paper choice")
        used.add(choice.sourceId)
        papers.append({**sources[choice.sourceId], "relevance": choice.relevance[:800], "readingFocus": choice.readingFocus[:800], "source": "agentcore_web_search"})
    return papers
