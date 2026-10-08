import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { INTERVIEW_CRITERION_LABELS, INTERVIEW_RATINGS, type InterviewAssessment, type InterviewExchange, type InterviewOverallSummary, type InterviewSettings } from "@meeting-notes/shared";
import { ApiError, useApi } from "../lib/api";
import { interviewSpeakerLabels, readingInterviewNotes, resumeComparisonText, simpleInterviewMarkdown } from "../lib/interview-export";
import { useStableUrl } from "../lib/stable-url";
import { AudioPlayer, hms, type AudioPlayerHandle } from "../components/AudioPlayer";
import { Transcript } from "../components/Transcript";
import { InterviewProgress, InterviewStatus, interviewActive } from "../components/InterviewStatus";
import { InterviewSettingsForm, interviewInputClass } from "../components/InterviewSettings";
import { MathText } from "../components/MathText";
import { Button, Card, InlineError, Page, Pill, Segmented, Skeleton } from "../components/ui";
import { IconChevronLeft, IconTrash } from "../components/icons";

type Tab = "notes" | "assessment" | "resume" | "transcript";
const ROLES = { candidate: "후보자", interviewer: "면접관", unknown: "확인 필요" } as const;

export function InterviewPage() {
  const { id = "" } = useParams(); const api = useApi(); const nav = useNavigate(); const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("notes"); const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [editing, setEditing] = useState<InterviewSettings | null>(null); const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<"simple" | "full" | null>(null); const [error, setError] = useState("");
  const player = useRef<AudioPlayerHandle>(null);
  const query = useQuery({ queryKey: ["interview", id], queryFn: () => api.interviewResult(id),
    refetchInterval: (q) => q.state.data && interviewActive(q.state.data.interview.status) ? 5000 : false });
  const [audioUrl, refreshAudio] = useStableUrl(query.data?.audioUrl ?? null);
  const invalidate = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ["interview", id] }), qc.invalidateQueries({ queryKey: ["interviews"] })]); };
  const start = useMutation({ mutationFn: () => api.startInterview(id), onSuccess: invalidate });
  const retry = useMutation({ mutationFn: () => api.retryInterview(id), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: () => api.deleteInterview(id), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["interviews"] }); nav("/interviews"); } });
  useEffect(() => {
    if (pendingTarget) {
      window.document.getElementById(pendingTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setPendingTarget(null);
    }
  }, [tab, pendingTarget]);
  if (query.isLoading) return <Page title="인터뷰 불러오는 중"><Skeleton className="h-52" /></Page>;
  if (!query.data || query.error) return <Page title="인터뷰"><InlineError>{query.error?.message ?? "인터뷰를 찾을 수 없습니다"}</InlineError></Page>;
  const { interview, document: doc, transcriptUrl, markdownUrl, resumeUrl } = query.data;
  const active = interviewActive(interview.status);
  const speakers = doc?.speakers ?? interview.speakerHints ?? [];
  const speakerLabels = interviewSpeakerLabels(speakers);
  async function save() {
    if (!editing) return;
    setSaving(true); setError("");
    try { await api.updateInterviewSettings(id, editing); await api.retryInterview(id); setEditing(null); await invalidate(); }
    catch (err) { setError((err as Error).message); await invalidate(); } finally { setSaving(false); }
  }
  async function download(format: "simple" | "full") {
    if (format === "simple" ? !doc : !markdownUrl) return;
    setExporting(format); setError("");
    try {
      let blob: Blob;
      if (format === "simple") {
        blob = new Blob([simpleInterviewMarkdown(doc!)], { type: "text/markdown; charset=utf-8" });
      } else {
        try {
          const content = await api.downloadInterview(id);
          blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 413) throw err;
          // Exceptionally large exports exceed Lambda's response envelope; use a freshly signed URL.
          const latest = await api.interviewResult(id);
          if (!latest.markdownUrl) throw new Error("다운로드할 인터뷰 노트가 아직 준비되지 않았습니다.");
          const response = await fetch(latest.markdownUrl, { cache: "no-store" });
          if (!response.ok) throw new Error(`인터뷰 노트 다운로드에 실패했습니다 (HTTP ${response.status}). 다시 시도하세요.`);
          blob = await response.blob();
        }
      }
      const url = URL.createObjectURL(blob); const anchor = window.document.createElement("a");
      anchor.href = url; anchor.download = `${interview.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 100) || "인터뷰"}_${format === "simple" ? "간소화_인터뷰노트" : "전체_인터뷰기록"}.md`;
      window.document.body.appendChild(anchor);
      try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
    } catch (err) { setError((err as Error).message); } finally { setExporting(null); }
  }
  return <Page title={interview.title} subtitle={`${interview.settings.targetLevel} · ${interview.settings.roleTitle || "인터뷰"}`} back={<Link to="/interviews" className="inline-flex gap-1 items-center text-sm text-ink-3 mb-3"><IconChevronLeft size={16} />인터뷰 목록</Link>}>
    <InterviewStatus interview={interview} />
    {active && <Card className="mt-4 p-4"><p className="text-sm text-ink-2 mb-4">발언을 기록하고 선택한 항목의 평가 근거를 정리하고 있습니다.</p><InterviewProgress interview={interview} /></Card>}
    {interview.status === "UPLOAD_PENDING" && <Card className="mt-4 p-4"><p className="text-sm">{interview.uploadsComplete ? "MP3 업로드가 완료되었습니다." : "업로드 화면에서 이어서 진행하거나, 이 인터뷰를 삭제하고 다시 등록하세요."}</p>{interview.uploadsComplete && <Button full className="mt-3" loading={start.isPending} onClick={() => start.mutate()}>인터뷰 분석 시작</Button>}</Card>}
    {interview.status === "UPLOADED" && <Button full className="mt-3" loading={start.isPending} onClick={() => start.mutate()}>처리 시작 확인</Button>}
    {interview.status === "FAILED" && <Card className="mt-4 p-4"><p className="text-sm text-danger">{interview.error}</p><Button full className="mt-3" loading={retry.isPending} onClick={() => retry.mutate()}>완료된 단계부터 다시 시도</Button></Card>}
    {(error || start.error || retry.error || remove.error) && <InlineError>{error || start.error?.message || retry.error?.message || remove.error?.message}</InlineError>}
    {audioUrl && <div className="sticky top-0 z-10 -mx-4 px-4 py-3 mt-3 bg-bg/95 backdrop-blur"><AudioPlayer ref={player} src={audioUrl} onError={() => { void query.refetch().then(() => refreshAudio()); }} /></div>}
    {(doc || transcriptUrl) && <Segmented className="mt-3" value={tab} onChange={setTab} options={[...(doc ? [{ value: "notes" as const, label: "인터뷰 노트" }, { value: "assessment" as const, label: "AI 평가 의견" }] : []), ...(doc?.resume ? [{ value: "resume" as const, label: "이력서 대조" }] : []), ...(transcriptUrl ? [{ value: "transcript" as const, label: "전사" }] : [])]} />}
    {(doc || markdownUrl) && <div className="mt-4 space-y-3">
      {doc && <div><Button full loading={exporting === "simple"} disabled={exporting !== null} onClick={() => void download("simple")}>간소화 노트 다운로드 (.md)</Button><p className="mt-2 text-xs text-ink-3">주제별 질문·답변과 후속 질문을 읽기 쉽게 정리합니다. 이력서 대조와 평가는 제외합니다.</p></div>}
      {markdownUrl && <div><Button full variant="secondary" loading={exporting === "full"} disabled={exporting !== null} onClick={() => void download("full")}>전체 기록 다운로드 (.md)</Button><p className="mt-2 text-xs text-ink-3">상세 노트, 이력서 대조, AI 평가 의견과 근거를 함께 저장합니다.</p></div>}
    </div>}
    {doc && tab === "notes" && <div className="space-y-4 mt-5">
      <p className="text-sm text-ink-3">{doc.exchanges.length}개 질문 · 핵심 답변</p>
      {doc.exchanges.map((exchange) => <QuestionNotes key={exchange.id} exchange={exchange} speakerLabels={speakerLabels} seek={(time) => player.current?.seek(time)} />)}
      {doc.settings.interviewerNotes && <details className="text-sm"><summary className="cursor-pointer text-ink-3">면접관 메모</summary><p className="mt-3 whitespace-pre-wrap">{doc.settings.interviewerNotes}</p></details>}
    </div>}
    {doc && tab === "assessment" && <div className="space-y-4 mt-5"><p className="text-xs text-ink-3 leading-relaxed">목표 {doc.settings.targetLevel}에 대한 AI 평가 초안입니다. 근거 질문과 녹음을 확인하고 면접관이 최종 판단하세요. 관찰하지 못한 항목은 낮은 점수와 구분합니다.</p>
      {doc.overallSummary && <OverallSummary value={doc.overallSummary}
        jump={(question) => { setTab("notes"); setPendingTarget(`interview-${question}`); }} />}
      {doc.assessments.map((assessment) => <Assessment key={assessment.criterion} value={assessment}
        hasResumeGaps={doc.resumeComparisons?.some((comparison) => comparison.status === "gap" && comparison.affectedCriteria.includes(assessment.criterion))}
        jump={(question) => { setTab("notes"); setPendingTarget(`interview-${question}`); }}
        openResume={() => setTab("resume")} />)}
    </div>}
    {doc?.resume && tab === "resume" && <div className="mt-5 space-y-4">
      <p className="text-sm break-words">원본: {doc.resume.fileName}{resumeUrl && <a href={resumeUrl} target="_blank" rel="noreferrer" className="text-accent underline ml-2">PDF 열기</a>}</p>
      {!doc.resume.claims.length && <p className="text-sm text-warning">이력서에서 직무 관련 주장을 읽지 못했습니다. 원본 PDF를 확인하세요.</p>}
      {doc.resume.claims.map((claim) => {
        const comparison = doc.resumeComparisons?.find((item) => item.claimId === claim.id);
        const labels = { supported: "답변으로 뒷받침됨", gap: "역량 격차 확인", uncertain: "추가 확인 필요", not_tested: "미검증" } as const;
        return <section id={`resume-${claim.id}`} key={claim.id} className="scroll-mt-28"><Card className="p-4">
          <div className="flex flex-wrap gap-2 justify-between items-center"><h2 className="text-sm font-semibold">{comparison?.readingNotes?.claim ?? claim.text}</h2>{comparison && <Pill tone={comparison.status === "gap" ? "danger" : comparison.status === "supported" ? "success" : comparison.status === "uncertain" ? "warning" : "neutral"}>{labels[comparison.status]}</Pill>}</div>
          {comparison && <p className="mt-3 text-sm text-ink-2 leading-relaxed">{resumeComparisonText(comparison)}</p>}
          <details className="mt-3 text-xs text-ink-3"><summary className="cursor-pointer">이력서 원문·관련 질문</summary>
            <p className="mt-3 leading-relaxed">{claim.text}</p><p className="mt-2">이력서 {claim.pages.join(", ")}페이지</p>
            <div className="mt-3 flex flex-wrap gap-2">{comparison?.exchangeIds.map((qid) => <button key={qid} onClick={() => { setTab("notes"); setPendingTarget(`interview-${qid}`); }} className="tap rounded-md bg-accent-soft text-accent px-2 py-1 text-xs">질문 {qid.replace(/^q/, "")}</button>)}</div>
          </details>
        </Card></section>;
      })}
    </div>}
    {transcriptUrl && (tab === "transcript" || !doc) && <div className="mt-4"><Transcript title={interview.title} transcriptUrl={transcriptUrl} audioUrl={null} speakerLabels={speakerLabels} speakerRoleLabels={speakerLabels} onSeek={(time) => player.current?.seek(time)} onRefreshUrls={async () => (await query.refetch({ throwOnError: true })).data} /></div>}
    {!active && ["FAILED", "COMPLETED"].includes(interview.status) && <div className="mt-6">
      {doc && JSON.stringify(doc.settings) !== JSON.stringify(interview.settings) && <p className="text-sm text-warning mb-3">설정이 변경되었습니다. 현재 노트와 의견은 이전 설정을 기준으로 작성되었습니다.</p>}
      {!editing ? <Button full variant="secondary" onClick={() => setEditing({ ...interview.settings, speakerRoles: { ...Object.fromEntries(speakers.map((speaker) => [speaker.id, speaker.role])), ...interview.settings.speakerRoles } })}>평가 항목·레벨·화자 역할 수정</Button>
        : <Card className="p-4"><fieldset disabled={saving}><InterviewSettingsForm value={editing} onChange={setEditing} />
          {!!speakers.length && <div className="mt-5 space-y-3"><h3 className="font-semibold">화자 역할 확인</h3><p className="text-xs text-ink-3">녹음을 확인하고 역할을 지정하세요.</p>{speakers.map((speaker) => <label key={speaker.id} className="block text-sm">{speakerLabels[speaker.id]}<select aria-label={`${speakerLabels[speaker.id]} 역할`} className={interviewInputClass} value={editing.speakerRoles[speaker.id] ?? speaker.role} onChange={(e) => setEditing({ ...editing, speakerRoles: { ...editing.speakerRoles, [speaker.id]: e.target.value as InterviewSettings["speakerRoles"][string] } })}>{Object.entries(ROLES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>)}</div>}
        </fieldset><p className="mt-4 text-xs text-ink-3">원본 전사는 재사용합니다. 설정에 따라 AI 분석 비용이 발생할 수 있습니다.</p><Button full className="mt-4" loading={saving} disabled={!editing.criteria.length} onClick={() => void save()}>설정 적용하고 다시 분석</Button><Button full variant="ghost" className="mt-2" disabled={saving} onClick={() => setEditing(null)}>취소</Button></Card>}
    </div>}
    {!active && <Button full variant="danger" className="mt-10" loading={remove.isPending} icon={<IconTrash size={16} />} onClick={() => { if (confirm("이 인터뷰의 녹음, 이력서, 전사, 노트와 평가 의견을 삭제할까요?")) remove.mutate(); }}>인터뷰 삭제</Button>}
  </Page>;
}

function QuestionNotes({ exchange: q, seek, speakerLabels }: { exchange: InterviewExchange; seek: (time: number) => void; speakerLabels: Record<string, string> }) {
  const notes = readingInterviewNotes(q);
  return <section id={`interview-${q.id}`} className="scroll-mt-28"><Card className="p-4">
    <p className="text-xs text-accent">{notes.topic}</p>
    <h2 className="mt-2 font-semibold text-[15px] leading-relaxed">{q.questionKind === "primary" ? "Q" : "f/u Q"}{q.interviewerId ? ` · ${speakerLabels[q.interviewerId] ?? "면접관"}` : ""}: <MathText text={notes.question} /></h2>
    <h3 className="mt-3 text-xs font-semibold text-ink-3">후보자 답변</h3>
    {notes.answer.length ? <ul className="mt-2 space-y-1 list-disc pl-4 text-sm leading-relaxed">{notes.answer.map((point, i) => <li key={i}><MathText text={point} /></li>)}</ul> : <p className="mt-2 text-sm text-ink-3">명확한 답변 없음.</p>}
    {!!notes.hints.length && <div className="mt-3 text-xs text-ink-2"><strong>면접관 힌트·정정</strong><ul className="mt-1 list-disc pl-4 space-y-1">{notes.hints.map((hint, i) => <li key={i}><MathText text={hint} /></li>)}</ul></div>}
    <details className="mt-3"><summary className="text-xs text-accent cursor-pointer">전체 답변·녹음 보기</summary>
      <p className="mt-3 text-sm font-semibold"><MathText text={q.question} /></p>
      <ul className="mt-2 space-y-2 list-disc pl-4 text-sm">{q.answer.map((point, i) => <li key={i}><MathText text={point.text} /></li>)}</ul>
      <ol className="mt-3 space-y-2 max-h-96 overflow-y-auto">{q.evidence.map((e) => <li key={e.segmentId}><button className="tap text-left w-full bg-surface-2 rounded-lg p-3 text-sm" onClick={() => seek(e.start)}><span className="block text-xs text-accent mb-1">{hms(e.start)} · {speakerLabels[e.speaker] ?? "미확인 화자"}</span>{e.text}</button></li>)}</ol>
    </details>
  </Card></section>;
}
function OverallSummary({ value, jump }: { value: InterviewOverallSummary; jump: (id: string) => void }) {
  return <section aria-label="종합 의견 Summary"><Card className="p-4">
    <h2 className="font-semibold">종합 의견 (Summary)</h2>
    <p className="mt-4 text-sm leading-relaxed"><strong className={value.recommendation === "Inclined" ? "text-success" : "text-danger"}>{value.recommendation}</strong>, {value.reason}</p>
    {value.rationale.split(/\n\s*\n/).filter(Boolean).map((paragraph, i) => <p key={i} className="mt-3 text-sm leading-relaxed">{paragraph}</p>)}
    <details className="mt-4 pt-3 border-t border-line">
      <summary className="text-xs text-accent cursor-pointer">종합 의견 근거</summary>
      <p className="mt-3 text-xs text-ink-3">{value.criterionIds.map((criterion) => INTERVIEW_CRITERION_LABELS[criterion]).join(" · ")}</p>
      <div className="flex flex-wrap gap-2 mt-3">{value.exchangeIds.map((id) => <button key={id} className="tap rounded-md bg-accent-soft text-accent px-2 py-1 text-xs" onClick={() => jump(id)}>질문 {id.replace(/^q/, "")}</button>)}</div>
    </details>
  </Card></section>;
}

function Assessment({ value, jump, openResume, hasResumeGaps = false }: { value: InterviewAssessment; jump: (id: string) => void; openResume: () => void; hasResumeGaps?: boolean }) {
  const tone = value.rating === null ? "neutral" : value.rating <= 2 ? "danger" : value.rating === 3 ? "warning" : "success";
  const evidenceIds = [...new Set([...value.positives, ...value.concerns].flatMap((point) => point.exchangeIds))];
  const hasOpinion = value.positives.length + value.concerns.length > 0;
  return <Card className="p-4"><div className="flex flex-wrap justify-between items-center gap-2"><h2 className="font-semibold">{INTERVIEW_CRITERION_LABELS[value.criterion]}</h2><Pill tone={tone}>{value.rating === null ? "근거 부족 · 미평가" : `${value.rating}: ${INTERVIEW_RATINGS[value.rating]}`}</Pill></div>
    {value.rating !== null && value.evidenceStatus === "limited" && <p className="mt-2 text-xs text-warning">잠정 평가 · 확인된 근거에 기반한 점수이며 평가 범위에 제한이 있습니다.</p>}
    {[...value.positives, ...value.concerns].map((point, i) => <p key={i} className="mt-4 text-sm leading-relaxed whitespace-pre-line">{point.text}</p>)}
    {!hasOpinion && <p className="mt-4 text-sm text-ink-2 leading-relaxed">{value.levelAssessment}</p>}
    <details className="mt-4 pt-3 border-t border-line"><summary className="text-xs text-accent cursor-pointer">평가 근거·추가 확인</summary>
      {hasOpinion && <p className="mt-3 text-sm text-ink-2 leading-relaxed">{value.levelAssessment}</p>}
      {!!evidenceIds.length && <div className="flex flex-wrap gap-2 mt-3">{evidenceIds.map((id) => <button key={id} className="tap rounded-md bg-accent-soft text-accent px-2 py-1 text-xs" onClick={() => jump(id)}>근거 {id}</button>)}</div>}
      {hasResumeGaps && <button className="mt-3 text-xs text-accent underline" onClick={openResume}>이력서 대조 보기</button>}
      {!!value.followUps.length && <div className="mt-4"><h3 className="text-xs font-semibold text-ink-3">추가 확인 질문</h3><ul className="mt-2 list-disc pl-4 text-sm space-y-2">{value.followUps.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
    </details>
  </Card>;
}
