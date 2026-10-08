import json

from meeting_agents.chat import evidence, gateway, prompting
from meeting_agents.chat.agent import _delta_event, tool_title


def test_owner_filter_is_always_present():
    assert gateway.owner_filter("u1", None) == {"equals": {"key": "owner", "value": "u1"}}
    f = gateway.owner_filter("u1", "m1")
    assert f["andAll"][0] == {"equals": {"key": "owner", "value": "u1"}} and f["andAll"][1]["equals"]["key"] == "meetingId"


def test_evidence_labels_links_and_timestamps():
    results = [
        {"content": {"text": "[00:16] S2 (seg-0006): 안녕하세요, 백엔드 리드 이서현입니다."}, "location": {"s3Location": {"uri": "s3://b/transcripts/m1/transcript.md"}}, "score": 0.81, "metadata": {"meetingId": "m1", "title": "주간회의", "date": "2026-09-05"}},
        {"content": {"text": "## 결정 사항\n- 타임아웃 5초"}, "location": {"s3Location": {"uri": "s3://b/results/m1/document.md"}}, "score": 0.7, "metadata": {"meetingId": "m1", "title": "주간회의", "date": "2026-09-05"}},
        {"content": {"text": "## 결정 사항\n- 타임아웃 5초"}, "location": {"s3Location": {"uri": "s3://b/results/m1/document.md"}}, "score": 0.6, "metadata": {"meetingId": "m1"}},
    ]
    items = evidence.to_evidence(results, web_origin="https://x", start_index=2)
    assert [i["id"] for i in items] == ["E3", "E4"]  # duplicate dropped, numbering continues from prior evidence
    assert items[0]["kind"] == "transcript" and items[0]["startSec"] == 16 and items[0]["url"] == "https://x/meetings/m1?t=16" and items[0]["segmentIds"] == ["seg-0006"]
    assert items[1]["kind"] == "document" and items[1]["url"] == "https://x/meetings/m1"
    text = evidence.format_for_model(items)
    assert text.startswith("[E3] 주간회의 2026-09-05 | 전사 00:16") and "[E4] 주간회의" in text


def test_gateway_result_parsing_handles_json_and_sse():
    body = {"jsonrpc": "2.0", "id": 1, "result": {"isError": False, "content": [{"type": "text", "text": json.dumps({"retrievalResults": [{"content": {"text": "x"}}]})}]}}
    assert gateway._parse_tool_result(body) == [{"content": {"text": "x"}}]

    class Resp:
        headers = {"content-type": "text/event-stream"}
        text = "event: message\ndata: " + json.dumps(body) + "\n\n"

    assert gateway._parse_tool_result(gateway._decode_response(Resp())) == [{"content": {"text": "x"}}]


def test_history_selection_respects_budget_and_turns():
    msgs = [{"role": "user" if i % 2 == 0 else "assistant", "text": "x" * 1000, "seq": i} for i in range(40)]
    kept, dropped = prompting.select_history(msgs, budget_chars=5000, max_turns=12)
    assert len(kept) == 4 and dropped == 36 and kept[-1]["seq"] == 39
    kept2, dropped2 = prompting.select_history(msgs, budget_chars=10**6, max_turns=3)
    assert len(kept2) == 6 and dropped2 == 34


def test_turn_prompt_mentions_scope_summary_and_language():
    p = prompting.build_turn_prompt(question="타임아웃 결정은?", history=[{"role": "user", "text": "안녕"}], summary="이전에 결제 모듈을 논의함", facts=["이서현은 백엔드 리드"], meeting_scope={"meetingId": "m1", "title": "주간회의"}, language="ko")
    assert "주간회의" in p and "이전에 결제 모듈을 논의함" in p and "이서현은 백엔드 리드" in p and "답변 언어: 한국어" in p


