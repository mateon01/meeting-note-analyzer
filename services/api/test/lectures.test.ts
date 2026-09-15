import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeLectureUploadSchema, createLectureSchema, lectureKeys, parseUploadKey, SLIDE_TYPES, type LectureRecord } from "@meeting-notes/shared";

const mocks = vi.hoisted(() => ({ claim: vi.fn(), release: vi.fn(), get: vi.fn(), list: vi.fn(), ddb: vi.fn(), s3: vi.fn(), start: vi.fn(), sign: vi.fn(), read: vi.fn(), multipart: vi.fn(), complete: vi.fn(), abort: vi.fn(), deletePrefix: vi.fn() }));
vi.mock("@meeting-notes/backend", async (importOriginal) => ({
  LectureLimitError: (await importOriginal<typeof import("@meeting-notes/backend")>()).LectureLimitError, claimLectureSlot: mocks.claim, releaseLectureSlot: mocks.release,
  getLecture: mocks.get, listLectures: mocks.list, ddb: { send: mocks.ddb }, s3: { send: mocks.s3 }, env: { dataBucket: "data" },
  lectureTable: () => "lectures", requireEnv: () => "state-machine", presignDownload: mocks.sign, readJson: mocks.read,
  createMultipartUpload: mocks.multipart, completeMultipartUpload: mocks.complete, abortMultipartUpload: mocks.abort, deletePrefix: mocks.deletePrefix,
}));
vi.mock("@aws-sdk/client-sfn", () => ({ SFNClient: class { send = mocks.start; }, StartExecutionCommand: class { constructor(readonly input: unknown) {} } }));
import { LectureLimitError } from "@meeting-notes/backend";
import { canRetryLecture, completeLectureUpload, createLecture, lectureResult, ownedLecture, removeLecture, startLecture, validateParts } from "../src/routes/lectures.js";

const caller = { sub: "alice" };
const fixture = (): LectureRecord => ({ PK: "MEETING#test", SK: "META", GSI1PK: "USER#alice", GSI1SK: "now", lectureId: "test", owner: "alice", title: "Optimization", course: "ML", status: "UPLOAD_PENDING", outputLanguage: "ko", languageHint: "auto", stages: {}, createdAt: "now", updatedAt: "now", assets: {
  audio: { key: "lecture-uploads/alice/test/audio.mp3", fileName: "audio.mp3", fileSize: 100, contentType: "audio/mpeg", uploadId: "a", complete: true },
  slides: { key: "lecture-uploads/alice/test/slides.pdf", fileName: "slides.pdf", fileSize: 100, contentType: SLIDE_TYPES.pdf, uploadId: "s", complete: true },
} });
beforeEach(() => { vi.resetAllMocks(); mocks.get.mockResolvedValue(fixture()); mocks.ddb.mockResolvedValue({}); mocks.claim.mockResolvedValue(undefined); mocks.release.mockResolvedValue(undefined); mocks.start.mockResolvedValue({ executionArn: "execution" }); });

describe("lecture inputs", () => {
  it("accepts PPTX/PDF and rejects oversized decks and incompatible extensions", () => {
    const value = { title: "Course", video: { fileName: "a.mp4", fileSize: 100, contentType: "video/mp4" }, slides: { fileName: "a.pdf", fileSize: 100, contentType: SLIDE_TYPES.pdf } };
    expect(createLectureSchema.safeParse(value).success).toBe(true);
    expect(createLectureSchema.safeParse({ ...value, slides: undefined }).success).toBe(true);
    expect(createLectureSchema.safeParse({ ...value, video: undefined }).success).toBe(false);
    expect(createLectureSchema.safeParse({ ...value, video: { ...value.video, fileSize: 4 * 1024 ** 3 + 1 } }).success).toBe(false);
    expect(createLectureSchema.safeParse({ ...value, video: { ...value.video, fileName: "a.mp3" } }).success).toBe(false);
    expect(createLectureSchema.safeParse({ ...value, slides: { ...value.slides, fileName: "a.ppt" } }).success).toBe(false);
    expect(createLectureSchema.safeParse({ ...value, slides: { ...value.slides, fileSize: 101 * 1024 * 1024 } }).success).toBe(false);
    expect(parseUploadKey(`${lectureKeys.inputPrefix("alice", "test")}audio.mp3`)).toBeNull();
  });
  it("rejects duplicate and incomplete multipart submissions", () => {
    expect(() => validateParts(20 * 1024 * 1024, [{ partNumber: 1, etag: "x" }, { partNumber: 1, etag: "y" }])).toThrow();
    expect(() => validateParts(20 * 1024 * 1024, [{ partNumber: 1, etag: "x" }])).toThrow();
    expect(() => validateParts(20 * 1024 * 1024, [{ partNumber: 2, etag: "y" }, { partNumber: 1, etag: "x" }])).not.toThrow();
    expect(completeLectureUploadSchema.safeParse({ asset: "script" }).success).toBe(false);
  });
});

