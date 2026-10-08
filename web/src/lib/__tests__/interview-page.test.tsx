// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { interviewSettingsSchema, type InterviewResult } from "@meeting-notes/shared";
const api = vi.hoisted(() => ({ interviewResult: vi.fn(), downloadInterview: vi.fn(), retryInterview: vi.fn(), startInterview: vi.fn(), deleteInterview: vi.fn(), updateInterviewSettings: vi.fn() }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), useApi: () => api }));
import { InterviewPage } from "../../pages/InterviewPage";
import { ApiError } from "../api";
let root: Root, element: HTMLDivElement, client: QueryClient;
const settings = interviewSettingsSchema.parse({ criteria: ["domain_depth", "dive_deep"] });
const fixture = (): InterviewResult => ({
  interview: { interviewId: "i", title: "Interview", settings, status: "COMPLETED", stages: {}, audioName: "a.mp3", resumeName: "r.pdf", uploadsComplete: true, createdAt: "2026-09-22", updatedAt: "2026-09-22" },
  audioUrl: null, transcriptUrl: null, markdownUrl: "https://example.org/interview.md", resumeUrl: "https://example.org/resume.pdf",
  document: { version: 1, interviewId: "i", title: "Interview", settings, generatedAt: "2026-09-22", durationSec: 30, notesLanguage: "ko", overview: "1개 질문을 정리했습니다.", limitations: [],
    speakers: [{ id: "S1", role: "interviewer", label: "S1", confidence: 1, confirmedByUser: false, evidence: [] }, { id: "S2", role: "candidate", label: "S2", confidence: 1, confirmedByUser: false, evidence: [] }],
    exchanges: [{ id: "q1", topic: "ML", question: "손실을 설명하세요", questionKind: "primary", parentId: null, interviewerId: "S1", candidateId: "S2", answer: [{ text: "잘못된 가중치 방향으로 설명했다.", segmentIds: ["s2"] }], interviewerContext: [{ text: "면접관이 힌트를 제공했다.", segmentIds: ["s1"] }], uncertainty: ["seg-0060 전사가 끊겨 있어 단정할 수 없습니다."], resumeClaimIds: ["r1"], readingNotes: { topic: "ML", question: "손실 원리는?", answer: ["높은 신뢰도에 가중치를 더 준다고 답함."], hint: "어려운 예제에 집중하도록 보충" }, evidence: [{ segmentId: "s1", start: 0, end: 5, speaker: "S1", text: "힌트" }, { segmentId: "s2", start: 6, end: 30, speaker: "S2", text: "답변 원문" }] }],
    assessments: [
      { criterion: "domain_depth", rating: 2, evidenceStatus: "sufficient", positives: [], concerns: [{ text: "The demonstrated depth fell short of the resume claim.", exchangeIds: ["q1"], resumeClaimIds: ["r1"] }], levelAssessment: "Insufficient demonstrated depth for this answer.", followUps: [] },
      { criterion: "dive_deep", rating: null, evidenceStatus: "not_observed", positives: [], concerns: [], levelAssessment: "Not probed.", followUps: ["Ask for a debugging case."] },
    ],
    overallSummary: { recommendation: "Not Inclined", barAssessment: "borderline", reason: "based on unresolved technical-depth concerns.",
      rationale: "Practical exposure did not establish independent command of the probed concepts at the requested level.",
      criterionIds: ["domain_depth"], exchangeIds: ["q1"] },
    resume: { fileName: "r.pdf", pageCount: 1, claims: [{ id: "r1", text: "Expert-level loss design", pages: [1] }] },
    resumeComparisons: [{ claimId: "r1", status: "gap", explanation: "The explanation did not support the claimed expertise.", readingNotes: { claim: "손실 함수 설계", explanation: "가중치 설명이 이력서의 전문성 주장에 미치지 못했습니다." }, exchangeIds: ["q1"], affectedCriteria: ["domain_depth"] }],
  },
});
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); api.interviewResult.mockResolvedValue(fixture());
  Element.prototype.scrollIntoView = vi.fn();
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(["interview", "i"], fixture());
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/interviews/i"]}><Routes><Route path="/interviews/:id" element={<InterviewPage />} /></Routes></MemoryRouter></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (text: string) => [...element.querySelectorAll("button")].find((b) => b.textContent === text)!;
it("renders narrative feedback and Summary as separate paragraphs while retaining evidence navigation", async () => {
  const result = fixture();
  const doc = result.document!;
  doc.assessments[0]!.positives = [
    { text: "The candidate described a concrete project decision.", exchangeIds: ["q1"] },
    { text: "The candidate also explained the handover process.", exchangeIds: ["q1"] },
  ];
  doc.overallSummary!.rationale = "Project delivery supports this level.\n\nCollaboration adds positive evidence.\n\nRemaining development areas are non-blocking.";
  await act(async () => { client.setQueryData(["interview", "i"], result); });
  await act(async () => button("AI 평가 의견").click());
  const paragraphs = [...element.querySelectorAll("p")].map((p) => p.textContent);
  expect(paragraphs).toContain("The candidate described a concrete project decision.");
  expect(paragraphs).toContain("The candidate also explained the handover process.");
  expect(paragraphs).toContain("The demonstrated depth fell short of the resume claim.");
  expect(paragraphs).toContain("Project delivery supports this level.");
  expect(paragraphs).toContain("Collaboration adds positive evidence.");
  expect(paragraphs).toContain("Remaining development areas are non-blocking.");
  expect(element.textContent).not.toContain("(+)");
  expect(element.textContent).not.toContain("(−)");
  expect(button("근거 q1")).toBeDefined();
});
it("shows the overall binary recommendation before competency opinions and links back to its evidence", async () => {
  await act(async () => button("AI 평가 의견").click());
  const summary = element.querySelector('section[aria-label="종합 의견 Summary"]')!;
  expect(summary.textContent).toContain("Not Inclined");
  expect(summary.textContent).toContain("based on unresolved technical-depth concerns.");
  expect(summary.textContent).not.toContain("borderline");
  expect([...element.querySelectorAll("h2")][0]?.textContent).toBe("종합 의견 (Summary)");
  expect(summary.querySelector("details")?.open).toBe(false);
  await act(async () => (summary.querySelector("summary") as HTMLElement).click());
  await act(async () => (summary.querySelector("button") as HTMLButtonElement).click());
  expect(element.textContent).toContain("높은 신뢰도에 가중치를 더 준다고 답함.");
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});
it("shows concise notes without review essays or speaker IDs and keeps full evidence expandable", async () => {
  expect(element.textContent).not.toContain("이력서의 관련 주장 · 면접 발언과 별도");
  expect(element.textContent).toContain("후보자 답변");
  expect(element.textContent).toContain("면접관 힌트·정정");
  expect(element.textContent).toContain("높은 신뢰도에 가중치를 더 준다고 답함.");
  expect(element.textContent).not.toContain("seg-0060");
  expect(element.textContent).not.toContain("S1");
  expect(element.textContent).not.toContain("S2");
  expect(element.querySelector("details")?.open).toBe(false);
  await act(async () => button("AI 평가 의견").click());
  expect(element.textContent).toContain("2: Mild Concern");
  expect(element.textContent).toContain("근거 부족 · 미평가");
  expect(element.textContent).not.toContain("1: Concern");
  const detail = [...element.querySelectorAll("details")].find((item) => item.textContent?.includes("이력서 대조 보기"))!;
  expect(detail.open).toBe(false);
  expect(element.textContent).not.toContain("이력서 r1");
  await act(async () => { detail.querySelector("summary")!.click(); });
  await act(async () => button("이력서 대조 보기").click());
  expect(element.textContent).toContain("역량 격차 확인");
  expect(element.textContent).toContain("가중치 설명이 이력서의 전문성 주장에 미치지 못했습니다.");
  expect(element.textContent).not.toContain("The explanation did not support");
  expect(element.querySelector('a[href="https://example.org/resume.pdf"]')).not.toBeNull();
  await act(async () => element.querySelector("details summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await act(async () => button("질문 1").click());
  expect(element.textContent).toContain("높은 신뢰도에 가중치를 더 준다고 답함.");
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});
it("saves reviewed speaker roles and settings before requesting reanalysis", async () => {
  await act(async () => button("평가 항목·레벨·화자 역할 수정").click());
  await act(async () => button("설정 적용하고 다시 분석").click());
  expect(api.updateInterviewSettings).toHaveBeenCalledWith("i", expect.objectContaining({ targetLevel: "L6", speakerRoles: { S1: "interviewer", S2: "candidate" } }));
  expect(api.retryInterview).toHaveBeenCalledWith("i");
  expect(api.updateInterviewSettings.mock.invocationCallOrder[0]).toBeLessThan(api.retryInterview.mock.invocationCallOrder[0]!);
});
it("downloads Markdown from the authenticated API without fetching an old signed S3 URL", async () => {
  const content = "# 인터뷰\n\n(+) 근거에 기반한 의견\n";
  api.downloadInterview.mockResolvedValue(content);
  const objectUrl = vi.fn((_blob: Blob) => "blob:interview-note");
  vi.stubGlobal("URL", class extends URL { static createObjectURL = objectUrl; static revokeObjectURL = vi.fn(); });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await act(async () => button("전체 기록 다운로드 (.md)").click());
  expect(api.downloadInterview).toHaveBeenCalledWith("i");
  expect(fetch).not.toHaveBeenCalled();
  expect(objectUrl.mock.calls[0]?.[0]).toMatchObject({ type: "text/markdown; charset=utf-8", size: new TextEncoder().encode(content).length });
  expect(click.mock.instances[0]).toHaveProperty("download", "Interview_전체_인터뷰기록.md");
});
it("uses a freshly requested link for files above the authenticated API response limit", async () => {
  api.downloadInterview.mockRejectedValue(new ApiError(413, "direct_download_required", "Large file"));
  api.interviewResult.mockResolvedValue({ ...fixture(), markdownUrl: "https://example.org/fresh-large.md" });
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:large-note"); static revokeObjectURL = vi.fn(); });
  const fetch = vi.fn().mockResolvedValue(new Response("# Large interview"));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await act(async () => button("전체 기록 다운로드 (.md)").click());
  expect(fetch).toHaveBeenCalledWith("https://example.org/fresh-large.md", { cache: "no-store" });
  expect(fetch).not.toHaveBeenCalledWith(fixture().markdownUrl, expect.anything());
});
it("downloads a simple Q&A copy from the displayed notes without a new network request or analysis", async () => {
  const objectUrl = vi.fn((_blob: Blob) => "blob:simple-note");
  vi.stubGlobal("URL", class extends URL { static createObjectURL = objectUrl; static revokeObjectURL = vi.fn(); });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await act(async () => button("간소화 노트 다운로드 (.md)").click());
  expect(api.downloadInterview).not.toHaveBeenCalled();
  expect(api.retryInterview).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(click.mock.instances[0]).toHaveProperty("download", "Interview_간소화_인터뷰노트.md");
  const blob = objectUrl.mock.calls[0]![0];
  const content = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsText(blob); });
  expect(content).toContain("**Q: 손실 원리는?**");
  expect(content).toContain("**A:**");
  expect(content).not.toContain("Expert-level loss design");
  expect(content).not.toContain("The demonstrated depth");
  expect(content).not.toContain("Not Inclined");
  expect(content).not.toContain("unresolved technical-depth concerns");
  expect(content).not.toContain("r1");
});
