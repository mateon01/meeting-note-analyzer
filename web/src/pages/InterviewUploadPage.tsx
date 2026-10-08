import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { createInterviewSchema, INTERVIEW_LIMITS, type CreateInterviewResponse } from "@meeting-notes/shared";
import { useApi } from "../lib/api";
import { uploadMultipart, type UploadedPart } from "../lib/upload";
import { DEFAULT_INTERVIEW_SETTINGS, InterviewSettingsForm, interviewInputClass } from "../components/InterviewSettings";
import { Button, Card, InlineError, ProgressBar, SectionLabel } from "../components/ui";

export function InterviewUploadForm() {
  const api = useApi(); const nav = useNavigate(); const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null); const [title, setTitle] = useState("");
  const [resume, setResume] = useState<File | null>(null); const [badResume, setBadResume] = useState(false); const resumeInput = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState(DEFAULT_INTERVIEW_SETTINGS); const [languageHint, setLanguageHint] = useState("auto");
  const [plan, setPlan] = useState<CreateInterviewResponse | null>(null);
  const [parts, setParts] = useState<Partial<Record<"audio" | "resume", UploadedPart[]>>>({});
  const [uploaded, setUploaded] = useState({ audio: false, resume: false });
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(0); const [error, setError] = useState("");
  async function submit() {
    if (!file || badResume) return;
    setBusy(true); setError("");
    try {
      const input = createInterviewSchema.parse({ title, languageHint, settings, audio: { fileName: file.name, fileSize: file.size, contentType: "audio/mpeg" },
        resume: resume ? { fileName: resume.name, fileSize: resume.size, contentType: "application/pdf" } : undefined });
      const created = plan ?? await api.createInterview(input); setPlan(created);
      for (const asset of ["resume", "audio"] as const) {
        const selected = asset === "resume" ? resume : file;
        const target = asset === "resume" ? created.resumeUpload : created.upload;
        if (!selected || uploaded[asset]) continue;
        if (!target) throw new Error("파일 업로드 정보를 받지 못했습니다.");
        if (!parts[asset] && Date.now() > Date.parse(target.expiresAt)) throw new Error("업로드 링크가 만료되었습니다. 등록된 인터뷰를 삭제하고 다시 업로드하세요.");
        const completed = parts[asset] ?? await uploadMultipart(selected, target, setProgress);
        setParts((previous) => ({ ...previous, [asset]: completed }));
        await api.completeInterviewUpload(created.interview.interviewId, { asset, uploadId: target.uploadId, parts: completed });
        setUploaded((previous) => ({ ...previous, [asset]: true }));
      }
      await api.startInterview(created.interview.interviewId);
      await qc.invalidateQueries({ queryKey: ["interviews"] });
      nav(`/interviews/${created.interview.interviewId}`);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <>
    <fieldset disabled={busy || !!plan} className="space-y-5 disabled:opacity-60">
      <Card className="p-4"><label className="block font-semibold">인터뷰 녹음 <span className="block mt-1 text-xs text-ink-3 font-normal">MP3 · 최대 500MB, 4시간 · 한 후보자의 인터뷰</span><input aria-label="인터뷰 녹음" type="file" accept="audio/mpeg,.mp3" className="mt-3 block w-full text-sm font-normal file:mr-3 file:rounded-lg file:border-0 file:bg-surface-3 file:px-3 file:py-2 file:text-ink" onChange={(e) => {
        const selected = e.target.files?.[0] ?? null;
        if (selected && (!/\.mp3$/i.test(selected.name) || !selected.size || selected.size > INTERVIEW_LIMITS.maxAudioBytes)) { setFile(null); setError("최대 500MB의 MP3 파일을 선택하세요."); return; }
        setFile(selected); setError(""); if (selected && !title) setTitle(selected.name.replace(/\.mp3$/i, ""));
      }} /></label></Card>
      <Card className="p-4"><label className="block font-semibold">후보자 이력서 <span className="text-xs font-normal text-ink-3">선택</span><span className="block mt-1 text-xs text-ink-3 font-normal">PDF · 최대 20MB, 20페이지</span><input ref={resumeInput} aria-label="후보자 이력서 (선택)" type="file" accept="application/pdf,.pdf" className="block mt-3 w-full text-sm font-normal file:mr-3 file:rounded-lg file:border-0 file:bg-surface-3 file:px-3 file:py-2 file:text-ink" onChange={(e) => {
        const selected = e.target.files?.[0] ?? null;
        if (selected && (!/\.pdf$/i.test(selected.name) || !selected.size || selected.size > INTERVIEW_LIMITS.maxResumeBytes)) { setResume(null); setBadResume(true); setError("이력서는 최대 20MB의 PDF를 선택하세요."); return; }
        setResume(selected); setBadResume(false); setError("");
      }} /></label><p className="mt-3 text-xs text-ink-3 leading-relaxed">이력서는 질문과 답변을 이해하는 배경으로 사용합니다. 주장 대비 역량 격차가 확인되면 해당 항목의 감점 근거로 반영하고, 질문하지 않은 내용은 미검증으로 남깁니다.</p>{(resume || badResume) && <Button size="sm" variant="ghost" className="mt-2" onClick={() => { setResume(null); setBadResume(false); setError(""); if (resumeInput.current) resumeInput.current.value = ""; }}>이력서 첨부 취소</Button>}</Card>
      <label className="block"><SectionLabel>인터뷰 제목</SectionLabel><input aria-label="인터뷰 제목" className={interviewInputClass} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: ML 엔지니어 기술 인터뷰" /></label>
      <label className="block"><SectionLabel>녹음에서 사용하는 언어</SectionLabel><select aria-label="인터뷰 녹음 언어" className={interviewInputClass} value={languageHint} onChange={(e) => setLanguageHint(e.target.value)}><option value="auto">자동 감지</option><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="zh">中文</option></select></label>
      <InterviewSettingsForm value={settings} onChange={setSettings} />
    </fieldset>
    {busy && <div className="mt-4" role="status"><p className="text-sm mb-2">업로드 및 인터뷰 분석 준비 {progress}%</p><ProgressBar value={progress} /></div>}
    {error && <InlineError>{error}</InlineError>}
    <Button full className="mt-6" loading={busy} disabled={!file || badResume || !title.trim() || !settings.criteria.length} onClick={() => void submit()}>{plan ? "업로드 이어서 진행" : "인터뷰 노트 만들기"}</Button>
    {plan && !busy && <Link to={`/interviews/${plan.interview.interviewId}`} className="block mt-3 text-center text-sm text-accent">등록된 인터뷰 보기 / 삭제</Link>}
    <p className="mt-3 text-xs text-ink-3 leading-relaxed">질문·후속 질문·후보자 답변을 정리하고, 힌트와 정정은 별도로 기록합니다. AI 의견은 발언 근거를 확인한 뒤 면접관이 검토하는 초안입니다.</p>
  </>;
}
