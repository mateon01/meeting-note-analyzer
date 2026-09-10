// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: { profile: { email: "user@example.test", sub: "u1", name: "User" } }, revokeTokens: vi.fn(), removeUser: vi.fn() }));
const navigateTo = vi.hoisted(() => vi.fn());
vi.mock("react-oidc-context", () => ({ useAuth: () => auth }));
vi.mock("../api", () => ({ useApi: () => ({}) }));
vi.mock("../use-config", () => ({ useConfig: () => ({ cognitoDomain: "https://auth.example.test", cognitoClientId: "client-1" }) }));
vi.mock("../push", () => ({ currentSubscription: async () => null, enablePush: vi.fn(), disablePush: vi.fn(), isIos: () => false, isStandalone: () => false, pushSupported: () => false }));
vi.mock("../navigation", () => ({ navigateTo }));
import { SettingsPage } from "../../pages/SettingsPage";

let root: Root; let element: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  auth.revokeTokens.mockResolvedValue(undefined); auth.removeUser.mockResolvedValue(undefined);
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
async function render() { await act(async () => root.render(<MemoryRouter><SettingsPage /></MemoryRouter>)); }
const logoutButton = () => [...element.querySelectorAll("button")].find((b) => b.textContent?.includes("로그아웃"))!;
const logoutUrl = `https://auth.example.test/logout?client_id=client-1&logout_uri=${encodeURIComponent(`${window.location.origin}/`)}`;

it("revokes the refresh token at Cognito before clearing the device session and leaving for the logout endpoint", async () => {
  await render();
  await act(async () => logoutButton().click());
  await vi.waitFor(() => expect(navigateTo).toHaveBeenCalledWith(logoutUrl));
  expect(auth.revokeTokens).toHaveBeenCalledWith(["refresh_token"]);
  expect(auth.revokeTokens.mock.invocationCallOrder[0]).toBeLessThan(auth.removeUser.mock.invocationCallOrder[0]!);
  expect(auth.removeUser.mock.invocationCallOrder[0]).toBeLessThan(navigateTo.mock.invocationCallOrder[0]!);
});
it("still signs out locally when the revocation call fails", async () => {
  auth.revokeTokens.mockRejectedValue(new Error("network"));
  await render();
  await act(async () => logoutButton().click());
  await vi.waitFor(() => expect(navigateTo).toHaveBeenCalledWith(logoutUrl));
  expect(auth.removeUser).toHaveBeenCalledTimes(1);
});
