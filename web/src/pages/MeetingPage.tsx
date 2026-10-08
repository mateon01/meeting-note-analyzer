import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ACTIVE_STATUSES, type NotesDocument } from "@meeting-notes/shared";
import { useApi } from "../lib/api";
import { StatusChip } from "../components/StatusChip";
import { StageProgress } from "../components/StageProgress";
import { Transcript } from "../components/Transcript";
import { MindMapView } from "../components/MindMap";
import { MeetingBrief } from "../components/MeetingBrief";
import { IconAlert, IconChat, IconChevronLeft, IconChevronRight, IconClock, IconDoc, IconEdit, IconExternal, IconFlag, IconLightbulb, IconListChecks, IconMindMap, IconNote, IconRefresh, IconTrash, IconUsers, IconWaveform } from "../components/icons";
import { Avatar, Bullets, Button, Card, InlineError, Pill, SectionLabel, Segmented, Skeleton, formatDate, formatDuration, speakerColorClass } from "../components/ui";

type Tab = "summary" | "agenda" | "notes" | "followups" | "suggestions" | "mindmap" | "transcript";
const TABS: { value: Tab; label: string; icon: React.ReactNode }[] = [
  { value: "summary", label: "요약", icon: <IconDoc size={15} /> },
  { value: "agenda", label: "안건", icon: <IconListChecks size={15} /> },
  { value: "notes", label: "노트", icon: <IconNote size={15} /> },
  { value: "followups", label: "F/U", icon: <IconFlag size={15} /> },
  { value: "suggestions", label: "제안", icon: <IconLightbulb size={15} /> },
  { value: "mindmap", label: "마인드맵", icon: <IconMindMap size={15} /> },
  { value: "transcript", label: "전사", icon: <IconWaveform size={15} /> },
];