def test_stream_delta_mapping_and_tool_titles():
    assert _delta_event({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "안"}}) == {"type": "text", "delta": "안"}
    assert _delta_event({"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "..."}}) == {"type": "thinking", "delta": "..."}
    assert _delta_event({"type": "content_block_start"}) is None
    assert tool_title("mcp__meeting__search_meetings", {"query": "타임아웃"}) == "자료 검색: 타임아웃"


def test_speaker_namer_uses_selected_ids_and_honors_manual_names():
    from meeting_agents.chat.tools import _speaker_namer

    name = _speaker_namer({"speakers": [{"id": "S1", "label": "김민준"}, {"id": "S2", "label": "이서현"}]})
    assert name({"id": "seg-1", "speaker": "S1"}) == "김민준"
    assert name({"id": "seg-2", "speaker": "S3", "speakerLabel": "직접 소개한 이름"}) == "직접 소개한 이름"
    assert name({"id": "seg-9", "speaker": "S2", "speakerLabel": "이전 이름"}) == "이서현"
    assert name({"id": "seg-5", "speaker": "S7"}) == "S7"


def test_preview_strips_markdown_and_labels():
    from meeting_agents.chat.agent import preview

    assert preview("## 회의 목록\n\n- 주간회의 2026-09-05 [E1]\n- **결정** 타임아웃 5초 [E2][E3]") == "회의 목록 주간회의 2026-09-05 결정 타임아웃 5초"


def test_ddb_safe_converts_floats_recursively():
    from decimal import Decimal

    from meeting_agents.chat.store import ddb_safe

    out = ddb_safe({"evidence": [{"score": 0.553123456789, "segmentIds": ["a"]}], "usage": {"costUsd": 0.05, "turns": 3}, "text": "x"})
    assert out["evidence"][0]["score"] == Decimal("0.553123") and out["usage"]["costUsd"] == Decimal("0.05") and out["usage"]["turns"] == 3 and out["text"] == "x"


def test_every_tool_has_a_ui_title():
    from meeting_agents.chat.agent import TOOL_TITLES
    from meeting_agents.chat.tools import TOOL_NAMES

    assert "mcp__meeting__ask_user" in TOOL_NAMES and set(TOOL_NAMES) <= set(TOOL_TITLES)


def test_completed_meetings_filters_and_formats(monkeypatch):
    from meeting_agents.chat import tools

    class FakeTable:
        def query(self, **kw):
            return {"Items": [
                {"SK": "META", "status": "COMPLETED", "meetingId": "m2", "title": "주간회의 2", "createdAt": "2026-09-05T10:00:00Z"},
                {"SK": "META", "status": "FAILED", "meetingId": "m1", "title": "실패한 회의", "createdAt": "2026-09-04T10:00:00Z"},
            ]}

    monkeypatch.setattr(tools, "_ddb", lambda: FakeTable())
    assert tools._completed_meetings("u1") == [{"meetingId": "m2", "title": "주간회의 2", "date": "2026-09-05"}]


def test_diversify_caps_chunks_per_document_but_keeps_relevance_order():
    from meeting_agents.chat.evidence import diversify

    def r(mid, i):
        return {"content": {"text": f"{mid}-{i}"}, "location": {"s3Location": {"uri": f"s3://b/results/{mid}/document.md"}}, "metadata": {"meetingId": mid}, "score": 1 - i / 100}

    results = [r("A", i) for i in range(6)] + [r("B", 0), r("B", 1), r("C", 0)]
    out = diversify(results, per_document=3, limit=8)
    assert [x["content"]["text"] for x in out] == ["A-0", "A-1", "A-2", "B-0", "B-1", "C-0", "A-3", "A-4"]


def test_lecture_chunks_become_lecture_evidence_with_page_links():
    results = [{"content": {"text": "## 5. 체(Field)의 정의\n\n### 장표 요약\n체는 두 연산을 가진 집합이다."}, "score": 0.9,
                "location": {"s3Location": {"uri": "s3://data/lecture-results/lec-1/runs/run-1/study.md"}},
                "metadata": {"kind": "lecture", "lectureId": "lec-1", "title": "선형대수학 1주차", "course": "선형대수", "date": "2026-09-06"}},
               {"content": {"text": "학습 목표: 체의 공리를 나열한다"}, "score": 0.5,
                "location": {"s3Location": {"uri": "s3://data/lecture-results/lec-1/runs/run-1/study.md"}}, "metadata": {"lectureId": "lec-1", "title": "선형대수학 1주차"}}]
    items = evidence.to_evidence(results, web_origin="https://x", start_index=0)
    assert [i["kind"] for i in items] == ["lecture", "lecture"]
    assert items[0]["lectureId"] == "lec-1" and items[0]["meetingId"] is None and items[0]["page"] == 5
    assert items[0]["url"] == "https://x/lectures/lec-1?page=5"
    assert items[1]["page"] is None and items[1]["url"] == "https://x/lectures/lec-1"
    text = evidence.format_for_model(items)
    assert "[E1] 선형대수학 1주차 2026-09-06 | 강의 학습 항목 5" in text and "[E2] 선형대수학 1주차 | 강의" in text
    assert evidence.diversify(results * 3, per_document=3, limit=8)[3] is results[1]  # one lecture cannot fill every slot


def test_completed_lectures_and_lecture_document_tools(monkeypatch):
    from meeting_agents.chat import tools

    class FakeLectures:
        def query(self, **kw):
            assert kw["KeyConditionExpression"]._values[1] == "USER#u1"
            return {"Items": [
                {"SK": "META", "status": "COMPLETED", "lectureId": "lec-1", "owner": "u1", "title": "선형대수학 1주차", "course": "선형대수", "createdAt": "2026-09-06T10:00:00Z", "pageCount": 20, "durationSec": 1840, "documentKey": "lecture-results/lec-1/runs/run-1/document.json"},
                {"SK": "META", "status": "ANALYZING", "lectureId": "lec-2", "owner": "u1", "title": "분석 중 강의", "createdAt": "2026-09-05T10:00:00Z"},
            ]}
        def get_item(self, Key, **kw):
            return {"Item": {"lectureId": "lec-1", "owner": "u1", "title": "선형대수학 1주차", "course": "선형대수", "status": "COMPLETED", "createdAt": "2026-09-06T10:00:00Z", "documentKey": "lecture-results/lec-1/runs/run-1/document.json"}} if Key["PK"] == "MEETING#lec-1" else {}

    document = {"title": "선형대수학 1주차", "course": "선형대수", "overview": "체와 벡터공간을 소개한다.", "audience": {"level": "학부 1학년", "priorKnowledge": ["실수 연산"], "lectureGoal": "체를 판별한다"},
                "learningObjectives": ["체의 공리 나열"], "reviewPlan": ["정의 복습"],
                "pages": [{"page": 1, "title": "제목", "slideSummary": "제목 장표", "spokenSummary": "", "explanation": "", "concepts": [], "mathNotes": [], "reviewQuestions": [], "flashcards": [], "videoRanges": [{"startSec": 0, "endSec": 6}]},
                          {"page": 5, "title": "체의 정의", "slideSummary": "체는 두 연산을 가진 집합", "spokenSummary": "교수가 닫힘성을 설명", "explanation": "보충", "concepts": [{"term": "닫힘성", "explanation": "결과가 집합 안"}],
                           "mathNotes": [{"kind": "definition", "name": "체", "statement": "$F$", "steps": ["s1"], "intuition": "i", "supplementary": False}],
                           "reviewQuestions": [{"question": "공리는?", "answer": "다섯 가지", "difficulty": "basic"}], "flashcards": [{"front": "체?", "back": "집합"}], "videoRanges": [{"startSec": 300, "endSec": 580}]}]}
    monkeypatch.setattr(tools, "_lectures", lambda: FakeLectures())
    monkeypatch.setattr(tools, "_read_json", lambda key: document if key == "lecture-results/lec-1/runs/run-1/document.json" else None)
    assert tools._completed_lectures("u1") == [{"lectureId": "lec-1", "title": "선형대수학 1주차", "course": "선형대수", "date": "2026-09-06", "pageCount": 20, "durationMin": 31}]
    assert tools._owned_lecture(tools.TurnContext(sub="u1"), "lec-1")["title"] == "선형대수학 1주차"
    assert tools._owned_lecture(tools.TurnContext(sub="u2"), "lec-1") is None
    outline = tools.compact_lecture(document, "lec-1")
    assert outline["audienceLevel"] == "학부 1학년" and [p["page"] for p in outline["pages"]] == [1, 5]
    page = tools.compact_lecture(document, "lec-1", page=5)
    assert page["page"]["title"] == "체의 정의" and page["page"]["mathNotes"][0]["statement"] == "$F$" and page["page"]["startSec"] == 300
    assert "overview" not in page
    missing = tools.compact_lecture(document, "lec-1", page=9)
    assert "page not found" in missing["error"]
    assert [p["page"] for p in missing["pages"]] == [1, 5]


def test_gateway_calls_are_signed_with_the_runtime_role_not_the_user_token(monkeypatch):
    import httpx

    captured = {}

    class FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, url, json=None, headers=None, content=None):
            captured["headers"] = headers or {}
            captured["url"] = url
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "{\"retrievalResults\": []}"}]}})

    monkeypatch.setattr(gateway.httpx, "Client", FakeClient)
    monkeypatch.setattr(gateway, "GATEWAY_URL", "https://gw.example/mcp")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIATEST"); monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret"); monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    assert gateway.retrieve("체의 정의", sub="u1", meeting_id=None) == []
    auth = captured["headers"].get("Authorization", "")
    assert auth.startswith("AWS4-HMAC-SHA256") and "bedrock-agentcore" in auth and "Bearer" not in auth
    assert "X-Amz-Date" in captured["headers"] or "x-amz-date" in captured["headers"]


