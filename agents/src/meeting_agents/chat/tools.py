"""In-process MCP tools for the chat agent. Every tool checks ownership and appends structured evidence to the turn."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key
from claude_agent_sdk import ToolAnnotations, create_sdk_mcp_server, tool

from . import gateway, memory
from .config import DATA_BUCKET, LECTURE_TABLE_NAME, MAX_RESULTS, REGION, TABLE_NAME, WEB_ORIGIN
from .evidence import display_snippet, diversify, format_for_model, locate_lecture_pages, to_evidence
from ..keys import attributed_transcript
from ..transcript import identity_review_lines

log = logging.getLogger("chat.tools")

TOOL_NAMES = [
    "mcp__meeting__search_meetings",
    "mcp__meeting__get_meeting",
    "mcp__meeting__list_meetings",
    "mcp__meeting__get_transcript_window",
    "mcp__meeting__list_lectures",
    "mcp__meeting__get_lecture",
    "mcp__meeting__memory_facts",
    "mcp__meeting__ask_user",
]


@dataclass
class TurnContext:
    sub: str
    meeting_id: str | None = None
    lecture_id: str | None = None
    source_type: str = "all"
    evidence: list[dict[str, Any]] = field(default_factory=list)
    new_evidence: list[dict[str, Any]] = field(default_factory=list)  # drained by the streamer after each tool call
    clarify: dict[str, Any] | None = None  # set by ask_user: the turn ends with a question and tappable options
    documents: dict[str, dict[str, Any]] = field(default_factory=dict)  # lecture documents read this turn (page lookup for evidence)

    def add(self, items: list[dict[str, Any]]) -> None:
        self.evidence.extend(items)
        self.new_evidence.extend(items)


def _text(payload: Any) -> dict:
    return {"content": [{"type": "text", "text": payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)}],
            **({"is_error": True} if isinstance(payload, dict) and payload.get("error") else {})}


def _ddb():
    return boto3.resource("dynamodb", region_name=REGION).Table(TABLE_NAME)


def _s3():
    return boto3.client("s3", region_name=REGION, config=Config(retries={"mode": "standard", "max_attempts": 5}))


def _owned_meeting(ctx: TurnContext, meeting_id: str) -> dict | None:
    if ctx.source_type == "lecture" or ctx.lecture_id or (ctx.meeting_id and ctx.meeting_id != meeting_id):
        return None
    rec = _ddb().get_item(Key={"PK": f"MEETING#{meeting_id}", "SK": "META"}).get("Item")
    if not rec or rec.get("owner") != ctx.sub:
        return None
    return rec


def _completed_meetings(sub: str, limit: int = 4) -> list[dict]:
    res = _ddb().query(IndexName="GSI1", KeyConditionExpression=Key("GSI1PK").eq(f"USER#{sub}"), ScanIndexForward=False, Limit=25)
    done = [m for m in res.get("Items", []) if m.get("SK") == "META" and m.get("status") == "COMPLETED"]
    return [{"meetingId": m.get("meetingId"), "title": m.get("title"), "date": (m.get("createdAt") or "")[:10]} for m in done[:limit]]


def _lectures():
    return boto3.resource("dynamodb", region_name=REGION).Table(LECTURE_TABLE_NAME)


def _owned_lecture(ctx: TurnContext, lecture_id: str) -> dict | None:
    if ctx.source_type == "meeting" or ctx.meeting_id or (ctx.lecture_id and ctx.lecture_id != lecture_id):
        return None
    rec = _lectures().get_item(Key={"PK": f"MEETING#{lecture_id}", "SK": "META"}).get("Item")
    if not rec or rec.get("owner") != ctx.sub:
        return None
    return rec


def _lecture_row(m: dict) -> dict:
    return {"lectureId": m.get("lectureId"), "title": m.get("title"), "course": m.get("course") or "", "date": (m.get("createdAt") or "")[:10], "pageCount": int(m.get("pageCount") or 0), "durationMin": round(float(m.get("durationSec") or 0) / 60)}


def _completed_lectures(sub: str, limit: int = 4) -> list[dict]:
    res = _lectures().query(IndexName="GSI1", KeyConditionExpression=Key("GSI1PK").eq(f"USER#{sub}"), ScanIndexForward=False, Limit=25)
    done = [m for m in res.get("Items", []) if m.get("SK") == "META" and m.get("status") == "COMPLETED"]
    return [_lecture_row(m) for m in done[:limit]]


def _lecture_document(ctx: TurnContext, lecture_id: str) -> dict | None:
    """The owner's published study document, read at most once per turn."""
    if lecture_id not in ctx.documents:
        rec = _owned_lecture(ctx, lecture_id)
        ctx.documents[lecture_id] = (_read_json(rec["documentKey"]) if rec and rec.get("documentKey") else None) or {}
    return ctx.documents[lecture_id]


