import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), remove: vi.fn(), send: vi.fn() }));
vi.mock("../src/lib/task-tokens.js", () => ({ getTaskToken: mocks.get, deleteTaskToken: mocks.remove }));
vi.mock("@aws-sdk/client-sfn", () => ({ SFNClient: class { send = mocks.send; }, SendTaskSuccessCommand: class { constructor(readonly input: unknown) {} }, SendTaskFailureCommand: class { constructor(readonly input: unknown) {} } }));
import { handleNotification } from "../src/handlers/transcription-callback.js";
const notification = { inferenceId: "lecture-abc-123", invocationStatus: "Completed", responseParameters: { outputLocation: "s3://data/stt/output/result" } };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("STT_CALLBACK_KIND", "lecture");
  vi.spyOn(console, "warn").mockImplementation(() => undefined); vi.spyOn(console, "info").mockImplementation(() => undefined);
  mocks.get.mockResolvedValue({ taskToken: "token" }); mocks.send.mockResolvedValue({}); mocks.remove.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("ignores a meeting notification before any lecture-table lookup or warning", async () => {
  expect(await handleNotification({ ...notification, inferenceId: "meeting-uuid-123" })).toBe("ignored");
  expect(mocks.get).not.toHaveBeenCalled(); expect(console.warn).not.toHaveBeenCalled();
});
it("ignores lecture notifications in the meeting callback during filter propagation", async () => {
  vi.stubEnv("STT_CALLBACK_KIND", "meeting");
  expect(await handleNotification(notification)).toBe("ignored"); expect(mocks.get).not.toHaveBeenCalled();
});
it("removes the task token only after the callback was acknowledged", async () => {
  expect(await handleNotification(notification)).toBe("success");
  expect(mocks.remove).toHaveBeenCalledWith(notification.inferenceId, "token");
  expect(mocks.send.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]!);
});
it("retains the token after a transient callback failure so SNS can redeliver", async () => {
  mocks.send.mockRejectedValueOnce(new Error("network failure"));
  await expect(handleNotification(notification)).rejects.toThrow("network failure");
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(await handleNotification(notification)).toBe("success"); expect(mocks.remove).toHaveBeenCalledOnce();
});
it("treats consumed or stale callbacks as normal duplicates", async () => {
  mocks.get.mockResolvedValueOnce(undefined);
  expect(await handleNotification(notification)).toBe("ignored");
  mocks.send.mockRejectedValueOnce(Object.assign(new Error(), { name: "TaskTimedOut" }));
  expect(await handleNotification(notification)).toBe("ignored");
  expect(mocks.remove).toHaveBeenCalledOnce(); expect(console.warn).not.toHaveBeenCalled();
});
it("routes interview callbacks to the separate interview token table", async () => {
  vi.stubEnv("INTERVIEW_TABLE_NAME", "interviews");
  const msg = { ...notification, inferenceId: "lecture-i-abc-123" };
  expect(await handleNotification(msg)).toBe("success");
  expect(mocks.get).toHaveBeenCalledWith(msg.inferenceId, "interviews");
  expect(mocks.remove).toHaveBeenCalledWith(msg.inferenceId, "token", "interviews");
  mocks.get.mockClear(); vi.stubEnv("STT_CALLBACK_KIND", "meeting");
  expect(await handleNotification(msg)).toBe("ignored");
  expect(mocks.get).not.toHaveBeenCalled();
});
