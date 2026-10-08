import type { Transcript } from "@meeting-notes/shared";

export type TranscriptExportOptions = {
  title: string;
  variant: "original" | "corrected";
  format: "txt" | "md";
  speakerLabels?: Record<string, string>;
  speakerRoleLabels?: Record<string, string>;
  confirmedSpeakerNames?: string[];
};

function timestamp(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, "0")).join(":");
}
// Transcript content is verbatim text, including code/HTML/Markdown someone dictated.
function escapeMarkdown(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_[\]{}()#+.!|~$-]/g, "\\$&").replace(/\n/g, "  \n");
}

export function transcriptExport(transcript: Transcript, options: TranscriptExportOptions) {
  const { title, variant, format, speakerLabels = {}, speakerRoleLabels, confirmedSpeakerNames = [] } = options;
  const original = variant === "original";
  const version = original ? "원본 전사" : "보정 전사";
  const text = format === "md" ? escapeMarkdown : (value: string) => value;
  const lines = [`${format === "md" ? "# " : ""}${text(title)} — ${version}`, "",
    `길이: ${timestamp(transcript.durationSec)} · 언어: ${text(transcript.language ?? "미확인")}`, "",
    speakerRoleLabels ? "원본 발언과 시간을 유지하고 화자는 역할로 표시합니다." : original ? "음성 인식 결과의 원래 화자와 발언입니다." : "화자 보정과 표시 이름을 반영한 전사입니다. 발언 내용과 시간은 원본 전사를 유지합니다.", ""];
  const corrections = original ? [] : (transcript.speakerAttribution?.corrections ?? [])
    .filter((c) => !(c.kind === "label" && confirmedSpeakerNames.includes(c.to)));
  if (!original && transcript.attributed && !transcript.speakerAttribution) lines.push("이전 방식으로 보정된 전사로, 발언별 검토 정보가 없습니다.", "");
  for (const seg of transcript.segments) {
    const speaker = original ? undefined : speakerLabels[seg.speaker] ?? transcript.speakers.find((s) => s.id === seg.speaker)?.label ?? seg.speakerLabel;
    const identity = speakerRoleLabels ? speakerRoleLabels[seg.speaker] ?? "미확인 화자" : speaker && speaker !== seg.speaker ? `${speaker} (${seg.speaker})` : seg.speaker;
    const reviews = corrections.filter((c) => c.status === "review_required" && (c.segmentIds.includes(seg.id) || (c.kind === "label" && c.to === seg.speaker)));
    const pendingSpeaker = !original && transcript.speakers.some((s) => s.id === seg.speaker && s.reviewRequired && !s.nameConfirmedByUser && !confirmedSpeakerNames.includes(s.id));
    const pending = reviews.length > 0 || pendingSpeaker || (!original && seg.speakerReviewRequired && !transcript.speakerAttribution);
    lines.push(`[${timestamp(seg.start)}–${timestamp(seg.end)}] ${text(identity)}${pending ? " [화자 검토 필요, 제안 미적용]" : ""}${speakerRoleLabels ? "" : ` (${text(seg.id)})`}`, text(seg.text), "");
  }
  if (corrections.length) {
    lines.push(`${format === "md" ? "## " : ""}화자 보정 기록`, "");
    for (const c of corrections) {
      lines.push(text(`${c.id}: ${c.status === "applied" ? "적용됨" : "검토 필요, 제안 미적용"} · ${c.from.join(", ")} → ${c.to}${c.proposedLabel ? ` (이름 제안: ${c.proposedLabel})` : ""}`));
      if (c.reason) lines.push(text(c.reason));
      for (const e of c.evidence) lines.push(text(`근거 (${e.segmentId}): ${e.quote}`));
      lines.push("");
    }
  }
  const safeTitle = Array.from(title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").trim()).slice(0, 100).join("").replace(/[. ]+$/, "") || "전사";
  return { content: lines.join("\n"), filename: `${safeTitle}_${original ? "원본전사" : "보정전사"}.${format}`, contentType: format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8" };
}

export function downloadTranscript(transcript: Transcript, options: TranscriptExportOptions) {
  const exported = transcriptExport(transcript, options);
  const url = URL.createObjectURL(new Blob(["\uFEFF", exported.content], { type: exported.contentType }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = exported.filename;
  document.body.appendChild(anchor);
  try { anchor.click(); } finally {
    anchor.remove();
    // Leave enough time for the browser to start consuming the blob.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
