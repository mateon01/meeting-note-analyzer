import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), s3: vi.fn(), sfn: vi.fn(), runtime: vi.fn(), read: vi.fn(), deletePrefix: vi.fn(), notify: vi.fn(), release: vi.fn() }));
vi.mock("@meeting-notes/backend", async (importOriginal) => ({ lectureKbMetadata: (await importOriginal<typeof import("@meeting-notes/backend")>()).lectureKbMetadata,
  getLecture: mocks.get, updateLectureRun: mocks.update,
  env: { dataBucket: "data", tableName: "lecture-table" }, s3: { send: mocks.s3 }, ddb: { send: vi.fn() },
  notifyUser: mocks.notify, readJson: mocks.read, deletePrefix: mocks.deletePrefix, releaseLectureSlot: mocks.release, requireEnv: () => "runtime-arn",
}));
vi.mock("@aws-sdk/client-sfn", () => ({ SFNClient: class { send = mocks.sfn; }, SendTaskSuccessCommand: class { constructor(readonly input: unknown) {} } }));
vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({ BedrockAgentCoreClient: class { send = mocks.runtime; }, InvokeAgentRuntimeCommand: class { constructor(readonly input: unknown) {} } }));
import { handler } from "../src/handlers/lecture.js";

beforeEach(() => {
  vi.resetAllMocks(); mocks.update.mockResolvedValue({});
  mocks.get.mockResolvedValue({ lectureId: "lecture", owner: "owner", runId: "run", status: "PREPARING", durationSec: 12, hasAudio: false, assets: { video: { key: "video.mp4", complete: true } }, stages: { video: { status: "COMPLETED" } } });
});
it("dispatches video preparation as its own async runtime phase", async () => {
  mocks.runtime.mockResolvedValue({ response: { transformToString: async () => JSON.stringify({ status: "accepted" }) } });
  await handler({ op: "prepare", lectureId: "lecture", runId: "run", taskToken: "token" });
  const request = mocks.runtime.mock.calls[0]![0].input;
  expect(JSON.parse(request.payload.toString())).toMatchObject({ phase: "prepare", ownerSub: "owner" });
  expect(request.runtimeSessionId).toMatch(/-prepare$/);
  expect(JSON.parse(request.payload.toString()).attempt).toBe(0);
});
it.each(["prepare", "analyze"] as const)("passes the retry count and a new callback token to a fresh %s session", async (phase) => {
  mocks.get.mockResolvedValue({ lectureId: "lecture", owner: "owner", runId: "run", status: phase === "prepare" ? "PREPARING" : "ANALYZING" });
  mocks.runtime.mockResolvedValue({ response: { transformToString: async () => JSON.stringify({ status: "accepted" }) } });
  await handler({ op: phase, lectureId: "lecture", runId: "run", taskToken: "retry-token", attempt: 2 });
  const request = mocks.runtime.mock.calls[0]![0].input;
  expect(request.runtimeSessionId).toBe(`lecture-lecture-run-${phase}-r2`);
  expect(JSON.parse(request.payload.toString())).toMatchObject({ phase, attempt: 2, taskToken: "retry-token" });
});
it("skips STT for a silent MP4 and normalizes an empty timestamped transcript", async () => {
  await handler({ op: "transcribe", lectureId: "lecture", runId: "run", taskToken: "token" });
  expect(mocks.sfn.mock.calls[0]![0].input.output).toBe(JSON.stringify({ silent: true }));
  mocks.s3.mockResolvedValue({});
  await handler({ op: "normalize", lectureId: "lecture", runId: "run", stt: { silent: true } });
  const object = mocks.s3.mock.calls[0]![0].input;
  expect(JSON.parse(object.Body)).toMatchObject({ durationSec: 12, segments: [], model: "silent-video" });
  expect(mocks.update.mock.calls.at(-1)![2].stages.video.status).toBe("COMPLETED");
});
it("rejects an expired run before invoking the runtime", async () => {
  await expect(handler({ op: "prepare", lectureId: "lecture", runId: "stale", taskToken: "token" })).rejects.toThrow("no longer active");
  expect(mocks.runtime).not.toHaveBeenCalled();
});

