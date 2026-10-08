import json

import jsonschema
import pytest

from meeting_agents.chat import tools


DOC = {"title": "CTC", "overview": "Sequence learning", "grouped": True, "selectedPages": [43, 44, 45, 46, 47],
       "pages": [{"page": 1, "sourcePages": [43, 44], "source": "deck", "title": "CTC concepts", "slideSummary": "Concepts"},
                 {"page": 2, "sourcePages": [45, 46, 47], "source": "deck", "title": "Forward-backward", "slideSummary": "Recursion"}]}


@pytest.fixture
def lecture_tool(monkeypatch):
    # Retain the real SDK decorator/schema, only intercept server registration.
    monkeypatch.setattr(tools, "create_sdk_mcp_server", lambda **kwargs: {t.name: t for t in kwargs["tools"]})
    monkeypatch.setattr(tools, "_lectures", lambda: type("Table", (), {"get_item": lambda self, **kwargs: {
        "Item": {"owner": "owner", "status": "COMPLETED", "documentKey": "document"}}})())
    monkeypatch.setattr(tools, "_read_json", lambda key: DOC)
    ctx = tools.TurnContext(sub="owner", source_type="lecture", lecture_id="lecture-1")
    return ctx, tools.build_server(ctx)["get_lecture"]


@pytest.mark.parametrize("args", [{}, {"lectureId": "lecture-1"}, {"page": 0}, {"page": None}])
async def test_outline_is_valid_without_a_required_page(lecture_tool, args):
    ctx, tool = lecture_tool
    jsonschema.validate(args, tool.input_schema)
    result = await tool.handler(args)
    assert not result.get("is_error")
    assert json.loads(result["content"][0]["text"])["pages"][1]["sourcePages"] == [45, 46, 47]
    assert ctx.evidence[0]["page"] is None


@pytest.mark.parametrize("args", [{"sourcePage": 45}, {"page": 45}, {"page": 2}])
async def test_physical_slide_resolves_to_its_group_and_correct_link(lecture_tool, args):
    ctx, tool = lecture_tool
    jsonschema.validate(args, tool.input_schema)
    result = await tool.handler(args)
    assert not result.get("is_error")
    page = json.loads(result["content"][0]["text"])["page"]
    assert page["page"] == 2 and page["sourcePages"] == [45, 46, 47]
    assert ctx.evidence[0]["page"] == 2 and ctx.evidence[0]["url"].endswith("?page=2")


@pytest.mark.parametrize("args", [{"sourcePage": 42}, {"page": 90}, {"page": 1, "sourcePage": 45}, {"lectureId": "other-lecture"}])
async def test_missing_or_foreign_sources_are_errors_without_evidence(lecture_tool, args):
    ctx, tool = lecture_tool
    result = await tool.handler(args)
    assert result["is_error"] is True
    assert not ctx.evidence
