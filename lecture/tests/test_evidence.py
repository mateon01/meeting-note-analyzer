import json
import pytest
from lecture_study.alignment import page_evidence, transcript_batches, validate_alignment
from lecture_study.schemas import Alignment, Papers
from lecture_study.search import search_results, selected_papers, GatewaySearch
from lecture_study.model import Model


SEGMENTS = [{"id": f"seg-{i}", "start": i * 10, "end": i * 10 + 8, "text": f"concept {i}", "speaker": "S1"} for i in range(1, 5)]


def assignment(page=1, start="seg-1", end="seg-2", confidence=0.9):
    return {"page": page, "startSegmentId": start, "endSegmentId": end, "confidence": confidence, "reason": "Matching specific derivation"}


@pytest.mark.parametrize("matches", [
    [assignment(start="invented")], [assignment(page=4)], [assignment(start="seg-3", end="seg-1")],
    [assignment(), assignment(page=2, start="seg-2", end="seg-3")],
])
def test_alignment_rejects_invented_reversed_and_overlapping_evidence(matches):
    with pytest.raises(ValueError):
        validate_alignment(Alignment(assignments=matches), SEGMENTS, 3)


def test_revisits_skipped_slides_and_low_confidence_remain_visible():
    value = Alignment(assignments=[assignment(end="seg-1"), assignment(page=2, start="seg-2", end="seg-2"), assignment(start="seg-3", end="seg-4", confidence=0.5)])
    validate_alignment(value, SEGMENTS, 3)
    evidence, confidence = page_evidence(1, [value], [SEGMENTS])
    assert [s["segmentId"] for s in evidence] == ["seg-1", "seg-3", "seg-4"]
    assert confidence["status"] == "uncertain"
    assert confidence["confidence"] == 0.5
    assert page_evidence(3, [value], [SEGMENTS])[1]["status"] == "unmatched"


def test_transcript_batches_preserve_every_segment_without_silent_truncation():
    batches = transcript_batches(SEGMENTS, budget=230)
    assert [s for b in batches for s in b] == SEGMENTS
    with pytest.raises(ValueError):
        transcript_batches(SEGMENTS + [SEGMENTS[0]])
    with pytest.raises(ValueError):
        transcript_batches(SEGMENTS, budget=1)


def test_paper_urls_come_from_actual_mcp_results_only():
    raw = {"results": [{"title": "Real paper", "url": "https://arxiv.org/abs/1706.03762", "text": "An attention architecture", "publishedDate": "2017-06-12"}, {"title": "bad", "url": "javascript:alert(1)"}]}
    sources = search_results({"content": [{"type": "text", "text": json.dumps(raw)}]})
    choices = Papers(papers=[{"sourceId": 0, "relevance": "Attention", "readingFocus": "Architecture"}])
    papers = selected_papers(choices, sources)
    assert len(papers) == 1
    assert papers[0]["url"] == raw["results"][0]["url"]
    assert papers[0]["title"] == "Real paper"
    with pytest.raises(ValueError):
        selected_papers(Papers(papers=[{"sourceId": 2, "relevance": "Invented", "readingFocus": "Invented"}]), sources)


def test_malformed_or_failed_search_is_not_reported_as_no_results():
    for result in ({"isError": True}, {"content": [{"type": "text", "text": "upstream unavailable"}]}):
        with pytest.raises((ValueError, RuntimeError)):
            search_results(result)
    assert search_results({"structuredContent": {"results": []}}) == []


def test_gateway_discovers_tool_and_limits_queries_without_external_calls():
    gateway = GatewaySearch("https://example.com/mcp", session=object())
    calls = []
    def rpc(method, params):
        calls.append((method, params))
        return {"tools": [{"name": "academic-search___WebSearch", "inputSchema": {"properties": {"query": {"type": "string"}, "maxResults": {"type": "integer"}}}}]} if method == "tools/list" else {"structuredContent": {"results": []}}
    gateway.rpc = rpc
    gateway.search("x" * 250)
    assert calls[1][1]["name"] == "academic-search___WebSearch"
    assert len(calls[1][1]["arguments"]["query"]) == 200
    assert calls[1][1]["arguments"]["maxResults"] == 8


def test_model_rejects_truncated_output_and_validates_reference_ids():
    class FakeClient:
        def __init__(self): self.calls = []
        def converse(self, **kwargs):
            self.calls.append(kwargs)
            if len(self.calls) == 1: return {"stopReason": "max_tokens"}
            return {"stopReason": "tool_use", "output": {"message": {"content": [{"toolUse": {"name": "deliver", "input": {"assignments": []}}}]}}}
    client = FakeClient()
    model = Model(client=client)
    assert model.generate(Alignment, "align", {}).assignments == []
    assert len(client.calls) == 2
    assert client.calls[0]["inferenceConfig"]["maxTokens"] == 8192
    with pytest.raises(ValueError, match="context"):
        model.generate(Alignment, "align", {"text": "x" * 180001})


def test_paper_selection_trims_extra_choices_and_long_guidance_instead_of_failing():
    sources = [{"title": f"Paper {i}", "url": f"https://arxiv.org/abs/000{i}", "snippet": "s"} for i in range(6)]
    choices = Papers(papers=[{"sourceId": i, "relevance": "r" * 1500, "readingFocus": "f" * 900} for i in range(5)])
    papers = selected_papers(choices, sources)
    assert [p["url"] for p in papers] == [s["url"] for s in sources[:3]]
    assert all(len(p["relevance"]) == 800 and len(p["readingFocus"]) == 800 for p in papers)
