// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ createInterview: vi.fn(), completeInterviewUpload: vi.fn(), startInterview: vi.fn() }));
const upload = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ useApi: () => api }));
vi.mock("../upload", () => ({ uploadMultipart: upload }));
import { InterviewUploadForm } from "../../pages/InterviewUploadPage";

let root: Root, element: HTMLDivElement, client: QueryClient;
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  api.createInterview.mockResolvedValue({ interview: { interviewId: "i" }, upload: { uploadId: "audio", partSize: 16, parts: [], expiresAt: "2099-01-01" },
    resumeUpload: { uploadId: "resume", partSize: 16, parts: [], expiresAt: "2099-01-01" } });
  upload.mockResolvedValue([{ partNumber: 1, etag: "etag" }]);
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element); client = new QueryClient();
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><InterviewUploadForm /></MemoryRouter></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); client.clear(); });
async function choose(label: string, file: File) {
  const input = element.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
const button = (label: string) => [...element.querySelectorAll("button")].find((b) => b.textContent === label)!;
const checkbox = (label: string) => element.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
it("uploads MP3 without a resume and preserves multiple criteria plus the target level", async () => {
  await choose("인터뷰 녹음", new File(["mp3"], "interview.mp3"));
  await act(async () => checkbox("System Architecture").click());
  await act(async () => checkbox("Technical Communication").click());
  await act(async () => checkbox("Dive Deep").click());
  const techFit = [...element.querySelectorAll("fieldset")].find((f) => f.querySelector(":scope > legend")?.textContent?.startsWith("Technical Fit"))!;
  const lp = [...element.querySelectorAll("fieldset")].find((f) => f.querySelector(":scope > legend")?.textContent?.startsWith("Amazon LP"))!;
  expect(techFit.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
  expect(techFit.textContent).toContain("비전공자·경영진·유관부서");
  expect(lp.querySelector('input[aria-label="Technical Communication"]')).toBeNull();
  expect(lp.querySelector('input[aria-label="Customer Obsession"]')).not.toBeNull();
  const level = element.querySelector('select[aria-label="목표 레벨"]') as HTMLSelectElement;
  await act(async () => { level.value = "L5"; level.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => button("인터뷰 노트 만들기").click());
  expect(api.createInterview.mock.calls[0]![0].settings).toMatchObject({ targetLevel: "L5", criteria: ["domain_depth", "system_architecture", "technical_communication", "dive_deep"], notesLanguage: "ko", opinionLanguage: "en" });
  expect(api.createInterview.mock.calls[0]![0].resume).toBeUndefined();
  expect(api.completeInterviewUpload.mock.calls.map((c) => c[1].asset)).toEqual(["audio"]);
  expect(api.startInterview).toHaveBeenCalledWith("i");
});
it("uploads optional PDF first and reuses completed parts after a lost completion response", async () => {
  await choose("인터뷰 녹음", new File(["mp3"], "interview.mp3"));
  await choose("후보자 이력서 (선택)", new File(["pdf"], "resume.pdf"));
  api.completeInterviewUpload.mockRejectedValueOnce(new Error("Network failure"));
  await act(async () => button("인터뷰 노트 만들기").click());
  expect(api.startInterview).not.toHaveBeenCalled();
  await act(async () => button("업로드 이어서 진행").click());
  expect(api.createInterview).toHaveBeenCalledOnce();
  expect(api.createInterview.mock.calls[0]![0].resume).toMatchObject({ contentType: "application/pdf", fileName: "resume.pdf" });
  expect(upload).toHaveBeenCalledTimes(2); // resume bytes are reused on the completion retry
  expect(api.completeInterviewUpload.mock.calls.map((c) => c[1].asset)).toEqual(["resume", "resume", "audio"]);
  expect(api.startInterview).toHaveBeenCalledOnce();
});
it("blocks an invalid resume until it is removed and requires at least one criterion", async () => {
  await choose("인터뷰 녹음", new File(["mp3"], "interview.mp3"));
  await choose("후보자 이력서 (선택)", new File(["docx"], "resume.docx"));
  expect(button("인터뷰 노트 만들기").disabled).toBe(true);
  await act(async () => button("이력서 첨부 취소").click());
  expect(button("인터뷰 노트 만들기").disabled).toBe(false);
  await act(async () => checkbox("Domain Depth").click());
  expect(button("인터뷰 노트 만들기").disabled).toBe(true);
});
