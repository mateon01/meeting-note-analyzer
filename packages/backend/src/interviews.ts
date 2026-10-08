import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { interviewKeys, type InterviewRecord } from "@meeting-notes/shared";
import { ddb } from "./db.js";
import { requireEnv } from "./env.js";

export const interviewTable = () => requireEnv("INTERVIEW_TABLE_NAME");
export async function getInterview(id: string): Promise<InterviewRecord | undefined> {
  return (await ddb.send(new GetCommand({ TableName: interviewTable(), Key: interviewKeys.record(id), ConsistentRead: true }))).Item as InterviewRecord | undefined;
}
export async function listInterviews(owner: string, cursor?: string, limit = 25) {
  const result = await ddb.send(new QueryCommand({
    TableName: interviewTable(), IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :owner",
    ExpressionAttributeValues: { ":owner": interviewKeys.user(owner) }, ScanIndexForward: false, Limit: limit,
    ExclusiveStartKey: cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()) : undefined,
  }));
  return { items: (result.Items ?? []) as InterviewRecord[], cursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url") : null };
}
/** Execution lease prevents an expired attempt from changing a newer run or recreating a deleted record. */
export async function updateInterviewRun(id: string, runId: string, fields: Record<string, unknown>, remove: string[] = [], expectedStatus?: InterviewRecord["status"]) {
  const names: Record<string, string> = { "#run": "runId" };
  const values: Record<string, unknown> = { ":run": runId };
  const sets = Object.entries({ ...fields, updatedAt: new Date().toISOString() }).filter(([, v]) => v !== undefined).map(([k, v], i) => {
    names[`#f${i}`] = k; values[`:v${i}`] = v; return `#f${i} = :v${i}`;
  });
  remove.forEach((key, i) => { names[`#r${i}`] = key; });
  if (expectedStatus) { names["#status"] = "status"; values[":expected"] = expectedStatus; }
  await ddb.send(new UpdateCommand({ TableName: interviewTable(), Key: interviewKeys.record(id),
    UpdateExpression: `SET ${sets.join(", ")}${remove.length ? ` REMOVE ${remove.map((_, i) => `#r${i}`).join(", ")}` : ""}`,
    ConditionExpression: `attribute_exists(PK) AND #run = :run${expectedStatus ? " AND #status = :expected" : ""}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values,
  }));
}

export const ACTIVE_INTERVIEW_STATUSES: InterviewRecord["status"][] = ["UPLOAD_PENDING", "UPLOADED", "PREPARING", "TRANSCRIBING", "ANALYZING"];
export class InterviewLimitError extends Error {
  override readonly name = "InterviewLimitError";
  constructor(readonly max: number) { super(`처리 중인 인터뷰가 ${max}건입니다. 완료 후 다시 시도하세요`); }
}
type TransactWriteItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
const slotKey = (owner: string) => ({ PK: interviewKeys.user(owner), SK: "ACTIVE" });

export async function countActiveInterviews(owner: string): Promise<number> {
  let cursor: string | undefined; let active = 0;
  do {
    const page = await listInterviews(owner, cursor, 100);
    active += page.items.filter((x) => ACTIVE_INTERVIEW_STATUSES.includes(x.status)).length;
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return active;
}

/**
 * Claims one of `max` concurrent processing slots for the owner in the same transaction as the caller's own write
 * (record creation or a status claim), so every start path is limited atomically. A drifted counter (a release that
 * never ran) is healed from the real active count before giving up.
 */
export async function claimInterviewSlot(owner: string, max: number, write: TransactWriteItem, healed = false): Promise<void> {
  const counter = { Update: { TableName: interviewTable(), Key: slotKey(owner), UpdateExpression: "SET #n = if_not_exists(#n, :zero) + :one",
    ConditionExpression: "attribute_not_exists(#n) OR #n < :max", ExpressionAttributeNames: { "#n": "count" }, ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":max": max } } };
  try { await ddb.send(new TransactWriteCommand({ TransactItems: [counter, write] })); }
  catch (error) {
    const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
    if (failure.name !== "TransactionCanceledException" || !failure.CancellationReasons) throw error;
    if (failure.CancellationReasons[1]?.Code === "ConditionalCheckFailed") throw Object.assign(new Error("interview state changed"), { name: "ConditionalCheckFailedException" });
    if (failure.CancellationReasons[0]?.Code !== "ConditionalCheckFailed") throw error;
    const active = await countActiveInterviews(owner);
    if (healed || active >= max) throw new InterviewLimitError(max);
    await ddb.send(new UpdateCommand({ TableName: interviewTable(), Key: slotKey(owner), UpdateExpression: "SET #n = :n", ExpressionAttributeNames: { "#n": "count" }, ExpressionAttributeValues: { ":n": active } }));
    return claimInterviewSlot(owner, max, write, true);
  }
}
/** Frees a slot when a interview stops being active (completed, failed, or deleted before it started). Never goes below zero. */
export async function releaseInterviewSlot(owner: string): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({ TableName: interviewTable(), Key: slotKey(owner), UpdateExpression: "SET #n = #n - :one", ConditionExpression: "#n > :zero",
      ExpressionAttributeNames: { "#n": "count" }, ExpressionAttributeValues: { ":one": 1, ":zero": 0 } }));
  } catch (error) { if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error; }
}
