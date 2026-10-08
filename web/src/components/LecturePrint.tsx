import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { formatSlidePages, type LectureDocument, type LecturePage } from "@meeting-notes/shared";
import { MathText } from "./MathText";
import { LectureMathNotes } from "./LectureMathNotes";
import { Button, InlineError } from "./ui";
import { hms } from "./AudioPlayer";

/** Text and rendered math only: no signed media/download URLs enter the printable document. */
export function LecturePrint({ document: doc }: { document: LectureDocument }) {
  return createPortal(<article className="lecture-print" lang={doc.outputLanguage}>
    <h1>{doc.title}</h1>
    <p>{doc.course} · {doc.generatedAt.slice(0, 10)} · {hms(doc.durationSec)}</p>
    {doc.customPrompt && <><h2>추가 요청</h2><p className="whitespace-pre-wrap">{doc.customPrompt}</p></>}
    {doc.selectedPages && <p>분석 범위: {formatSlidePages(doc.selectedPages)}페이지 · 학습 묶음 {doc.pages.length}개</p>}
    <h2>전체 정리</h2><Text text={doc.overview} />
    {doc.audience && <><h2>이 강의의 대상</h2><Text text={doc.audience.level} /><List items={doc.audience.priorKnowledge} /><Text text={doc.audience.lectureGoal} /></>}
    <h2>학습 목표</h2><List items={doc.learningObjectives} />
    <h2>복습 순서</h2><List items={doc.reviewPlan} ordered />
    {doc.pages.map((page) => <section key={page.page} className="lecture-print-page">
      <h2>{page.page}. {page.title}</h2>
      <Source page={page} />
      <h3>{page.source === "audio" ? "음성 주제 요약" : "화면·장표 요약"}</h3><Text text={page.slideSummary} />
      <h3>수업에서 언급된 내용</h3><Text text={page.spokenSummary || "대응하는 발언을 확인하지 못했습니다."} />
      <Text text={`연결: ${page.alignment.status === "matched" ? "구간 연결" : page.alignment.status === "uncertain" ? "확인 필요" : "구간 미확인"} · ${page.alignment.reason}`} />
      <h3>이해를 돕는 보충 설명</h3><p>학습을 위해 AI가 덧붙인 설명입니다.</p><Text text={page.explanation} />
      {!!page.concepts.length && <><h3>핵심 개념</h3><dl>{page.concepts.map((c, i) => <div key={i}><dt><MathText text={c.term} /></dt><dd><MathText text={c.explanation} /></dd></div>)}</dl></>}
      {!!page.mathNotes?.length && <><h3>수식과 정리</h3><LectureMathNotes notes={page.mathNotes} /></>}
      {!!page.reviewQuestions.length && <><h3>복습 문제와 답</h3>{page.reviewQuestions.map((q, i) => <div key={i}><Text text={`${i + 1}. ${q.question}`} /><Text text={q.answer} /></div>)}</>}
      {!!page.flashcards.length && <><h3>복습 카드</h3>{page.flashcards.map((c, i) => <div key={i}><Text text={`Q. ${c.front}`} /><Text text={`A. ${c.back}`} /></div>)}</>}
      {!!page.evidence.length && <><h3>발언 근거</h3>{page.evidence.map((e) => <Text key={e.segmentId} text={`[${hms(e.start)}–${hms(e.end)}] ${e.speaker}: ${e.text}`} />)}</>}
      <h3>함께 읽을 논문</h3>
      {page.research.papers.map((p, i) => <div key={i}><p><strong>{p.title}</strong></p>{/^https?:\/\//i.test(p.url) && <p><a href={p.url}>{p.url}</a></p>}<Text text={p.relevance} /><Text text={`읽을 부분: ${p.readingFocus}`} /></div>)}
      {!page.research.papers.length && <p>{page.research.status === "failed" ? "논문 검색을 완료하지 못했습니다." : "참고 논문이 없습니다."}</p>}
    </section>)}
    {!!doc.warnings.length && <><h2>확인할 사항</h2><List items={doc.warnings} /></>}
  </article>, window.document.body);
}

function Text({ text }: { text: string }) { return <p className="whitespace-pre-wrap"><MathText text={text} /></p>; }
function List({ items, ordered }: { items: string[]; ordered?: boolean }) {
  const Tag = ordered ? "ol" : "ul";
  return <Tag>{items.map((item, i) => <li key={i}><MathText text={item} /></li>)}</Tag>;
}
function Source({ page }: { page: LecturePage }) {
  const ranges = page.audioRanges ?? page.videoRanges ?? [];
  return <>
    {page.sourceFile && <p>원본: {page.sourceFile}{page.source !== "audio" && page.source !== "video" ? ` · ${page.sourcePages ? formatSlidePages(page.sourcePages) : page.deckPage ?? page.page}페이지` : ""}</p>}
    {!!page.relatedPages?.length && <p>관련 원본 장표: {page.relatedPages.map((r) => `${r.page}페이지 ${r.topic}`).join(", ")}</p>}
    {!!ranges.length && <p>{page.source === "audio" ? "음성" : "영상"} 구간: {ranges.map((r) => `${hms(r.startSec)}–${hms(r.endSec)}`).join(", ")}</p>}
  </>;
}

export function LectureExportButton({ document: doc, compact = false }: { document: LectureDocument; compact?: boolean }) {
  const [printable, setPrintable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cleanup = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cleanup.current?.(); }; }, []);
  async function exportPdf() {
    setError(""); setBusy(true);
    try {
      flushSync(() => setPrintable(true));
      // The print tree is hidden on screen, so its font faces may not have
      // loaded yet when exporting directly from the overview tab.
      await Promise.all(Array.from(window.document.fonts ?? []).filter((face) => face.family.startsWith("KaTeX")).map((face) => face.load()));
      await window.document.fonts?.ready;
      if (!mounted.current) return;
      cleanup.current?.();
      const title = window.document.title;
      window.document.title = doc.title;
      const restore = () => { window.document.title = title; window.removeEventListener("afterprint", restore); cleanup.current = null; };
      cleanup.current = restore;
      window.addEventListener("afterprint", restore, { once: true });
      window.print();
    } catch {
      cleanup.current?.();
      setError("인쇄 창을 열지 못했습니다. 브라우저의 인쇄 기능에서 PDF로 저장하세요.");
    } finally { setBusy(false); }
  }
  return <div className={compact ? "shrink-0" : "mt-4"}>
    <Button variant="success" size={compact ? "sm" : "md"} loading={busy} onClick={() => void exportPdf()}>PDF로 저장</Button>
    {!compact && <p className="mt-2 text-xs text-ink-3">전체 학습 자료와 수식, 복습 답안을 저장합니다. 인쇄 창에서 ‘PDF로 저장’을 선택하세요.</p>}
    {error && <InlineError>{error}</InlineError>}
    {printable && <LecturePrint document={doc} />}
  </div>;
}