export function MeetingPage() {
  const { id = "" } = useParams();
  const api = useApi();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("summary");
  const [briefJump, setBriefJump] = useState(0);
  const q = useQuery({
    queryKey: ["meeting", id],
    queryFn: () => api.getResult(id),
    refetchInterval: (query) => (query.state.data && (ACTIVE_STATUSES.includes(query.state.data.meeting.status) || query.state.data.meeting.briefStatus === "RUNNING") ? 5_000 : false),
    refetchOnWindowFocus: false,
  });
  const retry = useMutation({
    mutationFn: () => api.retryMeeting(id),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["meeting", id] }), qc.invalidateQueries({ queryKey: ["meetings"] })]);
    },
  });
  const generateBrief = useMutation({
    mutationFn: () => api.createMeetingBrief(id),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["meeting", id] }); },
  });
  useEffect(() => {
    if (!briefJump) return;
    const element = document.getElementById("meeting-brief");
    element?.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    element?.focus({ preventScroll: true });
  }, [briefJump]);
  const ask = useMutation({
    mutationFn: () => api.createChatSession(id),
    onSuccess: ({ session }) => nav(`/chat/${session.sessionId}`),
  });
  const rename = useMutation({
    mutationFn: (labels: Record<string, string>) => api.renameSpeakers(id, labels),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["meeting", id] }),
  });
  const renameMeeting = useMutation({
    mutationFn: (title: string) => api.updateMeeting(id, { title }),
    // Refetch before the editor closes so the heading and the list never show the old title.
    onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ["meeting", id] }), qc.invalidateQueries({ queryKey: ["meetings"] })]); },
  });
  const del = useMutation({
    mutationFn: () => api.deleteMeeting(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["meetings"] });
      nav("/");
    },
  });

  const back = (
    <button className="tap -ml-1 inline-flex items-center gap-0.5 h-9 pr-2 text-[15px] text-accent" onClick={() => nav("/")}>
      <IconChevronLeft size={20} />목록
    </button>
  );

  if (q.isLoading) return <div className="px-4 pt-2">{back}<Skeleton className="h-8 w-3/4 mt-3" /><Skeleton className="h-4 w-1/2 mt-3" /><Skeleton className="h-40 mt-5" /></div>;
  if (q.error || !q.data) return <div className="px-4 pt-2">{back}<InlineError>{String((q.error as Error)?.message ?? "오류")}</InlineError></div>;
  const { meeting, notes, transcriptUrl, originalTranscriptUrl, transcriptRevision, audioUrl, notesMarkdownUrl } = q.data;
  const doc = notes as NotesDocument | null;
  const speakerLabels = Object.fromEntries((doc?.speakers ?? []).map((s) => [s.id, s.label]));
  const processing = meeting.status !== "COMPLETED";
  const hasContent = !!doc || !!transcriptUrl;

  return (
    <div className="px-4 pt-2">
      {back}
      <div className="mt-2 flex items-start justify-between gap-3">
        <MeetingTitle title={meeting.title} onSave={(title) => renameMeeting.mutateAsync(title)} />
        <div className="shrink-0 pt-1"><StatusChip status={meeting.status} /></div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
        <span>{formatDate(meeting.createdAt)}</span>
        {meeting.durationSec ? <span className="inline-flex items-center gap-1"><IconClock size={13} />{formatDuration(meeting.durationSec)}</span> : null}
        {meeting.speakerCount ? <span className="inline-flex items-center gap-1"><IconUsers size={13} />화자 {meeting.speakerCount}명</span> : null}
        {meeting.detectedLanguage && <span className="uppercase">{meeting.detectedLanguage}</span>}
      </div>

      {processing && (
        <Card className="mt-4 p-4">
          <StageProgress meeting={meeting} />
          {meeting.status === "FAILED" && (
            <>
              <div className="mt-4 flex gap-2.5 rounded-xl bg-danger-soft p-3 text-[13px] text-danger">
                <IconAlert size={18} className="shrink-0 mt-0.5" />
                <p className="leading-relaxed break-words">{meeting.error ?? "처리 중 오류가 발생했습니다."}</p>
              </div>
              <Button full className="mt-3" icon={<IconRefresh size={18} />} loading={retry.isPending} onClick={() => retry.mutate()}>
                실패한 단계부터 다시 시도
              </Button>
              <p className="mt-2 text-[12px] text-ink-3">완료된 전사와 분석 단계는 그대로 두고, 실패한 단계부터 이어서 처리합니다.</p>
              {retry.error && <InlineError>{(retry.error as Error).message}</InlineError>}
            </>
          )}
          {ACTIVE_STATUSES.includes(meeting.status) && <p className="mt-4 text-[12px] text-ink-3">서버에서 처리 중입니다. 앱을 닫아도 진행되며, 완료되면 알림을 보내 드립니다.</p>}
        </Card>
      )}

      {meeting.status === "COMPLETED" && (
        <button type="button" onClick={() => ask.mutate()} disabled={ask.isPending} className="tap mt-4 flex w-full items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-left active:bg-surface-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><IconChat size={20} /></span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-[15px] font-semibold">이 회의에 질문<span className="rounded-md border border-violet/50 bg-violet/15 px-1.5 text-[10px] font-bold tracking-wide text-violet">BETA</span></span>
            <span className="block text-[12.5px] text-ink-3">결정 사항, 담당자, 발언 내용을 근거와 함께 답합니다</span>
          </span>
        </button>
      )}
      {hasContent && <Segmented className="mt-5" options={TABS.filter((t) => (t.value === "transcript" ? !!transcriptUrl : t.value === "mindmap" ? !!doc?.mindmap : !!doc))} value={tab} onChange={setTab} />}
      {doc && <button type="button" className="tap mt-4 flex w-full items-center justify-between rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-[13px] font-medium text-accent" onClick={() => { setTab("summary"); setBriefJump((n) => n + 1); }}>핵심 요약 보기<IconChevronRight size={15} /></button>}

      <section className="mt-4">
        {tab === "summary" && doc && <SummaryTab doc={doc} onRename={meeting.status === "COMPLETED" ? (id, label) => rename.mutateAsync({ [id]: label }) : undefined} />}
        {tab === "agenda" && doc && <AgendaTab doc={doc} />}
        {tab === "notes" && doc && <NotesTab doc={doc} notesMarkdownUrl={notesMarkdownUrl} />}
        {tab === "followups" && doc && <FollowUpsTab doc={doc} />}
        {tab === "suggestions" && doc && <SuggestionsTab doc={doc} />}
        {tab === "mindmap" && doc?.mindmap && <MindMapView map={doc.mindmap} />}
        {tab === "transcript" && transcriptUrl && <Transcript title={meeting.title} transcriptUrl={transcriptUrl} originalTranscriptUrl={originalTranscriptUrl} transcriptRevision={transcriptRevision} audioUrl={audioUrl} speakerLabels={speakerLabels} proposedLabels={Object.fromEntries((doc?.speakers ?? []).filter((s) => s.reviewRequired && s.proposedLabel).map((s) => [s.id, s.proposedLabel!]))} confirmedSpeakerNames={(doc?.speakers ?? []).filter((s) => s.nameConfirmedByUser).map((s) => s.id)} onRefreshUrls={async () => (await q.refetch({ throwOnError: true })).data} />}
        {tab !== "transcript" && !doc && transcriptUrl && <p className="text-sm text-ink-3">분석이 끝나면 여기에 결과가 표시됩니다. 전사 탭에서 전사 결과를 먼저 볼 수 있습니다.</p>}
      </section>
      {doc && (tab === "summary" || tab === "notes") && <MeetingBrief doc={doc}
        onGenerate={meeting.status === "COMPLETED" && meeting.briefStatus !== "RUNNING" ? () => generateBrief.mutate() : undefined}
        generating={generateBrief.isPending || meeting.briefStatus === "RUNNING"}
        generationError={generateBrief.error?.message ?? (meeting.briefStatus === "FAILED" ? "추가 요약을 완료하지 못했습니다. 회의록은 그대로이며, 추가 요약 만들기를 다시 누르면 이어서 처리합니다." : undefined)}
        onDetails={(next) => { setTab(next); document.querySelector(".app-shell > main")?.scrollTo({ top: 0, behavior: "smooth" }); }} />}

      <Button variant="danger" full className="mt-12 mb-4" icon={<IconTrash size={18} />} loading={del.isPending} onClick={() => { if (confirm("이 회의와 모든 결과를 삭제할까요?")) del.mutate(); }}>
        회의 삭제
      </Button>
    </div>
  );
}

