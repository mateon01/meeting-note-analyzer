import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), s3: vi.fn(), runtime: vi.fn(), read: vi.fn(), remove: vi.fn(), release: vi.fn(), notify: vi.fn(), stt: vi.fn() }));
vi.mock("@meeting-notes/backend", () => ({
  getInterview: mocks.get, updateInterviewRun: mocks.update, env: { dataBucket: "data" }, s3: { send: mocks.s3 },
  readJson: mocks.read, deletePrefix: mocks.remove, releaseInterviewSlot: mocks.release, notifyUser: mocks.notify, requireEnv: () => "runtime",
}));
vi.mock("../src/handlers/start-transcription.js", () => ({ handler: mocks.stt }));
vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({ BedrockAgentCoreClient: class { send = mocks.runtime; }, InvokeAgentRuntimeCommand: class { constructor(readonly input: unknown) {} } }));
import { handler } from "../src/handlers/interview.js";
const record = () => ({ interviewId: "i", owner: "alice", runId: "run", status: "ANALYZING", title: "Interview", languageHint: "ko", stages: {},
  assets: { audio: { key: "interview-uploads/alice/i/audio.mp3", complete: true } } });
const result = { documentKey: "interview-results/i/runs/run/document.json", markdownKey: "interview-results/i/runs/run/interview.md" };
beforeEach(() => { vi.resetAllMocks(); mocks.get.mockResolvedValue(record()); mocks.read.mockResolvedValue({ interviewId: "i" }); });
it("dispatches interview mode with a fenced run and fresh retry session", async () => {
  mocks.runtime.mockResolvedValue({ response: { transformToString: async () => '{"status":"accepted"}' } });
  await handler({ op: "analyze", interviewId: "i", runId: "run", taskToken: "token", attempt: 2 });
  const input = mocks.runtime.mock.calls[0]![0].input;
  expect(JSON.parse(input.payload.toString())).toMatchObject({ kind: "interview", lectureId: "i", runId: "run", ownerSub: "alice", attempt: 2 });
  expect(input.runtimeSessionId).toBe("interview-i-run-analyze-r2");
  await expect(handler({ op: "analyze", interviewId: "i", runId: "stale", taskToken: "token" })).rejects.toThrow("no longer active");
});
it("reuses the original transcript when it is present", async () => {
  mocks.get.mockResolvedValue({ ...record(), status: "PREPARING", transcriptKey: "interview-results/i/transcript.json" });
  mocks.s3.mockResolvedValue({});
  await handler({ op: "transcribe", interviewId: "i", runId: "run", taskToken: "token" });
  expect(mocks.stt).toHaveBeenCalledWith(expect.objectContaining({ kind: "interview", resume: true, transcriptKey: "interview-results/i/transcript.json" }));
});
it("publishes only this run, without a knowledge-base sidecar, and releases the slot once", async () => {
  await handler({ op: "complete", interviewId: "i", runId: "run", result });
  expect(mocks.update).toHaveBeenCalledWith("i", "run", expect.objectContaining({ status: "COMPLETED", ...result }), [], "ANALYZING");
  expect(mocks.s3).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledOnce();
  mocks.get.mockResolvedValue({ ...record(), status: "COMPLETED", ...result });
  await handler({ op: "complete", interviewId: "i", runId: "run", result });
  await handler({ op: "failed", interviewId: "i", runId: "run", error: "late callback" });
  expect(mocks.release).toHaveBeenCalledOnce();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("does not release another active slot when a duplicate publish loses the status claim", async () => {
  mocks.update.mockRejectedValue(Object.assign(new Error(), { name: "ConditionalCheckFailedException" }));
  await expect(handler({ op: "complete", interviewId: "i", runId: "run", result })).resolves.toEqual({ alreadyFinished: true });
  expect(mocks.release).not.toHaveBeenCalled(); expect(mocks.notify).not.toHaveBeenCalled();
});
it("rejects foreign result pointers and retains prior published files on failure", async () => {
  await expect(handler({ op: "complete", interviewId: "i", runId: "run", result: { ...result, documentKey: "interview-results/other/document.json" } })).rejects.toThrow("not under this run");
  mocks.get.mockResolvedValue({ ...record(), documentKey: "interview-results/i/runs/old/document.json" });
  await handler({ op: "failed", interviewId: "i", runId: "run", error: "failed" });
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("interview-results/i/runs/run/");
});
