"""Readable interview Markdown; generated assessment stays separate from recorded notes."""
import re
from .interview_criteria import LABELS
RATINGS = {1: "Concern", 2: "Mild Concern", 3: "Mixed", 4: "Mild Strength", 5: "Strength"}


def escape(text):
    return re.sub(r"([\\`*_\[\]#])", r"\\\1", str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def time(seconds):
    n = max(0, int(seconds))
    return f"{n // 3600:02}:{n // 60 % 60:02}:{n % 60:02}"


def markdown(document):
    settings = document["settings"]
    lines = [f"# {escape(document['title'])}", "",
             f"- Target level: {settings['targetLevel']}", f"- Role: {escape(settings['roleTitle'])}",
             f"- Criteria: {', '.join(LABELS[c] for c in settings['criteria'])}",
             f"- Duration: {time(document['durationSec'])}", "", "## 인터뷰 노트", ""]
    topic = None
    for exchange in document["exchanges"]:
        if topic != exchange["topic"]:
            topic = exchange["topic"]
            lines.extend([f"### {escape(topic)}", ""])
        prefix = "f/u Q" if exchange["questionKind"] == "follow_up" else "정정 Q" if exchange["questionKind"] == "clarification" else "Q"
        who = " (면접관)" if exchange.get("interviewerId") else ""
        timestamp = time(exchange["evidence"][0]["start"]) if exchange["evidence"] else ""
        lines.extend([f"**{prefix}{who} [{exchange['id']}, {timestamp}]: {escape(exchange['question'])}**", ""])
        if exchange.get("resumeClaimIds"):
            lines.extend(["이력서 관련 주장 (면접 발언과 별도): " + ", ".join(exchange["resumeClaimIds"]), ""])
        source = {e["segmentId"]: e for e in exchange["evidence"]}
        for point in exchange["answer"]:
            at = ", ".join(time(source[sid]["start"]) for sid in point["segmentIds"] if sid in source)
            lines.append(f"- {escape(point['text'])} ({at})")
        if not exchange["answer"]:
            lines.append("- 기록에서 후보자의 답변을 확인하지 못했습니다.")
        if exchange["interviewerContext"]:
            lines.extend(["", "**면접관의 힌트·정정·재질문**"])
            lines.extend(f"- {escape(point['text'])}" for point in exchange["interviewerContext"])
        lines.append("")
    if settings.get("interviewerNotes"):
        lines.extend(["## 면접관이 별도로 입력한 메모", "", escape(settings["interviewerNotes"]), ""])
    lines.extend(["## AI 평가 의견 — 면접관 검토용 초안", "",
                  "평가는 이 인터뷰에서 확인된 근거에 한정합니다. 미관찰 항목은 낮은 점수와 구분하며, 레벨 가이드는 Amazon의 공식 직무별 평가 기준이 아닙니다.", ""])
    summary = document.get("overallSummary")
    if summary:
        lines.extend(["### Summary", "", f"**{summary['recommendation']}**, {escape(summary['reason'])}", "",
                      escape(summary["rationale"]), "",
                      "<details>", "<summary>종합 의견 근거</summary>", "",
                      "평가 항목: " + ", ".join(LABELS[c] for c in summary["criterionIds"]),
                      "관련 질문: " + ", ".join(summary["exchangeIds"]), "", "</details>", ""])
    for assessment in document["assessments"]:
        rating = assessment["rating"]
        lines.extend([f"### {LABELS[assessment['criterion']]}", "",
                      f"**{rating}: {RATINGS[rating]}**" if rating is not None else "**근거 부족 — 미평가**", ""])
        if rating is not None and assessment["evidenceStatus"] == "limited":
            lines.extend(["잠정 평가: 확인된 근거에 기반한 점수이며 평가 범위에 제한이 있습니다.", ""])
        for point in assessment["positives"] + assessment["concerns"]:
            lines.extend([escape(point["text"]), ""])
        has_opinion = bool(assessment["positives"] or assessment["concerns"])
        if not has_opinion:
            lines.extend([escape(assessment["levelAssessment"]), ""])
        lines.extend(["<details>", "<summary>평가 근거·추가 확인</summary>", ""])
        if has_opinion:
            lines.extend([escape(assessment["levelAssessment"]), ""])
        refs = list(dict.fromkeys(qid for field in ("positives", "concerns") for point in assessment[field] for qid in point["exchangeIds"]))
        if refs:
            lines.extend(["면접 근거: " + ", ".join(refs), ""])
        if assessment["followUps"]:
            lines.extend(["**추가 확인 질문**", *[f"- {escape(q)}" for q in assessment["followUps"]], ""])
        lines.extend(["</details>", ""])
    if document.get("resume"):
        resume = document["resume"]
        lines.extend(["## 이력서 주장과 면접 답변 대조", "", "<details>",
                      f"<summary>이력서 대조 상세 ({len(resume['claims'])}개)</summary>", "",
                      f"원본: {escape(resume['fileName'])}", "",
                      "이력서는 후보자의 주장입니다. 답변과 함께 검토하며, 질문하지 않은 항목은 감점하지 않습니다.", ""])
        statuses = {"supported": "답변으로 뒷받침됨", "gap": "역량 격차 확인", "uncertain": "추가 확인 필요", "not_tested": "미검증"}
        for claim in resume["claims"]:
            comparison = next((r for r in document.get("resumeComparisons", []) if r["claimId"] == claim["id"]), None)
            brief = comparison.get("readingNotes", {}) if comparison else {}
            lines.extend([f"### {claim['id']}: {escape(brief.get('claim', claim['text']))}", f"이력서 {', '.join(map(str, claim['pages']))}페이지", ""])
            if comparison:
                fallback = {"supported": "면접 답변에서 관련 경험을 확인했습니다.", "gap": "면접 답변에서 이력서에 적힌 역량과의 차이가 확인됐습니다.",
                            "uncertain": "면접 내용만으로는 해당 경험을 판단하기 어렵습니다.", "not_tested": "면접에서 구체적으로 검증하지 않은 항목입니다."}
                lines.extend([f"**{statuses[comparison['status']]}**", escape(brief.get("explanation", fallback[comparison["status"]]))])
                if comparison["exchangeIds"]: lines.append("면접 근거: " + ", ".join(comparison["exchangeIds"]))
                if comparison["affectedCriteria"]: lines.append("관련 평가: " + ", ".join(LABELS[c] for c in comparison["affectedCriteria"]))
                lines.append("")
        lines.extend(["</details>", ""])
    if document["limitations"]:
        lines.extend(["## 기록의 한계", "", *[f"- {escape(item)}" for item in document["limitations"]]])
    return "\n".join(lines).rstrip() + "\n"
