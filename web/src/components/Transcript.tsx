import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SpeakerCorrection, Transcript as TranscriptDoc } from "@meeting-notes/shared";
import { urlPath, useStableUrl } from "../lib/stable-url";
import { correctionTitle, reviewReasons } from "../lib/speaker-review";
import { downloadTranscript } from "../lib/transcript-export";
import { AudioPlayer, hms, type AudioPlayerHandle } from "./AudioPlayer";
import { Avatar, Button, InlineError, Skeleton, speakerColorClass } from "./ui";

interface Props {
  title?: string;
  transcriptUrl: string;
  originalTranscriptUrl?: string | null;
  transcriptRevision?: string;
  audioUrl: string | null;
  speakerLabels: Record<string, string>;
  speakerRoleLabels?: Record<string, string>;
  /** Unconfirmed name proposals (id -> label): shown as a hint next to the acoustic label, never as the identity. */
  proposedLabels?: Record<string, string>;
  confirmedSpeakerNames?: string[];
  onRefreshUrls?: () => Promise<{ transcriptUrl?: string | null; originalTranscriptUrl?: string | null; audioUrl?: string | null } | undefined>;
  onSeek?: (time: number) => void;
}

export function Transcript({ title = "전사", transcriptUrl, originalTranscriptUrl, transcriptRevision, audioUrl, speakerLabels, speakerRoleLabels, proposedLabels = {}, confirmedSpeakerNames = [], onRefreshUrls, onSeek }: Props) {
  const [showOriginal, setShowOriginal] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);
  const original = showOriginal && !!originalTranscriptUrl;
  const selectedUrl = original ? originalTranscriptUrl! : transcriptUrl;
  const [audioOverride, setAudioOverride] = useState<{ path: string | null; url: string } | null>(null);
  const [stableAudio, refreshAudio] = useStableUrl(audioOverride && audioOverride.path === urlPath(audioUrl) ? audioOverride.url : audioUrl);
  const audioRecoveryUsed = useRef(false);
  const recoveringAudio = useRef(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [current, setCurrent] = useState(0);
  const [downloadError, setDownloadError] = useState("");
  const player = useRef<AudioPlayerHandle>(null);

  const recoverAudio = async (manual = false) => {
    if (recoveringAudio.current) return;
    if (audioRecoveryUsed.current && !manual) {
      setAudioError("오디오 연결을 복구하지 못했습니다. 다시 시도해 주세요.");
      return;
    }
    audioRecoveryUsed.current = true;
    recoveringAudio.current = true;
    player.current?.preservePosition?.();
    setAudioLoading(true); setAudioError(null);
    try {
      const result = await onRefreshUrls?.();
      if (!result?.audioUrl || result.audioUrl === stableAudio) throw new Error("오디오 연결을 새로 받지 못했습니다. 잠시 후 다시 시도해 주세요.");
      setAudioOverride({ path: urlPath(audioUrl), url: result.audioUrl });
      refreshAudio();
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "오디오 연결에 실패했습니다.");
    } finally {
      recoveringAudio.current = false;
      setAudioLoading(false);
    }
  };

  // Signatures rotate while polling; object revisions change only when content does.
  // Use the latest signed URL when a fetch is actually necessary.
  const q = useQuery({
    queryKey: ["transcript", urlPath(selectedUrl), transcriptRevision ?? "legacy"],
    queryFn: async () => {
      let r = await fetch(selectedUrl, { cache: "no-store" });
      // Opening an old tab can use an expired signature. Renew it once through
      // the authenticated API, without depending on a parent rerender's timing.
      if (r.status === 403 && onRefreshUrls) {
        const result = await onRefreshUrls();
        const renewed = original ? result?.originalTranscriptUrl : result?.transcriptUrl;
        if (renewed) r = await fetch(renewed, { cache: "no-store" });
      }
      if (!r.ok) throw new Error(`전사를 불러오지 못했습니다 (${r.status})`);
      return (await r.json()) as TranscriptDoc;
    },
    staleTime: Infinity,
  });
  const data = q.data;
  const speakerIds = useMemo(() => Array.from(new Set((data?.segments ?? []).map((s) => s.speaker))), [data]);
  const label = (id: string) => speakerRoleLabels ? speakerRoleLabels[id] ?? "미확인 화자" : original ? id : speakerLabels[id] ?? data?.speakers.find((s) => s.id === id)?.label ?? id;
  const hint = (id: string) => (original ? undefined : proposedLabels[id]);
  const corrections = (original ? [] : data?.speakerAttribution?.corrections ?? []).filter((c) =>
    !(c.kind === "label" && confirmedSpeakerNames.includes(c.to)));
  const reviewItems = corrections.filter((c) => c.status === "review_required");
  const filteringReview = reviewOnly && reviewItems.length > 0;
  const correctionById = new Map(corrections.map((c) => [c.id, c]));
  const correctionsFor = (seg: TranscriptDoc["segments"][number]) => (seg.speakerCorrectionIds ?? [])
    .map((id) => correctionById.get(id)).filter((c): c is SpeakerCorrection => !!c);
  const segments = (data?.segments ?? []).filter((seg) => !filteringReview || correctionsFor(seg).some((c) => c.status === "review_required"));
  const seekTime = (time: number) => onSeek ? onSeek(time) : player.current?.seek(time);
  const seek = (id: string) => {
    const seg = data?.segments.find((s) => s.id === id);
    if (seg) seekTime(seg.start);
  };
  const exportOriginal = original || (!originalTranscriptUrl && !data?.attributed);
  const exportLabel = exportOriginal ? "원본 전사" : "보정 전사";
  function download(format: "txt" | "md") {
    if (!data) return;
    setDownloadError("");
    try { downloadTranscript(data, { title, variant: exportOriginal ? "original" : "corrected", format, speakerLabels, speakerRoleLabels, confirmedSpeakerNames }); }
    catch { setDownloadError("전사 파일을 저장하지 못했습니다. 다시 시도하세요."); }
  }

  return (
    <div>
      {stableAudio && (
        <div className="sticky top-0 z-10 -mx-4 px-4 pt-1 pb-2 bg-bg/95 backdrop-blur">
          <AudioPlayer ref={player} src={stableAudio} onTime={setCurrent} onError={() => { void recoverAudio(); }} />
          {audioLoading && <p className="mt-2 text-xs text-ink-3" role="status">오디오 연결을 다시 확인하고 있습니다.</p>}
          {audioError && <InlineError>{audioError}<button className="tap underline ml-2" onClick={() => { void recoverAudio(true); }}>오디오 다시 연결</button></InlineError>}
        </div>
      )}
      {originalTranscriptUrl && (
        <div className="flex gap-2 my-3" role="group" aria-label="전사 버전">
          <Button size="sm" variant={original ? "secondary" : "primary"} aria-pressed={!original} onClick={() => { setShowOriginal(false); setReviewOnly(false); }}>보정 전사</Button>
          <Button size="sm" variant={original ? "primary" : "secondary"} aria-pressed={original} onClick={() => { setShowOriginal(true); setReviewOnly(false); }}>원본 전사</Button>
        </div>
      )}
      {q.error && <InlineError>{(q.error as Error).message}<button className="tap underline ml-2" onClick={() => { void q.refetch(); }}>다시 불러오기</button></InlineError>}
      {!data && !q.error && <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>}
      {data && <>
        <div className="my-3"><p className="text-xs text-ink-3 mb-2">{exportLabel} 전체 다운로드 · 시간과 화자 포함</p><div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" aria-label={`${exportLabel} TXT 다운로드`} onClick={() => download("txt")}>TXT 다운로드</Button>
          <Button size="sm" variant="secondary" aria-label={`${exportLabel} Markdown 다운로드`} onClick={() => download("md")}>Markdown 다운로드</Button>
        </div>{downloadError && <InlineError>{downloadError}</InlineError>}</div>
        {original && <p className="text-xs text-ink-3 mb-3">음성 분석에서 구분한 원래 화자입니다. 발언 내용과 시간은 보정 전사와 같습니다.</p>}
        {!original && data.attributed && !data.speakerAttribution && <p className="text-xs text-ink-3 mb-3">이전 방식으로 보정된 전사입니다. 발언별 검토 정보는 없습니다. 원본과 비교해 확인해 주세요.</p>}
        {!original && data.speakerAttribution && (
          <div className="rounded-xl border border-line bg-surface p-3 mb-3 text-sm" aria-label="화자 보정 상태">
            <p className="font-semibold">화자 보정 {corrections.filter((c) => c.status === "applied").length}건 적용{reviewItems.length > 0 ? `, 검토 필요 ${reviewItems.length}건` : ""}</p>
            <p className="mt-1 text-xs text-ink-3">검토가 필요한 제안은 적용하지 않았습니다. 근거와 해당 음성을 확인해 주세요.</p>
            {reviewItems.some((c) => c.segmentIds.length > 0) && <label className="inline-flex items-center gap-2 mt-3 text-xs cursor-pointer"><input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} />검토 필요한 발언만 보기</label>}
            {reviewItems.filter((c) => c.segmentIds.length === 0).map((c) => <CorrectionDetails key={c.id} corrections={[c]} onSeek={seek} hasAudio={!!stableAudio} />)}
          </div>
        )}
        <div className="flex flex-wrap gap-2 mt-2 mb-3">
          {speakerIds.map((id, i) => (
            <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-surface border border-line pl-1 pr-2.5 py-1 text-xs">
              <Avatar name={label(id)} index={i} size={20} />
              <span className={`font-semibold ${speakerColorClass(i)}`}>{label(id)}</span>
              {hint(id) && <span className="text-[11px] text-ink-3">추정: {hint(id)}</span>}
            </span>
          ))}
        </div>
        {filteringReview && segments.length === 0 && <p className="text-sm text-ink-3">검토할 발언이 없습니다.</p>}
        <ol className="space-y-1">
          {segments.map((seg, idx) => {
            const active = current >= seg.start && current < seg.end;
            const si = speakerIds.indexOf(seg.speaker);
            const changes = correctionsFor(seg);
            const needsReview = changes.some((c) => c.status === "review_required");
            const newSpeaker = idx === 0 || segments[idx - 1]?.speaker !== seg.speaker;
            return (
              <li key={seg.id} data-segment-id={seg.id}>
                <button onClick={() => seekTime(seg.start)} className={`tap w-full text-left rounded-xl px-3 py-2 transition-colors ${active ? "bg-accent-soft ring-1 ring-accent/40" : "active:bg-surface"}`}>
                  {(newSpeaker || changes.length > 0) && (
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <Avatar name={label(seg.speaker)} index={si} size={22} />
                      <span className={`text-[12px] font-semibold ${speakerColorClass(si)}`}>{label(seg.speaker)}</span>
                      {hint(seg.speaker) && <span className="text-[11px] text-ink-3">추정: {hint(seg.speaker)}</span>}
                      {needsReview ? <span className="text-[11px] rounded border border-line px-1.5 py-0.5 text-ink">검토 필요</span> : changes.length > 0 && <span className="text-[11px] text-accent">보정됨</span>}
                    </div>
                  )}
                  <div className="flex gap-3">
                    <span className={`shrink-0 w-11 text-[11px] tabular-nums pt-0.5 ${active ? "text-accent" : "text-ink-3"}`}>{hms(seg.start)}</span>
                    <p className={`min-w-0 text-[14.5px] leading-relaxed [overflow-wrap:anywhere] ${active ? "text-ink" : "text-ink-2"}`}>{seg.text}</p>
                  </div>
                </button>
                {changes.length > 0 && <div className="px-3 pb-2"><CorrectionDetails corrections={changes} onSeek={seek} hasAudio={!!stableAudio} /></div>}
              </li>
            );
          })}
        </ol>
      </>}
    </div>
  );
}

function CorrectionDetails({ corrections, onSeek, hasAudio }: { corrections: SpeakerCorrection[]; onSeek: (id: string) => void; hasAudio: boolean }) {
  return <details className="mt-2 text-xs text-ink-2">
    <summary className="cursor-pointer text-ink-3">화자 보정 근거</summary>
    <ul className="mt-2 space-y-3">
      {corrections.map((c) => <li key={c.id} className="border-l-2 border-line pl-3">
        <p className="font-semibold">{correctionTitle(c)}: {c.status === "review_required" ? "검토 필요, 제안 미적용" : "적용됨"}</p>
        {c.reason && <p className="mt-1">{c.reason}</p>}
        {reviewReasons(c).map((reason, i) => <p key={i} className="mt-1">{reason}</p>)}
        {c.evidence.map((e, i) => <div key={i} className="mt-2"><blockquote className="whitespace-pre-wrap">“{e.quote}”</blockquote>{hasAudio && <button className="tap text-accent underline mt-1" onClick={() => onSeek(e.segmentId)}>근거 발언 듣기 ({e.segmentId})</button>}</div>)}
      </li>)}
    </ul>
  </details>;
}
