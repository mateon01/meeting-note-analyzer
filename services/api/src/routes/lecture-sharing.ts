import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, lectureTable } from "@meeting-notes/backend";
import { type LectureShare, type createLectureShareSchema } from "@meeting-notes/shared";
import type { z } from "zod";
import { HttpError, type Caller } from "../lib/http.js";
import { ownedLecture } from "./lectures.js";

export interface ShareRecord {
  PK: string; SK: "META"; GSI1PK: string; GSI1SK: string;
  shareId: string; lectureId: string; owner: string; emails: string[];
  createdAt: string; expiresAt: string; ttl: number; revokedAt?: string;
}
export const shareKey = (id: string) => ({ PK: `LECTURE_SHARE#${id}`, SK: "META" });
export function toShare(record: ShareRecord): LectureShare {
  return { shareId: record.shareId, lectureId: record.lectureId, emails: record.emails, createdAt: record.createdAt,
    expiresAt: record.expiresAt, ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
    url: `${process.env["UPLOAD_BASE_URL"]}/shared/lectures/${record.shareId}` };
}
export async function createLectureShare(caller: Caller, id: string, input: z.output<typeof createLectureShareSchema>) {
  const lecture = await ownedLecture(caller, id);
  if (!lecture.documentKey) throw new HttpError(409, "학습 자료가 생성된 강의만 공유할 수 있습니다");
  const shareId = randomUUID(); const createdAt = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + input.expiresInDays * 86400;
  const record: ShareRecord = { ...shareKey(shareId), SK: "META", GSI1PK: `LECTURE_SHARES#${id}`, GSI1SK: createdAt,
    shareId, lectureId: id, owner: caller.sub, emails: input.emails, createdAt, expiresAt: new Date(ttl * 1000).toISOString(), ttl };
  await ddb.send(new PutCommand({ TableName: lectureTable(), Item: record, ConditionExpression: "attribute_not_exists(PK)" }));
  return { share: toShare(record) };
}
export async function listLectureShares(caller: Caller, id: string) {
  await ownedLecture(caller, id);
  const result = await ddb.send(new QueryCommand({ TableName: lectureTable(), IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": `LECTURE_SHARES#${id}` },
    ScanIndexForward: false, Limit: 100 }));
  return { items: (result.Items as ShareRecord[] ?? []).filter((r) => r.owner === caller.sub).map(toShare) };
}
export async function getShare(id: string): Promise<ShareRecord | undefined> {
  const result = await ddb.send(new GetCommand({ TableName: lectureTable(), Key: shareKey(id), ConsistentRead: true }));
  return result.Item as ShareRecord | undefined;
}
export async function revokeLectureShare(caller: Caller, lectureId: string, shareId: string) {
  await ownedLecture(caller, lectureId);
  const record = await getShare(shareId);
  if (!record || record.owner !== caller.sub || record.lectureId !== lectureId) throw new HttpError(404, "공유 링크를 찾을 수 없습니다");
  await ddb.send(new UpdateCommand({ TableName: lectureTable(), Key: shareKey(shareId),
    UpdateExpression: "SET revokedAt = :now", ConditionExpression: "#owner = :owner AND lectureId = :lecture",
    ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":now": new Date().toISOString(), ":owner": caller.sub, ":lecture": lectureId } }));
}
