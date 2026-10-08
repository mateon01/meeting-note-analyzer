// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../use-config", () => ({ useConfig: () => ({ apiBase: "/api" }) }));
import { GuestLecturePage } from "../../pages/GuestLecturePage";
let root: Root, element: HTMLDivElement, client: QueryClient;
let authenticated = false, revoked = false, rejectCode = false;
const shareId = "11111111-1111-4111-8111-111111111111";
const fixture = { expiresAt: "2099-01-01", images: [], document: { version: 1, lectureId: "lecture", title: "공유된 CTC 강의", course: "ML", generatedAt: "2026-01-01",
  outputLanguage: "ko", durationSec: 120, selectedPages: [38, 39], originalPageCount: 73, grouped: true,
  overview: "시퀀스 학습의 개념", learningObjectives: [], reviewPlan: [], warnings: [], pages: [] } };
const fetchMock = vi.fn();
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  authenticated = revoked = rejectCode = false; fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
    let data: unknown; let status = 200;
    if (url.endsWith("/request-code")) data = { challengeId: "22222222-2222-4222-8222-abcdefabcdef" };
    else if (url.endsWith("/verify-code")) { authenticated = !rejectCode; data = rejectCode ? { message: "잘못된 인증 코드" } : { verified: true }; status = rejectCode ? 400 : 200; }
    else if (url.endsWith("/logout")) { authenticated = false; data = {}; }
    else if (revoked) { status = 404; data = { message: "공유가 해제되었습니다" }; }
    else { status = authenticated ? 200 : 401; data = authenticated ? fixture : { message: "이메일 인증이 필요합니다" }; }
    expect(options.credentials).toBe("include"); expect(options.cache).toBe("no-store");
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/shared/lectures/${shareId}`]}><Routes>
      <Route path="/shared/lectures/:shareId" element={<GuestLecturePage />} />
    </Routes></MemoryRouter></QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); element.remove(); vi.unstubAllGlobals(); });
async function input(label: string, value: string) {
  await act(async () => {
    const node = element.querySelector(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { element.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await new Promise((resolve) => setTimeout(resolve, 30)); });
}
it("opens the guest email-code flow without an owner login or password", async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(element.querySelector('input[type="password"]')).toBeNull();
  expect(element.textContent).toContain("초대된 이메일");
  await input("게스트 이메일", "guest@example.com"); await submit();
  const field = element.querySelector('input[aria-label="인증 코드"]') as HTMLInputElement;
  expect(field.maxLength).toBe(8);
  await input("인증 코드", "01234567");
  expect(field.value).toBe("01234567");
  expect(field.checkValidity()).toBe(true);
  expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  await submit();
  const verification = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/verify-code"))!;
  expect(JSON.parse(verification[1].body).code).toBe("01234567");
  expect(element.textContent).toContain("공유된 CTC 강의");
  expect(element.textContent).toContain("38–39페이지");
  expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith("/api/guest/"))).toBe(true);
});

it("does not display the lecture after a rejected code", async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  rejectCode = true;
  await input("게스트 이메일", "guest@example.com"); await submit();
  await input("인증 코드", "01234567"); await submit();
  expect(element.textContent).toContain("잘못된 인증 코드");
  expect(element.textContent).not.toContain("공유된 CTC 강의");
});

it("hides previously loaded notes when a fresh read reports revocation", async () => {
  authenticated = true;
  await act(async () => { await client.invalidateQueries({ queryKey: ["guest-lecture"] }); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(element.textContent).toContain("공유된 CTC 강의");
  revoked = true;
  await act(async () => { await client.invalidateQueries({ queryKey: ["guest-lecture"] }); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(element.textContent).not.toContain("공유된 CTC 강의");
  expect(element.textContent).toContain("공유가 해제되었습니다");
});
