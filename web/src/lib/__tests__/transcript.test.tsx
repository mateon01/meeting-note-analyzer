// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MeetingResultResponse, Transcript as TranscriptDoc } from "@meeting-notes/shared";
import { Transcript } from "../../components/Transcript";
import * as exports from "../transcript-export";

const rawUrl = "https://example.test/transcripts/m1/transcript.json?sig=1";
const correctedUrl = "https://example.test/results/m1/transcript_attributed.json?sig=1";
const audioUrl = "https://example.test/audio.mp3?sig=1";
const raw = (): TranscriptDoc => ({
  version: 1, meetingId: "m1", normalizedAt: "2026-09-08", durationSec: 35, language: "ko", mode: "intended", model: "test", stats: {},
  speakers: [{ id: "S1", talkTimeSec: 20 }, { id: "S2", talkTimeSec: 10 }],
  segments: [
    { id: "seg-0", start: 0, end: 10, speaker: "S1", text: "첫 번째 발언", words: [] },
    { id: "seg-1", start: 12, end: 22, speaker: "S1", text: "검토할 발언", words: [] },
    { id: "seg-2", start: 25, end: 35, speaker: "S2", text: "세 번째 발언", words: [] },
  ],
});
const corrected = (): TranscriptDoc => {
  const t = raw();
  return { ...t, attributed: true, speakers: [{ id: "S1", label: "화자 1", talkTimeSec: 10 }, { id: "S2", label: "확인된 이름", talkTimeSec: 20 }],
    segments: t.segments.map((s, i) => ({ ...s, originalSpeaker: s.speaker, speaker: i === 0 ? "S2" : s.speaker, speakerCorrectionIds: i === 0 ? ["c1"] : i === 1 ? ["c2"] : [], speakerReviewRequired: i === 1 })),
    speakerAttribution: { version: 2, corrections: [
      { id: "c1", kind: "relabel", from: ["S1"], to: "S2", status: "applied", reason: "자기소개 근거", issues: [], evidence: [{ segmentId: "seg-0", quote: "첫 번째 발언" }], segmentIds: ["seg-0"] },
      { id: "c2", kind: "relabel", from: ["S1"], to: "S2", status: "review_required", reason: "질문 이후 답변으로 추정", issues: ["context_only"], evidence: [{ segmentId: "seg-1", quote: "검토할 발언" }], segmentIds: ["seg-1"] },
    ] },
  };
};
let root: Root; let element: HTMLDivElement; let client: QueryClient;
let props: ComponentProps<typeof Transcript>;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes("transcript_attributed") ? corrected() : raw() }));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  props = { transcriptUrl: correctedUrl, originalTranscriptUrl: rawUrl, transcriptRevision: "v1", audioUrl, speakerLabels: {} };
});
afterEach(async () => {
  await act(async () => root.unmount()); element.remove(); client.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function render() {
  await act(async () => { root.render(<QueryClientProvider client={client}><Transcript {...props} /></QueryClientProvider>); });
  await settle();
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }
function button(label: string) { return [...element.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!; }
function segments() { return [...element.querySelectorAll("[data-segment-id]")].map((e) => e.getAttribute("data-segment-id")); }

it("shows interview roles in the transcript and passes those labels to original-transcript downloads", async () => {
  props = { ...props, transcriptUrl: rawUrl, originalTranscriptUrl: null, speakerRoleLabels: { S1: "면접관", S2: "후보자" } };
  const download = vi.spyOn(exports, "downloadTranscript").mockImplementation(() => {});
  await render();
  expect(element.querySelector('[data-segment-id="seg-0"]')?.textContent).toContain("면접관");
  expect(element.querySelector('[data-segment-id="seg-2"]')?.textContent).toContain("후보자");
  expect(element.textContent).not.toContain("S1");
  expect(element.textContent).not.toContain("S2");
  await act(async () => button("TXT 다운로드").click());
  expect(download.mock.calls[0]![1]).toMatchObject({ variant: "original", speakerRoleLabels: { S1: "면접관", S2: "후보자" } });
});

it("shows accepted changes, review reasons and a filter without changing the original speaker", async () => {
  await render();
  expect(element.textContent).toContain("화자 보정 1건 적용, 검토 필요 1건");
  expect(element.querySelector('[data-segment-id="seg-0"]')?.textContent).toContain("확인된 이름");
  expect(element.querySelector('[data-segment-id="seg-1"]')?.textContent).toContain("화자 1");
  expect(element.textContent).toContain("대화의 흐름만으로 추정한 제안입니다");
  await act(async () => element.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(segments()).toEqual(["seg-1"]);
  await act(async () => button("근거 발언 듣기").click());
  expect(element.querySelector("audio")!.currentTime).toBe(12);
  expect(element.querySelector("button button")).toBeNull();
});
it("compares acoustic labels and keeps audio playback while switching transcripts", async () => {
  props.speakerLabels = { S1: "수정된 이름" };
  await render();
  const audio = element.querySelector("audio")!; audio.currentTime = 18;
  await act(async () => button("원본 전사").click()); await settle();
  expect(segments()).toHaveLength(3);
  expect(element.textContent).not.toContain("수정된 이름");
  expect(element.querySelector('[data-segment-id="seg-0"]')?.textContent).toContain("S1");
  expect(element.querySelector("audio")).toBe(audio);
  expect(audio.currentTime).toBe(18);
  await act(async () => button("보정 전사").click()); await settle();
  expect(element.textContent).toContain("검토 필요");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("refreshes overwritten transcript content but ignores URL signature rotation", async () => {
  await render();
  props = { ...props, transcriptUrl: correctedUrl.replace("sig=1", "sig=2"), audioUrl: audioUrl.replace("sig=1", "sig=2") };
  await render();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(element.querySelector("audio")!.src).toBe(audioUrl);
  props = { ...props, transcriptRevision: "v2" };
  await render();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]![0]).toContain("sig=2");
});
it("renews an expired transcript signature once using the authenticated result API", async () => {
  const renew = vi.fn().mockResolvedValue({ transcriptUrl: correctedUrl.replace("sig=1", "sig=renewed") } as MeetingResultResponse);
  props.onRefreshUrls = renew;
  fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
  await render();
  expect(renew).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[1]![0]).toContain("sig=renewed");
  expect(element.textContent).toContain("검토할 발언");
});
it("keeps failures recoverable and does not loop when renewed access is denied", async () => {
  props.onRefreshUrls = vi.fn().mockResolvedValue({ transcriptUrl: correctedUrl });
  fetchMock.mockResolvedValue({ ok: false, status: 403 });
  await render();
  expect(props.onRefreshUrls).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(element.textContent).toContain("전사를 불러오지 못했습니다 (403)");
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => corrected() });
  await act(async () => button("다시 불러오기").click()); await settle();
  expect(element.textContent).toContain("검토할 발언");
});
it("supports original-only and legacy attributed transcripts without implying evidence was checked", async () => {
  props = { ...props, transcriptUrl: rawUrl, originalTranscriptUrl: null, transcriptRevision: undefined };
  await render();
  expect(element.textContent).not.toContain("전사 버전");
  expect(element.textContent).toContain("첫 번째 발언");
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...raw(), attributed: true }) });
  props = { ...props, transcriptUrl: correctedUrl, originalTranscriptUrl: rawUrl };
  await render();
  expect(element.textContent).toContain("발언별 검토 정보는 없습니다");
});
it("manual name confirmation clears only name review, leaving membership review visible", async () => {
  const t = corrected();
  t.speakerAttribution!.corrections.push({ id: "c3", kind: "label", from: ["S1"], to: "S1", proposedLabel: "후보 이름", status: "review_required", reason: "", issues: ["context_only"], evidence: [], segmentIds: ["seg-1"] });
  t.segments[1]!.speakerCorrectionIds!.push("c3");
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => t });
  props = { ...props, speakerLabels: { S1: "사용자가 확인한 이름" }, confirmedSpeakerNames: ["S1"] };
  await render();
  expect(element.textContent).not.toContain("후보 이름");
  expect(element.textContent).toContain("사용자가 확인한 이름");
  expect(element.textContent).toContain("검토 필요 1건");
});
it("renews an expired audio URL, preserves position, and limits automatic recovery", async () => {
  const renew = vi.fn().mockResolvedValue({ audioUrl: audioUrl.replace("sig=1", "sig=renewed") });
  props.onRefreshUrls = renew;
  await render();
  const audio = element.querySelector("audio")!; audio.currentTime = 18;
  await act(async () => audio.dispatchEvent(new Event("error"))); await settle();
  expect(renew).toHaveBeenCalledTimes(1);
  expect(audio.src).toContain("sig=renewed");
  audio.currentTime = 0; // browsers reset the position when src changes
  await act(async () => audio.dispatchEvent(new Event("loadedmetadata")));
  expect(audio.currentTime).toBe(18);
  await act(async () => audio.dispatchEvent(new Event("error")));
  expect(renew).toHaveBeenCalledTimes(1);
  expect(button("오디오 다시 연결")).toBeDefined();
  renew.mockResolvedValue({ audioUrl: audioUrl.replace("sig=1", "sig=retry") });
  await act(async () => button("오디오 다시 연결").click()); await settle();
  expect(renew).toHaveBeenCalledTimes(2);
  expect(audio.src).toContain("sig=retry");
});
it("restores all speech if manual confirmation resolves the last visible name review", async () => {
  const t = corrected();
  t.speakerAttribution!.corrections = [{ id: "c2", kind: "label", from: ["S1"], to: "S1", proposedLabel: "후보 이름", status: "review_required", reason: "", issues: ["context_only"], evidence: [], segmentIds: ["seg-1"] }];
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => t });
  await render();
  await act(async () => element.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(segments()).toEqual(["seg-1"]);
  props = { ...props, confirmedSpeakerNames: ["S1"] };
  await render();
  expect(segments()).toHaveLength(3);
});
it("shows a proposed name as a hint next to an unconfirmed speaker, only in the corrected view", async () => {
  props = { ...props, proposedLabels: { S1: "김민수" } };
  await render();
  const segment = element.querySelector('[data-segment-id="seg-1"]')?.textContent ?? "";
  expect(segment).toContain("화자 1");
  expect(segment).toContain("추정: 김민수");
  await act(async () => button("원본 전사").click()); await settle();
  expect(element.textContent).not.toContain("추정: 김민수");
});

it("downloads the full selected transcript even while review filtering hides other speech", async () => {
  const download = vi.spyOn(exports, "downloadTranscript").mockImplementation(() => {});
  props.title = "주간 회의";
  await render();
  await act(async () => element.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(segments()).toEqual(["seg-1"]);
  await act(async () => button("TXT 다운로드").click());
  expect(download.mock.calls[0]![0].segments).toHaveLength(3);
  expect(download.mock.calls[0]![1]).toMatchObject({ title: "주간 회의", variant: "corrected", format: "txt" });
  await act(async () => button("원본 전사").click()); await settle();
  await act(async () => button("Markdown 다운로드").click());
  expect(download.mock.calls[1]![0].segments[0]!.speaker).toBe("S1");
  expect(download.mock.calls[1]![1]).toMatchObject({ variant: "original", format: "md" });
});