const runResult = { documentKey: "lecture-results/lecture/runs/run/document.json", markdownKey: "lecture-results/lecture/runs/run/study.md", flashcardsKey: "lecture-results/lecture/runs/run/flashcards.csv", researchFailures: 0, pageCount: 2 };
it("publishes a run by writing the knowledge-base sidecar, swapping every result pointer at once and removing the previous run", async () => {
  mocks.get.mockResolvedValue({ lectureId: "lecture", owner: "owner", runId: "run", status: "ANALYZING", title: "Linear algebra", course: "Math", outputLanguage: "ko", assets: {}, stages: {},
    documentKey: "lecture-results/lecture/runs/old/document.json", markdownKey: "lecture-results/lecture/runs/old/study.md", flashcardsKey: "lecture-results/lecture/runs/old/flashcards.csv" });
  mocks.read.mockResolvedValue({ title: "Linear algebra", generatedAt: "2026-09-06T12:00:00Z", outputLanguage: "ko", durationSec: 1840, pages: [{ page: 1 }, { page: 2 }], audience: { level: "학부 1학년" } });
  mocks.s3.mockResolvedValue({});
  await handler({ op: "complete", lectureId: "lecture", runId: "run", result: runResult });
  const sidecar = mocks.s3.mock.calls.map((c) => c[0].input).find((i) => i.Key === "lecture-results/lecture/runs/run/study.md.metadata.json")!;
  expect(JSON.parse(sidecar.Body).metadataAttributes).toMatchObject({ owner: "owner", kind: "lecture", lectureId: "lecture", title: "Linear algebra", course: "Math", date: "2026-09-06", pageCount: 2, durationMin: 31 });
  const published = mocks.update.mock.calls.find((c) => c[2].status === "COMPLETED")![2];
  expect(published).toMatchObject({ documentKey: runResult.documentKey, markdownKey: runResult.markdownKey, flashcardsKey: runResult.flashcardsKey, pageCount: 2 });
  expect(mocks.update.mock.calls.findIndex((c) => c[2].status === "COMPLETED")).toBeGreaterThan(-1);
  expect(mocks.s3.mock.calls.findIndex((c) => c[0].input.Key?.endsWith("study.md.metadata.json"))).toBeLessThan(mocks.update.mock.calls.length + mocks.s3.mock.calls.length); // sidecar before the pointer swap
  expect(mocks.deletePrefix).toHaveBeenCalledWith("lecture-results/lecture/runs/old/");
});
it("refuses to publish result files that are not under this run", async () => {
  mocks.get.mockResolvedValue({ lectureId: "lecture", owner: "owner", runId: "run", status: "ANALYZING", assets: {}, stages: {} });
  await expect(handler({ op: "complete", lectureId: "lecture", runId: "run", result: { ...runResult, documentKey: "lecture-results/lecture/runs/other/document.json" } })).rejects.toThrow();
  await expect(handler({ op: "complete", lectureId: "lecture", runId: "run", result: { ...runResult, markdownKey: "lecture-results/other/runs/run/study.md" } })).rejects.toThrow();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.deletePrefix).not.toHaveBeenCalled();
});

it("frees the owner's processing slot when a run completes or fails", async () => {
  mocks.get.mockResolvedValue({ lectureId: "lecture", owner: "owner", runId: "run", status: "ANALYZING", title: "T", course: "", assets: {}, stages: {} });
  mocks.read.mockResolvedValue({ title: "T", generatedAt: "2026-09-06T12:00:00Z", pages: [] }); mocks.s3.mockResolvedValue({});
  await handler({ op: "complete", lectureId: "lecture", runId: "run", result: runResult });
  expect(mocks.release).toHaveBeenCalledWith("owner");
  mocks.release.mockClear();
  await handler({ op: "failed", lectureId: "lecture", runId: "run", error: "boom" });
  expect(mocks.update.mock.calls.at(-1)![2]).toMatchObject({ status: "FAILED" });
  expect(mocks.release).toHaveBeenCalledWith("owner");
});
it("a failed attempt removes its own unpublished result files but never the published run", async () => {
  mocks.get.mockResolvedValue({ lectureId: "lecture", owner: "owner", runId: "run", status: "ANALYZING", assets: {}, stages: {}, documentKey: "lecture-results/lecture/runs/old/document.json" });
  await handler({ op: "failed", lectureId: "lecture", runId: "run", error: "boom" });
  expect(mocks.deletePrefix).toHaveBeenCalledWith("lecture-results/lecture/runs/run/");
  mocks.deletePrefix.mockClear();
  mocks.get.mockResolvedValue({ lectureId: "lecture", owner: "owner", runId: "run", status: "ANALYZING", assets: {}, stages: {}, documentKey: "lecture-results/lecture/runs/run/document.json" }); // published, then a later step failed
  await handler({ op: "failed", lectureId: "lecture", runId: "run", error: "push failed" });
  expect(mocks.deletePrefix).not.toHaveBeenCalled();
});
