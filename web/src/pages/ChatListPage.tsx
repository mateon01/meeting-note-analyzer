import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ChatSessionDto, CreateChatSessionRequest } from "@meeting-notes/shared";
import { ChatScopePicker } from "../components/chat/ChatScopePicker";
import { useApi } from "../lib/api";
import { IconChat, IconChevronRight, IconPlus, IconTrash } from "../components/icons";
import { Button, Card, EmptyState, InlineError, Page, Pill, Skeleton, formatDate } from "../components/ui";

export function BetaBadge() {
  return <span className="inline-flex h-[18px] items-center rounded-md border border-violet/50 bg-violet/15 px-1.5 text-[10px] font-bold tracking-wide text-violet">BETA</span>;
}

export function ChatListPage() {
  const api = useApi();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [scope, setScope] = useState<CreateChatSessionRequest>({ sourceType: "meeting" });
  const q = useQuery({ queryKey: ["chat-sessions"], queryFn: () => api.listChatSessions() });
  const create = useMutation({
    mutationFn: () => api.createChatSession(scope),
    onSuccess: ({ session }) => {
      void qc.invalidateQueries({ queryKey: ["chat-sessions"] });
      nav(`/chat/${session.sessionId}`);
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteChatSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chat-sessions"] }),
  });
  return (
    <Page
      title={<span className="inline-flex items-center gap-2">챗봇 <BetaBadge /></span>}
      subtitle="회의록·전사 또는 강의를 골라 질문하세요"
      action={<Button size="sm" icon={<IconPlus size={16} strokeWidth={2.25} />} loading={create.isPending} onClick={() => create.mutate()}>새 대화</Button>}
    >
      <Card className="p-4 mb-5"><ChatScopePicker value={scope} onChange={setScope} disabled={create.isPending} /></Card>
      {q.isLoading && <div className="space-y-3"><Skeleton className="h-[76px]" /><Skeleton className="h-[76px]" /></div>}
      {q.error && <InlineError>{String((q.error as Error).message)}</InlineError>}
      {create.error && <InlineError>{String((create.error as Error).message)}</InlineError>}
      {q.data && q.data.items.length === 0 && (
        <EmptyState
          illustration={<div className="grid h-16 w-16 place-items-center rounded-2xl bg-accent-soft text-accent"><IconChat size={30} /></div>}
          title="아직 대화가 없습니다"
          description="회의의 결정 사항이나 강의의 개념·수식을 물어보세요. 위에서 자료를 고르면 해당 자료를 근거로 답합니다."
          action={<Button icon={<IconPlus size={18} strokeWidth={2.25} />} loading={create.isPending} onClick={() => create.mutate()}>대화 시작</Button>}
        />
      )}
      <ul className="space-y-3">
        {q.data?.items.map((s) => (
          <li key={s.sessionId}>
            <SessionRow s={s} onDelete={() => { if (confirm("이 대화를 삭제할까요?")) del.mutate(s.sessionId); }} />
          </li>
        ))}
      </ul>
    </Page>
  );
}

function SessionRow({ s, onDelete }: { s: ChatSessionDto; onDelete: () => void }) {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <Link to={`/chat/${s.sessionId}`} className="min-w-0 flex-1 block">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 truncate font-semibold text-[16px] leading-snug">{s.title || "새 대화"}</h2>
            {s.meetingId && <Pill tone="accent">회의 지정</Pill>}
            {(s.lectureId || s.sourceType === "lecture") && <Pill tone="accent">{s.lectureId ? "강의 지정" : "강의"}</Pill>}
          </div>
          {s.lastMessagePreview && <p className="mt-1 text-[13px] text-ink-2 line-clamp-2">{s.lastMessagePreview}</p>}
          <div className="mt-2 flex items-center gap-3 text-[12px] text-ink-3">
            <span>{formatDate(s.updatedAt)}</span>
            <span>{s.messageCount}개 메시지</span>
            <IconChevronRight size={16} className="ml-auto" />
          </div>
        </Link>
        <button type="button" onClick={onDelete} className="tap -mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 hover:text-danger" aria-label="대화 삭제"><IconTrash size={17} /></button>
      </div>
    </Card>
  );
}