it("rejects cross-user reads, downloads, starts, uploads and deletion before any write", async () => {
  mocks.get.mockResolvedValue({ ...fixture(), owner: "bob" });
  const calls = [() => ownedLecture(caller, "test"), () => lectureResult(caller, "test"), () => startLecture(caller, "test"), () => completeLectureUpload(caller, "test", { asset: "audio", uploadId: "a", parts: [{ partNumber: 1, etag: "x" }] }), () => removeLecture(caller, "test")];
  for (const call of calls) await expect(call()).rejects.toMatchObject({ status: 404 });
  expect(mocks.ddb).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
});

it("does not start a lecture until both uploads have completed", async () => {
  const record = fixture(); record.assets.slides!.complete = false; mocks.get.mockResolvedValue(record);
  await expect(startLecture(caller, "test")).rejects.toMatchObject({ code: "uploads_incomplete" });
  expect(mocks.start).not.toHaveBeenCalled();
});

it("returns download links instead of embedding a potentially large study document", async () => {
  mocks.get.mockResolvedValue({ ...fixture(), status: "COMPLETED", documentKey: "lecture-results/test/runs/run/document.json", markdownKey: "lecture-results/test/runs/run/study.md", flashcardsKey: "lecture-results/test/runs/run/flashcards.csv", pageCount: 120 });
  mocks.sign.mockImplementation(async (key: string) => `https://data.s3.amazonaws.com/${key}?signed`);
  const result = await lectureResult(caller, "test");
  expect(result.documentUrl).toContain("lecture-results/test/runs/run/document.json");
  expect(result.markdownUrl).toContain("lecture-results/test/runs/run/study.md");
  expect(result.flashcardsUrl).toContain("lecture-results/test/runs/run/flashcards.csv");
  mocks.get.mockResolvedValue({ ...fixture(), status: "COMPLETED", documentKey: "lecture-results/test/document.json", pageCount: 1 }); // completed before per-run results
  const legacy = await lectureResult(caller, "test");
  expect(legacy.markdownUrl).toContain("lecture-results/test/study.md");
  expect(result.pageImages).toHaveLength(120);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(JSON.stringify(result).length).toBeLessThan(100_000);
});

it("can safely retry a lost StartExecution response with identical execution identity", async () => {
  mocks.get.mockResolvedValue({ ...fixture(), status: "UPLOADED", runId: "abc-run" });
  await startLecture(caller, "test"); await startLecture(caller, "test");
  expect(mocks.start.mock.calls[0]![0].input).toEqual(mocks.start.mock.calls[1]![0].input);
});

it("only retries failed work or completed documents with failed paper searches", () => {
  expect(canRetryLecture({ status: "COMPLETED", researchFailures: 1 })).toBe(true);
  expect(canRetryLecture({ status: "COMPLETED", researchFailures: 0 })).toBe(true); // re-analysis after a prompt update reuses cached work
  expect(canRetryLecture({ status: "ANALYZING" })).toBe(false);
  expect(canRetryLecture({ status: "FAILED" })).toBe(true);
});

it("acknowledges a repeated start after the original workflow has already advanced", async () => {
  mocks.get.mockResolvedValue({ ...fixture(), status: "ANALYZING", runId: "already-running" });
  await expect(startLecture(caller, "test")).resolves.toEqual({ lectureId: "test" });
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.ddb).not.toHaveBeenCalled();
});

it("verifies actual uploaded bytes even after a lost S3 completion response", async () => {
  const record = fixture(); record.assets.slides!.complete = false; mocks.get.mockResolvedValue(record);
  mocks.complete.mockRejectedValue(Object.assign(new Error(), { name: "NoSuchUpload" }));
  mocks.s3.mockResolvedValue({ ContentLength: 100, ContentType: SLIDE_TYPES.pdf, ETag: "verified" });
  await completeLectureUpload(caller, "test", { asset: "slides", uploadId: "s", parts: [{ partNumber: 1, etag: "x" }] });
  expect(mocks.ddb).toHaveBeenCalledOnce();
  mocks.ddb.mockClear(); mocks.s3.mockResolvedValue({ ContentLength: 99, ContentType: SLIDE_TYPES.pdf });
  await expect(completeLectureUpload(caller, "test", { asset: "slides", uploadId: "s", parts: [{ partNumber: 1, etag: "x" }] })).rejects.toMatchObject({ code: "invalid_upload" });
  expect(mocks.ddb).not.toHaveBeenCalled();
});

