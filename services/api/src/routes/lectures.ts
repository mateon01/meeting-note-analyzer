import { randomUUID } from "node:crypto";
import { DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { abortMultipartUpload, claimLectureSlot, completeMultipartUpload, createMultipartUpload, ddb, deletePrefix, env, getLecture, lectureTable, presignDownload, releaseLectureSlot, requireEnv, s3 } from "@meeting-notes/backend";
import { CONSTRAINTS, LECTURE_LIMITS, SLIDE_TYPES, lectureKeys, lectureUploadsComplete, toLectureDto, type CompleteLectureUpload, type CreateLectureResponse, type LectureRecord, type LectureResultLinks, createLectureSchema } from "@meeting-notes/shared";
import type { z } from "zod";
import { HttpError, type Caller } from "../lib/http.js";

const sfn = new SFNClient({});
export async function ownedLecture(caller: Caller, id: string) {
  const rec = await getLecture(id);
  if (!rec || rec.owner !== caller.sub) throw new HttpError(404, "강의를 찾을 수 없습니다", "not_found");
  return rec;
}
export async function createLecture(caller: Caller, input: z.output<typeof createLectureSchema>): Promise<CreateLectureResponse> {
  const id = randomUUID(); const now = new Date().toISOString();
  const prefix = lectureKeys.inputPrefix(caller.sub, id);
  const mediaKind = input.video ? "video" : "audio";
  const mediaInput = input.video ?? input.audio!;
  const mediaKey = `${prefix}${mediaKind}.${mediaKind === "video" ? "mp4" : "mp3"}`;
  const slidesKey = `${prefix}slides.${input.slides?.contentType === SLIDE_TYPES.pdf ? "pdf" : "pptx"}`;
  const media = await createMultipartUpload(mediaKey, mediaInput.contentType, mediaInput.fileSize, LECTURE_LIMITS.uploadExpirySec);
  let slides: Awaited<ReturnType<typeof createMultipartUpload>> | undefined;
  try {
    if (input.slides) slides = await createMultipartUpload(slidesKey, input.slides.contentType, input.slides.fileSize, LECTURE_LIMITS.uploadExpirySec);
    const rec: LectureRecord = { ...lectureKeys.record(id), SK: "META", GSI1PK: lectureKeys.user(caller.sub), GSI1SK: now,
      lectureId: id, owner: caller.sub, title: input.title, course: input.course, outputLanguage: input.outputLanguage, languageHint: input.languageHint,
      ...(input.customPrompt ? { customPrompt: input.customPrompt } : {}),
      ...(input.slideRange ? { slideRange: input.slideRange } : {}),
      status: "UPLOAD_PENDING", stages: {}, createdAt: now, updatedAt: now,
      assets: { [mediaKind]: { ...mediaInput, key: mediaKey, uploadId: media.uploadId, complete: false }, ...(slides && input.slides ? { slides: { ...input.slides, key: slidesKey, uploadId: slides.uploadId, complete: false } } : {}) },
    };
    // The record exists only if a processing slot was claimed in the same transaction (LectureLimitError -> 429).
    await claimLectureSlot(caller.sub, LECTURE_LIMITS.maxActive, { Put: { TableName: lectureTable(), Item: rec, ConditionExpression: "attribute_not_exists(PK)" } });
    return { lecture: toLectureDto(rec), uploads: { [mediaKind]: media, slides } };
  } catch (error) {
    await Promise.allSettled([abortMultipartUpload(mediaKey, media.uploadId), ...(slides ? [abortMultipartUpload(slidesKey, slides.uploadId)] : [])]);
    throw error;
  }
}

export function validateParts(fileSize: number, parts: CompleteLectureUpload["parts"]) {
  const expected = Math.ceil(fileSize / CONSTRAINTS.uploadPartBytes);
  const numbers = [...parts].map((p) => p.partNumber).sort((a, b) => a - b);
  if (numbers.length !== expected || numbers.some((n, i) => n !== i + 1)) throw new HttpError(400, "업로드 파트가 누락되었거나 중복되었습니다", "invalid_parts");
}
export async function completeLectureUpload(caller: Caller, id: string, body: CompleteLectureUpload) {
  const rec = await ownedLecture(caller, id); const asset = rec.assets[body.asset];
  if (!asset || asset.uploadId !== body.uploadId) throw new HttpError(400, "잘못된 업로드 ID입니다", "bad_upload_id");
  if (asset.complete) return; // Network retry after successful completion.
  if (rec.status !== "UPLOAD_PENDING") throw new HttpError(409, "이미 처리가 시작되었습니다", "already_started");
  validateParts(asset.fileSize, body.parts);
  try { await completeMultipartUpload(asset.key, asset.uploadId, body.parts); }
  catch (error) { if ((error as { name?: string }).name !== "NoSuchUpload") throw error; }
  const head = await s3.send(new HeadObjectCommand({ Bucket: env.dataBucket, Key: asset.key }));
  if (head.ContentLength !== asset.fileSize || head.ContentType !== asset.contentType) throw new HttpError(400, "업로드된 파일의 크기 또는 형식이 일치하지 않습니다", "invalid_upload");
  await ddb.send(new UpdateCommand({ TableName: lectureTable(), Key: lectureKeys.record(id),
    UpdateExpression: "SET #assets.#asset.#complete = :yes, #assets.#asset.etag = :etag, updatedAt = :now",
    ConditionExpression: "#status = :pending AND attribute_not_exists(deleting)",
    ExpressionAttributeNames: { "#assets": "assets", "#asset": body.asset, "#complete": "complete", "#status": "status" },
    ExpressionAttributeValues: { ":yes": true, ":etag": head.ETag, ":now": new Date().toISOString(), ":pending": "UPLOAD_PENDING" },
  }));
}

/** A completed lecture may be re-analyzed: cached work is reused and only failed searches and study entries from an older prompt version are regenerated. */
export function canRetryLecture(rec: Pick<LectureRecord, "status" | "researchFailures">) {
  return rec.status === "FAILED" || rec.status === "COMPLETED";
}
export async function startLecture(caller: Caller, id: string, retry = false) {
  const rec = await ownedLecture(caller, id);
  // A mobile client can lose the start response after the workflow has already advanced.
  if (["PREPARING", "TRANSCRIBING", "ANALYZING"].includes(rec.status) || (!retry && rec.status === "COMPLETED")) return { lectureId: id };
  // A previous StartExecution response may have been lost; STANDARD executions are idempotent for name + input.
  const pending = rec.status === "UPLOADED" && rec.runId;
  if (!pending && (retry ? !canRetryLecture(rec) : rec.status !== "UPLOAD_PENDING")) throw new HttpError(409, "현재 상태에서는 시작할 수 없습니다", "invalid_status");
  if (!lectureUploadsComplete(rec)) throw new HttpError(409, "강의 파일과 선택한 장표 업로드를 완료하세요", "uploads_incomplete");
  const runId = pending || randomUUID();
  if (!pending) {
    const claim = { TableName: lectureTable(), Key: lectureKeys.record(id),
      UpdateExpression: "SET #status = :queued, runId = :run, updatedAt = :now REMOVE #error, analysisClaim, prepareClaim",
      ConditionExpression: "#status = :old AND attribute_not_exists(deleting)",
      ExpressionAttributeNames: { "#status": "status", "#error": "error" },
      ExpressionAttributeValues: { ":queued": "UPLOADED", ":old": rec.status, ":run": runId, ":now": new Date().toISOString() } };
    // A finished lecture becoming active again takes a processing slot; an unstarted one still holds the slot claimed at creation.
    if (rec.status === "FAILED" || rec.status === "COMPLETED") await claimLectureSlot(caller.sub, LECTURE_LIMITS.maxActive, { Update: claim });
    else await ddb.send(new UpdateCommand(claim));
  }
  const response = await sfn.send(new StartExecutionCommand({ stateMachineArn: requireEnv("LECTURE_STATE_MACHINE_ARN"), name: `lecture-${id}-${runId.slice(0, 8)}`, input: JSON.stringify({ lectureId: id, runId }) }));
  await ddb.send(new UpdateCommand({ TableName: lectureTable(), Key: lectureKeys.record(id), UpdateExpression: "SET executionArn = :arn", ConditionExpression: "runId = :run", ExpressionAttributeValues: { ":run": runId, ":arn": response.executionArn } }));
  return { lectureId: id };
}

export async function lectureResult(caller: Caller, id: string): Promise<LectureResultLinks> {
  const rec = await ownedLecture(caller, id);
  const prefix = lectureKeys.resultPrefix(id);
  const [audioUrl, slidesUrl, markdownUrl, flashcardsUrl, pageImages, documentUrl, videoUrl, transcriptUrl] = await Promise.all([
    rec.assets.audio?.complete ? presignDownload(rec.assets.audio.key) : null,
    rec.assets.slides?.complete ? presignDownload(rec.assets.slides.key) : null,
    rec.documentKey ? presignDownload(rec.markdownKey ?? `${prefix}study.md`) : null,
    rec.documentKey ? presignDownload(rec.flashcardsKey ?? `${prefix}flashcards.csv`) : null,
    rec.studyImages && rec.documentKey
      ? Promise.all(rec.studyImages.map(async (image) => ({ page: image.page, sourcePage: image.sourcePage, url: await presignDownload(image.key) })))
      : Promise.all(Array.from({ length: rec.documentKey && (rec.assets.video || rec.assets.slides) ? Math.min(rec.pageCount ?? 0, LECTURE_LIMITS.maxResultPages) : 0 }, async (_, i) => ({ page: i + 1, url: await presignDownload(`${prefix}slides/${i + 1}.png`) }))),
    rec.documentKey ? presignDownload(rec.documentKey) : null,
    rec.assets.video?.complete ? presignDownload(rec.assets.video.key) : null,
    rec.transcriptKey ? presignDownload(rec.transcriptKey) : null,
  ]);
  return { lecture: toLectureDto(rec), documentUrl, audioUrl, videoUrl, slidesUrl, markdownUrl, flashcardsUrl, pageImages, transcriptUrl };
}
export async function removeLecture(caller: Caller, id: string) {
  const rec = await ownedLecture(caller, id);
  if (!["UPLOAD_PENDING", "FAILED", "COMPLETED"].includes(rec.status)) throw new HttpError(409, "처리가 끝난 후 삭제할 수 있습니다", "processing");
  await ddb.send(new UpdateCommand({ TableName: lectureTable(), Key: lectureKeys.record(id), UpdateExpression: "SET deleting = :yes", ConditionExpression: "#status = :status", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":yes": true, ":status": rec.status } }));
  await Promise.all(Object.values(rec.assets).filter((a) => !a.complete).map((a) => abortMultipartUpload(a.key, a.uploadId)));
  await Promise.all([deletePrefix(lectureKeys.inputPrefix(caller.sub, id)), deletePrefix(lectureKeys.resultPrefix(id))]);
  await ddb.send(new DeleteCommand({ TableName: lectureTable(), Key: lectureKeys.record(id), ConditionExpression: "deleting = :yes", ExpressionAttributeValues: { ":yes": true } }));
  if (rec.status === "UPLOAD_PENDING") await releaseLectureSlot(caller.sub);
}
