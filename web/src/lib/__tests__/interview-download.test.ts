import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../api";

afterEach(() => { vi.unstubAllGlobals(); });

it("renews authentication before downloading Markdown as text through the application API", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response('{"message":"expired"}', { status: 401 }))
    .mockResolvedValueOnce(new Response("# 인터뷰\n(+) 강점", { headers: { "content-type": "text/markdown; charset=utf-8" } }));
  vi.stubGlobal("fetch", fetch);
  const renew = vi.fn().mockResolvedValue("fresh");
  const text = await createApi("/api", () => "old", renew).downloadInterview("interview-1");
  expect(text).toBe("# 인터뷰\n(+) 강점");
  expect(renew).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[1]).toEqual(["/api/interviews/interview-1/markdown", expect.objectContaining({ headers: { authorization: "Bearer fresh" } })]);
});

it("retries one temporary download failure and keeps permission failures explicit", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response('{"message":"temporary"}', { status: 503 }))
    .mockResolvedValueOnce(new Response("# Recovered"));
  vi.stubGlobal("fetch", fetch);
  const api = createApi("/api", () => "token");
  await expect(api.downloadInterview("i")).resolves.toBe("# Recovered");
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockReset().mockResolvedValue(new Response('{"message":"권한을 확인하세요"}', { status: 403 }));
  await expect(api.downloadInterview("i")).rejects.toMatchObject({ status: 403, message: "권한을 확인하세요" });
  expect(fetch).toHaveBeenCalledOnce();
});