it("cleans up a partially created upload plan if slide upload preparation fails", async () => {
  mocks.list.mockResolvedValue({ items: [], cursor: null });
  mocks.multipart.mockResolvedValueOnce({ uploadId: "audio" }).mockRejectedValueOnce(new Error("S3 failure"));
  await expect(createLecture(caller, createLectureSchema.parse({ title: "ML", video: { fileName: "a.mp4", fileSize: 10, contentType: "video/mp4" }, slides: { fileName: "a.pdf", fileSize: 10, contentType: SLIDE_TYPES.pdf } }))).rejects.toThrow("S3 failure");
  expect(mocks.abort).toHaveBeenCalledWith(expect.stringMatching(/^lecture-uploads\/alice\//), "audio");
  expect(mocks.ddb).not.toHaveBeenCalled();
});

it("creates and starts a video-only lecture without requiring a slide upload", async () => {
  mocks.list.mockResolvedValue({ items: [], cursor: null });
  mocks.multipart.mockResolvedValue({ uploadId: "video", parts: [], partSize: 16 * 1024 * 1024, expiresAt: "later" });
  const result = await createLecture(caller, createLectureSchema.parse({ title: "ML video", video: { fileName: "class.mp4", fileSize: 2 * 1024 ** 3, contentType: "video/mp4" } }));
  expect(mocks.multipart).toHaveBeenCalledOnce();
  expect(result.uploads.slides).toBeUndefined();
  expect(result.lecture.videoName).toBe("class.mp4");
  const record = mocks.claim.mock.calls[0]![2].Put.Item as LectureRecord; // written inside the slot transaction
  record.assets.video!.complete = true;
  mocks.get.mockResolvedValue(record);
  await expect(startLecture(caller, record.lectureId)).resolves.toEqual({ lectureId: record.lectureId });
  expect(mocks.start).toHaveBeenCalledOnce();
});

describe("processing slots", () => {
  it("keeps the deleting record and slot until failed S3 cleanup is retried successfully", async () => {
    mocks.deletePrefix.mockRejectedValueOnce(new Error("Failed to delete 1 S3 object(s): AccessDenied"));
    await expect(removeLecture(caller, "test")).rejects.toThrow("AccessDenied");
    expect(mocks.ddb).toHaveBeenCalledOnce();
    expect(mocks.ddb.mock.calls[0]![0].input.UpdateExpression).toBe("SET deleting = :yes");
    expect(mocks.release).not.toHaveBeenCalled();
    mocks.get.mockResolvedValue({ ...fixture(), deleting: true });
    mocks.deletePrefix.mockResolvedValue(0);
    await removeLecture(caller, "test");
    expect(mocks.ddb.mock.calls.at(-1)![0].input.ConditionExpression).toBe("deleting = :yes");
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith("alice");
  });
  it("creates a lecture only together with a claimed slot", async () => {
    mocks.multipart.mockResolvedValue({ uploadId: "video", parts: [], partSize: 16 * 1024 * 1024, expiresAt: "later" });
    await createLecture(caller, createLectureSchema.parse({ title: "ML", video: { fileName: "a.mp4", fileSize: 10, contentType: "video/mp4" } }));
    expect(mocks.claim).toHaveBeenCalledWith("alice", 3, expect.objectContaining({ Put: expect.objectContaining({ ConditionExpression: "attribute_not_exists(PK)" }) }));
    expect(mocks.ddb).not.toHaveBeenCalled(); // the record is written inside the claim transaction
    mocks.claim.mockRejectedValueOnce(new LectureLimitError(3));
    await expect(createLecture(caller, createLectureSchema.parse({ title: "ML", video: { fileName: "a.mp4", fileSize: 10, contentType: "video/mp4" } }))).rejects.toBeInstanceOf(LectureLimitError);
    expect(mocks.abort).toHaveBeenCalled();
  });
  it("re-analysis of a finished lecture claims a slot atomically with the status change", async () => {
    mocks.get.mockResolvedValue({ ...fixture(), status: "COMPLETED" });
    await startLecture(caller, "test", true);
    expect(mocks.claim).toHaveBeenCalledWith("alice", 3, expect.objectContaining({ Update: expect.objectContaining({ ConditionExpression: expect.stringContaining("#status = :old") }) }));
    expect(mocks.start).toHaveBeenCalledOnce();
    mocks.claim.mockRejectedValueOnce(new LectureLimitError(3));
    await expect(startLecture(caller, "test", true)).rejects.toBeInstanceOf(LectureLimitError);
    expect(mocks.start).toHaveBeenCalledOnce();
  });
  it("first start of an uploaded lecture reuses the slot claimed at creation", async () => {
    await startLecture(caller, "test");
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.ddb).toHaveBeenCalled();
  });
  it("deleting a lecture that never started frees its slot", async () => {
    mocks.s3.mockResolvedValue({});
    await removeLecture(caller, "test");
    expect(mocks.release).toHaveBeenCalledWith("alice");
    mocks.release.mockClear(); mocks.get.mockResolvedValue({ ...fixture(), status: "COMPLETED" });
    await removeLecture(caller, "test");
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
