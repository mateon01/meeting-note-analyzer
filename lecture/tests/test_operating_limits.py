import httpx
import pytest
from botocore.exceptions import ClientError
from lecture_study.model import Model
from lecture_study.schemas import Alignment
from lecture_study.search import GatewaySearch, gateway_check


def tool_list():
    return {"tools": [{"name": "academic-search___WebSearch", "inputSchema": {"properties": {"query": {"type": "string"}}}}]}


def test_missing_connector_is_checked_once_not_once_per_page():
    search = GatewaySearch("https://example.org/mcp", session=object())
    calls = []
    search.rpc = lambda method, args: calls.append(method) or {"tools": []}
    for _ in range(60):
        with pytest.raises(RuntimeError): search.search("paper")
    assert calls == ["tools/list"] and search.calls == 0


def test_server_fixed_result_limit_and_query_cache():
    search = GatewaySearch("https://example.org/mcp", session=object())
    calls = []
    def rpc(method, args):
        calls.append((method, args))
        return tool_list() if method == "tools/list" else {"structuredContent": {"results": []}}
    search.rpc = rpc
    assert gateway_check(search=search)["searchExecuted"] is False
    search.search("paper"); search.search("paper")
    assert calls[1][1]["arguments"] == {"query": "paper"}
    assert search.calls == 1 and len(calls) == 2


def test_permission_failure_stops_remaining_remote_searches():
    search = GatewaySearch("https://example.org/mcp", session=object())
    calls = []
    def rpc(method, args):
        calls.append(method)
        if method == "tools/list": return tool_list()
        response = httpx.Response(403, request=httpx.Request("POST", "https://example.org/mcp"))
        raise httpx.HTTPStatusError("denied", request=response.request, response=response)
    search.rpc = rpc
    for _ in range(10):
        with pytest.raises(RuntimeError): search.search("paper")
    assert calls == ["tools/list", "tools/call"] and search.calls == 1


def test_search_budget_stops_before_the_extra_request(monkeypatch):
    monkeypatch.setenv("LECTURE_MAX_SEARCH_CALLS", "1")
    search = GatewaySearch("https://example.org/mcp", session=object())
    search.rpc = lambda method, args: tool_list() if method == "tools/list" else {"structuredContent": {"results": []}}
    search.search("one")
    with pytest.raises(RuntimeError, match="limit"): search.search("two")
    assert search.calls == 1


def test_model_budget_counts_retries_and_reported_tokens(monkeypatch):
    monkeypatch.setenv("LECTURE_MAX_MODEL_CALLS", "2")
    monkeypatch.setattr("lecture_study.model.time.sleep", lambda _: None)
    class Client:
        calls = 0
        def converse(self, **kwargs):
            self.calls += 1
            if self.calls == 1: raise ClientError({"Error": {"Code": "ThrottlingException", "Message": "retry"}}, "Converse")
            return {"stopReason": "tool_use", "usage": {"inputTokens": 100, "outputTokens": 10}, "output": {"message": {"content": [{"toolUse": {"name": "deliver", "input": {"assignments": []}}}]}}}
    client = Client(); model = Model(client=client)
    model.generate(Alignment, "align", {})
    assert model.metrics() == {"modelCalls": 2, "modelCallLimit": 2, "inputTokens": 100, "outputTokens": 10}
    with pytest.raises(RuntimeError, match="limit"): model.generate(Alignment, "align", {})
    assert client.calls == 2


def _ok(schema_input=None):
    return {"stopReason": "tool_use", "usage": {"inputTokens": 1, "outputTokens": 1}, "output": {"message": {"content": [{"toolUse": {"name": "deliver", "input": schema_input or {"assignments": []}}}]}}}


def _client_error(code):
    return ClientError({"Error": {"Code": code, "Message": "Bedrock is unable to process your request."}}, "Converse")


def test_transient_bedrock_errors_are_retried_with_growing_backoff(monkeypatch):
    from lecture_study.model import TRANSIENT_DELAYS
    sleeps = []
    monkeypatch.setattr("lecture_study.model.time.sleep", sleeps.append)
    class Client:
        calls = 0
        def converse(self, **kwargs):
            self.calls += 1
            if self.calls <= 6: raise _client_error("ServiceUnavailableException")
            return _ok()
    client = Client(); model = Model(client=client)
    model.generate(Alignment, "align", {})
    assert client.calls == 7 and sleeps == list(TRANSIENT_DELAYS[:6]) and sum(sleeps) >= 60
    assert model.metrics()["modelCalls"] == 7


def test_persistent_transient_error_is_reported_as_transient_and_other_errors_fail_fast(monkeypatch):
    from lecture_study.model import TRANSIENT_DELAYS, failure_code
    sleeps = []
    monkeypatch.setattr("lecture_study.model.time.sleep", sleeps.append)
    class Down:
        calls = 0
        def converse(self, **kwargs):
            self.calls += 1
            raise _client_error("ServiceUnavailableException")
    down = Down()
    with pytest.raises(ClientError) as excinfo: Model(client=down).generate(Alignment, "align", {})
    assert down.calls == len(TRANSIENT_DELAYS) + 1 and failure_code(excinfo.value) == "LectureTransient"
    class Rejecting:
        calls = 0
        def converse(self, **kwargs):
            self.calls += 1
            raise _client_error("ValidationException")
    rejecting = Rejecting()
    with pytest.raises(ClientError) as excinfo: Model(client=rejecting).generate(Alignment, "align", {})
    assert rejecting.calls == 1 and failure_code(excinfo.value) == "LectureAnalysisFailed"
    assert failure_code(ValueError("bad output")) == "LectureAnalysisFailed"
