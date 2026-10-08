"""Turn knowledge-base results into numbered evidence cards ([E1], [E2], ...) shared by the model and the UI."""
from __future__ import annotations

import re
from typing import Any

_TS = re.compile(r"\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]")
_SEG = re.compile(r"\((seg-\d+)\)")
_URI = re.compile(r"s3://[^/]+/(results|transcripts|lecture-results)/([^/]+)/([^?#]+)")
_PAGE = re.compile(r"^## (\d{1,3})\. ", re.M)  # study.md section heading: "## 5. 체(Field)의 정의"


def _start_sec(text: str) -> int | None:
    m = _TS.search(text)
    if not m:
        return None
    h_or_m, m2, s = m.group(1), m.group(2), m.group(3)
    if s is None:
        return int(h_or_m) * 60 + int(m2)
    return int(h_or_m) * 3600 + int(m2) * 60 + int(s)


_REVIEW_MARKER = "[speaker review required]"


def display_snippet(text: str) -> str:
    """Evidence text is shown to the user as well as the model: the transcript's review marker reads as Korean."""
    return text.replace(_REVIEW_MARKER, "(화자 검토 필요)").replace("[speaker name review required]", "(이름 검토 필요)")


def _snippet(text: str, limit: int = 420) -> str:
    text = re.sub(r"\s+", " ", display_snippet(text)).strip()
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


def to_evidence(results: list[dict[str, Any]], *, web_origin: str, start_index: int, source_label: str = "kb") -> list[dict[str, Any]]:
    """Deduplicated evidence items numbered from start_index+1. Unknown meetings (no metadata) are kept without a link."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in results:
        text = (r.get("content") or {}).get("text") or ""
        if not text.strip():
            continue
        meta = r.get("metadata") or {}
        uri = ((r.get("location") or {}).get("s3Location") or {}).get("uri") or meta.get("x-amz-bedrock-kb-source-uri") or ""
        m = _URI.search(uri)
        lecture = meta.get("kind") == "lecture" or (m is not None and m.group(1) == "lecture-results")
        meeting_id = lecture_id = page = None
        if lecture:
            kind = "lecture"
            lecture_id = meta.get("lectureId") or (m.group(2) if m else None)
            pm = _PAGE.search(text)
            page = int(pm.group(1)) if pm else None
        else:
            meeting_id = meta.get("meetingId") or (m.group(2) if m else None)
            kind = "transcript" if (m and m.group(1) == "transcripts") else "document"
        key = f"{meeting_id or lecture_id}:{kind}:{text[:80]}"
        if key in seen:
            continue
        seen.add(key)
        start = _start_sec(text) if kind == "transcript" else None
        if lecture:
            url = (f"{web_origin}/lectures/{lecture_id}" + (f"?page={page}" if page else "")) if lecture_id else None
        else:
            url = (f"{web_origin}/meetings/{meeting_id}" + (f"?t={start}" if start is not None else "")) if meeting_id else None
        item = {
            "id": f"E{start_index + len(out) + 1}",
            "source": source_label,
            "kind": kind,
            "meetingId": meeting_id,
            "lectureId": lecture_id,
            "page": page,
            "title": meta.get("title") or "제목 없음",
            "date": meta.get("date"),
            "meetingType": meta.get("meetingType"),
            "snippet": _snippet(text),
            "score": round(float(r["score"]), 3) if isinstance(r.get("score"), (int, float)) else None,
            "startSec": start,
            "segmentIds": _SEG.findall(text)[:5],
            "url": url,
        }
        out.append(item)
    return out


def diversify(results: list[dict[str, Any]], *, per_document: int = 3, limit: int = 8) -> list[dict[str, Any]]:
    """Keep result order (relevance) but cap chunks per source document so one long meeting cannot fill every slot.
    Overflow chunks are appended only if fewer than `limit` remain after the cap."""
    kept: list[dict[str, Any]] = []
    overflow: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    for r in results:
        uri = ((r.get("location") or {}).get("s3Location") or {}).get("uri") or ""
        meta = r.get("metadata") or {}
        m = _URI.search(uri)
        doc = f"{meta.get('meetingId') or meta.get('lectureId') or (m.group(2) if m else uri)}:{m.group(1) if m else 'doc'}"
        if counts.get(doc, 0) < per_document:
            counts[doc] = counts.get(doc, 0) + 1
            kept.append(r)
        else:
            overflow.append(r)
    return (kept + overflow)[:limit]


def format_for_model(items: list[dict[str, Any]]) -> str:
    """Compact text the model reads; it must cite these labels verbatim."""
    if not items:
        return "검색 결과 없음"
    lines = []
    for e in items:
        where = "전사" if e["kind"] == "transcript" else ("강의" + (f" 학습 항목 {e['page']}" if e.get("page") else "")) if e["kind"] == "lecture" else "회의록"
        when = f" {e['date']}" if e.get("date") else ""
        at = f" {e['startSec'] // 60:02d}:{e['startSec'] % 60:02d}" if e.get("startSec") is not None else ""
        lines.append(f"[{e['id']}] {e['title']}{when} | {where}{at}\n{e['snippet']}")
    return "\n\n".join(lines)


_MARKUP = re.compile(r"[#*`>_:()\[\]-]+")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", _MARKUP.sub(" ", text)).strip().lower()


def _page_texts(page: dict[str, Any]) -> list[str]:
    parts = [page.get("title"), page.get("slideSummary"), page.get("spokenSummary"), page.get("explanation")]
    parts += [c.get("term") for c in page.get("concepts", [])] + [c.get("explanation") for c in page.get("concepts", [])]
    parts += [q.get("question") for q in page.get("reviewQuestions", [])] + [q.get("answer") for q in page.get("reviewQuestions", [])]
    parts += [f.get("front") for f in page.get("flashcards", [])] + [f.get("back") for f in page.get("flashcards", [])]
    for n in page.get("mathNotes", []):
        parts += [n.get("name"), n.get("statement"), n.get("intuition"), *n.get("steps", [])]
    parts += [e.get("text") for e in page.get("evidence", [])]
    return [str(x) for x in parts if x]


def _page_for_snippet(doc: dict[str, Any], snippet: str) -> int | None:
    text = _norm(snippet.removesuffix("..."))
    probes = [text[i:i + 40] for i in (0, 60, 120, 180) if len(text) >= i + 24]
    for page in doc.get("pages", []):
        blob = _norm(" ".join(_page_texts(page)))
        if any(probe in blob for probe in probes):
            return int(page.get("page"))
    return None


def locate_lecture_pages(items: list[dict[str, Any]], load_document) -> None:
    """A study.md chunk often starts below its "## N. title" heading, so the page is recovered by matching the
    snippet against the lecture's own pages; each lecture document is loaded once per call."""
    docs: dict[str, dict[str, Any]] = {}
    for item in items:
        if item.get("kind") != "lecture" or item.get("page") or not item.get("lectureId"):
            continue
        lecture_id = item["lectureId"]
        if lecture_id not in docs:
            docs[lecture_id] = load_document(lecture_id) or {}
        page = _page_for_snippet(docs[lecture_id], item.get("snippet") or "")
        if page:
            item["page"] = page
            item["url"] = f"{item['url'].split('?')[0]}?page={page}" if item.get("url") else item.get("url")
