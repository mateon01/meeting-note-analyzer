import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { Button, Card, EmptyState, InlineError, Page, Skeleton, formatDate } from "../components/ui";
import { IconPlus, IconStudy } from "../components/icons";
import { LectureStatus } from "../components/LectureStatus";

export function LecturesPage() {
  const api = useApi(); const nav = useNavigate();
  const query = useInfiniteQuery({ queryKey: ["lectures"], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listLectures(pageParam), getNextPageParam: (last) => last.cursor ?? undefined,
    refetchInterval: (q) => q.state.data?.pages.some((p) => p.items.some((x) => ["UPLOADED", "PREPARING", "TRANSCRIBING", "ANALYZING"].includes(x.status))) ? 8000 : false });
  const lectures = query.data?.pages.flatMap((p) => p.items) ?? [];
  return <Page title="강의 노트" subtitle="주제별 정리와 게스트 공유" action={<Button size="sm" icon={<IconPlus size={16} />} onClick={() => nav("/upload?kind=lecture")}>새 강의</Button>}>
    {query.isLoading && <Skeleton className="h-28" />}
    {query.error && <InlineError>{query.error.message}</InlineError>}
    {!query.isLoading && !query.error && !lectures.length && <EmptyState illustration={<IconStudy size={52} className="text-accent" />} title="배운 내용을 내 지식으로" description="MP4 영상이나 MP3 음성을 올리세요. 강의 내용을 분석해 복습 자료와 참고 논문을 정리합니다. PPTX/PDF도 선택하여 첨부할 수 있습니다." action={<Button onClick={() => nav("/upload?kind=lecture")}>첫 강의 정리하기</Button>} />}
    <div className="space-y-3">{lectures.map((lecture) => <Card key={lecture.lectureId}>
      <button type="button" className="tap block w-full rounded-t-2xl p-4 text-left active:bg-surface-2" onClick={() => nav(`/lectures/${lecture.lectureId}`)}>
        <div className="flex justify-between items-center gap-2"><span className="text-[12px] text-ink-3 truncate">{lecture.course || "강의"}</span><LectureStatus lecture={lecture} /></div>
        <h2 className="mt-3 font-semibold text-[17px] [overflow-wrap:anywhere]">{lecture.title}</h2>
        <p className="mt-2 text-[12px] text-ink-3">{lecture.videoName ? "MP4 영상 · " : lecture.audioName ? "MP3 음성 · " : ""}{formatDate(lecture.createdAt)}{lecture.pageCount ? ` · 학습 항목 ${lecture.pageCount}개` : ""}{lecture.durationSec ? ` · ${Math.round(lecture.durationSec / 60)}분` : ""}</p>
      </button>
      {lecture.status === "COMPLETED" && <div className="border-t border-line px-4 py-3">
        <Button size="sm" variant="violet" onClick={() => nav(`/lectures/${lecture.lectureId}?share=1`)}>게스트 공유</Button>
      </div>}
    </Card>)}</div>
    {query.hasNextPage && <Button full variant="secondary" className="mt-4" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>더 보기</Button>}
  </Page>;
}