def compact_lecture(doc: dict, lecture_id: str, page: int | None = None, source_page: int | None = None) -> dict:
    """Outline of a lecture study document, or one section in full (its summaries, math notes, questions and cards)."""
    pages = doc.get("pages", [])
    if page is None and source_page is None:
        audience = doc.get("audience") or {}
        return {
            "lectureId": lecture_id, "title": doc.get("title"), "course": doc.get("course"), "audienceLevel": audience.get("level"),
            "overview": (doc.get("overview") or "")[:1500], "learningObjectives": doc.get("learningObjectives", [])[:10], "reviewPlan": doc.get("reviewPlan", [])[:10],
            "selectedPages": doc.get("selectedPages"), "grouped": doc.get("grouped", False),
            "pages": [{"page": p.get("page"), "sourcePages": p.get("sourcePages"), "title": p.get("title"), "startSec": (p.get("videoRanges") or [{}])[0].get("startSec")} for p in pages],
        }
    def contains_source(p, number):
        return number in p.get("sourcePages", [p.get("deckPage", p.get("page"))]) if p.get("source") not in ("audio", "video") else False
    if source_page is not None:
        match = next((p for p in pages if contains_source(p, source_page)), None)
        if match and page is not None and match.get("page") != page:
            return {"error": "page and sourcePage refer to different learning groups"}
    else:
        match = next((p for p in pages if p.get("page") == page), None)
        # Older prompts sometimes pass a physical slide number as page. Resolve
        # it only from the document's explicit mapping, never by position.
        if not match and doc.get("grouped"):
            match = next((p for p in pages if contains_source(p, page)), None)
    if not match:
        return {"error": "page not found in this lecture's selected scope",
                "pages": [{"page": p.get("page"), "sourcePages": p.get("sourcePages")} for p in pages]}
    return {"lectureId": lecture_id, "title": doc.get("title"), "page": {
        "page": match.get("page"), "sourcePages": match.get("sourcePages"), "title": match.get("title"), "startSec": (match.get("videoRanges") or [{}])[0].get("startSec"),
        "slideSummary": match.get("slideSummary"), "spokenSummary": match.get("spokenSummary"), "explanation": (match.get("explanation") or "")[:2000],
        "concepts": match.get("concepts", []),
        "mathNotes": [{k: n.get(k) for k in ("kind", "name", "statement", "steps", "intuition", "supplementary", "symbols", "assumptions", "sourceCheck")} for n in match.get("mathNotes", [])],
        "reviewQuestions": match.get("reviewQuestions", []), "flashcards": match.get("flashcards", []),
    }}


def _read_json(key: str, *, strict: bool = False) -> dict | None:
    try:
        body = _s3().get_object(Bucket=DATA_BUCKET, Key=key)["Body"].read()
        return json.loads(body)
    except Exception as exc:  # noqa: BLE001
        missing = isinstance(exc, ClientError) and exc.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound")
        if strict and not missing:
            raise
        log.info("read %s failed: %s", key, exc)
        return None


def _meeting_transcript(rec: dict) -> dict | None:
    """Call only after ownership is checked. Match the API's completed-output selection."""
    data = None
    if (rec.get("stages", {}).get("speaker_attribution") or {}).get("status") == "COMPLETED":
        data = _read_json(attributed_transcript(rec["meetingId"]), strict=True)
    if data is None:
        data = _read_json(rec["transcriptKey"], strict=True)
    if data and data.get("meetingId") and data["meetingId"] != rec["meetingId"]:
        raise ValueError("transcript belongs to a different meeting")
    return data


