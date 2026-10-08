import json
from io import BytesIO
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

from meeting_agents.chat import tools

RECORD = {"meetingId": "m1", "transcriptKey": "original", "stages": {"speaker_attribution": {"status": "COMPLETED"}}}


def test_chat_reads_the_same_corrected_source_as_the_ui(monkeypatch):
    storage = Mock()
    storage.get_object.return_value = {"Body": BytesIO(b'{"meetingId":"m1","attributed":true}')}
    monkeypatch.setattr(tools, "_s3", lambda: storage)
    assert tools._meeting_transcript(RECORD)["attributed"] is True
    assert storage.get_object.call_args.kwargs["Key"] == "results/m1/transcript_attributed.json"


@pytest.mark.parametrize("code", ["NoSuchKey", "AccessDenied", "SlowDown"])
def test_chat_falls_back_only_for_missing_corrected_files(monkeypatch, code):
    storage = Mock()
    storage.get_object.side_effect = [ClientError({"Error": {"Code": code}}, "GetObject"), {"Body": BytesIO(b'{"meetingId":"m1"}')}]
    monkeypatch.setattr(tools, "_s3", lambda: storage)
    if code == "NoSuchKey":
        assert tools._meeting_transcript(RECORD) == {"meetingId": "m1"}
        assert storage.get_object.call_args.kwargs["Key"] == "original"
    else:
        with pytest.raises(ClientError):
            tools._meeting_transcript(RECORD)
        assert storage.get_object.call_count == 1


def test_chat_does_not_read_unfinished_attribution(monkeypatch):
    read = Mock(return_value={"meetingId": "m1"})
    monkeypatch.setattr(tools, "_read_json", read)
    tools._meeting_transcript({**RECORD, "stages": {"speaker_attribution": {"status": "RUNNING"}}})
    read.assert_called_once_with("original", strict=True)


def test_chat_preserves_review_flags_and_honors_manually_confirmed_names():
    data = {"attributed": True, "speakerAttribution": {"version": 2, "corrections": [
        {"id": "c1", "kind": "relabel", "status": "review_required", "to": "S1"},
        {"id": "c2", "kind": "label", "status": "review_required", "to": "S2"},
    ]}}
    segs = [{"id": "seg-1", "start": 10, "speaker": "S2", "speakerLabel": "S2", "text": "원래 발언", "speakerCorrectionIds": ["c1", "c2"]}]
    doc = {"speakers": [{"id": "S2", "label": "확인한 이름", "nameConfirmedByUser": True}]}
    assert tools._transcript_lines(data, segs, doc) == ["[00:10] 확인한 이름 [speaker review required]: 원래 발언"]
    segs[0]["speakerCorrectionIds"] = ["c2"]
    assert tools._transcript_lines(data, segs, doc) == ["[00:10] 확인한 이름: 원래 발언"]


def test_chat_does_not_name_an_uncertain_participant_from_its_candidate():
    doc = {"speakers": [{"id": "S1", "label": "S1", "proposedLabel": "후보 이름", "reviewRequired": True}]}
    compact = tools.compact_document(doc, "m1")
    assert compact["speakers"] == [{"id": "S1", "label": "S1", "role": None, "reviewRequired": True}]


async def test_transcript_tool_checks_ownership_before_any_storage_read(monkeypatch):
    monkeypatch.setattr(tools, "tool", lambda *args, **kwargs: lambda handler: handler)
    monkeypatch.setattr(tools, "create_sdk_mcp_server", lambda **kwargs: {t.__name__: t for t in kwargs["tools"]})
    monkeypatch.setattr(tools, "_owned_meeting", lambda *args: None)
    storage = Mock()
    monkeypatch.setattr(tools, "_s3", lambda: storage)
    ctx = tools.TurnContext(sub="u2")
    result = await tools.build_server(ctx)["get_transcript_window"]({"meetingId": "m1", "startSec": 0, "endSec": 20})
    assert json.loads(result["content"][0]["text"])["error"] == "transcript not found"
    storage.get_object.assert_not_called()
    assert not ctx.evidence


async def test_transcript_tool_does_not_replay_proposals_when_corrected_file_is_missing(monkeypatch):
    monkeypatch.setattr(tools, "tool", lambda *args, **kwargs: lambda handler: handler)
    monkeypatch.setattr(tools, "create_sdk_mcp_server", lambda **kwargs: {t.__name__: t for t in kwargs["tools"]})
    monkeypatch.setattr(tools, "_owned_meeting", lambda *args: RECORD)
    source = {"meetingId": "m1", "segments": [{"id": "seg-1", "speaker": "S1", "start": 0, "end": 5, "text": "발언"}]}
    read = Mock(side_effect=lambda key, **kwargs: source if key == "original" else None)
    monkeypatch.setattr(tools, "_read_json", read)
    result = await tools.build_server(tools.TurnContext(sub="u1"))["get_transcript_window"]({"meetingId": "m1", "startSec": 0, "endSec": 20})
    assert json.loads(result["content"][0]["text"])["lines"] == ["[00:00] S1: 발언"]
    assert [call.args[0] for call in read.call_args_list] == ["results/m1/transcript_attributed.json", "original"]


async def test_name_only_review_reaches_transcript_tools_without_flagging_every_utterance(monkeypatch):
    from meeting_agents.attribution import reconcile_attribution
    from meeting_agents.transcript import Transcript
    source = {"meetingId": "m1", "durationSec": 10, "segments": [{"id": "seg-1", "start": 0, "end": 5, "speaker": "S1", "text": "제가 검토할게요.", "words": []}]}
    safe, data = reconcile_attribution(source, {"speakers": [{"id": "S1", "label": "이름 후보", "confidence": 0.5}]})
    assert not data["segments"][0]["speakerReviewRequired"]
    markdown = Transcript(data).to_markdown("회의")
    assert markdown.count("[speaker name review required]") == 1
    assert "[speaker review required]" not in markdown
    monkeypatch.setattr(tools, "tool", lambda *args, **kwargs: lambda handler: handler)
    monkeypatch.setattr(tools, "create_sdk_mcp_server", lambda **kwargs: {t.__name__: t for t in kwargs["tools"]})
    monkeypatch.setattr(tools, "_owned_meeting", lambda *args: {**RECORD, "notesKey": "document"})
    monkeypatch.setattr(tools, "_meeting_transcript", lambda rec: data)
    doc = {"speakers": safe["speakers"]}
    monkeypatch.setattr(tools, "_read_json", lambda key: doc)
    ctx = tools.TurnContext(sub="u1")
    result = await tools.build_server(ctx)["get_transcript_window"]({"meetingId": "m1", "startSec": 0, "endSec": 8})
    payload = json.loads(result["content"][0]["text"])
    assert payload["speakers"] == [{"id": "S1", "label": "S1", "reviewRequired": True, "proposedLabel": "이름 후보"}]
    assert "이름 검토 필요" in ctx.evidence[0]["snippet"]
    assert "speaker review required" not in payload["lines"][0]
    doc["speakers"] = [{"id": "S1", "label": "확인한 이름", "nameConfirmedByUser": True, "reviewRequired": False}]
    assert tools._window_speakers(data, data["segments"], doc) == [{"id": "S1", "label": "확인한 이름", "reviewRequired": False}]
