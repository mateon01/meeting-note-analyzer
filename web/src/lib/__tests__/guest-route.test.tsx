// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ isLoading: true, isAuthenticated: false, user: null, activeNavigator: undefined, error: undefined, signinSilent: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth: () => auth }));
vi.mock("../../pages/GuestLecturePage", () => ({ GuestLecturePage: () => <p>게스트 이메일 인증</p> }));
vi.mock("../../pages/LoginPage", () => ({ LoginPage: () => <p>소유자 로그인</p> }));
import { App } from "../../App";

it("opens the guest route during owner-auth loading while keeping owner routes protected", async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement("div"); document.body.appendChild(element);
  let root = createRoot(element);
  await act(async () => { root.render(<MemoryRouter initialEntries={["/shared/lectures/test"]}><App /></MemoryRouter>); });
  expect(element.textContent).toContain("게스트 이메일 인증");
  expect(element.textContent).not.toContain("소유자 로그인");
  await act(async () => root.unmount());
  auth.isLoading = false; root = createRoot(element);
  await act(async () => { root.render(<MemoryRouter initialEntries={["/lectures/test"]}><App /></MemoryRouter>); });
  expect(element.textContent).toContain("소유자 로그인");
  await act(async () => root.unmount()); element.remove();
});
