"""One chat turn: assemble context, run the Claude Agent SDK agent with streaming, map messages to UI events, persist."""
from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Any, AsyncIterator

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ResultMessage, StreamEvent, ToolResultBlock, ToolUseBlock, UserMessage, query

from ..config import PROMPTS_DIR
from . import memory, store
from .config import CHAT_MODEL, MAX_TURNS
from .payload import ChatPayload
from .prompting import build_turn_prompt, select_history
from .tools import TOOL_NAMES, TurnContext, build_server, _owned_lecture, _owned_meeting

log = logging.getLogger("chat.agent")

TOOL_TITLES = {
    "mcp__meeting__search_meetings": "자료 검색",
    "mcp__meeting__get_meeting": "회의 문서 열기",
    "mcp__meeting__list_meetings": "회의 목록 조회",
    "mcp__meeting__get_transcript_window": "전사 구간 확인",
    "mcp__meeting__list_lectures": "강의 목록 조회",
    "mcp__meeting__get_lecture": "강의 자료 열기",
    "mcp__meeting__memory_facts": "장기 기억 조회",
    "mcp__meeting__ask_user": "범위 확인 질문",
}


def preview(answer: str, limit: int = 120) -> str:
    """First line of the answer for the session list: markdown markers and evidence labels stripped."""
    flat = " ".join(l.strip().lstrip("#-* ").strip() for l in answer.splitlines() if l.strip())
    return re.sub(r"\s*\[E\d+\]", "", flat).replace("**", "")[:limit]


def system_prompt() -> str:
    return (PROMPTS_DIR / "chat_system.md").read_text(encoding="utf-8")


def tool_title(name: str, inp: dict[str, Any]) -> str:
    base = TOOL_TITLES.get(name, name)
    if name.endswith("search_meetings") and inp.get("query"):
        return f"{base}: {str(inp['query'])[:60]}"
    if name.endswith("get_meeting") and inp.get("meetingId"):
        return f"{base}"
    return base


def _delta_event(ev: dict[str, Any]) -> dict[str, Any] | None:
    """Map a raw Anthropic stream event to a UI event (text or thinking delta)."""
    if ev.get("type") != "content_block_delta":
        return None
    delta = ev.get("delta") or {}
    if delta.get("type") == "text_delta" and delta.get("text"):
        return {"type": "text", "delta": delta["text"]}
    if delta.get("type") == "thinking_delta" and delta.get("thinking"):
        return {"type": "thinking", "delta": delta["thinking"]}
    return None


def build_options(ctx: TurnContext, workdir: Path) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        model=CHAT_MODEL,
        effort="medium",
        system_prompt=system_prompt(),
        cwd=str(workdir),
        permission_mode="bypassPermissions",
        setting_sources=[],
        tools=[],
        allowed_tools=TOOL_NAMES,
        mcp_servers={"meeting": build_server(ctx)},
        include_partial_messages=True,
        max_turns=MAX_TURNS,
        max_thinking_tokens=2000,
    )


