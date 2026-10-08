// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ createLecture: vi.fn(), completeLectureUpload: vi.fn(), startLecture: vi.fn() }));
const upload = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ useApi: () => api }));
vi.mock("../upload", () => ({ uploadMultipart: upload }));
import { LectureUploadForm } from "../../pages/LectureUploadPage";
let root: Root, element: HTMLDivElement, client: QueryClient;
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  const target = { uploadId: "v", parts: [], partSize: 16, expiresAt: "2099-01-01" };
  api.createLecture.mockResolvedValue({ lecture: { lectureId: "lecture" }, uploads: { video: target } });
  api.completeLectureUpload.mockResolvedValue(undefined); api.startLecture.mockResolvedValue(undefined);
  upload.mockResolvedValue([{ partNumber: 1, etag: "part" }]);
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element); client = new QueryClient();
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><LectureUploadForm /></MemoryRouter></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); client.clear(); });
function fileInput(label: string) { return element.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement; }
async function choose(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
function submit() { return [...element.querySelectorAll("button")].find((b) => b.textContent === "학습 자료 만들기")!; }
async function setRequest(value: string) {
  const input = element.querySelector('textarea[aria-label="추가 요청 (선택)"]') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("accepts MP4 alone and does not send a slide completion request", async () => {
  expect(fileInput("강의 영상").accept).toBe("video/mp4,.mp4");
  expect(fileInput("강의 장표 (선택)").accept).toBe(".pptx,.pdf");
  await choose(fileInput("강의 영상"), new File(["mp4 fixture"], "course.mp4", { type: "video/mp4" }));
  expect(submit().disabled).toBe(false);
  await act(async () => submit().click());
  expect(api.createLecture.mock.calls[0]![0]).toMatchObject({ video: { fileName: "course.mp4", contentType: "video/mp4" } });
  expect(api.createLecture.mock.calls[0]![0].slides).toBeUndefined();
  expect(api.createLecture.mock.calls[0]![0].customPrompt).toBe("");
  expect(api.completeLectureUpload).toHaveBeenCalledOnce();
  expect(api.completeLectureUpload.mock.calls[0]![1].asset).toBe("video");
  expect(api.startLecture).toHaveBeenCalledWith("lecture");
});
it("submits an optional custom request and locks it with the rest of a resumable upload", async () => {
  const input = element.querySelector('textarea[aria-label="추가 요청 (선택)"]') as HTMLTextAreaElement;
  expect(input.required).toBe(false);
  expect(input.maxLength).toBe(2000);
  await setRequest("  첨부 슬라이드의 38–48페이지 위주로 보기  ");
  await choose(fileInput("강의 영상"), new File(["mp4"], "course.mp4", { type: "video/mp4" }));
  api.completeLectureUpload.mockRejectedValueOnce(new Error("Temporary failure"));
  await act(async () => submit().click());
  expect(api.createLecture.mock.calls[0]![0].customPrompt).toBe("첨부 슬라이드의 38–48페이지 위주로 보기");
  expect(input.closest("fieldset")?.disabled).toBe(true);
  await act(async () => [...element.querySelectorAll("button")].find((b) => b.textContent === "업로드 이어서 진행")!.click());
  expect(api.createLecture).toHaveBeenCalledOnce();
  expect(api.startLecture).toHaveBeenCalledWith("lecture");
});
it("rejects an oversized custom request before creating an upload plan", async () => {
  await choose(fileInput("강의 영상"), new File(["mp4"], "course.mp4", { type: "video/mp4" }));
  await setRequest("가".repeat(2001));
  await act(async () => submit().click());
  expect(api.createLecture).not.toHaveBeenCalled();
  expect(element.textContent).toContain("추가 요청은 2,000자 이하");
});
it("does not accept an MP3 as the primary lecture video", async () => {
  await choose(fileInput("강의 영상"), new File(["audio"], "voice.mp3", { type: "audio/mpeg" }));
  expect(submit().disabled).toBe(true);
  expect(api.createLecture).not.toHaveBeenCalled();
});

async function audioMode() {
  await act(async () => ([...element.querySelectorAll("button")].find((b) => b.textContent === "음성 MP3")!).click());
}
it("uploads MP3 alone through the audio asset and starts lecture analysis", async () => {
  api.createLecture.mockResolvedValue({ lecture: { lectureId: "lecture" }, uploads: { audio: { uploadId: "a", parts: [], partSize: 16, expiresAt: "2099-01-01" } } });
  await audioMode();
  expect(fileInput("강의 음성").accept).toBe("audio/mpeg,.mp3");
  await choose(fileInput("강의 음성"), new File(["mp3"], "course.mp3", { type: "audio/mpeg" }));
  await act(async () => submit().click());
  expect(api.createLecture.mock.calls[0]![0]).toMatchObject({ audio: { fileName: "course.mp3", contentType: "audio/mpeg" } });
  expect(api.createLecture.mock.calls[0]![0].video).toBeUndefined();
  expect(api.completeLectureUpload).toHaveBeenCalledWith("lecture", { asset: "audio", uploadId: "a", parts: [{ partNumber: 1, etag: "part" }] });
  expect(api.startLecture).toHaveBeenCalledWith("lecture");
});
it("clears the previous media selection when switching format and rejects MP4 in audio mode", async () => {
  await choose(fileInput("강의 영상"), new File(["mp4"], "course.mp4"));
  await audioMode();
  expect(submit().disabled).toBe(true);
  await choose(fileInput("강의 음성"), new File(["mp4"], "course.mp4"));
  expect(submit().disabled).toBe(true);
  expect(element.textContent).toContain("MP3 음성을 선택하세요");
});
it("retries audio completion after a lost response without uploading the bytes again", async () => {
  api.createLecture.mockResolvedValue({ lecture: { lectureId: "lecture" }, uploads: {
    audio: { uploadId: "a", parts: [], partSize: 16, expiresAt: "2099-01-01" },
    slides: { uploadId: "s", parts: [], partSize: 16, expiresAt: "2099-01-01" },
  } });
  api.completeLectureUpload.mockImplementation(async (_id, body) => { if (body.asset === "audio" && api.completeLectureUpload.mock.calls.length === 2) throw new Error("Network failure"); });
  await audioMode();
  await choose(fileInput("강의 음성"), new File(["mp3"], "course.mp3"));
  await choose(fileInput("강의 장표 (선택)"), new File(["pdf"], "course.pdf"));
  await act(async () => submit().click());
  expect(api.startLecture).not.toHaveBeenCalled();
  const resume = [...element.querySelectorAll("button")].find((b) => b.textContent === "업로드 이어서 진행")!;
  await act(async () => resume.click());
  expect(upload).toHaveBeenCalledTimes(2);
  expect(api.createLecture).toHaveBeenCalledOnce();
  expect(api.completeLectureUpload.mock.calls.map((c) => c[1].asset)).toEqual(["slides", "audio", "audio"]);
  expect(api.startLecture).toHaveBeenCalledOnce();
});