def compact_document(doc: dict, meeting_id: str) -> dict:
    """The parts of a final document a chat answer needs, with stable ids for citations."""
    return {
        "meetingId": meeting_id,
        "title": doc.get("title"),
        "date": (doc.get("generatedAt") or "")[:10],
        "meetingType": doc.get("meetingType"),
        "speakers": [{"id": s.get("id"), "label": s.get("label"), "role": s.get("role"), "reviewRequired": s.get("reviewRequired", False)} for s in doc.get("speakers", [])],
        "headline": (doc.get("summary") or {}).get("headline"),
        "overview": (doc.get("summary") or {}).get("overview"),
        "keyDecisions": (doc.get("summary") or {}).get("keyDecisions", []),
        "risksAndIssues": (doc.get("summary") or {}).get("risksAndIssues", []),
        "agenda": [{"id": a.get("id"), "title": a.get("title"), "decisions": a.get("decisions", []), "openQuestions": a.get("openQuestions", []), "discussionPoints": a.get("discussionPoints", [])[:6]} for a in doc.get("agenda", [])],
        "followUps": [{"id": f.get("id"), "title": f.get("title"), "owner": f.get("ownerName"), "due": f.get("dueHint"), "priority": f.get("priority")} for f in doc.get("followUps", [])],
        "suggestions": [{"id": s.get("id"), "target": (s.get("target") or {}).get("title"), "suggestion": (s.get("suggestion") or "")[:400]} for s in doc.get("suggestions", [])[:6]],
        "brief": compact_brief(doc.get("brief")),
    }


def compact_brief(brief: dict | None) -> dict | None:
    """The at-a-glance recap when the meeting has one; unsupported decision reasons are never passed on."""
    if not brief:
        return None
    return {
        "headline": brief.get("headline"),
        "decisions": [{"decision": d.get("decision"), "rationaleStatus": d.get("rationaleStatus"), "process": d.get("process") if d.get("rationaleStatus") == "supported" else ""} for d in brief.get("decisions", [])],
        "followUpIds": brief.get("followUpIds", []),
        "openQuestions": [q.get("question") for q in brief.get("openQuestions", [])],
    }


def _speaker_namer(doc: dict | None):
    """Honor edited display names while keeping the speaker ID from the selected transcript."""
    labels = {sp.get("id"): sp.get("label") or sp.get("id") for sp in (doc or {}).get("speakers", [])}

    def name(seg: dict) -> str:
        sid = seg.get("speaker")
        return str(labels.get(sid) or seg.get("speakerLabel") or sid)

    return name


def _transcript_lines(data: dict, segs: list[dict], doc: dict | None) -> list[str]:
    # Use the selected file's IDs, including the original when a corrected file is
    # unavailable. Replaying stage proposals here can disagree with the UI.
    name = _speaker_namer(doc)
    review = data.get("speakerAttribution")
    corrections = {c["id"]: c for c in (review or {}).get("corrections", [])}
    confirmed_names = {s["id"] for s in (doc or {}).get("speakers", []) if s.get("nameConfirmedByUser")}
    lines = []
    for seg in segs:
        pending = bool(seg.get("speakerReviewRequired"))
        if review:
            pending = any(c.get("status") == "review_required" and not (c.get("kind") == "label" and c.get("to") in confirmed_names)
                          for cid in seg.get("speakerCorrectionIds", []) if (c := corrections.get(cid)))
        marker = " [speaker review required]" if pending else ""
        lines.append(f"[{int(seg['start']) // 60:02d}:{int(seg['start']) % 60:02d}] {name(seg)}{marker}: {seg.get('text')}")
    return lines


