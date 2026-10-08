import { useState } from "react";
import { useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatSlidePages, type GuestLectureResult } from "@meeting-notes/shared";
import { Button, Card, InlineError, Page, Skeleton } from "../components/ui";
import { MathText } from "../components/MathText";
import { LectureMathNotes } from "../components/LectureMathNotes";
import { LectureExportButton } from "../components/LecturePrint";
import { useConfig } from "../lib/use-config";

class GuestError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export function GuestLecturePage() {
  const { shareId = "" } = useParams(); const cfg = useConfig();
  const qc = useQueryClient();
  const [email, setEmail] = useState(""); const [code, setCode] = useState(""); const [challengeId, setChallengeId] = useState("");
  const [sent, setSent] = useState(false);
  const path = `/guest/lectures/${encodeURIComponent(shareId)}`;
  async function call<T>(suffix = "", body?: unknown): Promise<T> {
    const response = await fetch(`${cfg.apiBase}${suffix === "/logout" ? "/guest/logout" : path + suffix}`, {
      method: body === undefined ? "GET" : "POST", credentials: "include", cache: "no-store",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new GuestError(response.status, data.message ?? "공유 강의를 불러오지 못했습니다.");
    return data as T;
  }
  const q = useQuery({ queryKey: ["guest-lecture", shareId], queryFn: () => call<GuestLectureResult>(), retry: false,
    refetchInterval: (query) => query.state.data && !query.state.error ? 30_000 : false });
  const request = useMutation({ mutationFn: () => call<{ challengeId: string }>("/request-code", { email: email.trim().toLowerCase() }),
    onSuccess: (result) => { setChallengeId(result.challengeId); setCode(""); setSent(true); verify.reset(); } });
  const verify = useMutation({ mutationFn: () => call("/verify-code", { challengeId, code }),
    onSuccess: async () => { setCode(""); await qc.resetQueries({ queryKey: ["guest-lecture"] }); } });
  const logout = useMutation({ mutationFn: () => call("/logout", {}), onSuccess: async () => {
    setChallengeId(""); setCode(""); setSent(false); await qc.resetQueries({ queryKey: ["guest-lecture"] });
  } });
  const busy = request.isPending || verify.isPending;
  const error = request.error ?? verify.error;
  if (q.isLoading) return <div className="mx-auto h-dvh max-w-3xl overflow-y-auto pb-8"><Page title="공유 강의"><Skeleton className="h-36" /></Page></div>;
  if (!q.data || q.error) return <div className="mx-auto h-dvh max-w-3xl overflow-y-auto pb-8 safe-top"><Page title="공유 강의 열람" subtitle="초대된 이메일로 인증해 주세요">
    <Card className="p-5 space-y-4">
      <p className="text-sm text-ink-2">공유자가 지정한 이메일로 인증 코드를 보냅니다. 비밀번호는 필요하지 않습니다.</p>
      {q.error instanceof GuestError && q.error.status !== 401 && <InlineError>{q.error.message}</InlineError>}
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (challengeId) verify.mutate(); else request.mutate(); }}>
        <label className="block text-sm">이메일<input aria-label="게스트 이메일" type="email" autoComplete="email" required maxLength={254} readOnly={!!challengeId}
          value={email} onChange={(e) => setEmail(e.target.value)} className="mt-2 h-12 w-full rounded-xl border border-line bg-surface px-3 text-[16px]" /></label>
        {sent && <p role="status" className="text-sm text-ink-2">초대된 이메일이라면 인증 메일을 보냈습니다. 받은 편지함과 스팸함을 확인해 주세요.</p>}
        {challengeId && <label className="block text-sm">인증 코드<input aria-label="인증 코드" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} pattern="[A-Za-z0-9]{6,8}" required maxLength={8}
          value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))} className="mt-2 h-12 w-full rounded-xl border border-line bg-surface px-3 text-[18px] tracking-widest" />
          <span className="block mt-2 text-xs text-ink-3">메일로 받은 코드를 생략하지 말고 5분 안에 입력해 주세요.</span></label>}
        {error && <InlineError>{error.message}</InlineError>}
        <Button full type="submit" loading={busy} disabled={!email.trim() || (!!challengeId && !/^[A-Za-z0-9]{6,8}$/.test(code))}>{challengeId ? "인증하고 강의 열기" : "인증 코드 받기"}</Button>
        {challengeId && <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={() => request.mutate()}>코드 다시 받기</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setChallengeId(""); setCode(""); setSent(false); request.reset(); verify.reset(); }}>다른 이메일 사용</Button></div>}
      </form>
    </Card>
  </Page></div>;
  const { document, images, expiresAt } = q.data;
  return <div className="mx-auto h-dvh max-w-3xl overflow-y-auto pb-8 safe-top"><Page title={document.title} subtitle={document.course || "공유된 강의 학습 자료"}>
    <div className="flex items-center justify-between gap-3 text-xs text-ink-3"><span>{expiresAt.slice(0, 10)}까지 열람</span>
      <Button size="sm" variant="ghost" loading={logout.isPending} onClick={() => logout.mutate()}>열람 종료</Button></div>
    {document.selectedPages && <p className="mt-3 text-sm text-accent">원본 {formatSlidePages(document.selectedPages)}페이지 · 학습 묶음 {document.pages.length}개</p>}
    <LectureExportButton document={document} />
    <Card className="mt-4 p-4"><h2 className="font-semibold mb-3">강의 정리</h2><p className="whitespace-pre-wrap text-sm leading-relaxed"><MathText text={document.overview} /></p></Card>
    <div className="space-y-4 mt-4">{document.pages.map((page) => <details key={page.page} className="rounded-2xl border border-line bg-surface p-4">
      <summary className="cursor-pointer font-semibold"><span className="block mb-1 text-xs text-accent">{page.sourcePages ? `${formatSlidePages(page.sourcePages)}페이지` : `학습 항목 ${page.page}`}</span>{page.title}</summary>
      <div className="mt-4 space-y-5">
        <div className="flex gap-3 overflow-x-auto">{images.filter((image) => image.page === page.page).map((image) => <figure key={image.url} className="min-w-[85%]">
          <img src={image.url} alt={image.sourcePage ? `원본 ${image.sourcePage}페이지` : page.title} loading="lazy" className="w-full rounded-lg bg-white" onError={() => void q.refetch()} />
          {image.sourcePage && <figcaption className="mt-1 text-xs text-ink-3">{image.sourcePage}페이지</figcaption>}</figure>)}</div>
        {[["핵심 내용", page.slideSummary], ["수업에서 언급된 내용", page.spokenSummary], ["이해를 돕는 설명", page.explanation]].map(([title, text]) => text && <div key={title}><h3 className="font-semibold text-sm mb-2">{title}</h3><p className="text-sm leading-relaxed whitespace-pre-wrap"><MathText text={text} /></p></div>)}
        {!!page.mathNotes?.length && <div><h3 className="font-semibold mb-3">수식과 정리</h3><LectureMathNotes notes={page.mathNotes} /></div>}
        {!!page.reviewQuestions.length && <div><h3 className="font-semibold mb-3">복습 질문</h3>{page.reviewQuestions.map((item, i) => <details key={i} className="my-2 rounded-lg bg-surface-2 p-3 text-sm"><summary className="cursor-pointer"><MathText text={item.question} /></summary><p className="mt-3"><MathText text={item.answer} /></p></details>)}</div>}
        {!!page.research.papers.length && <div><h3 className="font-semibold mb-2">참고 논문</h3>{page.research.papers.map((paper) => <a key={paper.url} href={paper.url} target="_blank" rel="noreferrer" className="block my-2 text-sm text-accent">{paper.title}</a>)}</div>}
      </div>
    </details>)}</div>
  </Page></div>;
}
