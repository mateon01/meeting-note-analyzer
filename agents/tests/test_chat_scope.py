from meeting_agents.chat import gateway, tools
from meeting_agents.chat.prompting import build_turn_prompt


def test_lecture_filter_includes_owner_type_and_fixed_lecture():
    value = gateway.owner_filter("owner", None, source_type="lecture", lecture_id="lecture-1")
    assert value == {"andAll": [
        {"equals": {"key": "owner", "value": "owner"}},
        {"equals": {"key": "kind", "value": "lecture"}},
        {"equals": {"key": "lectureId", "value": "lecture-1"}},
    ]}
    assert gateway.owner_filter("owner", None, source_type="meeting")["andAll"][1] == {
        "notEquals": {"key": "kind", "value": "lecture"}}


def test_direct_tools_cannot_escape_selected_source_or_record(monkeypatch):
    def unexpected():
        raise AssertionError("Disallowed source must not be read")
    monkeypatch.setattr(tools, "_ddb", unexpected)
    monkeypatch.setattr(tools, "_lectures", unexpected)
    lecture = tools.TurnContext(sub="owner", source_type="lecture", lecture_id="lecture-1")
    meeting = tools.TurnContext(sub="owner", source_type="meeting", meeting_id="meeting-1")
    assert tools._owned_meeting(lecture, "meeting-1") is None
    assert tools._owned_lecture(lecture, "lecture-2") is None
    assert tools._owned_lecture(meeting, "lecture-1") is None
    assert tools._owned_meeting(meeting, "meeting-2") is None
    assert tools.scoped_list(lecture, "meeting") == []
    assert tools.scoped_list(meeting, "lecture") == []


def test_search_discards_other_sources_owners_and_superseded_lecture_runs(monkeypatch):
    ctx = tools.TurnContext(sub="owner", source_type="lecture", lecture_id="lecture-1")
    monkeypatch.setattr(tools, "_owned_lecture", lambda context, lid: {
        "documentKey": "lecture-results/lecture-1/runs/current/document.json"
    } if lid == context.lecture_id else None)
    def row(owner="owner", lecture="lecture-1", run="current", kind="lecture"):
        return {"metadata": {"owner": owner, "kind": kind, "lectureId": lecture},
                "location": {"s3Location": {"uri": f"s3://bucket/lecture-results/{lecture}/runs/{run}/study.md"}}}
    valid = row()
    meeting = {"metadata": {"owner": "owner", "meetingId": "meeting-1"},
               "location": {"s3Location": {"uri": "s3://bucket/results/meeting-1/document.md"}}}
    assert tools.scoped_results(ctx, [valid, row(owner="other"), row(lecture="lecture-2"), row(run="old"), meeting]) == [valid]


def test_lecture_prompt_uses_current_groups_and_physical_source_pages():
    prompt = build_turn_prompt(question="38페이지를 설명해 줘", history=[], summary=None, facts=[], meeting_scope=None,
                               lecture_scope={"lectureId": "lecture-1", "title": "Optimization"}, source_type="lecture", language="ko")
    assert "lecture-1" in prompt and "get_lecture" in prompt and "sourcePages" in prompt
    doc = {"selectedPages": [38, 39], "grouped": True, "pages": [{"page": 1, "sourcePages": [38, 39], "title": "Gradient", "mathNotes": [{
        "sourceCheck": {"status": "corrected", "correctedStatement": "$-dE/ds$"}}]}]}
    outline = tools.compact_lecture(doc, "lecture-1")
    assert outline["selectedPages"] == [38, 39]
    assert outline["pages"][0]["sourcePages"] == [38, 39]
    section = tools.compact_lecture(doc, "lecture-1", 1)
    assert section["page"]["mathNotes"][0]["sourceCheck"]["correctedStatement"] == "$-dE/ds$"
