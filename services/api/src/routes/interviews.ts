import { randomUUID } from "node:crypto";
import { DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { abortMultipartUpload, claimInterviewSlot, completeMultipartUpload, createMultipartUpload, ddb, deletePrefix, env, getInterview, interviewTable, presignDownload, readJson, releaseInterviewSlot, requireEnv, s3 } from "@meeting-notes/backend";
import { INTERVIEW_LIMITS, interviewKeys, interviewUploadsComplete, toInterviewDto, type CompleteInterviewUpload, type CreateInterviewResponse, type InterviewRecord, type InterviewResultLinks, type InterviewSettings, type Transcript, createInterviewSchema } from "@meeting-notes/shared";
import type { z } from "zod";
import { HttpError, type Caller } from "../lib/http.js";
import { validateParts } from "./lectures.js";

const sfn = new SFNClient({});
export async function ownedInterview(caller: Caller, id: string) {
  const record = await getInterview(id);
  if (!record || record.owner !== caller.sub) throw new HttpError(404, "인터뷰를 찾을 수 없습니다", "not_found");
  return record;
}
export async function createInterview(caller: Caller, input: z.output<typeof createInterviewSchema>): Promise<CreateInterviewResponse> {
  const id = randomUUID(); const now = new Date().toISOString();
  const key = `${interviewKeys.inputPrefix(caller.sub, id)}audio.mp3`;
  const upload = await createMultipartUpload(key, "audio/mpeg", input.audio.fileSize, INTERVIEW_LIMITS.uploadExpirySec);
  const resumeKey = `${interviewKeys.inputPrefix(caller.sub, id)}resume.pdf`;
  let resumeUpload: CreateInterviewResponse["resumeUpload"];
  try {
    if (input.resume) resumeUpload = await createMultipartUpload(resumeKey, "application/pdf", input.resume.fileSize, INTERVIEW_LIMITS.uploadExpirySec);
    const record: InterviewRecord = { ...interviewKeys.record(id), GSI1PK: interviewKeys.user(caller.sub), GSI1SK: now,
      interviewId: id, owner: caller.sub, title: input.title, languageHint: input.languageHint, settings: input.settings,
      status: "UPLOAD_PENDING", stages: {}, createdAt: now, updatedAt: now,
      assets: { audio: { ...input.audio, key, uploadId: upload.uploadId, complete: false },
        ...(input.resume && resumeUpload ? { resume: { ...input.resume, key: resumeKey, uploadId: resumeUpload.uploadId, complete: false } } : {}) } };
    await claimInterviewSlot(caller.sub, INTERVIEW_LIMITS.maxActive, { Put: { TableName: interviewTable(), Item: record, ConditionExpression: "attribute_not_exists(PK)" } });
    return { interview: toInterviewDto(record), upload, resumeUpload };
  } catch (error) {
    await Promise.allSettled([abortMultipartUpload(key, upload.uploadId), ...(resumeUpload ? [abortMultipartUpload(resumeKey, resumeUpload.uploadId)] : [])]);
    throw error;
  }
}
export async function completeInterviewUpload(caller: Caller, id: string, body: CompleteInterviewUpload) {
  const record = await ownedInterview(caller, id); const assetKind = body.asset ?? "audio"; const asset = record.assets[assetKind];
  if (!asset || asset.uploadId !== body.uploadId) throw new HttpError(400, "잘못된 업로드 ID입니다", "bad_upload_id");
  if (asset.complete) return;
  if (record.status !== "UPLOAD_PENDING") throw new HttpError(409, "이미 처리가 시작되었습니다", "already_started");
  validateParts(asset.fileSize, body.parts);
  try { await completeMultipartUpload(asset.key, asset.uploadId, body.parts); }
  catch (error) { if ((error as { name?: string }).name !== "NoSuchUpload") throw error; }
  const head = await s3.send(new HeadObjectCommand({ Bucket: env.dataBucket, Key: asset.key }));
  if (head.ContentLength !== asset.fileSize || head.ContentType !== asset.contentType) throw new HttpError(400, "업로드된 파일이 등록 정보와 일치하지 않습니다", "invalid_upload");
  await ddb.send(new UpdateCommand({ TableName: interviewTable(), Key: interviewKeys.record(id),
    UpdateExpression: "SET assets.#asset.#complete = :yes, assets.#asset.etag = :etag, updatedAt = :now",
    ConditionExpression: "#status = :pending AND attribute_not_exists(deleting)",
    ExpressionAttributeNames: { "#complete": "complete", "#status": "status", "#asset": assetKind },
    ExpressionAttributeValues: { ":yes": true, ":etag": head.ETag, ":now": new Date().toISOString(), ":pending": "UPLOAD_PENDING" } }));
}
export async function startInterview(caller: Caller, id: string, retry = false) {
  const record = await ownedInterview(caller, id);
  if (["PREPARING", "TRANSCRIBING", "ANALYZING"].includes(record.status) || (!retry && record.status === "COMPLETED")) return { interviewId: id };
  const pending = record.status === "UPLOADED" && record.runId;
  if (!pending && (retry ? !["FAILED", "COMPLETED"].includes(record.status) : record.status !== "UPLOAD_PENDING")) throw new HttpError(409, "현재 상태에서는 시작할 수 없습니다", "invalid_status");
  if (!interviewUploadsComplete(record)) throw new HttpError(409, "녹음과 선택한 이력서 업로드를 완료하세요", "uploads_incomplete");
  const runId = pending || randomUUID();
  if (!pending) {
    const claim = { TableName: interviewTable(), Key: interviewKeys.record(id),
      UpdateExpression: "SET #status = :queued, runId = :run, updatedAt = :now REMOVE #error, analysisClaim, prepareClaim",
      ConditionExpression: "#status = :old AND attribute_not_exists(deleting)",
      ExpressionAttributeNames: { "#status": "status", "#error": "error" },
      ExpressionAttributeValues: { ":queued": "UPLOADED", ":old": record.status, ":run": runId, ":now": new Date().toISOString() } };
    if (["FAILED", "COMPLETED"].includes(record.status)) await claimInterviewSlot(caller.sub, INTERVIEW_LIMITS.maxActive, { Update: claim });
    else await ddb.send(new UpdateCommand(claim));
  }
  const result = await sfn.send(new StartExecutionCommand({ stateMachineArn: requireEnv("INTERVIEW_STATE_MACHINE_ARN"), name: `interview-${id}-${runId.slice(0, 8)}`, input: JSON.stringify({ interviewId: id, runId }) }));
  await ddb.send(new UpdateCommand({ TableName: interviewTable(), Key: interviewKeys.record(id), UpdateExpression: "SET executionArn = :arn", ConditionExpression: "runId = :run", ExpressionAttributeValues: { ":run": runId, ":arn": result.executionArn } }));
  return { interviewId: id };
}
export async function updateInterviewSettings(caller: Caller, id: string, settings: InterviewSettings) {
  const record = await ownedInterview(caller, id);
  if (!["UPLOAD_PENDING", "FAILED", "COMPLETED"].includes(record.status)) throw new HttpError(409, "처리가 끝난 뒤 평가 설정을 변경하세요", "processing");
  if (Object.keys(settings.speakerRoles).length) {
    const transcript = record.transcriptKey ? await readJson<Transcript>(record.transcriptKey) : null;
    const ids = new Set(transcript?.speakers.map((speaker) => speaker.id));
    if (Object.keys(settings.speakerRoles).some((id) => !ids.has(id))) throw new HttpError(400, "전사에 있는 화자만 지정할 수 있습니다", "invalid_speaker");
  }
  await ddb.send(new UpdateCommand({ TableName: interviewTable(), Key: interviewKeys.record(id),
    UpdateExpression: "SET settings = :settings, updatedAt = :now", ConditionExpression: "#status = :old AND attribute_not_exists(deleting)",
    ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":settings": settings, ":now": new Date().toISOString(), ":old": record.status } }));
  return { interview: toInterviewDto({ ...record, settings }) };
}
export async function interviewResult(caller: Caller, id: string): Promise<InterviewResultLinks> {
  const record = await ownedInterview(caller, id);
  const [documentUrl, transcriptUrl, audioUrl, markdownUrl, resumeUrl] = await Promise.all([
    record.documentKey ? presignDownload(record.documentKey) : null,
    record.transcriptKey ? presignDownload(record.transcriptKey) : null,
    record.assets.audio.complete ? presignDownload(record.assets.audio.key) : null,
    record.markdownKey ? presignDownload(record.markdownKey) : null,
    record.assets.resume?.complete ? presignDownload(record.assets.resume.key) : null,
  ]);
  return { interview: toInterviewDto(record), documentUrl, transcriptUrl, audioUrl, markdownUrl, resumeUrl };
}
export async function interviewMarkdown(caller: Caller, id: string): Promise<Buffer> {
  const record = await ownedInterview(caller, id);
  if (!record.markdownKey) throw new HttpError(409, "다운로드할 인터뷰 노트가 아직 준비되지 않았습니다.", "notes_not_ready");
  if (!record.markdownKey.startsWith(interviewKeys.resultPrefix(id))) throw new HttpError(404, "인터뷰 노트를 찾을 수 없습니다.", "not_found");
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: env.dataBucket, Key: record.markdownKey }));
    // Base64 keeps a 4 MiB file below Lambda's 6 MiB response envelope even for arbitrary UTF-8 text.
    if ((result.ContentLength ?? 0) > 4 * 1024 * 1024) {
      (result.Body as { destroy?: () => void } | undefined)?.destroy?.();
      throw new HttpError(413, "노트 파일이 커서 직접 다운로드로 전환합니다.", "direct_download_required");
    }
    if (!result.Body) throw new HttpError(404, "인터뷰 노트 파일을 찾을 수 없습니다.", "not_found");
    return Buffer.from(await result.Body.transformToByteArray());
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") throw new HttpError(404, "인터뷰 노트 파일을 찾을 수 없습니다. 다시 분석한 결과가 있는지 확인하세요.", "not_found");
    throw error;
  }
}
export async function removeInterview(caller: Caller, id: string) {
  const record = await ownedInterview(caller, id);
  if (!["UPLOAD_PENDING", "FAILED", "COMPLETED"].includes(record.status)) throw new HttpError(409, "처리가 끝난 뒤 삭제할 수 있습니다", "processing");
  await ddb.send(new UpdateCommand({ TableName: interviewTable(), Key: interviewKeys.record(id), UpdateExpression: "SET deleting = :yes",
    ConditionExpression: "#status = :old", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":yes": true, ":old": record.status } }));
  await Promise.all(Object.values(record.assets).filter((asset) => !asset.complete).map((asset) => abortMultipartUpload(asset.key, asset.uploadId)));
  await Promise.all([deletePrefix(interviewKeys.inputPrefix(caller.sub, id)), deletePrefix(interviewKeys.resultPrefix(id))]);
  await ddb.send(new DeleteCommand({ TableName: interviewTable(), Key: interviewKeys.record(id), ConditionExpression: "deleting = :yes", ExpressionAttributeValues: { ":yes": true } }));
  if (record.status === "UPLOAD_PENDING") await releaseInterviewSlot(caller.sub);
}
