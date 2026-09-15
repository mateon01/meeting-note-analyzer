import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterEach, expect, it, vi } from "vitest";

const { sleep } = vi.hoisted(() => ({ sleep: vi.fn().mockResolvedValue(undefined) }));
vi.mock("node:timers/promises", () => ({ setTimeout: sleep }));
vi.mock("../src/env.js", () => ({ env: { dataBucket: "test-bucket" } }));
import { deletePrefix } from "../src/s3.js";

afterEach(() => { vi.restoreAllMocks(); sleep.mockClear(); });

it("deletes every page and counts only successful keys", async () => {
  const send = vi.spyOn(S3Client.prototype, "send")
    .mockResolvedValueOnce({ Contents: [{ Key: "prefix/one" }], IsTruncated: true, NextContinuationToken: "next" } as never)
    .mockResolvedValueOnce({} as never)
    .mockResolvedValueOnce({ Contents: [{ Key: "prefix/two" }], IsTruncated: false } as never)
    .mockResolvedValueOnce({} as never);
  expect(await deletePrefix("prefix/")).toBe(2);
  expect(send.mock.calls[0]![0]).toBeInstanceOf(ListObjectsV2Command);
  expect(send.mock.calls[2]![0].input).toMatchObject({ ContinuationToken: "next" });
  expect(send.mock.calls[1]![0]).toBeInstanceOf(DeleteObjectsCommand);
});

it.each(["InternalError", "ServiceUnavailable", "SlowDown", "RequestTimeout"])("retries only the keys rejected with %s", async (code) => {
  const send = vi.spyOn(S3Client.prototype, "send")
    .mockResolvedValueOnce({ Contents: [{ Key: "prefix/one" }, { Key: "prefix/two" }] } as never)
    .mockResolvedValueOnce({ Errors: [{ Key: "prefix/two", Code: code }] } as never)
    .mockResolvedValueOnce({} as never);
  expect(await deletePrefix("prefix/")).toBe(2);
  expect(send.mock.calls[2]![0].input).toMatchObject({ Delete: { Objects: [{ Key: "prefix/two" }] } });
  expect(sleep).toHaveBeenCalledExactlyOnceWith(200);
});

it.each(["AccessDenied", "InvalidRequest", "UnexpectedError"])("surfaces permanent object errors without retrying: %s", async (code) => {
  const send = vi.spyOn(S3Client.prototype, "send")
    .mockResolvedValueOnce({ Contents: [{ Key: "prefix/one" }] } as never)
    .mockResolvedValueOnce({ Errors: [{ Key: "prefix/one", Code: code }] } as never);
  await expect(deletePrefix("prefix/")).rejects.toThrow(`Failed to delete 1 S3 object(s): ${code}`);
  expect(send).toHaveBeenCalledTimes(2);
  expect(sleep).not.toHaveBeenCalled();
});

it("bounds retries and never reports persistent failures as deleted", async () => {
  const send = vi.spyOn(S3Client.prototype, "send")
    .mockResolvedValueOnce({ Contents: [{ Key: "prefix/one" }] } as never)
    .mockResolvedValue({ Errors: [{ Key: "prefix/one", Code: "SlowDown" }] } as never);
  await expect(deletePrefix("prefix/")).rejects.toThrow("SlowDown");
  expect(send).toHaveBeenCalledTimes(5);
  expect(sleep.mock.calls).toEqual([[200], [400], [800]]);
});

it.each([{ Code: "SlowDown" }, { Key: "other-prefix/key", Code: "SlowDown" }])("fails closed for malformed object errors: %j", async (error) => {
  const send = vi.spyOn(S3Client.prototype, "send")
    .mockResolvedValueOnce({ Contents: [{ Key: "prefix/one" }] } as never)
    .mockResolvedValueOnce({ Errors: [error] } as never);
  await expect(deletePrefix("prefix/")).rejects.toThrow("Failed to delete");
  expect(send).toHaveBeenCalledTimes(2);
});

it("does not issue a delete request for an empty prefix", async () => {
  const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
  expect(await deletePrefix("prefix/")).toBe(0);
  expect(send).toHaveBeenCalledTimes(1);
});

it("preserves request-level errors after the SDK retry policy", async () => {
  const error = new Error("AccessDenied");
  vi.spyOn(S3Client.prototype, "send")
    .mockResolvedValueOnce({ Contents: [{ Key: "prefix/one" }] } as never)
    .mockRejectedValueOnce(error);
  await expect(deletePrefix("prefix/")).rejects.toBe(error);
});
