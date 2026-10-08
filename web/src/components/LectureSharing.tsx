import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLectureShareSchema } from "@meeting-notes/shared";
import { useApi } from "../lib/api";
import { Button, Card, InlineError } from "./ui";

export function LectureSharing({ lectureId, open, onClose }: { lectureId: string; open: boolean; onClose: () => void }) {
  const [emails, setEmails] = useState(""); const [days, setDays] = useState(30);
  const panel = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(""); const [copyError, setCopyError] = useState("");
  const api = useApi(); const qc = useQueryClient();
  const key = ["lecture-shares", lectureId];
  const q = useQuery({ queryKey: key, queryFn: () => api.listLectureShares(lectureId), enabled: open });
  const create = useMutation({
    mutationFn: () => { const input = createLectureShareSchema.parse({ emails: emails.split(/[\s,;]+/).filter(Boolean), expiresInDays: days });
      return api.createLectureShare(lectureId, input.emails, input.expiresInDays); },
    onSuccess: () => { setEmails(""); void qc.invalidateQueries({ queryKey: key }); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeLectureShare(lectureId, id), onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
  useEffect(() => {
    if (open) panel.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [open]);
  async function copy(url: string) {
    setCopyError("");
    try { await navigator.clipboard.writeText(url); setCopied(url); }
    catch { setCopyError("링크를 선택해서 복사해 주세요."); }
  }
  if (!open) return null;
  return <section ref={panel} id="lecture-sharing" aria-label="게스트 공유 설정" className="mt-3 scroll-mt-3">
    <Card className="p-4 space-y-4">
      <div><div className="flex items-center justify-between gap-2"><h2 className="font-semibold">게스트 공유</h2><Button size="sm" variant="ghost" onClick={onClose}>닫기</Button></div>
        <p className="mt-2 text-sm text-ink-2">지정한 이메일로 인증한 게스트가 이 강의의 학습 노트와 장표를 볼 수 있습니다. 비밀번호는 필요하지 않습니다.</p></div>
      <label className="block text-sm">초대할 이메일
        <textarea aria-label="초대할 이메일" value={emails} onChange={(e) => setEmails(e.target.value)} rows={3} maxLength={5100}
          placeholder="guest@example.com&#10;여러 주소는 줄바꿈이나 쉼표로 구분하세요."
          className="mt-2 w-full rounded-xl border border-line bg-surface px-3 py-2 text-[16px]" />
      </label>
      <label className="block text-sm">공유 기간
        <select aria-label="공유 기간" value={days} onChange={(e) => setDays(Number(e.target.value))} className="ml-3 rounded-lg border border-line bg-surface p-2">
          <option value={7}>7일</option><option value={30}>30일</option><option value={90}>90일</option>
        </select>
      </label>
      <Button loading={create.isPending} disabled={!emails.trim()} onClick={() => create.mutate()}>공유 링크 만들기</Button>
      <p className="text-xs text-ink-3">링크를 게스트에게 전달하세요. 게스트가 링크에서 인증을 요청하면 초대된 이메일로 코드를 보냅니다.</p>
      {create.error && <InlineError>{create.error.name === "ZodError" ? "올바른 이메일 주소를 최대 20개 입력해 주세요." : create.error.message}</InlineError>}
      {(q.error || revoke.error) && <InlineError>{(q.error ?? revoke.error)?.message}</InlineError>}
      {copyError && <InlineError>{copyError}</InlineError>}
      <div className="space-y-3">{q.data?.items.map((share) => {
        const inactive = !!share.revokedAt || Date.parse(share.expiresAt) <= Date.now();
        return <div key={share.shareId} className="rounded-xl border border-line p-3 text-sm">
          <p className="break-all">{share.emails.join(", ")}</p><p className="mt-1 text-xs text-ink-3">{inactive ? "공유 종료" : `${share.expiresAt.slice(0, 10)}까지`}</p>
          {!inactive && <><input aria-label="공유 링크" readOnly value={share.url} onFocus={(e) => e.target.select()} className="mt-2 w-full rounded-lg bg-surface-2 px-2 py-2 text-xs" />
            <div className="flex gap-2 mt-2"><Button size="sm" variant="secondary" onClick={() => void copy(share.url)}>{copied === share.url ? "복사됨" : "링크 복사"}</Button>
              <Button size="sm" variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(share.shareId)}>공유 해제</Button></div></>}
        </div>;
      })}</div>
    </Card>
  </section>;
}
