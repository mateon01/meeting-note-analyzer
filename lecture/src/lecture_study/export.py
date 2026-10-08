import csv
import io
import re

DIFFICULTY = {"basic": "기본", "understand": "이해", "apply": "적용"}
NOTE_KIND = {"definition": "정의", "theorem": "정리", "lemma": "보조정리", "formula": "공식", "example": "예제"}

def page_label(pages):
    ranges = []
    for page in pages:
        if ranges and ranges[-1][-1] + 1 == page:
            ranges[-1].append(page)
        else:
            ranges.append([page])
    return ", ".join(str(r[0]) if len(r) == 1 else f"{r[0]}–{r[-1]}" for r in ranges)


def markdown(document: dict) -> str:
    lines = [f"# {document['title']}", "", document["overview"]]
    if document.get("selectedPages"):
        lines.extend(["", f"분석 범위: {page_label(document['selectedPages'])}페이지 · 학습 묶음 {len(document['pages'])}개"])
    if document.get("customPrompt"):
        prompt = document["customPrompt"].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        prompt = re.sub(r"([\\`*_\[\]#])", r"\\\1", prompt)
        lines.extend(["", "## 추가 요청", *["> " + line for line in prompt.splitlines()]])
    audience = document.get("audience")
    if audience:
        lines.extend(["", "## 이 강의의 대상", f"- 수준: {audience['level']}", f"- 전제 지식: {', '.join(audience['priorKnowledge']) or '없음'}", f"- 강의 목표: {audience['lectureGoal']}"])
    lines.extend(["", "## 학습 목표"])
    lines.extend(f"- {x}" for x in document["learningObjectives"])
    lines.extend(["", "## 복습 순서", *[f"- {x}" for x in document["reviewPlan"]]])
    for page in document["pages"]:
        lines.extend(["", f"## {page['page']}. {page['title']}"])
        if page.get("sourceFile"):
            lines.append(f"원본: {page['sourceFile']}" + (f" · {page_label(page['sourcePages']) if page.get('sourcePages') else page.get('deckPage', page['page'])}페이지" if page.get("source") not in ("video", "audio") else ""))
        if page.get("relatedPages"):
            lines.extend(["", "관련 원본 장표: " + ", ".join(f"{ref['page']}페이지 {ref['topic']}" for ref in page["relatedPages"])])
        if page.get("audioRanges"):
            lines.extend(["", "### 음성 구간"])
            lines.extend(f"- {int(r['startSec']) // 60:02d}:{int(r['startSec']) % 60:02d} ~ {int(r['endSec']) // 60:02d}:{int(r['endSec']) % 60:02d}" for r in page["audioRanges"])
        if page.get("videoRanges"):
            lines.extend(["", "### 영상 구간"])
            lines.extend(f"- {int(r['startSec']) // 60:02d}:{int(r['startSec']) % 60:02d} ~ {int(r['endSec']) // 60:02d}:{int(r['endSec']) % 60:02d}" for r in page["videoRanges"])
        alignment = {"video_time": "영상 시간 기준", "audio_time": "음성 시간 기준"}.get(page["alignment"].get("method"), f"{page['alignment']['status']} ({page['alignment']['confidence']:.0%})")
        summary_title = {"video": "화면 요약", "audio": "음성 주제 요약"}.get(page.get("source"), "장표 요약")
        lines.extend(["", f"### {summary_title}", page["slideSummary"], "", "### 수업에서 언급된 내용", page["spokenSummary"] or "대응하는 발언을 확인하지 못했습니다.", f"연결: {alignment}", "", "### 학습 보충 설명", page["explanation"], "", "### 핵심 개념"])
        lines.extend(f"- **{x['term']}**: {x['explanation']}" for x in page["concepts"])
        if page.get("mathNotes"):
            lines.extend(["", "### 수식과 정리"])
            for note in page["mathNotes"]:
                lines.extend([f"- **[{NOTE_KIND[note['kind']]}] {note['name']}**", f"  {note['statement']}"])
                check = note.get("sourceCheck")
                if check:
                    label = {"consistent": "원본 검토", "corrected": "원본 오류 수정", "uncertain": "원본 확인 필요"}[check["status"]]
                    lines.append(f"  **{label}:** {check['explanation']}")
                    if check.get("correctedStatement"):
                        lines.append(f"  {'수정식' if check['status'] == 'corrected' else '검토할 해석'}: {check['correctedStatement']}")
                lines.extend(f"  - {symbol['symbol']}: {symbol['meaning']}" for symbol in note.get("symbols", []))
                if note.get("assumptions"):
                    lines.append("  전제: " + "; ".join(note["assumptions"]))
                lines.extend(f"  {i}. {step}" for i, step in enumerate(note["steps"], 1))
                if note["intuition"]:
                    lines.append(f"  직관: {note['intuition']}")
                if note["supplementary"]:
                    lines.append("  (강의에서 생략된 증명을 보충했습니다. 추가 유도와 예시는 학습을 위한 AI 설명입니다.)")
        lines.extend(["", "### 복습 문제"])
        for question in page["reviewQuestions"]:
            lines.extend([f"- 질문 ({DIFFICULTY[question.get('difficulty', 'basic')]}): {question['question']}", f"  정답: {question['answer']}"])
        lines.extend(["", "### 발언 근거"])
        lines.extend(f"- [{int(e['start']) // 60:02d}:{int(e['start']) % 60:02d}] ({e['segmentId']}) {e['text']}" for e in page["evidence"])
        lines.extend(["", "### 참고 논문"])
        for paper in page["research"]["papers"]:
            title = paper["title"].replace("[", "\\[").replace("]", "\\]").replace("\n", " ")
            lines.extend([f"- [{title}](<{paper['url']}>)", f"  관련성: {paper['relevance']}", f"  읽을 부분: {paper['readingFocus']}"])
        if page["research"]["status"] == "failed":
            lines.append("논문 검색을 완료하지 못했습니다. 앱에서 다시 시도할 수 있습니다.")
        elif not page["research"]["papers"]:
            lines.append("참고 논문이 없습니다.")
    if document["warnings"]:
        lines.extend(["", "## 확인할 사항", *[f"- {x}" for x in document["warnings"]]])
    return "\n".join(lines) + "\n"


def flashcard_csv(document: dict) -> str:
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["Front", "Back", "Page", "Lecture"])
    def safe(value):
        text = str(value)
        return "'" + text if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else text
    for page in document["pages"]:
        for card in page["flashcards"]:
            writer.writerow([safe(card["front"]), safe(card["back"]), page_label(page["sourcePages"]) if page.get("sourcePages") else page["page"], safe(document["title"])])
    return "\ufeff" + output.getvalue()
