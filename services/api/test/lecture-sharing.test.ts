import { beforeEach, expect, it, vi } from "vitest";
import { createLectureShareSchema } from "@meeting-notes/shared";
const m = vi.hoisted(() => ({ ddb: vi.fn(), owned: vi.fn() }));
vi.mock("@meeting-notes/backend", () => ({ ddb: { send: m.ddb }, lectureTable: () => "lectures" }));
vi.mock("../src/routes/lectures.js", () => ({ ownedLecture: m.owned }));
import { createLectureShare, listLectureShares, revokeLectureShare } from "../src/routes/lecture-sharing.js";
beforeEach(() => {
  vi.resetAllMocks(); process.env["UPLOAD_BASE_URL"] = "https://example.org";
  m.owned.mockResolvedValue({ documentKey: "document.json" }); m.ddb.mockResolvedValue({});
});

it("stores a normalized explicit email allowlist with an expiry without sending invitations", async () => {
  const input = createLectureShareSchema.parse({ emails: [" Guest@Example.com ", "guest@example.com"], expiresInDays: 7 });
  const result = await createLectureShare({ sub: "owner" }, "lecture", input);
  const record = m.ddb.mock.calls[0]![0].input.Item;
  expect(m.owned).toHaveBeenCalledWith({ sub: "owner" }, "lecture");
  expect(record.emails).toEqual(["guest@example.com"]);
  expect(record.owner).toBe("owner");
  expect(record.GSI1PK).toBe("LECTURE_SHARES#lecture");
  expect(record.ttl).toBeGreaterThan(Date.now() / 1000 + 6 * 86400);
  expect(result.share.url).toBe(`https://example.org/shared/lectures/${record.shareId}`);
  expect(result.share).not.toHaveProperty("owner");
  expect(m.ddb).toHaveBeenCalledTimes(1);
});

it("requires ownership for both creating and listing shares", async () => {
  m.owned.mockRejectedValue(new Error("not found"));
  await expect(createLectureShare({ sub: "other" }, "lecture", { emails: ["guest@example.com"], expiresInDays: 7 })).rejects.toThrow();
  await expect(listLectureShares({ sub: "other" }, "lecture")).rejects.toThrow();
  expect(m.ddb).not.toHaveBeenCalled();
});

it("cannot revoke a share belonging to another owner or another lecture", async () => {
  for (const record of [{ owner: "other", lectureId: "lecture" }, { owner: "owner", lectureId: "other-lecture" }]) {
    m.ddb.mockResolvedValue({ Item: record });
    await expect(revokeLectureShare({ sub: "owner" }, "lecture", "share")).rejects.toThrow();
  }
  expect(m.ddb.mock.calls.every((c) => c[0].constructor.name === "GetCommand")).toBe(true);
});

it("marks a share revoked under an owner and lecture condition", async () => {
  m.ddb.mockResolvedValue({ Item: { owner: "owner", lectureId: "lecture" } });
  await revokeLectureShare({ sub: "owner" }, "lecture", "share");
  const update = m.ddb.mock.calls[1]![0].input;
  expect(update.UpdateExpression).toContain("revokedAt");
  expect(update.ExpressionAttributeValues).toMatchObject({ ":owner": "owner", ":lecture": "lecture" });
});
