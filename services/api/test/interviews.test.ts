import { beforeEach, expect, it, vi } from "vitest";
import { createInterviewSchema, interviewSettingsSchema, INTERVIEW_CRITERIA, type InterviewRecord } from "@meeting-notes/shared";

const mocks = vi.hoisted(() => ({ get: vi.fn(), claim: vi.fn(), release: vi.fn(), multipart: vi.fn(), abort: vi.fn(), complete: vi.fn(), send: vi.fn(), s3: vi.fn(), sign: vi.fn(), read: vi.fn(), remove: vi.fn(), start: vi.fn() }));
vi.mock("@meeting-notes/backend", async (original) => ({ ...await original<typeof import("@meeting-notes/backend")>(),
  getInterview: mocks.get, claimInterviewSlot: mocks.claim, releaseInterviewSlot: mocks.release, interviewTable: () => "interviews",
  createMultipartUpload: mocks.multipart, abortMultipartUpload: mocks.abort, completeMultipartUpload: mocks.complete,
  ddb: { send: mocks.send }, s3: { send: mocks.s3 }, presignDownload: mocks.sign, readJson: mocks.read, deletePrefix: mocks.remove,
  requireEnv: () => "interview-machine", env: { dataBucket: "data" },
}));
vi.mock("@aws-sdk/client-sfn", () => ({ SFNClient: class { send = mocks.start; }, StartExecutionCommand: class { constructor(readonly input: unknown) {} } }));
import { createInterview, completeInterviewUpload, interviewMarkdown, interviewResult, ownedInterview, removeInterview, startInterview, updateInterviewSettings } from "../src/routes/interviews.js";
import { handler } from "../src/handlers/interviews.js";
const settings = interviewSettingsSchema.parse({ criteria: ["domain_depth", "dive_deep"], targetLevel: "L6" });
const fixture = (): InterviewRecord => ({ PK: "MEETING#i", SK: "META", GSI1PK: "USER#alice", GSI1SK: "now",
  interviewId: "i", owner: "alice", title: "Interview", settings, languageHint: "ko", status: "UPLOAD_PENDING", stages: {}, createdAt: "now", updatedAt: "now",
  assets: { audio: { key: "interview-uploads/alice/i/audio.mp3", fileName: "a.mp3", fileSize: 100, contentType: "audio/mpeg", uploadId: "upload", complete: false } } });
