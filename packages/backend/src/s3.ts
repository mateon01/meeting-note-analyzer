import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { setTimeout as sleep } from "node:timers/promises";
import { CONSTRAINTS, planParts, rewriteUploadUrl, type UploadPartTarget } from "@meeting-notes/shared";

/** Origin the browser should upload to (CloudFront in front of the bucket); unset = direct S3 URLs. */
const uploadBase = () => process.env["UPLOAD_BASE_URL"] || undefined;
import { env } from "./env.js";

export const s3 = new S3Client({});

/** Legacy single-object presigned PUT (content-type is signed so the client cannot upload other types). */
export async function presignUpload(key: string, contentType: string): Promise<string> {
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: env.dataBucket, Key: key, ContentType: contentType }), { expiresIn: CONSTRAINTS.presignedUrlExpirySec, signableHeaders: new Set(["content-type"]) });
  return rewriteUploadUrl(url, uploadBase());
}

export interface MultipartPlan {
  uploadId: string;
  partSize: number;
  parts: UploadPartTarget[];
  expiresAt: string;
}

/** Start an S3 multipart upload and presign one UploadPart URL per part (the content type is fixed at creation). */
export async function createMultipartUpload(key: string, contentType: string, fileSize: number, expiresIn: number = CONSTRAINTS.presignedUrlExpirySec): Promise<MultipartPlan> {
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: env.dataBucket, Key: key, ContentType: contentType }));
  if (!UploadId) throw new Error("S3 did not return an upload id");
  const partSize = CONSTRAINTS.uploadPartBytes;
  const parts = await Promise.all(
    planParts(fileSize, partSize).map(async ({ partNumber }) => ({
      partNumber,
      url: rewriteUploadUrl(await getSignedUrl(s3, new UploadPartCommand({ Bucket: env.dataBucket, Key: key, UploadId, PartNumber: partNumber }), { expiresIn }), uploadBase()),
    })),
  );
  return { uploadId: UploadId, partSize, parts, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
}

export async function completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: env.dataBucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }),
  );
}

export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  try {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: env.dataBucket, Key: key, UploadId: uploadId }));
  } catch (err) {
    if ((err as { name?: string }).name !== "NoSuchUpload") throw err;
  }
}

export async function presignDownload(key: string, expiresIn = 3600): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.dataBucket, Key: key }), { expiresIn });
}

/** Missing objects are a supported fallback. Permission and service failures must surface. */
export async function headObject(key: string): Promise<{ revision: string } | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: env.dataBucket, Key: key }));
    return { revision: (res.VersionId && res.VersionId !== "null" ? res.VersionId : undefined) ?? res.ETag ?? res.LastModified?.toISOString() ?? "unknown" };
  } catch (err) {
    const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (error.name === "NotFound" || error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

export async function readJson<T = unknown>(key: string): Promise<T | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: env.dataBucket, Key: key }));
    const text = await res.Body?.transformToString("utf8");
    return text ? (JSON.parse(text) as T) : null;
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
}

export async function deletePrefix(prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: env.dataBucket, Prefix: prefix, ContinuationToken: token }),
    );
    let pending = (list.Contents ?? []).map((object) => ({ Key: object.Key! }));
    for (let attempt = 0; pending.length; attempt++) {
      const result = await s3.send(new DeleteObjectsCommand({ Bucket: env.dataBucket, Delete: { Objects: pending, Quiet: true } }));
      const errors = result.Errors ?? [];
      if (!errors.length) {
        deleted += pending.length;
        break;
      }
      const retryable = new Set(["InternalError", "ServiceUnavailable", "SlowDown", "RequestTimeout"]);
      if (attempt >= 3 || errors.some((error) => !error.Key || !pending.some((object) => object.Key === error.Key) || !retryable.has(error.Code ?? ""))) {
        throw new Error(`Failed to delete ${errors.length} S3 object(s): ${[...new Set(errors.map((error) => error.Code ?? "Unknown"))].join(", ")}`);
      }
      const failedKeys = new Set(errors.map((error) => error.Key));
      deleted += pending.length - failedKeys.size;
      pending = pending.filter((object) => failedKeys.has(object.Key));
      await sleep(200 * 2 ** attempt);
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}