def _window_speakers(data: dict, segs: list[dict], doc: dict | None) -> list[dict]:
    registry = {s["id"]: s for s in data.get("speakers", [])}
    for speaker in (doc or {}).get("speakers", []):
        registry[speaker["id"]] = {**registry.get(speaker["id"], {}), **speaker}
    out = []
    for sid in dict.fromkeys(s["speaker"] for s in segs):
        speaker = registry.get(sid, {})
        pending = bool(speaker.get("reviewRequired") and not speaker.get("nameConfirmedByUser"))
        out.append({"id": sid, "label": speaker.get("label") or sid, "reviewRequired": pending,
                    **({"proposedLabel": speaker["proposedLabel"]} if pending and speaker.get("proposedLabel") else {})})
    return out


def scoped_results(ctx: TurnContext, results: list[dict]) -> list[dict]:
    """Defense in depth: enforce the fixed session scope and discard superseded lecture runs."""
    allowed = []
    for result in results:
        meta = result.get("metadata") or {}
        if meta.get("owner") != ctx.sub:
            continue
        uri = ((result.get("location") or {}).get("s3Location") or {}).get("uri") or meta.get("x-amz-bedrock-kb-source-uri") or ""
        lecture = meta.get("kind") == "lecture" or "/lecture-results/" in uri
        if lecture:
            lid = meta.get("lectureId")
            if not lid:
                continue
            rec = _owned_lecture(ctx, lid)
            if not rec or not rec.get("documentKey"):
                continue
            key = rec.get("markdownKey") or rec["documentKey"].removesuffix("document.json") + "study.md"
            if not uri.endswith("/" + key):
                continue
        elif ctx.source_type == "lecture" or ctx.lecture_id or (ctx.meeting_id and meta.get("meetingId") != ctx.meeting_id):
            continue
        allowed.append(result)
    return allowed


def scoped_list(ctx, kind, limit=20):
    if kind == "lecture":
        if ctx.source_type == "meeting" or ctx.meeting_id:
            return []
        if ctx.lecture_id:
            rec = _owned_lecture(ctx, ctx.lecture_id)
            return [_lecture_row(rec)] if rec and rec.get("status") == "COMPLETED" else []
        return _completed_lectures(ctx.sub, limit)
    if ctx.source_type == "lecture" or ctx.lecture_id:
        return []
    if ctx.meeting_id:
        rec = _owned_meeting(ctx, ctx.meeting_id)
        return [{"meetingId": rec["meetingId"], "title": rec.get("title"), "date": (rec.get("createdAt") or "")[:10]}] if rec else []
    return _completed_meetings(ctx.sub, limit)


LECTURE_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "lectureId": {"type": "string", "minLength": 1, "maxLength": 128,
                      "description": "The lecture ID. Omit only when this conversation is pinned to one lecture."},
        "page": {"type": ["integer", "null"], "minimum": 0, "maximum": 360,
                 "description": "Learning-group ID from the outline. Omit or use 0 for the outline."},
        "sourcePage": {"type": ["integer", "null"], "minimum": 1, "maximum": 120,
                       "description": "Physical slide number, e.g. 45. Returns the complete selected learning group containing it."},
    },
    "required": [],
    "additionalProperties": False,
}