def test_chat_payload_no_longer_needs_the_user_token():
    from meeting_agents.chat.payload import ChatPayload

    payload = ChatPayload.model_validate({"sub": "u1", "sessionId": "session-1", "message": "안녕"})
    assert payload.sub == "u1" and not hasattr(payload, "idToken")


def test_lecture_evidence_gets_its_page_from_the_study_document():
    items = [{"kind": "lecture", "lectureId": "lec-1", "page": None, "url": "https://x/lectures/lec-1",
              "snippet": "### 학습 보충 설명 이 슬라이드는 체의 정의를 구체적인 예시로 확인하는 부분입니다. **무한체(infinite field) 예시**: $R,Q,C$는 익숙한 무한개의 원소를 가진 체입니다."},
             {"kind": "lecture", "lectureId": "lec-1", "page": 3, "url": "https://x/lectures/lec-1?page=3", "snippet": "already placed"},
             {"kind": "document", "meetingId": "m1", "page": None, "url": "https://x/meetings/m1", "snippet": "회의 결정"}]
    doc = {"pages": [{"page": 4, "title": "Vector space", "slideSummary": "벡터의 두 정의", "explanation": "물리와 수학의 벡터"},
                     {"page": 9, "title": "체의 예시", "slideSummary": "R, Q, C, Z2", "explanation": "이 슬라이드는 체의 정의를 구체적인 예시로 확인하는 부분입니다.\n\n**무한체(infinite field) 예시**: $R,Q,C$는 익숙한 무한개의 원소를 가진 체입니다."}]}
    loads = []
    evidence.locate_lecture_pages(items, lambda lid: loads.append(lid) or doc)
    assert items[0]["page"] == 9 and items[0]["url"] == "https://x/lectures/lec-1?page=9"
    assert loads == ["lec-1"]  # one document read per lecture, only for items still missing a page
    assert items[1]["page"] == 3 and items[2]["page"] is None
    assert "강의 학습 항목 9" in evidence.format_for_model([{**items[0], "id": "E1", "title": "T", "date": None, "startSec": None}])


