import { useInfiniteQuery } from "@tanstack/react-query";
import type { ChatSourceType, CreateChatSessionRequest } from "@meeting-notes/shared";
import { useApi } from "../../lib/api";
import { Button, InlineError, SectionLabel, Segmented } from "../ui";

export function ChatScopePicker({ value, onChange, disabled = false }: {
  value: CreateChatSessionRequest; onChange: (scope: CreateChatSessionRequest) => void; disabled?: boolean;
}) {
  const api = useApi();
  const type = value.sourceType ?? "meeting";
  const q = useInfiniteQuery({
    queryKey: ["chat-targets", type], initialPageParam: undefined as string | undefined,
    enabled: type !== "all",
    queryFn: async ({ pageParam }) => {
      if (type === "lecture") {
        const result = await api.listLectures(pageParam);
        return { items: result.items.filter((r) => r.status === "COMPLETED").map((r) => ({ id: r.lectureId, title: r.title })), cursor: result.cursor };
      }
      const result = await api.listMeetings(pageParam);
      return { items: result.items.filter((r) => r.status === "COMPLETED").map((r) => ({ id: r.meetingId, title: r.title })), cursor: result.cursor };
    },
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const selectedId = value.lectureId ?? value.meetingId ?? "";
  return <fieldset disabled={disabled} className="space-y-2 disabled:opacity-60">
    <SectionLabel>질문할 자료</SectionLabel>
    <Segmented<ChatSourceType> value={type} onChange={(sourceType) => onChange({ sourceType })}
      options={[{ value: "meeting", label: "회의록·전사" }, { value: "lecture", label: "강의" }, { value: "all", label: "전체" }]} />
    {type !== "all" && <select aria-label={type === "lecture" ? "강의 선택" : "회의 선택"} value={selectedId}
      onChange={(e) => onChange({ sourceType: type, ...(e.target.value ? type === "lecture" ? { lectureId: e.target.value } : { meetingId: e.target.value } : {}) })}
      className="w-full h-11 rounded-xl border border-line bg-surface px-3 text-sm">
      <option value="">{type === "lecture" ? "내 강의 전체" : "내 회의 전체"}</option>
      {selectedId && !items.some((item) => item.id === selectedId) && <option value={selectedId}>현재 지정한 {type === "lecture" ? "강의" : "회의"}</option>}
      {items.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select>}
    {q.hasNextPage && <Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>자료 더 보기</Button>}
    {q.error && <InlineError>{q.error.message}</InlineError>}
  </fieldset>;
}
