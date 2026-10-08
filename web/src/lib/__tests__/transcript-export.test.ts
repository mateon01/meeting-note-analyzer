import { expect, it } from "vitest";
import type { Transcript } from "@meeting-notes/shared";
import { transcriptExport } from "../transcript-export";

const transcript: Transcript = {
  version: 1, meetingId: "m1", normalizedAt: "2026-09-22", durationSec: 3662, language: "ko", mode: "intended", model: "test", stats: {}, attributed: true,
  speakers: [{ id: "S1", label: "화자 1", talkTimeSec: 2 }],
  segments: [
    { id: "seg-1", start: 0, end: 1, speaker: "S1", text: "원문 그대로\n두 번째 줄", words: [] },
    { id: "seg-2", start: 3660, end: 3662, speaker: "S1", text: "<script>alert(1)</script> **강조** $x$", words: [], speakerCorrectionIds: ["c1"] },
  ],
  speakerAttribution: { version: 2, corrections: [{ id: "c1", kind: "label", from: ["S1"], to: "S1", status: "review_required", reason: "불확실한 이름", issues: [], segmentIds: ["seg-2"], evidence: [], proposedLabel: "후보 이름" }] },
};
it("keeps original text, speaker IDs and hour timestamps in TXT without applying display names", () => {
  const result = transcriptExport(transcript, { title: "강의/회의", variant: "original", format: "txt", speakerLabels: { S1: "수정 이름" } });
  expect(result.filename).toBe("강의_회의_원본전사.txt");
  expect(result.content).toContain("[01:01:00–01:01:02] S1");
  expect(result.content).toContain("원문 그대로\n두 번째 줄");
  expect(result.content).not.toContain("수정 이름");
  expect(result.content).not.toContain("후보 이름");
  expect(result.content).toContain("<script>alert(1)</script> **강조** $x$");
});
it("exports interview speaker roles while preserving original speech and timestamps", () => {
  const result = transcriptExport(transcript, { title: "인터뷰", variant: "original", format: "txt", speakerRoleLabels: { S1: "후보자" } });
  expect(result.content).toContain("[01:01:00–01:01:02] 후보자");
  expect(result.content).toContain("원문 그대로\n두 번째 줄");
  expect(result.content).not.toContain("S1");
  expect(result.content).not.toContain("seg-1");
  expect(transcript.segments[0]!.speaker).toBe("S1");
});
it("exports corrected identities and marks pending proposals without applying them", () => {
  const result = transcriptExport(transcript, { title: "회의", variant: "corrected", format: "txt", speakerLabels: { S1: "표시 이름" } });
  expect(result.filename).toBe("회의_보정전사.txt");
  expect(result.content).toContain("표시 이름 (S1)");
  expect(result.content).toContain("[화자 검토 필요, 제안 미적용]");
  expect(result.content).toContain("이름 제안: 후보 이름");
  expect(result.content).not.toContain("] 후보 이름 (S1)");
});
it("escapes dictated HTML and Markdown in MD and respects confirmed names", () => {
  const result = transcriptExport(transcript, { title: "회의 **제목**", variant: "corrected", format: "md", confirmedSpeakerNames: ["S1"] });
  expect(result.content).toContain("# 회의 \\*\\*제목\\*\\* — 보정 전사");
  expect(result.content).not.toContain("<script>");
  expect(result.content).toContain("&lt;script&gt;");
  expect(result.content).toContain("\\*\\*강조\\*\\*");
  expect(result.content).toContain("\\$x\\$");
  expect(result.content).not.toContain("검토 필요");
});