beforeEach(() => {
  vi.resetAllMocks(); mocks.get.mockResolvedValue(fixture()); mocks.multipart.mockResolvedValue({ uploadId: "upload", parts: [], partSize: 16, expiresAt: "later" });
  mocks.start.mockResolvedValue({ executionArn: "execution" }); mocks.sign.mockImplementation(async (key) => `https://example.org/${key}`);
});
it("accepts multiple tech/LP criteria and one target level, rejects duplicates, unknown levels and non-MP3", () => {
  expect(settings.criteria).toEqual(["domain_depth", "dive_deep"]);
  for (const input of [{ criteria: [] }, { criteria: ["domain_depth", "domain_depth"] }, { criteria: ["unknown"] }, { criteria: ["domain_depth"], targetLevel: "L8" }]) {
    expect(interviewSettingsSchema.safeParse(input).success).toBe(false);
  }
  expect(createInterviewSchema.safeParse({ title: "Interview", settings, audio: { fileName: "a.mp4", fileSize: 100, contentType: "audio/mpeg" } }).success).toBe(false);
});
it("accepts Technical Communication alongside other criteria and persists the selection", async () => {
  const selected = interviewSettingsSchema.parse({ criteria: ["domain_depth", "technical_communication", "earn_trust"], targetLevel: "L6" });
  const result = await createInterview({ sub: "alice" }, createInterviewSchema.parse({
    title: "Stakeholder communication", settings: selected, audio: { fileName: "a.mp3", fileSize: 100, contentType: "audio/mpeg" },
  }));
  expect(mocks.claim.mock.calls[0]![2].Put.Item.settings.criteria).toEqual(selected.criteria);
  expect(result.interview.settings.criteria).toEqual(selected.criteria);
  expect(interviewSettingsSchema.parse({ criteria: [...INTERVIEW_CRITERIA] }).criteria).toHaveLength(19);
  expect(interviewSettingsSchema.safeParse({ criteria: ["technical_communication", "technical_communication"] }).success).toBe(false);
});
it("uses the interview table, quota and private upload prefix, then completes audio before starting", async () => {
  const created = await createInterview({ sub: "alice" }, createInterviewSchema.parse({ title: "Interview", settings, audio: { fileName: "a.mp3", fileSize: 100, contentType: "audio/mpeg" } }));
  const record = mocks.claim.mock.calls[0]![2].Put.Item;
  expect(mocks.claim.mock.calls[0]![2].Put.TableName).toBe("interviews");
  expect(record.assets.audio.key).toMatch(/^interview-uploads\/alice\//);
  expect(created.interview).not.toHaveProperty("owner");
  mocks.get.mockResolvedValue(record);
  await expect(startInterview({ sub: "alice" }, record.interviewId)).rejects.toMatchObject({ code: "uploads_incomplete" });
  mocks.s3.mockResolvedValue({ ContentLength: 100, ContentType: "audio/mpeg", ETag: "etag" });
  await completeInterviewUpload({ sub: "alice" }, record.interviewId, { uploadId: "upload", parts: [{ partNumber: 1, etag: "etag" }] });
  record.assets.audio.complete = true;
  await startInterview({ sub: "alice" }, record.interviewId);
  expect(mocks.start.mock.calls[0]![0].input.stateMachineArn).toBe("interview-machine");
});
it("rejects another owner's reads, downloads, changes and deletion before writing or signing", async () => {
  mocks.get.mockResolvedValue({ ...fixture(), owner: "bob" });
  for (const call of [
    () => ownedInterview({ sub: "alice" }, "i"), () => interviewResult({ sub: "alice" }, "i"),
    () => interviewMarkdown({ sub: "alice" }, "i"),
    () => updateInterviewSettings({ sub: "alice" }, "i", settings), () => removeInterview({ sub: "alice" }, "i"),
    () => startInterview({ sub: "alice" }, "i"),
  ]) await expect(call()).rejects.toMatchObject({ status: 404 });
  expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.s3).not.toHaveBeenCalled();
});
it("downloads the latest published Markdown through the owner-protected API with exact UTF-8 bytes", async () => {
  const id = "11111111-1111-4111-8111-abcdefabcdef";
  const markdownKey = `interview-results/${id}/runs/latest/interview.md`;
  const content = Buffer.from("# 인터뷰\n\n(+) 강점\n\n(-) 우려점\n", "utf8");
  mocks.get.mockResolvedValue({ ...fixture(), interviewId: id, status: "COMPLETED", markdownKey });
  mocks.s3.mockResolvedValue({ ContentLength: content.length, Body: { transformToByteArray: async () => content } });
  const result = await handler({ routeKey: "GET /api/interviews/{id}/markdown", pathParameters: { id },
    requestContext: { authorizer: { jwt: { claims: { sub: "alice" } } } } } as unknown as Parameters<typeof handler>[0]);
  expect(result).toMatchObject({ statusCode: 200, isBase64Encoded: true, headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "private, no-store" } });
  expect(Buffer.from((result as { body: string }).body, "base64")).toEqual(content);
  expect(mocks.s3.mock.calls[0]![0].input.Key).toBe(markdownKey);
  expect(mocks.sign).not.toHaveBeenCalled();
});
it("distinguishes unready files and oversized exports without reading another interview's object", async () => {
  await expect(interviewMarkdown({ sub: "alice" }, "i")).rejects.toMatchObject({ status: 409, code: "notes_not_ready" });
  mocks.get.mockResolvedValue({ ...fixture(), markdownKey: "interview-results/someone-else/interview.md" });
  await expect(interviewMarkdown({ sub: "alice" }, "i")).rejects.toMatchObject({ status: 404 });
  expect(mocks.s3).not.toHaveBeenCalled();
  const read = vi.fn(), destroy = vi.fn();
  mocks.get.mockResolvedValue({ ...fixture(), markdownKey: "interview-results/i/runs/current/interview.md" });
  mocks.s3.mockResolvedValue({ ContentLength: 5 * 1024 * 1024, Body: { transformToByteArray: read, destroy } });
  await expect(interviewMarkdown({ sub: "alice" }, "i")).rejects.toMatchObject({ status: 413, code: "direct_download_required" });
  expect(destroy).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
});
it("allows only actual transcript speaker IDs and blocks settings changes while processing", async () => {
  mocks.get.mockResolvedValue({ ...fixture(), status: "COMPLETED", transcriptKey: "interview-results/i/transcript.json" });
  mocks.read.mockResolvedValue({ speakers: [{ id: "S1" }, { id: "S2" }] });
  await expect(updateInterviewSettings({ sub: "alice" }, "i", { ...settings, speakerRoles: { S9: "candidate" } })).rejects.toMatchObject({ code: "invalid_speaker" });
  expect(mocks.send).not.toHaveBeenCalled();
  await updateInterviewSettings({ sub: "alice" }, "i", { ...settings, speakerRoles: { S1: "interviewer", S2: "candidate" } });
  expect(mocks.send).toHaveBeenCalledOnce();
  mocks.get.mockResolvedValue({ ...fixture(), status: "ANALYZING" });
  await expect(updateInterviewSettings({ sub: "alice" }, "i", settings)).rejects.toMatchObject({ status: 409 });
});
it("keeps failed cleanup recoverable and does not release the processing slot early", async () => {
  mocks.remove.mockRejectedValueOnce(new Error("S3 deletion failed"));
  await expect(removeInterview({ sub: "alice" }, "i")).rejects.toThrow("S3 deletion failed");
  expect(mocks.release).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledOnce();
});
it("waits for an optional resume upload, validates its MIME and signs it only for the owner", async () => {
  mocks.multipart.mockResolvedValueOnce({ uploadId: "audio" }).mockResolvedValueOnce({ uploadId: "resume" });
  const created = await createInterview({ sub: "alice" }, createInterviewSchema.parse({ title: "Interview", settings,
    audio: { fileName: "a.mp3", fileSize: 100, contentType: "audio/mpeg" },
    resume: { fileName: "resume.pdf", fileSize: 200, contentType: "application/pdf" } }));
  expect(created.resumeUpload?.uploadId).toBe("resume");
  const record = mocks.claim.mock.calls[0]![2].Put.Item;
  record.assets.audio.complete = true; mocks.get.mockResolvedValue(record);
  await expect(startInterview({ sub: "alice" }, record.interviewId)).rejects.toMatchObject({ code: "uploads_incomplete" });
  mocks.s3.mockResolvedValue({ ContentLength: 200, ContentType: "text/plain", ETag: "etag" });
  await expect(completeInterviewUpload({ sub: "alice" }, record.interviewId, { asset: "resume", uploadId: "resume", parts: [{ partNumber: 1, etag: "etag" }] })).rejects.toMatchObject({ code: "invalid_upload" });
  mocks.s3.mockResolvedValue({ ContentLength: 200, ContentType: "application/pdf", ETag: "etag" });
  await completeInterviewUpload({ sub: "alice" }, record.interviewId, { asset: "resume", uploadId: "resume", parts: [{ partNumber: 1, etag: "etag" }] });
  record.assets.resume.complete = true;
  expect((await interviewResult({ sub: "alice" }, record.interviewId)).resumeUrl).toContain("/resume.pdf");
  await startInterview({ sub: "alice" }, record.interviewId);
  expect(mocks.start).toHaveBeenCalledOnce();
});
