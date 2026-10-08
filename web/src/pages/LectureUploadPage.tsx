import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LECTURE_LIMITS, SLIDE_TYPES, createLectureSchema, type CreateLectureResponse, type OutputLanguage } from "@meeting-notes/shared";
import { useApi } from "../lib/api";
import { uploadMultipart, type UploadedPart } from "../lib/upload";
import { Button, Card, InlineError, ProgressBar, SectionLabel, Segmented } from "../components/ui";
import { IconVideo, IconStudy, IconFileAudio } from "../components/icons";

/** Lecture media and optional deck upload, with resumable multipart completion. */
export function LectureUploadForm() {
  const api = useApi(); const nav = useNavigate(); const qc = useQueryClient();
  const [title, setTitle] = useState(""); const [course, setCourse] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [slideRange, setSlideRange] = useState("");
  const [mediaKind, setMediaKind] = useState<"video" | "audio">("video");
  const [media, setMedia] = useState<File | null>(null); const [slides, setSlides] = useState<File | null>(null);
  const slidesInput = useRef<HTMLInputElement>(null); const [badSlides, setBadSlides] = useState(false);
  const [language, setLanguage] = useState<OutputLanguage>("ko"); const [hint, setHint] = useState("auto");
  const [progress, setProgress] = useState(0); const [busy, setBusy] = useState(false); const [phase, setPhase] = useState("");
  const [error, setError] = useState(""); const [plan, setPlan] = useState<CreateLectureResponse | null>(null);
  const [uploaded, setUploaded] = useState({ video: false, audio: false, slides: false });
  const [completedParts, setCompletedParts] = useState<Partial<Record<"video" | "audio" | "slides", UploadedPart[]>>>({});
  const isVideo = mediaKind === "video";
  const mediaLabel = isVideo ? "강의 영상" : "강의 음성";
  async function submit() {
    if (!media || badSlides) return;
    setError(""); setBusy(true);
    try {
      const parsed = createLectureSchema.safeParse({ title, course, customPrompt, slideRange: slides ? slideRange : "", outputLanguage: language, languageHint: hint,
        [mediaKind]: { fileName: media.name, fileSize: media.size, contentType: isVideo ? "video/mp4" : "audio/mpeg" },
        slides: slides ? { fileName: slides.name, fileSize: slides.size, contentType: /\.pdf$/i.test(slides.name) ? SLIDE_TYPES.pdf : SLIDE_TYPES.pptx } : undefined });
      if (!parsed.success) throw new Error(parsed.error.issues.map((x) => x.message).join(", "));
      const created = plan ?? await api.createLecture(parsed.data); setPlan(created);
      for (const asset of ["slides", mediaKind] as const) {
        const target = created.uploads[asset]; const file = asset === "slides" ? slides : media;
        if (!file) continue;
        if (!target) throw new Error("파일 업로드 정보를 받지 못했습니다. 다시 시도하세요.");
        if (uploaded[asset]) continue;
        if (!completedParts[asset] && Date.now() > Date.parse(target.expiresAt)) throw new Error("업로드 링크가 만료되었습니다. 아래 강의를 삭제하고 새로 등록하세요.");
        setPhase(asset === "slides" ? "첨부 장표 업로드" : `${mediaLabel} 업로드`); setProgress(0);
        const parts = completedParts[asset] ?? await uploadMultipart(file, target, setProgress);
        setCompletedParts((previous) => ({ ...previous, [asset]: parts }));
        await api.completeLectureUpload(created.lecture.lectureId, { asset, uploadId: target.uploadId, parts });
        setUploaded((previous) => ({ ...previous, [asset]: true }));
      }
      setPhase("강의 분석 시작");
      await api.startLecture(created.lecture.lectureId);
      await qc.invalidateQueries({ queryKey: ["lectures"] });
      nav(`/lectures/${created.lecture.lectureId}`);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  function chooseMedia(file: File | null) {
    if (file && (!(isVideo ? /\.mp4$/i : /\.mp3$/i).test(file.name) || file.size === 0 || file.size > (isVideo ? LECTURE_LIMITS.maxVideoBytes : LECTURE_LIMITS.maxAudioBytes))) {
      setMedia(null); setError(isVideo ? "MP4 영상을 선택하세요. 최대 4GB입니다." : "MP3 음성을 선택하세요. 최대 500MB입니다."); return;
    }
    setMedia(file); setError(""); if (file && !title) setTitle(file.name.replace(/\.(mp4|mp3)$/i, ""));
  }
  function chooseSlides(file: File | null) {
    if (file && (!/\.(pptx|pdf)$/i.test(file.name) || file.size > LECTURE_LIMITS.maxSlidesBytes)) { setSlides(null); setBadSlides(true); setError("PPTX 또는 PDF를 선택하세요. 최대 100MB입니다."); return; }
    setSlides(file); setBadSlides(false); setError("");
  }
  const inputClass = "mt-2 w-full rounded-xl bg-surface border border-line px-3 h-12 text-[16px] focus:outline-none focus:border-accent";
  return <>
    <fieldset disabled={busy || !!plan} className="space-y-5 disabled:opacity-60">
      <div><SectionLabel>강의 파일 형식</SectionLabel><Segmented className="mt-2" value={mediaKind} onChange={(next) => { setMediaKind(next); setMedia(null); setError(""); }} options={[{ value: "video", label: "영상 MP4", icon: <IconVideo size={15} /> }, { value: "audio", label: "음성 MP3", icon: <IconFileAudio size={15} /> }]} /></div>
      <Card className="p-4"><label className="block"><span className="flex items-center gap-2 font-semibold">{isVideo ? <IconVideo className="text-accent" /> : <IconFileAudio className="text-accent" />}{mediaLabel}</span><span className="block mt-1 text-xs text-ink-3">{isVideo ? "MP4 · 최대 4GB, 4시간, 4K" : "MP3 · 최대 500MB, 4시간"}</span><input key={mediaKind} aria-label={mediaLabel} type="file" accept={isVideo ? "video/mp4,.mp4" : "audio/mpeg,.mp3"} className="block mt-3 w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-surface-3 file:px-3 file:py-2 file:text-ink" onChange={(e) => chooseMedia(e.target.files?.[0] ?? null)} /></label></Card>
      <Card className="p-4"><label className="block"><span className="flex items-center gap-2 font-semibold"><IconStudy className="text-accent" />장표 첨부 <span className="text-xs font-normal text-ink-3">선택</span></span><span className="block mt-1 text-xs text-ink-3">PPTX 또는 PDF · 최대 100MB, 120장</span><input ref={slidesInput} aria-label="강의 장표 (선택)" type="file" accept=".pptx,.pdf" className="block mt-3 w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-surface-3 file:px-3 file:py-2 file:text-ink" onChange={(e) => chooseSlides(e.target.files?.[0] ?? null)} /></label><p className="text-xs text-ink-3 leading-relaxed mt-3">{isVideo ? "첨부하면 영상 속 화면을 원본 장표와 대조합니다. 장표 없이 영상만 올려도 분석할 수 있습니다." : "첨부하면 발언과 장표를 연결해 이론과 수식을 설명합니다. 장표 없이 음성만 올리면 발언을 주제별로 정리합니다."}</p>{(slides || badSlides) && <Button variant="ghost" size="sm" className="mt-2" onClick={() => { chooseSlides(null); if (slidesInput.current) slidesInput.current.value = ""; }}>첨부 취소</Button>}</Card>
      <label className="block"><SectionLabel>강의 제목</SectionLabel><input aria-label="강의 제목" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 머신러닝 3주차 — 최적화" className={inputClass} /></label>
      <label className="block"><SectionLabel>과목명 (선택)</SectionLabel><input aria-label="과목명" maxLength={120} value={course} onChange={(e) => setCourse(e.target.value)} placeholder="예: 고급 머신러닝" className={inputClass} /></label>
      {slides && <label className="block"><SectionLabel>분석할 페이지 (선택)</SectionLabel>
        <input aria-label="분석할 페이지 (선택)" value={slideRange} onChange={(e) => setSlideRange(e.target.value)} maxLength={200} placeholder="예: 38-47 또는 3-8, 12-15" className={inputClass} />
        <span className="block mt-2 text-xs text-ink-3 leading-relaxed">지정한 페이지만 분석합니다. 비워 두면 추가 요청에 적은 범위를 따르며, 범위 지정이 없으면 전체 장표를 주제별로 묶어 정리합니다. 첨부파일의 첫 장이 1페이지입니다.</span>
      </label>}
      <label className="block"><SectionLabel>추가 요청 (선택)</SectionLabel>
        <textarea aria-label="추가 요청 (선택)" aria-describedby="lecture-custom-prompt-help" maxLength={LECTURE_LIMITS.maxCustomPromptChars} rows={4}
          value={customPrompt} onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder="예: 38–47페이지만 정리하고, 이어지는 장표는 묶어서 수식의 의미와 유도를 쉽게 설명해 주세요."
          className="mt-2 w-full rounded-xl bg-surface border border-line px-3 py-3 text-[16px] focus:outline-none focus:border-accent" />
        <span id="lecture-custom-prompt-help" className="block mt-2 text-xs text-ink-3 leading-relaxed">원하는 설명 방식이나 범위를 적어주세요. ‘분석할 페이지’를 입력했다면 그 범위가 우선합니다. 연결된 내용은 주제별로 묶고, 개요나 반복 내용은 짧게 정리합니다.</span>
        <span className="block mt-1 text-right text-xs text-ink-3">{customPrompt.length.toLocaleString()} / {LECTURE_LIMITS.maxCustomPromptChars.toLocaleString()}</span>
      </label>
      <div><SectionLabel>학습 자료 언어</SectionLabel><Segmented className="mt-2" value={language} onChange={setLanguage} options={[{ value: "ko", label: "한국어" }, { value: "en", label: "English" }, { value: "auto", label: "강의 언어" }]} /></div>
      <label className="block"><SectionLabel>강의에서 사용하는 언어</SectionLabel><select aria-label="강의 언어" className={inputClass} value={hint} onChange={(e) => setHint(e.target.value)}><option value="auto">자동 감지</option><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="zh">中文</option></select></label>
    </fieldset>
    {busy && <div className="mt-5" role="status"><p className="text-sm text-ink-2 mb-2">{phase} {progress}%</p><ProgressBar value={progress} /></div>}
    {error && <InlineError>{error}</InlineError>}
    <Button full className="mt-6" loading={busy} disabled={!media || badSlides || !title.trim()} onClick={() => void submit()}>{plan ? "업로드 이어서 진행" : "학습 자료 만들기"}</Button>
    {plan && !busy && <Link className="block text-center text-sm text-ink-3 mt-3" to={`/lectures/${plan.lecture.lectureId}`}>등록된 강의 보기 / 삭제</Link>}
    <p className="mt-3 text-xs text-ink-3 leading-relaxed">업로드가 끝나면 앱을 닫아도 됩니다. 강의 내용을 쉽게 풀어 설명하고, 수식의 기호와 유도 과정을 포함한 복습 자료를 만듭니다.</p>
  </>;
}
