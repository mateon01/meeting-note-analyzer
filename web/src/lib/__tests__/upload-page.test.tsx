// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../api", () => ({ useApi: () => ({}) }));
vi.mock("../upload", () => ({ uploadMultipart: vi.fn() }));
import { UploadPage } from "../../pages/UploadPage";

let root: Root; let element: HTMLDivElement; let client: QueryClient;
afterEach(async () => { await act(async () => root.unmount()); element.remove(); client.clear(); });
async function render(path: string) {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element); client = new QueryClient();
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><UploadPage /></MemoryRouter></QueryClientProvider>));
}
const tab = (label: string) => [...element.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;

it("offers meeting and lecture uploads as tabs above the form, meeting first", async () => {
  await render("/upload");
  expect(tab("회의 녹음").getAttribute("aria-selected")).toBe("true");
  expect(tab("강의 노트").getAttribute("aria-selected")).toBe("false");
  expect(element.textContent).toContain("mp3 파일 선택");
  expect(element.querySelector('input[aria-label="강의 영상"]')).toBeNull();
  await act(async () => tab("강의 노트").click());
  expect(tab("강의 노트").getAttribute("aria-selected")).toBe("true");
  expect(element.querySelector('input[aria-label="강의 영상"]')).not.toBeNull();
  expect(element.textContent).toContain("학습 자료 만들기");
  expect(element.textContent).not.toContain("mp3 파일 선택");
});
it("opens the lecture tab directly from the kind query parameter", async () => {
  await render("/upload?kind=lecture");
  expect(tab("강의 노트").getAttribute("aria-selected")).toBe("true");
  expect(element.querySelector('input[aria-label="강의 영상"]')).not.toBeNull();
});
