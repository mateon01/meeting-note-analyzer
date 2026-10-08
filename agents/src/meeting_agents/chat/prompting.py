"""Prompt assembly for one chat turn: session summary + recent turns within a character budget + facts + question."""
from __future__ import annotations

from typing import Any

from .config import CONTEXT_BUDGET_CHARS, HISTORY_TURNS


def select_history(messages: list[dict[str, Any]], budget_chars: int = CONTEXT_BUDGET_CHARS, max_turns: int = HISTORY_TURNS) -> tuple[list[dict[str, Any]], int]:
    """Newest messages that fit the budget (at most max_turns user/assistant pairs). Returns (kept, dropped_count)."""
    kept: list[dict[str, Any]] = []
    used = 0
    for m in reversed(messages):
        size = len(m.get("text") or "") + 20
        if used + size > budget_chars or len(kept) >= max_turns * 2:
            break
        kept.append(m)
        used += size
    kept.reverse()
    return kept, len(messages) - len(kept)


def build_turn_prompt(*, question: str, history: list[dict[str, Any]], summary: str | None, facts: list[str], meeting_scope: dict[str, Any] | None, language: str, lecture_scope=None, source_type="all") -> str:
    lines = ["# 사용자 질문에 답하라", ""]
    if meeting_scope:
        lines += ["## 검색 범위", f"이 대화는 회의 \"{meeting_scope.get('title')}\" (meetingId {meeting_scope.get('meetingId')})에 고정되어 있다. search_meetings는 이 회의로 제한된다.", ""]
    elif lecture_scope:
        lines += ["## 검색 범위", f"이 대화는 강의 \"{lecture_scope.get('title')}\" (lectureId {lecture_scope.get('lectureId')})에 고정되어 있다. "
                  "먼저 get_lecture로 현재 목차를 열고 필요한 학습 묶음을 읽어라. 그룹의 page는 학습 묶음 번호이고 sourcePages가 원본 장표 번호다. "
                  "자료에 없는 페이지를 분석했다고 말하지 말라. 회의 자료는 사용하지 말라.", ""]
    elif source_type != "all":
        lines += ["## 검색 범위", "이 대화는 강의 자료만 사용한다. list_lectures/get_lecture로 현재 강의 자료도 직접 확인하라."
                  if source_type == "lecture" else "이 대화는 회의록과 회의 전사만 사용한다. 강의 자료는 사용하지 말라.", ""]
    lines += ["## 이전 대화 요약", summary or "없음", ""]
    if history:
        lines += ["## 최근 대화"]
        for m in history:
            role = "사용자" if m.get("role") == "user" else "비서"
            lines.append(f"{role}: {m.get('text', '')}")
        lines.append("")
    if facts:
        lines += ["## 이 사용자에 대한 장기 기억 (참고용, 근거로 인용하지 말 것)", *[f"- {f}" for f in facts], ""]
    lang = {"ko": "한국어", "en": "English"}.get(language, language)
    lines += ["## 현재 질문", question, "", f"답변 언어: {lang}. 근거 표기 규칙과 문체 규칙을 지켜라."]
    return "\n".join(lines)