async def run_turn(payload: ChatPayload, workdir: Path) -> AsyncIterator[dict[str, Any]]:
    """Yield UI events for one turn. The caller (entrypoint) streams them as SSE."""
    t0 = time.time()
    try:
        session = store.ensure_session(payload.sub, payload.sessionId, payload.meetingId, payload.lectureId, payload.sourceType)
    except store.NotOwner:
        yield {"type": "error", "message": "세션을 찾을 수 없음"}
        return
    # The stored session is authoritative. A later turn cannot widen its search scope.
    scope_id = session.get("meetingId")
    lecture_id = session.get("lectureId")
    source_type = session.get("sourceType") or ("lecture" if lecture_id else "meeting" if scope_id else "all")
    ctx = TurnContext(sub=payload.sub, meeting_id=scope_id, lecture_id=lecture_id, source_type=source_type)
    scope = None
    if scope_id:
        rec = _owned_meeting(ctx, scope_id)
        if not rec:
            yield {"type": "error", "message": "지정한 회의를 찾을 수 없습니다."}
            return
        scope = {"meetingId": scope_id, "title": rec.get("title")}
    lecture_scope = None
    if lecture_id:
        rec = _owned_lecture(ctx, lecture_id)
        if not rec:
            yield {"type": "error", "message": "지정한 강의를 찾을 수 없습니다."}
            return
        lecture_scope = {"lectureId": lecture_id, "title": rec.get("title")}
    history_all = store.list_messages(payload.sessionId, limit=64)
    history, dropped = select_history(history_all)
    summary = session.get("summary") or (memory.session_summary(payload.sub, payload.sessionId) if dropped else None)
    facts = [] if source_type == "lecture" else memory.user_facts(payload.sub, payload.message)
    prompt = build_turn_prompt(question=payload.message, history=history, summary=summary, facts=facts, meeting_scope=scope,
                               lecture_scope=lecture_scope, source_type=source_type, language=payload.language)

    store.append_message(payload.sessionId, "user", payload.message)
    options = build_options(ctx, workdir)
    text_parts: list[str] = []
    steps: list[dict[str, Any]] = []
    tool_names: dict[str, str] = {}
    result: ResultMessage | None = None
    streamed_text = False

    async for msg in query(prompt=prompt, options=options):
        if isinstance(msg, StreamEvent):
            ev = _delta_event(msg.event)
            if ev and msg.parent_tool_use_id is None:
                if ev["type"] == "text":
                    text_parts.append(ev["delta"])
                    streamed_text = True
                yield ev
        elif isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, ToolUseBlock):
                    tool_names[block.id] = block.name
                    title = tool_title(block.name, block.input if isinstance(block.input, dict) else {})
                    steps.append({"id": block.id, "name": block.name, "title": title, "input": block.input})
                    yield {"type": "tool_use", "id": block.id, "name": block.name, "title": title}
                elif not streamed_text and getattr(block, "text", None):
                    # partial streaming disabled or unavailable: emit the whole block once
                    text_parts.append(block.text)
                    yield {"type": "text", "delta": block.text}
        elif isinstance(msg, UserMessage) and isinstance(msg.content, list):
            for block in msg.content:
                if isinstance(block, ToolResultBlock):
                    name = tool_names.get(block.tool_use_id, "tool")
                    new_items = list(ctx.new_evidence)
                    ctx.new_evidence.clear()
                    summary_text = f"근거 {len(new_items)}건" if new_items else ("오류" if block.is_error else ("선택지 준비" if name.endswith("ask_user") else "완료"))
                    for s in steps:
                        if s["id"] == block.tool_use_id:
                            s["result"] = summary_text
                    yield {"type": "tool_result", "id": block.tool_use_id, "name": name, "summary": summary_text, "isError": bool(block.is_error)}
                    if new_items:
                        yield {"type": "evidence", "items": new_items}
        elif isinstance(msg, ResultMessage):
            result = msg

    answer = "".join(text_parts).strip() or (result.result if result and result.result else "")
    if result and result.is_error and not answer:
        yield {"type": "error", "message": f"모델 오류: {result.subtype}"}
        return
    options: list[str] = []
    if ctx.clarify:
        options = list(ctx.clarify.get("options") or [])
        if not answer:
            answer = str(ctx.clarify.get("question") or "")
            yield {"type": "text", "delta": answer}
        yield {"type": "clarify", "question": ctx.clarify.get("question"), "options": options}
    usage = {"costUsd": getattr(result, "total_cost_usd", None), "turns": getattr(result, "num_turns", None), "durationSec": round(time.time() - t0, 1)}
    seq = store.append_message(payload.sessionId, "assistant", answer, evidence=ctx.evidence, steps=[{k: v for k, v in s.items() if k != "input"} for s in steps], usage=usage, options=options)
    fields: dict[str, Any] = {"lastMessagePreview": preview(answer)}
    if not session.get("title"):
        fields["title"] = payload.message.strip()[:40]
    store.update_session(payload.sessionId, fields)
    memory.record_turn(payload.sub, payload.sessionId, payload.message, answer)
    yield {"type": "done", "messageSeq": seq, "usage": usage, "evidenceCount": len(ctx.evidence)}