function Section({ title, tone, children }: { title: string; tone?: "default" | "success" | "warning" | "accent" | "danger"; children: React.ReactNode }) {
  return (
    <Card className="p-4 mb-3">
      <SectionLabel tone={tone}>{title}</SectionLabel>
      <div className="mt-2.5">{children}</div>
    </Card>
  );
}

function SummaryTab({ doc, onRename }: { doc: NotesDocument; onRename?: (id: string, label: string) => Promise<unknown> }) {
  return (
    <div>
      <div className="rounded-2xl bg-gradient-to-br from-accent-soft to-surface border border-line p-4 mb-3">
        <SectionLabel tone="accent">핵심 한 줄</SectionLabel>
        <p className="mt-2 text-[16px] font-semibold leading-relaxed">{doc.summary.headline}</p>
      </div>
      <Section title="개요"><p className="text-[14px] text-ink leading-relaxed whitespace-pre-line">{doc.summary.overview}</p></Section>
      <Section title="참석자">
        <ul className="space-y-2.5">
          {doc.speakers.map((s, i) => (
            <li key={s.id} className="flex items-center gap-3">
              <Avatar name={s.label} index={i} size={30} />
              <div className="min-w-0 flex-1">
                <SpeakerName label={s.label} colorClass={speakerColorClass(i) ?? ""} onSave={onRename ? (label) => onRename(s.id, label) : undefined} />
                {s.role && <p className="text-[12px] text-ink-3">{s.role}</p>}
                {s.reviewRequired && <p className="text-[12px] text-ink-3 mt-1">이름 검토 필요{s.proposedLabel ? `: ${s.proposedLabel}로 추정` : ""}. 전사 탭에서 근거를 확인할 수 있습니다.</p>}
              </div>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="결정 사항" tone="success"><Bullets items={doc.summary.keyDecisions} /></Section>
      <Section title="핵심 논의">
        <ul className="space-y-3">
          {doc.summary.keyDiscussions.map((d, i) => (
            <li key={i}>
              <p className="text-[14px] font-semibold">{d.title}</p>
              <p className="mt-0.5 text-[14px] text-ink-2 leading-relaxed">{d.detail}</p>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="리스크와 이슈" tone="warning"><Bullets items={doc.summary.risksAndIssues} /></Section>
      <Section title="다음 단계" tone="accent"><Bullets items={doc.summary.nextSteps} /></Section>
      <Section title="토픽 흐름">
        <ol className="space-y-2">
          {doc.topics.map((t) => (
            <li key={t.id} className="flex gap-3 text-[14px]">
              <span className="w-12 shrink-0 tabular-nums text-ink-3">{Math.floor(t.startSec / 60)}분</span>
              <span>{t.title}</span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

function AgendaTab({ doc }: { doc: NotesDocument }) {
  return (
    <div>
      {doc.agenda.map((a, i) => (
        <Card key={a.id} className="p-4 mb-3">
          <div className="flex gap-3">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent text-[13px] font-bold">{i + 1}</span>
            <h3 className="font-semibold text-[15px] leading-snug pt-0.5">{a.title}</h3>
          </div>
          {a.background && <p className="mt-3 text-[13.5px] text-ink-2 leading-relaxed">{a.background}</p>}
          <div className="mt-3"><SectionLabel>논의</SectionLabel><div className="mt-1.5"><Bullets items={a.discussionPoints} /></div></div>
          {a.decisions.length > 0 && <div className="mt-3"><SectionLabel tone="success">결정</SectionLabel><div className="mt-1.5"><Bullets items={a.decisions} /></div></div>}
          {a.openQuestions.length > 0 && <div className="mt-3"><SectionLabel tone="warning">미결 질문</SectionLabel><div className="mt-1.5"><Bullets items={a.openQuestions} /></div></div>}
        </Card>
      ))}
    </div>
  );
}

function NotesTab({ doc, notesMarkdownUrl }: { doc: NotesDocument; notesMarkdownUrl: string | null }) {
  return (
    <div>
      {doc.notes.sections.map((s, i) => <Section key={i} title={s.title}><Bullets items={s.bullets} /></Section>)}
      {notesMarkdownUrl && (
        <a href={notesMarkdownUrl} target="_blank" rel="noreferrer" className="tap mt-1 inline-flex w-full items-center justify-center gap-2 h-11 rounded-xl border border-line-2 text-[14px] text-ink-2">
          <IconExternal size={16} />전체 회의록 (Markdown) 열기
        </a>
      )}
    </div>
  );
}

function FollowUpsTab({ doc }: { doc: NotesDocument }) {
  const tone = { high: "danger", medium: "warning", low: "neutral" } as const;
  const label = { high: "높음", medium: "보통", low: "낮음" } as const;
  if (!doc.followUps.length) return <p className="text-sm text-ink-3">F/U 항목이 없습니다.</p>;
  return (
    <ul className="space-y-2.5">
      {doc.followUps.map((f) => (
        <li key={f.id}>
          <Card className="p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="font-semibold text-[14.5px] leading-snug">{f.title}</p>
              <Pill tone={tone[f.priority]}>{label[f.priority]}</Pill>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
              {f.ownerName && <span className="inline-flex items-center gap-1"><IconUsers size={13} />{f.ownerName}</span>}
              {f.dueHint && <span className="inline-flex items-center gap-1"><IconClock size={13} />{f.dueHint}</span>}
              {f.status === "carried_over" && <span className="text-warning">이월 ({f.carriedFrom ?? "이전 회의"})</span>}
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function SuggestionsTab({ doc }: { doc: NotesDocument }) {
  return (
    <div>
      {doc.suggestions.map((s) => (
        <Card key={s.id} className="p-4 mb-3">
          <div className="flex items-start gap-2.5">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><IconLightbulb size={16} /></span>
            <h3 className="font-semibold text-[15px] leading-snug pt-0.5">{s.target.title}</h3>
          </div>
          <p className="mt-3 text-[14px] leading-relaxed whitespace-pre-line">{s.suggestion}</p>
          {s.nextSteps.length > 0 && <div className="mt-3"><SectionLabel tone="accent">다음 단계</SectionLabel><div className="mt-1.5"><Bullets items={s.nextSteps} /></div></div>}
          {s.alternatives.length > 0 && <div className="mt-3"><SectionLabel>대안</SectionLabel><div className="mt-1.5"><Bullets items={s.alternatives} /></div></div>}
          {s.risks.length > 0 && <div className="mt-3"><SectionLabel tone="warning">리스크</SectionLabel><div className="mt-1.5"><Bullets items={s.risks} /></div></div>}
          {s.clarifyingQuestions.length > 0 && <div className="mt-3"><SectionLabel>확인 질문</SectionLabel><div className="mt-1.5"><Bullets items={s.clarifyingQuestions} /></div></div>}
          {s.conflictsWithPast && (
            <div className="mt-3 flex gap-2 rounded-xl bg-danger-soft p-3 text-[13px] text-danger">
              <IconAlert size={16} className="shrink-0 mt-0.5" /><p className="leading-relaxed">과거 결정과 충돌: {s.conflictsWithPast}</p>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

/** Speaker display name with inline editing: tap the pencil, type the real name, Enter saves (Escape cancels). */
/** Heading with an inline editor; renaming is allowed at any status because the record is the source of truth. */
function MeetingTitle({ title, onSave }: { title: string; onSave: (title: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!editing) {
    return (
      <div className="flex min-w-0 flex-1 items-start gap-1">
        {/* Titles come from file names and can be one long token: the heading must shrink and wrap, the chip keeps its width. */}
        <h1 className="min-w-0 text-[22px] font-bold leading-tight tracking-tight [overflow-wrap:anywhere]">{title}</h1>
        <button type="button" aria-label="제목 바꾸기" onClick={() => { setValue(title); setEditing(true); setError(null); }} className="tap grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-3 hover:text-ink"><IconEdit size={15} /></button>
      </div>
    );
  }
  const commit = async () => {
    const next = value.trim();
    if (!next || next === title) return setEditing(false);
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="min-w-0 flex-1">
      <input
        aria-label="회의 제목"
        autoFocus
        value={value}
        maxLength={200}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-10 w-full rounded-lg border border-accent bg-surface-2 px-3 text-[17px] font-bold outline-none"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" loading={saving} onClick={() => void commit()}>저장</Button>
        <button type="button" onClick={() => setEditing(false)} className="tap text-[12px] text-ink-3">취소</button>
      </div>
      {error && <p className="mt-1 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

function SpeakerName({ label, colorClass, onSave }: { label: string; colorClass: string; onSave?: (label: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!editing || !onSave) {
    return (
      <div className="flex items-center gap-1.5">
        <p className={`text-[14px] font-semibold ${colorClass}`}>{label}</p>
        {onSave && (
          <button type="button" aria-label="이름 바꾸기" onClick={() => { setValue(label); setEditing(true); setError(null); }} className="tap grid h-7 w-7 place-items-center rounded-full text-ink-3 hover:text-ink"><IconEdit size={14} /></button>
        )}
      </div>
    );
  }
  const commit = async () => {
    const next = value.trim();
    if (!next || next === label) return setEditing(false);
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={value}
          maxLength={40}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="h-8 w-40 rounded-lg border border-accent bg-surface-2 px-2 text-[14px] font-semibold outline-none"
        />
        <Button size="sm" loading={saving} onClick={() => void commit()}>저장</Button>
        <button type="button" onClick={() => setEditing(false)} className="tap text-[12px] text-ink-3">취소</button>
      </div>
      {error && <p className="mt-1 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
