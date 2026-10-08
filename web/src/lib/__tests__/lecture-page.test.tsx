// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LectureResultResponse } from "@meeting-notes/shared";

const api = vi.hoisted(() => ({ lectureResult: vi.fn(), retryLecture: vi.fn(), startLecture: vi.fn(), deleteLecture: vi.fn(), createChatSession: vi.fn(), listLectureShares: vi.fn() }));
vi.mock("../api", () => ({ useApi: () => api }));
import { LecturePage } from "../../pages/LecturePage";

let root: Root; let element: HTMLDivElement; let client: QueryClient;
const fixture = (): LectureResultResponse => ({
  lecture: { lectureId: "test", owner: "alice", title: "최적화 수업", course: "머신러닝", status: "COMPLETED", outputLanguage: "ko", languageHint: "ko", stages: {}, createdAt: "2026-09-06", updatedAt: "2026-09-06", audioName: "a.mp3", slidesName: "a.pdf", uploadsComplete: true, pageCount: 1, researchFailures: 1 },
  document: { version: 1, lectureId: "test", title: "최적화 수업", course: "머신러닝", outputLanguage: "ko", generatedAt: "2026-09-06", overview: "경사 하강법의 원리와 학습률을 공부합니다.", audience: { level: "학부 1학년, 첫 최적화 수업", priorKnowledge: ["미분"], lectureGoal: "경사 하강 한 단계를 계산하기" }, learningObjectives: ["업데이트 식을 이해하기"], reviewPlan: ["미분을 복습하기"], durationSec: 100, warnings: [], pages: [{
    page: 1, title: "경사 하강법", slideText: "Gradient descent", imageKey: "one.png", slideSummary: "장표는 가중치 갱신을 설명합니다.", spokenSummary: "", explanation: "학습률 $\\eta$ 가 이동 크기를 정합니다.", alignment: { status: "unmatched", confidence: 0, reason: "" }, evidence: [],
    concepts: [{ term: "학습률", explanation: "갱신의 크기" }], reviewQuestions: [{ question: "학습률이 크면?", answer: "최적점을 지나칠 수 있습니다.", difficulty: "basic" }], mathNotes: [{ kind: "formula", name: "갱신 식", statement: "$$x_{t+1} = x_t - \\eta \\nabla f(x_t)$$", steps: ["현재 위치 $x_t$에서 시작한다", "기울기 반대 방향으로 이동한다"], intuition: "내리막으로 걷기", supplementary: true }], flashcards: [{ front: "학습률이란?", back: "갱신의 크기" }], research: { status: "failed", queries: ["gradient descent"], papers: [] },
  }] }, audioUrl: null, slidesUrl: "https://example.org/slides.pdf", markdownUrl: "https://example.org/study.md", flashcardsUrl: "https://example.org/cards.csv", pageImages: [],
});
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); api.lectureResult.mockResolvedValue(fixture()); api.retryLecture.mockResolvedValue(undefined);
  api.listLectureShares.mockResolvedValue({ items: [] });
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["lecture", "test"], fixture());
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/lectures/test"]}><Routes><Route path="/lectures/:id" element={<LecturePage />} /></Routes></MemoryRouter></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); client.clear(); });
function button(text: string) { return [...element.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!; }

it("opens guest sharing from the action row without creating an invitation", async () => {
  const actions = element.querySelector('[role="group"][aria-label="강의 작업"]')!;
  expect([...actions.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
    "이 강의에 질문하기", "게스트 공유", "논문 검색 다시 시도", "PDF로 저장",
  ]);
  const share = button("게스트 공유");
  expect(share.textContent).toBe("게스트 공유");
  expect(share.getAttribute("aria-expanded")).toBe("false");
  expect(element.querySelector('textarea[aria-label="초대할 이메일"]')).toBeNull();
  await act(async () => { (share as HTMLButtonElement).click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(element.querySelector('textarea[aria-label="초대할 이메일"]')).not.toBeNull();
  expect(api.listLectureShares).toHaveBeenCalledWith("test");
  await act(async () => button("닫기").click());
  expect(element.querySelector("#lecture-sharing")).toBeNull();
});

it("opens a sharing link directly, including while a published lecture is being regenerated", async () => {
  const result = fixture();
  result.lecture.status = "ANALYZING";
  api.lectureResult.mockResolvedValue(result); client.setQueryData(["lecture", "test"], result);
  await act(async () => root.unmount()); element.remove();
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/lectures/test?share=1&page=1"]}><Routes><Route path="/lectures/:id" element={<LecturePage />} /></Routes></MemoryRouter></QueryClientProvider>));
  expect(button("게스트 공유").getAttribute("aria-expanded")).toBe("true");
  expect(element.querySelector('textarea[aria-label="초대할 이메일"]')).not.toBeNull();
  expect(element.textContent).toContain("수식과 정리");
});

it("shows only selected source pages and switches images inside a learning group", async () => {
  const result = fixture();
  Object.assign(result.document!, { grouped: true, selectedPages: [38, 39], originalPageCount: 73 });
  Object.assign(result.document!.pages[0]!, { source: "deck", deckPage: 38, sourcePages: [38, 39] });
  result.pageImages = [{ page: 1, sourcePage: 38, url: "https://example.org/38.png" }, { page: 1, sourcePage: 39, url: "https://example.org/39.png" }];
  api.lectureResult.mockResolvedValue(result);
  await act(async () => { client.setQueryData(["lecture", "test"], result); await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(element.textContent).toContain("분석 범위: 38–39페이지");
  expect(element.textContent).toContain("학습 묶음 1개");
  await act(async () => button("주제별 학습").click());
  expect(element.querySelector("img")?.getAttribute("src")).toBe("https://example.org/38.png");
  await act(async () => button("39페이지").click());
  expect(element.querySelector("img")?.getAttribute("src")).toBe("https://example.org/39.png");
  expect(element.querySelectorAll('select[aria-label="장표 선택"] option')).toHaveLength(1);
});

it("opens chat with the current lecture as its fixed scope", async () => {
  api.createChatSession.mockRejectedValue(new Error("Temporary failure"));
  await act(async () => { button("이 강의에 질문하기").click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(api.createChatSession).toHaveBeenCalledWith({ sourceType: "lecture", lectureId: "test" });
  expect(element.textContent).toContain("Temporary failure");
});

it("shows study exports, unmatched speech and search failures without fabricated content", async () => {
  expect(element.textContent).toContain("경사 하강법의 원리");
  expect(element.querySelector('a[href="https://example.org/cards.csv"]')).not.toBeNull();
  await act(async () => button("장표별 학습").click());
  expect(element.textContent).toContain("대응하는 발언을 녹음에서 찾지 못했습니다");
  expect(element.textContent).toContain("논문 검색을 완료하지 못했습니다");
  expect(element.textContent).not.toContain("참고 논문이 없습니다");
  const question = [...element.querySelectorAll("details")].find((d) => d.textContent?.includes("학습률이 크면"))!;
  expect(question.open).toBe(false);
  expect(question.textContent).toContain("최적점을 지나칠 수 있습니다");
});
it("shows the request that was applied to the document as optional plain text", async () => {
  expect([...element.querySelectorAll("summary")].some((s) => s.textContent === "추가 요청")).toBe(false);
  const result = fixture();
  result.document!.customPrompt = "첨부 슬라이드의 38–48페이지 위주로 보기 <script>example</script>";
  result.lecture.customPrompt = result.document!.customPrompt;
  api.lectureResult.mockResolvedValue(result);
  await act(async () => { client.setQueryData(["lecture", "test"], result); await new Promise((resolve) => setTimeout(resolve, 10)); });
  const request = [...element.querySelectorAll("details")].find((d) => d.querySelector("summary")?.textContent === "추가 요청")!;
  expect(request.open).toBe(false);
  expect(request.textContent).toContain("38–48페이지");
  expect(request.querySelector("script")).toBeNull();
});

it("opens flashcards and offers to retry only the failed paper search", async () => {
  await act(async () => button("복습 카드").click());
  expect(element.querySelector("details summary")?.textContent).toContain("학습률이란");
  await act(async () => button("논문 검색 다시 시도").click());
  expect(api.retryLecture).toHaveBeenCalledWith("test");
});

it("shows the inferred audience, question difficulty and KaTeX-rendered math notes", async () => {
  expect(element.textContent).toContain("이 강의의 대상");
  expect(element.textContent).toContain("학부 1학년, 첫 최적화 수업");
  await act(async () => button("장표별 학습").click());
  expect(element.textContent).toContain("수식과 정리");
  expect(element.textContent).toContain("갱신 식");
  expect(element.textContent).toContain("기본");
  expect(element.textContent).toContain("강의에서 생략된 증명을 보충했습니다");
  expect(element.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(3); // statement, a step and the explanation
  expect(element.textContent).not.toContain("$$");
  const steps = [...element.querySelectorAll("ol")].find((list) => list.textContent?.includes("기울기 반대 방향"))!;
  expect(steps.querySelectorAll("li").length).toBe(2);
});

it("opens the section named in the page query parameter", async () => {
  await act(async () => root.unmount()); element.remove();
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/lectures/test?page=1"]}><Routes><Route path="/lectures/:id" element={<LecturePage />} /></Routes></MemoryRouter></QueryClientProvider>));
  expect(element.textContent).toContain("수식과 정리");
  expect(element.textContent).not.toContain("학습 목표");
});

it("docks the video as a pinned mini player only while it is playing and scrolled out of view", async () => {
  const observers: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class { constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { observers.push(cb); } observe() {} unobserve() {} disconnect() {} };
  await act(async () => root.unmount()); element.remove();
  const withVideo = { ...fixture(), videoUrl: "https://example.org/lecture.mp4" };
  api.lectureResult.mockResolvedValue(withVideo); client.setQueryData(["lecture", "test"], withVideo);
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/lectures/test"]}><Routes><Route path="/lectures/:id" element={<LecturePage />} /></Routes></MemoryRouter></QueryClientProvider>));
  const video = element.querySelector("video")!; const dock = () => element.querySelector('[data-testid="video-dock"]');
  expect(observers).toHaveLength(1);
  await act(async () => { observers[0]!([{ isIntersecting: false }]); }); // scrolled past while paused: nothing happens
  expect(dock()).toBeNull();
  expect(element.textContent).not.toContain("펼치기");
  await act(async () => { video.dispatchEvent(new Event("play")); });
  await act(async () => { observers[0]!([{ isIntersecting: false }]); });
  expect(dock()?.className).toContain("sticky");
  expect(element.textContent).toContain("펼치기");
  expect(video.hasAttribute("controls")).toBe(false);
  await act(async () => { video.dispatchEvent(new Event("pause")); }); // pausing keeps the mini player until the user scrolls back up
  expect(dock()).not.toBeNull();
  await act(async () => { observers[0]!([{ isIntersecting: true }]); });
  expect(dock()).toBeNull();
  expect(video.hasAttribute("controls")).toBe(true);
});

it("wraps a long lecture title in the page header", async () => {
  expect(element.querySelector("h1")?.className).toContain("[overflow-wrap:anywhere]");
});

it("plays audio topic ranges without showing slide or video labels", async () => {
  const result = fixture();
  result.lecture.slidesName = undefined;
  result.document!.pages[0] = { ...result.document!.pages[0]!, source: "audio", sourceFile: "class.mp3", audioRanges: [{ startSec: 10, endSec: 50 }], alignment: { status: "matched", confidence: 1, method: "audio_time", reason: "발언 시간" } };
  api.lectureResult.mockResolvedValue(result);
  await act(async () => { client.setQueryData(["lecture", "test"], result); await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => button("구간별 학습").click());
  expect(element.textContent).toContain("음성 듣기");
  expect(element.textContent).toContain("음성 시간 기준");
  expect(element.textContent).not.toContain("영상에서 확인한");
  expect(element.querySelector("img")).toBeNull();
});

it("prints every section and expanded answers with rendered math but no signed source links", async () => {
  const result = fixture();
  result.document!.pages.push({ ...result.document!.pages[0]!, page: 2, title: "두 번째 주제", explanation: "화면에 선택되지 않은 두 번째 설명" });
  result.document!.pages[0]!.mathNotes![0] = {
    ...result.document!.pages[0]!.mathNotes![0]!,
    symbols: [{ symbol: "$\\eta$", meaning: "학습률" }], assumptions: ["미분 가능"],
    sourceCheck: { status: "corrected", explanation: "원본 부호가 손실 정의와 충돌합니다.", correctedStatement: "$$\\delta=-\\frac{\\partial E}{\\partial s}$$" },
  };
  api.lectureResult.mockResolvedValue(result);
  await act(async () => { client.setQueryData(["lecture", "test"], result); await new Promise((resolve) => setTimeout(resolve, 10)); });
  const print = vi.spyOn(window, "print").mockImplementation(() => {});
  await act(async () => button("PDF로 저장").click());
  const printable = document.querySelector(".lecture-print")!;
  expect(print).toHaveBeenCalledOnce();
  expect(printable.textContent).toContain("두 번째 주제");
  expect(printable.textContent).toContain("화면에 선택되지 않은 두 번째 설명");
  expect(printable.textContent).toContain("최적점을 지나칠 수 있습니다.");
  expect(printable.textContent).toContain("원본 오류 수정");
  expect(printable.textContent).toContain("기호의 뜻");
  expect(printable.querySelectorAll(".katex").length).toBeGreaterThan(3);
  expect(printable.querySelector("details, audio, video, img")).toBeNull();
  expect(printable.innerHTML).not.toContain("https://example.org/slides.pdf");
  expect(printable.innerHTML).not.toContain("https://example.org/study.md");
  await act(async () => window.dispatchEvent(new Event("afterprint")));
  print.mockRestore();
});
