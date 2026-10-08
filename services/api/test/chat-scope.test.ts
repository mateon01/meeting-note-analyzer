import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), meeting: vi.fn(), lecture: vi.fn() }));
vi.mock("@meeting-notes/backend", () => ({
  env: {}, createChatSession: mocks.create, deleteChatSession: vi.fn(), deleteChatSessionMemory: vi.fn(),
  getOwnedChatSession: vi.fn(), listChatMessages: vi.fn(), listChatSessions: vi.fn(),
}));
vi.mock("../src/routes/meetings.js", () => ({ requireOwnedMeeting: mocks.meeting }));
vi.mock("../src/routes/lectures.js", () => ({ ownedLecture: mocks.lecture }));
import { createChatSessionSchema, createSession } from "../src/routes/chat.js";

const lectureId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { vi.resetAllMocks(); mocks.create.mockResolvedValue({ sessionId: "session" }); });

it("persists the selected lecture only after verifying ownership", async () => {
  const input = createChatSessionSchema.parse({ sourceType: "lecture", lectureId });
  await createSession({ sub: "owner" }, input);
  expect(mocks.lecture).toHaveBeenCalledWith({ sub: "owner" }, lectureId);
  expect(mocks.create).toHaveBeenCalledWith("owner", expect.any(String), undefined, { sourceType: "lecture", lectureId });
  expect(mocks.meeting).not.toHaveBeenCalled();
});

it("does not create a session for a foreign lecture", async () => {
  mocks.lecture.mockRejectedValue(new Error("not found"));
  await expect(createSession({ sub: "owner" }, { sourceType: "lecture", lectureId })).rejects.toThrow("not found");
  expect(mocks.create).not.toHaveBeenCalled();
});

it("rejects mixed or contradictory source scopes", () => {
  for (const input of [{ meetingId: "meeting", lectureId }, { sourceType: "meeting", lectureId },
    { sourceType: "lecture", meetingId: "meeting" }, { sourceType: "all", lectureId }]) {
    expect(createChatSessionSchema.safeParse(input).success).toBe(false);
  }
});

it("keeps existing meeting entry points and supports all lectures", async () => {
  await createSession({ sub: "owner" }, { meetingId: "meeting" });
  expect(mocks.meeting).toHaveBeenCalledWith({ sub: "owner" }, "meeting");
  expect(mocks.create).toHaveBeenLastCalledWith("owner", expect.any(String), "meeting", { sourceType: "meeting" });
  await createSession({ sub: "owner" }, { sourceType: "lecture" });
  expect(mocks.create).toHaveBeenLastCalledWith("owner", expect.any(String), undefined, { sourceType: "lecture" });
});
