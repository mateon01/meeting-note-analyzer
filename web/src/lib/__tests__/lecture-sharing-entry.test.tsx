// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listLectures: vi.fn() }));
vi.mock("../api", () => ({ useApi: () => api }));
import { LecturesPage } from "../../pages/LecturesPage";
function Destination() { const location = useLocation(); return <p>{location.pathname}{location.search}</p>; }

it("opens the selected completed lecture's sharing settings from the list", async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const data = { items: [
    { lectureId: "finished", title: "완료된 강의", course: "ML", status: "COMPLETED", createdAt: "2026-01-01" },
    { lectureId: "processing", title: "처리 중인 강의", status: "TRANSCRIBING", createdAt: "2026-01-01" },
  ], cursor: null };
  api.listLectures.mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["lectures"], { pages: [data], pageParams: [undefined] });
  const element = document.createElement("div"); document.body.appendChild(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/lectures"]}><Routes>
      <Route path="/lectures" element={<LecturesPage />} /><Route path="/lectures/:id" element={<Destination />} />
    </Routes></MemoryRouter></QueryClientProvider>));
    const sharing = [...element.querySelectorAll("button")].filter((button) => button.textContent === "게스트 공유");
    expect(sharing).toHaveLength(1);
    expect(element.querySelector("button button")).toBeNull();
    await act(async () => sharing[0]!.click());
    expect(element.textContent).toBe("/lectures/finished?share=1");
  } finally {
    await act(async () => root.unmount()); client.clear(); element.remove();
  }
});
