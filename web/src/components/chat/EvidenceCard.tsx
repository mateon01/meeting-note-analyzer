import { Link } from "react-router";
import type { ChatEvidence } from "@meeting-notes/shared";
import { IconDoc, IconExternal, IconStudy, IconWaveform } from "../icons";

const mmss = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export function EvidenceCard({ item, highlighted, domId }: { item: ChatEvidence; highlighted?: boolean; domId?: string }) {
  const path = item.kind === "lecture" ? `/lectures/${item.lectureId}${item.page ? `?page=${item.page}` : ""}` : `/meetings/${item.meetingId}${item.startSec != null ? `?t=${item.startSec}` : ""}`;
  return (
    <div id={domId} className={`rounded-xl border px-3 py-2.5 transition-colors ${highlighted ? "border-accent bg-accent-soft/60" : "border-line bg-surface-2"}`}>
      <div className="flex items-center gap-2 text-[12px]">
        <span className="inline-flex h-5 items-center rounded-md bg-accent-soft px-1.5 font-semibold text-accent">{item.id}</span>
        <span className="inline-flex items-center gap-1 text-ink-2">{item.kind === "transcript" ? <IconWaveform size={13} /> : item.kind === "lecture" ? <IconStudy size={13} /> : <IconDoc size={13} />}{item.kind === "lecture" ? `강의${item.page ? ` 학습 항목 ${item.page}` : ""}` : item.kind === "transcript" ? `전사 ${item.startSec != null ? mmss(item.startSec) : ""}` : "회의록"}</span>
        {item.date && <span className="text-ink-3">{item.date}</span>}
        <Link to={path} className="tap ml-auto inline-flex items-center gap-1 text-accent">
          열기<IconExternal size={13} />
        </Link>
      </div>
      {item.title && <p className="mt-1 text-[13px] font-semibold leading-snug line-clamp-1">{item.title}</p>}
      <p className="mt-1 text-[13px] leading-relaxed text-ink-2 line-clamp-3">{item.snippet}</p>
    </div>
  );
}
