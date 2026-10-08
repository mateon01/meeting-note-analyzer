import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatSlidePages, type LecturePage as PageData } from "@meeting-notes/shared";
import { useApi } from "../lib/api";
import { useStableUrl } from "../lib/stable-url";
import { AudioPlayer, hms, type AudioPlayerHandle } from "../components/AudioPlayer";
import { VideoPlayer } from "../components/VideoPlayer";
import { LectureProgress, LectureStatus } from "../components/LectureStatus";
import { MathText } from "../components/MathText";
import { LectureMathNotes } from "../components/LectureMathNotes";
import { LectureExportButton } from "../components/LecturePrint";
import { LectureSharing } from "../components/LectureSharing";
import { Transcript } from "../components/Transcript";
import { Bullets, Button, Card, InlineError, Page, Pill, SectionLabel, Segmented, Skeleton } from "../components/ui";
import { IconChevronLeft, IconChevronRight, IconExternal, IconRefresh, IconTrash } from "../components/icons";

type Tab = "overview" | "pages" | "cards" | "transcript";
export function LecturePage() {
  const { id = "" } = useParams(); const api = useApi(); const nav = useNavigate(); const qc = useQueryClient();
  const [params, setParams] = useSearchParams(); const requestedPage = Number(params.get("page")) || 0; // chat evidence links open one section directly
  const sharingOpen = params.get("share") === "1";
  function showSharing(open: boolean) {
    const next = new URLSearchParams(params);
    if (open) next.set("share", "1"); else next.delete("share");
    setParams(next, { replace: true });
  }
  const [tab, setTab] = useState<Tab>(requestedPage ? "pages" : "overview"); const [pageIndex, setPageIndex] = useState(0);
  const [pendingPage, setPendingPage] = useState(requestedPage);
  const player = useRef<AudioPlayerHandle>(null);
  // Mini player: only while playing, once the full player has scrolled out of view; it stays docked (even paused) until the user scrolls back up.
  const [docked, setDocked] = useState(false); const sentinel = useRef<HTMLDivElement>(null); const playing = useRef(false); const pastPlayer = useRef(false);
  const query = useQuery({ queryKey: ["lecture", id], queryFn: () => api.lectureResult(id),
    refetchInterval: (q) => q.state.data && ["UPLOADED", "PREPARING", "TRANSCRIBING", "ANALYZING"].includes(q.state.data.lecture.status) ? 5000 : false });
  const [audioUrl, refreshAudio] = useStableUrl(query.data?.audioUrl ?? null);
  const [videoUrl, refreshVideo] = useStableUrl(query.data?.videoUrl ?? null);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      pastPlayer.current = !entry.isIntersecting;
      if (entry.isIntersecting) setDocked(false);
      else if (playing.current) setDocked(true);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [videoUrl]);
  const onPlayingChange = (next: boolean) => { playing.current = next; if (next && pastPlayer.current) setDocked(true); };
  const retry = useMutation({ mutationFn: () => api.retryLecture(id), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["lecture", id] }); await qc.invalidateQueries({ queryKey: ["lectures"] }); } });
  const start = useMutation({ mutationFn: () => api.startLecture(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["lecture", id] }) });
  const remove = useMutation({ mutationFn: () => api.deleteLecture(id), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["lectures"] }); nav("/lectures"); } });
  const chat = useMutation({ mutationFn: () => api.createChatSession({ sourceType: "lecture", lectureId: id }),
    onSuccess: ({ session }) => { void qc.invalidateQueries({ queryKey: ["chat-sessions"] }); nav(`/chat/${session.sessionId}`); } });
  if (query.isLoading) return <Page title="강의 불러오는 중"><Skeleton className="h-52" /></Page>;
  if (!query.data || query.error) return <Page title="강의"><InlineError>{query.error?.message ?? "강의를 찾을 수 없습니다"}</InlineError><Link to="/lectures" className="text-accent block mt-4">강의 목록</Link></Page>;
  const { lecture, document, pageImages, markdownUrl, flashcardsUrl, slidesUrl, transcriptUrl } = query.data;
  const customPrompt = document ? document.customPrompt : lecture.customPrompt;
  if (pendingPage && document) { const index = document.pages.findIndex((p) => p.page === pendingPage); if (index >= 0) setPageIndex(index); setPendingPage(0); }
  const page = document?.pages[pageIndex];
  const active = ["UPLOADED", "PREPARING", "TRANSCRIBING", "ANALYZING"].includes(lecture.status);
  return <Page title={lecture.title} subtitle={lecture.course || "강의 학습 자료"}
    back={<Link to="/lectures" className="inline-flex items-center text-sm text-ink-3 mb-3"><IconChevronLeft size={16} />강의 목록</Link>}>
    <div className="flex items-center justify-between gap-2"><LectureStatus lecture={lecture} /><span className="text-xs text-ink-3">{lecture.pageCount ? `학습 항목 ${lecture.pageCount}개` : lecture.videoName ? "MP4" : lecture.audioName ? "MP3" : lecture.slidesName}{lecture.durationSec ? ` · ${hms(lecture.durationSec)}` : ""}</span></div>
    {document && <div role="group" aria-label="강의 작업" className="mt-3 flex flex-nowrap items-center gap-2 overflow-x-auto py-1">
      {lecture.status === "COMPLETED" && <Button size="sm" className="shrink-0" loading={chat.isPending} onClick={() => chat.mutate()}>이 강의에 질문하기</Button>}
      <Button size="sm" className="shrink-0" variant="violet" aria-expanded={sharingOpen} aria-controls="lecture-sharing" onClick={() => showSharing(!sharingOpen)}>게스트 공유</Button>
      {lecture.status === "COMPLETED" && <Button size="sm" className="shrink-0" variant="secondary" loading={retry.isPending}
        onClick={() => { if ((lecture.researchFailures ?? 0) > 0 || confirm("최신 설명 방식으로 학습 자료를 다시 만들까요? 기존 전사와 장표 분석은 재사용하며 AI 분석 비용이 발생할 수 있습니다.")) retry.mutate(); }}>
        {(lecture.researchFailures ?? 0) > 0 ? "논문 검색 다시 시도" : "학습 설명 업데이트"}
      </Button>}
      <LectureExportButton key={document.generatedAt} document={document} compact />
    </div>}
    {document && <LectureSharing key={id} lectureId={id} open={sharingOpen} onClose={() => showSharing(false)} />}
    {customPrompt && <details className="mt-3 text-sm"><summary className="cursor-pointer text-ink-3">추가 요청</summary><p className="mt-2 whitespace-pre-wrap leading-relaxed">{customPrompt}</p></details>}
    {document?.selectedPages && <Card className="mt-3 p-4"><p className="text-sm font-semibold">분석 범위: {formatSlidePages(document.selectedPages)}페이지</p>
      <p className="mt-1 text-xs text-ink-3">원본 {document.originalPageCount}장 중 {document.selectedPages.length}장 · 주제별 학습 묶음 {document.pages.length}개</p></Card>}
    {chat.error && <InlineError>{chat.error.message}</InlineError>}
    {active && <Card className="mt-5 p-4"><p className="text-sm text-ink-2 mb-4">강의 내용을 정리하고 있습니다. 강의 길이와 장표 수에 따라 시간이 걸릴 수 있습니다.</p>{lecture.status === "TRANSCRIBING" && <p className="mb-4 text-xs text-ink-3">초기 준비나 대기 상태에 따라 전사에 시간이 더 걸릴 수 있습니다. 완료되면 자동으로 이어집니다.</p>}<LectureProgress lecture={lecture} /></Card>}
    {lecture.status === "UPLOAD_PENDING" && <Card className="mt-5 p-4"><p className="text-sm text-ink-2">{lecture.uploadsComplete ? "선택한 파일의 업로드가 완료되었습니다." : "파일 업로드가 완료되지 않았습니다. 업로드 화면이 열려 있다면 이어서 진행하세요. 화면을 닫았다면 이 강의를 삭제하고 다시 등록하세요."}</p>{lecture.uploadsComplete && <Button full className="mt-3" loading={start.isPending} onClick={() => start.mutate()}>강의 분석 시작</Button>}</Card>}
    {lecture.status === "UPLOADED" && <Button full variant="secondary" className="mt-3" loading={start.isPending} onClick={() => start.mutate()}>처리 시작 확인</Button>}
    {lecture.status === "FAILED" && <Card className="mt-5 p-4"><p className="font-semibold text-danger">분석을 완료하지 못했습니다</p><p className="mt-2 text-sm text-ink-2">완료된 단계의 자료를 재사용해 이어서 처리할 수 있습니다.</p><details className="mt-3 text-xs text-ink-3"><summary className="cursor-pointer">오류 상세</summary><p className="mt-2 break-all">{lecture.error}</p></details></Card>}
    {(lecture.status === "FAILED" || (!document && lecture.status === "COMPLETED" && (lecture.researchFailures ?? 0) > 0)) && <Button full className="mt-3" loading={retry.isPending} icon={<IconRefresh size={16} />} onClick={() => retry.mutate()}>{lecture.status === "COMPLETED" ? "논문 검색 다시 시도" : "완료된 작업부터 이어서 처리"}</Button>}
    {(retry.error || start.error || remove.error) && <InlineError>{(retry.error || start.error || remove.error)?.message}</InlineError>}
    {videoUrl && <>
      <div ref={sentinel} aria-hidden className="h-px" />
      <div data-testid={docked ? "video-dock" : undefined} className={docked ? "sticky top-0 z-10 -mx-4 px-4 py-2 mt-3 bg-bg/95 backdrop-blur" : "mt-3"}>
        <VideoPlayer ref={player} src={videoUrl} title={lecture.title} compact={docked} onPlayingChange={onPlayingChange}
          onExpand={() => { window.document.querySelector(".app-shell > main")?.scrollTo({ top: 0, behavior: "smooth" }); setDocked(false); }}
          onRefresh={async () => { await query.refetch(); refreshVideo(); }} />
      </div>
    </>}
    {document && <>
      {audioUrl && !videoUrl && tab !== "transcript" && <div className="sticky top-0 z-10 -mx-4 px-4 py-3 mt-3 bg-bg/95 backdrop-blur"><AudioPlayer ref={player} src={audioUrl} onError={() => { void query.refetch().then(() => refreshAudio()); }} /></div>}
      <Segmented className="mt-3" value={tab} onChange={setTab} options={[{ value: "overview", label: "전체 정리" }, { value: "pages", label: document.grouped ? "주제별 학습" : document.videoAnalysis || !lecture.slidesName ? "구간별 학습" : "장표별 학습" }, { value: "cards", label: "복습 카드" }, ...(transcriptUrl ? [{ value: "transcript" as const, label: "전사" }] : [])]} />
      {tab === "overview" && <div className="space-y-5 mt-5">
        <Card className="p-4"><SectionLabel tone="accent">이번 강의</SectionLabel><p className="mt-3 text-[15px] leading-relaxed whitespace-pre-wrap"><MathText text={document.overview} /></p></Card>
        {document.audience && <Card className="p-4"><h2 className="font-semibold">이 강의의 대상</h2><p className="mt-1 text-xs text-ink-3">강의 내용에서 추론한 수준에 맞춰 문제와 카드를 만들었습니다.</p><p className="mt-3 text-sm leading-relaxed">{document.audience.level}</p>{!!document.audience.priorKnowledge.length && <div className="mt-3 flex flex-wrap gap-1.5">{document.audience.priorKnowledge.map((item) => <span key={item} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-ink-2">{item}</span>)}</div>}<p className="mt-3 text-sm leading-relaxed text-ink-2"><span className="text-ink-3">강의 목표 </span><MathText text={document.audience.lectureGoal} /></p></Card>}
        <Card className="p-4"><h2 className="font-semibold mb-3">학습 목표</h2><Bullets items={document.learningObjectives} /></Card>
        <Card className="p-4"><h2 className="font-semibold mb-3">복습 순서</h2><ol className="space-y-3">{document.reviewPlan.map((step, i) => <li key={i} className="flex gap-3 text-sm leading-relaxed"><span className="shrink-0 text-accent font-semibold">{String(i + 1).padStart(2, "0")}</span>{step}</li>)}</ol></Card>
        <div><h2 className="font-semibold mb-3">{document.videoAnalysis ? "장표·영상 학습 목차" : !lecture.slidesName ? "음성 학습 목차" : document.grouped ? "학습 묶음 목차" : "장표 목차"}</h2><div className="space-y-2">{document.pages.map((p, i) => <button key={p.page} onClick={() => { setPageIndex(i); setTab("pages"); }} className="tap w-full flex items-center gap-3 bg-surface border border-line rounded-xl px-3 py-3 text-left"><span className="text-accent tabular-nums text-sm">{String(p.page).padStart(2, "0")}</span><span className="flex-1 text-sm">{p.source && <span className="block text-[10px] text-ink-3 mb-1">{p.source === "deck" ? `원본 ${p.sourcePages ? formatSlidePages(p.sourcePages) : p.deckPage}페이지` : p.source === "audio" ? `음성 ${hms(p.audioRanges?.[0]?.startSec ?? 0)}` : `영상 ${hms(p.videoRanges?.[0]?.startSec ?? 0)}`}</span>}{p.title}</span>{p.alignment.status !== "matched" && <span className="text-[10px] text-warning">{p.alignment.status === "unmatched" ? "구간 미확인" : "연결 확인"}</span>}<IconChevronRight size={14} /></button>)}</div></div>
        <div className="flex flex-wrap gap-2">{[[markdownUrl, "학습 자료 Markdown"], [flashcardsUrl, "복습 카드 CSV"], [slidesUrl, "원본 장표"]].map(([url, label]) => url && <a key={label} href={url} target="_blank" rel="noreferrer" className="tap inline-flex items-center gap-1.5 rounded-xl border border-line-2 px-3 py-3 text-[13px] text-ink-2"><IconExternal size={14} />{label}</a>)}</div>
        <div className="text-xs text-ink-3 leading-relaxed space-y-2">{document.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>
      </div>}
      {tab === "pages" && page && <div className="mt-4 space-y-4">
        <div className="flex items-center gap-2"><Button size="sm" variant="secondary" aria-label="이전 장표" disabled={pageIndex === 0} onClick={() => setPageIndex((i) => i - 1)}><IconChevronLeft size={16} /></Button><select aria-label="장표 선택" value={pageIndex} onChange={(e) => setPageIndex(Number(e.target.value))} className="min-w-0 flex-1 h-10 rounded-lg border border-line bg-surface px-2 text-sm">{document.pages.map((p, i) => <option key={p.page} value={i}>{p.sourcePages ? `${formatSlidePages(p.sourcePages)}페이지 · ` : `${p.page}. `}{p.title}</option>)}</select><Button size="sm" variant="secondary" aria-label="다음 장표" disabled={pageIndex === document.pages.length - 1} onClick={() => setPageIndex((i) => i + 1)}><IconChevronRight size={16} /></Button></div>
        {page.sourcePages && <p className="text-sm text-accent">원본 {formatSlidePages(page.sourcePages)}페이지 · 하나의 학습 묶음</p>}
        <SlideStudy key={page.page} page={page} images={pageImages.filter((image) => image.page === page.page)} seek={(time) => player.current?.seek(time)} />
      </div>}
      {tab === "cards" && <div className="mt-5 space-y-3"><p className="text-sm text-ink-3">먼저 답을 떠올린 뒤 카드를 펼쳐 확인하세요.</p>{document.pages.flatMap((p) => p.flashcards.map((card, i) => <details key={`${p.page}-${i}`} className="rounded-2xl bg-surface border border-line p-4"><summary className="cursor-pointer text-[15px] font-medium"><span className="block text-[11px] text-accent mb-2">{p.sourcePages ? `${formatSlidePages(p.sourcePages)}페이지` : `${p.page}장`} · {p.title}</span><MathText text={card.front} /></summary><p className="mt-4 border-t border-line pt-4 text-sm leading-relaxed whitespace-pre-wrap"><MathText text={card.back} /></p></details>))}</div>}
    </>}
    {transcriptUrl && (tab === "transcript" || !document) && <div className="mt-4"><Transcript title={lecture.title} transcriptUrl={transcriptUrl} audioUrl={videoUrl ? null : audioUrl} speakerLabels={{}} onSeek={videoUrl ? (time) => player.current?.seek(time) : undefined} onRefreshUrls={async () => (await query.refetch({ throwOnError: true })).data} /></div>}
    {!active && <Button full variant="danger" className="mt-10" loading={remove.isPending} icon={<IconTrash size={16} />} onClick={() => { if (confirm("이 강의의 영상·음성, 첨부 파일, 학습 자료를 모두 삭제할까요?")) remove.mutate(); }}>강의 삭제</Button>}
  </Page>;
}

const DIFFICULTY = { basic: "기본", understand: "이해", apply: "적용" } as const;

function SlideStudy({ page, images, seek }: { page: PageData; images: { url: string; sourcePage?: number }[]; seek: (time: number) => void }) {
  const [imageIndex, setImageIndex] = useState(0);
  const imageUrl = images[imageIndex]?.url;
  const status = page.alignment.status;
  return <>
    {images.length > 1 && <div className="flex flex-wrap gap-2" aria-label="묶음 안의 원본 장표">{images.map((image, i) =>
      <Button key={image.sourcePage ?? i} size="sm" variant={i === imageIndex ? "primary" : "secondary"} onClick={() => setImageIndex(i)}>{image.sourcePage}페이지</Button>)}</div>}
    <Card className="overflow-hidden">{imageUrl && <a href={imageUrl} target="_blank" rel="noreferrer" aria-label={`${page.title} 화면 크게 보기`}><img src={imageUrl} alt={page.title} loading="lazy" className="w-full h-auto bg-white" /></a>}<div className="p-4"><SectionLabel>{page.source === "audio" ? "음성 주제" : page.source === "video" ? "영상에서 확인한 화면" : `원본 ${page.sourcePages ? formatSlidePages(page.sourcePages) : page.deckPage ?? page.page}페이지`}</SectionLabel><h2 className="mt-2 font-semibold text-[18px]">{page.title}</h2>{page.sourceFile && <p className="mt-2 text-xs text-ink-3 break-words">원본: {page.sourceFile}</p>}{!!page.relatedPages?.length && <p className="mt-2 text-xs text-ink-3">관련 원본 장표: {page.relatedPages.map((ref) => `${ref.page}페이지 ${ref.topic}`).join(", ")}</p>}{!!page.audioRanges?.length && <div className="flex flex-wrap gap-2 mt-3">{page.audioRanges.map((range, i) => <button key={i} className="tap rounded-lg bg-accent-soft text-accent px-3 py-2 text-xs" onClick={() => seek(range.startSec)}>{hms(range.startSec)}–{hms(range.endSec)} 음성 듣기</button>)}</div>}<p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap"><MathText text={page.slideSummary} /></p>{!!page.videoRanges?.length && <div className="flex flex-wrap gap-2 mt-4">{page.videoRanges.map((range, i) => <button key={i} className="tap rounded-lg bg-accent-soft text-accent px-3 py-2 text-xs" onClick={() => seek(range.startSec)} aria-label={`영상 ${hms(range.startSec)}부터 보기`}>{hms(range.startSec)}–{hms(range.endSec)} 영상 보기</button>)}</div>}</div></Card>
    <Card className="p-4"><div className="flex items-center justify-between gap-2"><h3 className="font-semibold">수업에서 언급된 내용</h3><Pill tone={status === "matched" ? "success" : "warning"}>{status === "matched" ? "구간 연결" : status === "uncertain" ? "연결 확인 필요" : "구간 미확인"}</Pill></div><p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap"><MathText text={page.spokenSummary || (page.source === "audio" ? "이 음성 구간에서 전사된 발언이 없습니다." : page.source === "deck" ? "이 학습 묶음과 대응하는 발언을 녹음에서 찾지 못했습니다." : page.source ? page.videoRanges?.length ? "이 영상 구간에서 전사된 발언이 없습니다." : "영상에서 이 장표에 대응하는 구간을 확인하지 못했습니다." : "이 장표와 대응하는 발언을 녹음에서 찾지 못했습니다.")} /></p>{status !== "unmatched" && <p className="mt-3 text-xs text-ink-3">{page.alignment.method === "audio_time" ? "음성 시간 기준" : page.alignment.method === "video_time" ? "영상 시간 기준" : `연결 신뢰도 ${Math.round(page.alignment.confidence * 100)}%`} · {page.alignment.reason}</p>}
      {!!page.evidence.length && <details className="mt-4"><summary className="cursor-pointer text-sm text-accent">발언 근거 {page.evidence.length}개 보기</summary><ol className="mt-3 space-y-2 max-h-96 overflow-y-auto">{page.evidence.map((evidence) => <li key={evidence.segmentId}><button onClick={() => seek(evidence.start)} className="tap w-full text-left rounded-lg bg-surface-2 p-3"><span className="text-xs text-accent">{hms(evidence.start)} · {evidence.speaker}</span><span className="block mt-1 text-sm leading-relaxed">{evidence.text}</span></button></li>)}</ol></details>}
    </Card>
    <Card className="p-4"><h3 className="font-semibold">이해를 돕는 보충 설명</h3><p className="mt-1 text-xs text-ink-3">학습을 위해 AI가 덧붙인 설명입니다.</p><p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap"><MathText text={page.explanation} /></p></Card>
    {!!page.concepts.length && <Card className="p-4"><h3 className="font-semibold mb-4">핵심 개념</h3><dl className="space-y-4">{page.concepts.map((concept, i) => <div key={i}><dt className="text-sm font-semibold text-accent"><MathText text={concept.term} /></dt><dd className="mt-1.5 text-sm leading-relaxed text-ink-2"><MathText text={concept.explanation} /></dd></div>)}</dl></Card>}
    {!!page.mathNotes?.length && <Card className="p-4"><h3 className="font-semibold">수식과 정리</h3><p className="mt-1 mb-4 text-xs text-ink-3">원본 표기와 기호의 뜻을 확인하고, 유도 과정과 쉬운 예시로 이해합니다.</p><LectureMathNotes notes={page.mathNotes} /></Card>}
    {!!page.reviewQuestions.length && <Card className="p-4"><h3 className="font-semibold mb-3">이해했는지 확인하기</h3><div className="space-y-3">{page.reviewQuestions.map((question, i) => <details key={i} className="rounded-xl bg-surface-2 px-3 py-3"><summary className="cursor-pointer text-sm font-medium"><span className="mr-2 text-[11px] text-ink-3">{DIFFICULTY[question.difficulty ?? "basic"]}</span>{i + 1}. <MathText text={question.question} /></summary><p className="mt-3 text-sm leading-relaxed text-ink-2 whitespace-pre-wrap"><MathText text={question.answer} /></p></details>)}</div></Card>}
    <Card className="p-4"><h3 className="font-semibold">함께 읽을 논문</h3><p className="mt-1 text-xs text-ink-3">검색 결과를 바탕으로 선정했습니다. 원문에서 세부 내용을 확인하세요.</p>{page.research.status === "failed" ? <p className="mt-4 text-sm text-warning">논문 검색을 완료하지 못했습니다. 화면 위의 다시 시도로 검색만 다시 할 수 있습니다.</p> : !page.research.papers.length && <p className="mt-4 text-sm text-ink-3">참고 논문이 없습니다.</p>}<div className="space-y-4 mt-4">{page.research.papers.map((paper) => <article key={paper.url} className="border-t border-line pt-4 first:border-0 first:pt-0"><a href={paper.url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-accent underline underline-offset-4 break-words">{paper.title}<IconExternal size={13} className="inline ml-1" /></a>{paper.publishedDate && <p className="mt-1 text-xs text-ink-3">{paper.publishedDate}</p>}<p className="mt-2 text-sm leading-relaxed">{paper.relevance}</p><p className="mt-2 text-xs leading-relaxed text-ink-2">읽을 부분: {paper.readingFocus}</p></article>)}</div></Card>
  </>;
}