def build_server(ctx: TurnContext):
    @tool("search_meetings", "Hybrid search over this user's meeting documents, transcripts and lecture study notes (managed knowledge base). Returns passages labeled [E#] that you must cite. Use a focused query; optionally restrict to one meetingId.", {"query": str, "meetingId": str})
    async def search_meetings(args: dict) -> dict:
        meeting_id = ctx.meeting_id or (args.get("meetingId") if ctx.source_type != "lecture" and not ctx.lecture_id else None)
        # Ask for more than we show, then cap chunks per document: a single long meeting used to fill all 8 slots.
        results = gateway.retrieve(str(args["query"]), sub=ctx.sub, meeting_id=meeting_id or None, k=MAX_RESULTS + 4,
                                   source_type=ctx.source_type, lecture_id=ctx.lecture_id)
        results = scoped_results(ctx, results)
        items = to_evidence(diversify(results, per_document=3 if not meeting_id else MAX_RESULTS, limit=MAX_RESULTS), web_origin=WEB_ORIGIN, start_index=len(ctx.evidence))
        locate_lecture_pages(items, lambda lid: _lecture_document(ctx, lid))
        ctx.add(items)
        return _text(format_for_model(items))

    @tool("get_meeting", "Structured summary of one meeting the user owns: headline, agenda with decisions and open questions, follow-ups with owners, speakers, suggestions, and the at-a-glance brief (core outcome, decision rationale) when present. Adds one evidence entry [E#] for the document.", {"meetingId": str})
    async def get_meeting(args: dict) -> dict:
        mid = str(args["meetingId"])
        rec = _owned_meeting(ctx, mid)
        if not rec:
            return _text({"error": "meeting not found"})
        if not rec.get("notesKey"):
            return _text({"error": "analysis not finished", "status": rec.get("status")})
        doc = _read_json(rec["notesKey"])
        if not doc:
            return _text({"error": "document unavailable"})
        compact = compact_document(doc, mid)
        label = f"E{len(ctx.evidence) + 1}"
        ctx.add([{"id": label, "source": "document", "kind": "document", "meetingId": mid, "title": compact["title"], "date": compact["date"], "meetingType": compact["meetingType"], "snippet": compact.get("headline") or "", "score": None, "startSec": None, "segmentIds": [], "url": f"{WEB_ORIGIN}/meetings/{mid}"}])
        return _text({"evidenceLabel": label, **compact})

    @tool("list_meetings", "List this user's meetings (newest first): meetingId, title, date, type, status. Use it when the user refers to a meeting without naming it.", {"limit": int})
    async def list_meetings(args: dict) -> dict:
        limit = max(1, min(int(args.get("limit") or 20), 50))
        items = scoped_list(ctx, "meeting", limit)
        return _text({"meetings": items})

    @tool("get_transcript_window", "Verbatim transcript lines (speaker, time, text) of one meeting between startSec and endSec (max 10 minutes). Adds an evidence entry [E#].", {"meetingId": str, "startSec": int, "endSec": int})
    async def get_transcript_window(args: dict) -> dict:
        mid = str(args["meetingId"])
        rec = _owned_meeting(ctx, mid)
        if not rec or not rec.get("transcriptKey"):
            return _text({"error": "transcript not found"})
        start, end = max(0, int(args["startSec"])), int(args["endSec"])
        end = min(end, start + 600)
        data = _meeting_transcript(rec)
        if not data:
            return _text({"error": "transcript unavailable"})
        doc = _read_json(rec["notesKey"]) if rec.get("notesKey") else None
        segs = [s for s in data.get("segments", []) if s.get("end", 0) >= start and s.get("start", 0) <= end]
        lines = _transcript_lines(data, segs[:200], doc)
        speakers = _window_speakers(data, segs[:200], doc)
        name_reviews = identity_review_lines(speakers)
        label = f"E{len(ctx.evidence) + 1}"
        ctx.add([{"id": label, "source": "transcript", "kind": "transcript", "meetingId": mid, "title": rec.get("title"), "date": (rec.get("createdAt") or "")[:10], "meetingType": None, "snippet": display_snippet(" ".join(name_reviews + lines))[:420], "score": None, "startSec": start, "segmentIds": [s.get("id") for s in segs[:5] if s.get("id")], "url": f"{WEB_ORIGIN}/meetings/{mid}?t={start}"}])
        return _text({"evidenceLabel": label, "lines": lines, "speakers": speakers})

    @tool("list_lectures", "List this user's analyzed lectures (newest first): lectureId, title, course, date, pageCount. Use it when the user refers to a lecture or class without naming it.", {"limit": int})
    async def list_lectures(args: dict) -> dict:
        limit = max(1, min(int(args.get("limit") or 20), 50))
        return _text({"lectures": scoped_list(ctx, "lecture", limit)})

    @tool("get_lecture", "Read the current published lecture. Omit page/sourcePage for its outline. Use page for a learning-group ID, or sourcePage for a physical slide number such as 45; the latter returns the entire group containing that slide. Omit lectureId in a pinned lecture conversation. Returns summaries, explanation, math notes, source corrections and questions with evidence [E#].",
          LECTURE_INPUT_SCHEMA, annotations=ToolAnnotations(readOnlyHint=True, maxResultSizeChars=80_000))
    async def get_lecture(args: dict) -> dict:
        lid = args.get("lectureId") or ctx.lecture_id
        if not isinstance(lid, str) or not lid:
            return _text({"error": "lectureId required", "instruction": "Choose one of the user's lectures using list_lectures."})
        rec = _owned_lecture(ctx, lid)
        if not rec:
            return _text({"error": "lecture not found"})
        if rec.get("status") != "COMPLETED" or not rec.get("documentKey"):
            return _text({"error": "analysis not finished", "status": rec.get("status")})
        doc = _read_json(rec["documentKey"])
        if not doc:
            return _text({"error": "document unavailable"})
        page, source_page = args.get("page"), args.get("sourcePage")
        if page is not None and (type(page) is not int or not 0 <= page <= 360):
            return _text({"error": "page must be a learning-group integer or omitted"})
        if source_page is not None and (type(source_page) is not int or not 1 <= source_page <= 120):
            return _text({"error": "sourcePage must be a physical slide integer or omitted"})
        compact = compact_lecture(doc, lid, page or None, source_page)
        if "error" in compact:
            return _text(compact)
        page = compact["page"]["page"] if "page" in compact else None
        label = f"E{len(ctx.evidence) + 1}"
        snippet = (compact["page"]["slideSummary"] if page else compact["overview"]) or ""
        ctx.add([{"id": label, "source": "document", "kind": "lecture", "meetingId": None, "lectureId": lid, "page": page, "title": doc.get("title"), "date": (rec.get("createdAt") or "")[:10], "meetingType": None, "snippet": snippet[:420], "score": None, "startSec": None, "segmentIds": [], "url": f"{WEB_ORIGIN}/lectures/{lid}" + (f"?page={page}" if page else "")}])
        return _text({"evidenceLabel": label, **compact})

    @tool("memory_facts", "Long-term facts remembered about this user's past meetings (people, roles, projects, decisions). Use for context, not as the only evidence.", {"query": str})
    async def memory_facts(args: dict) -> dict:
        if ctx.source_type == "lecture" or ctx.lecture_id:
            return _text({"facts": []})
        return _text({"facts": memory.user_facts(ctx.sub, str(args["query"]))})

    @tool("ask_user", "Ask the user a clarifying question when their request is too broad or ambiguous to answer well. kind: 'meeting' when the user must pick a meeting, 'lecture' when they must pick a lecture (options are then filled from their real list, ignore yours), otherwise 'topic' or 'period' with 2 to 4 short options of your own. After calling this, reply with only the returned question and options, then stop.", {"question": str, "kind": str, "options": list})
    async def ask_user(args: dict) -> dict:
        question = str(args.get("question") or "").strip()
        kind = str(args.get("kind") or "topic")
        if not question:
            return _text({"error": "question required"})
        if kind == "meeting":
            # Never let the model invent meeting names: choices come from the user's finished meetings, newest first.
            options = [f"{m['title']} ({m['date']})" for m in scoped_list(ctx, "meeting", 4)]
            if not options:
                return _text({"error": "no finished meetings", "instruction": "Tell the user no analyzed meeting exists yet."})
        elif kind == "lecture":
            options = [f"{m['title']} ({m['date']})" for m in scoped_list(ctx, "lecture", 4)]
            if not options:
                return _text({"error": "no finished lectures", "instruction": "Tell the user no analyzed lecture exists yet."})
        else:
            options = [str(o).strip() for o in (args.get("options") or []) if str(o).strip()][:4]
        ctx.clarify = {"question": question, "options": options}
        return _text({"ok": True, "instruction": "Reply with only this question in one or two friendly sentences, naming only these options, and stop.", "question": question, "options": options})

    return create_sdk_mcp_server(name="meeting", version="1.0.0", tools=[search_meetings, get_meeting, list_meetings, get_transcript_window, list_lectures, get_lecture, memory_facts, ask_user])
