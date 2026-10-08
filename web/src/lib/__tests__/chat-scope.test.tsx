// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ listChatSessions: vi.fn(), createChatSession: vi.fn(), listMeetings: vi.fn(), listLectures: vi.fn() }));
vi.mock("../api", () => ({ useApi: () => api }));
import { ChatListPage } from "../../pages/ChatListPage";
let root: Root, element: HTMLDivElement, client: QueryClient;
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  api.listChatSessions.mockResolvedValue({ items: [] });
  api.listMeetings.mockResolvedValue({ items: [{ meetingId: "meeting-1", title: "회의", status: "COMPLETED" }], cursor: null });
  api.listLectures.mockResolvedValue({ items: [{ lectureId: "lecture-1", title: "CTC 강의", status: "COMPLETED" }], cursor: null });
  api.createChatSession.mockResolvedValue({ session: { sessionId: "new-session" } });
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/chat"]}><Routes>
    <Route path="/chat" element={<ChatListPage />} /><Route path="/chat/:id" element={<p>대화 화면</p>} />
  </Routes></MemoryRouter></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); client.clear(); });
function button(text: string) { return [...element.querySelectorAll("button")].find((b) => b.textContent === text)!; }

it("starts a conversation pinned to the lecture chosen after the source tab", async () => {
  await act(async () => { button("강의").click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(element.textContent).toContain("CTC 강의");
  const select = element.querySelector('select[aria-label="강의 선택"]') as HTMLSelectElement;
  await act(async () => { select.value = "lecture-1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => button("새 대화").click());
  expect(api.createChatSession).toHaveBeenCalledWith({ sourceType: "lecture", lectureId: "lecture-1" });
  expect(element.textContent).toContain("대화 화면");
});

it("supports searching all lectures without carrying a meeting ID into the scope", async () => {
  await act(async () => button("강의").click());
  await act(async () => button("새 대화").click());
  expect(api.createChatSession).toHaveBeenCalledWith({ sourceType: "lecture" });
});