def test_compact_document_exposes_the_brief_without_unsupported_reasons():
    from meeting_agents.chat.tools import compact_brief, compact_document

    brief = {"headline": "핵심 기능부터 출시", "decisions": [{"decision": "검색부터 출시", "process": "테스트 기간 부족", "rationaleStatus": "supported"}, {"decision": "통계는 다음 버전", "process": "추측", "rationaleStatus": "not_recorded"}], "followUpIds": ["F1"], "openQuestions": [{"question": "출시일"}]}
    out = compact_brief(brief)
    assert out["decisions"][0]["process"] == "테스트 기간 부족" and out["decisions"][1]["process"] == ""
    assert out["openQuestions"] == ["출시일"]
    assert compact_document({"summary": {}, "speakers": [], "agenda": [], "followUps": [], "suggestions": []}, "m1")["brief"] is None


def test_review_marker_reads_as_korean_in_evidence_snippets():
    results = [{"content": {"text": "[00:10] S1 [speaker review required] (seg-1): 제가 맡겠습니다"}, "score": 0.5,
                "location": {"s3Location": {"uri": "s3://data/transcripts/m1/transcript.md"}}, "metadata": {"meetingId": "m1", "title": "회의"}}]
    item = evidence.to_evidence(results, web_origin="https://x", start_index=0)[0]
    assert "(화자 검토 필요)" in item["snippet"] and "speaker review required" not in item["snippet"]
    assert evidence.display_snippet("A [speaker review required]: B") == "A (화자 검토 필요): B"
