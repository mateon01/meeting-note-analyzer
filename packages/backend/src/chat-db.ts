import { DeleteCommand, GetCommand, PutCommand, QueryCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import { chatKeys, type ChatMessageDto, type ChatSessionDto, type ChatSessionRecord, type CreateChatSessionRequest } from "@meeting-notes/shared";
import { ddb } from "./db.js";
import { env } from "./env.js";

const toDto = (r: ChatSessionRecord): ChatSessionDto => {
  const { PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g2, owner: _o, ...dto } = r;
  return dto;
};

export async function createChatSession(ownerSub: string, sessionId: string, meetingId?: string, scope: CreateChatSessionRequest = {}): Promise<ChatSessionDto> {
  const now = new Date().toISOString();
  const item: ChatSessionRecord = { ...chatKeys.session(sessionId), GSI1PK: chatKeys.userGsi(ownerSub), GSI1SK: now, sessionId, owner: ownerSub, title: "", createdAt: now, updatedAt: now, messageCount: 0, ...(meetingId ? { meetingId } : {}), ...scope } as ChatSessionRecord;
  await ddb.send(new PutCommand({ TableName: env.tableName, Item: item, ConditionExpression: "attribute_not_exists(PK)" }));
  return toDto(item);
}

/** Session META when it exists and belongs to the caller; null otherwise (a foreign session looks like a missing one). */
export async function getOwnedChatSession(ownerSub: string, sessionId: string): Promise<ChatSessionDto | null> {
  const res = await ddb.send(new GetCommand({ TableName: env.tableName, Key: chatKeys.session(sessionId) }));
  const item = res.Item as ChatSessionRecord | undefined;
  return item && item.owner === ownerSub ? toDto(item) : null;
}

export async function listChatSessions(ownerSub: string, limit = 50): Promise<ChatSessionDto[]> {
  const res: QueryCommandOutput = await ddb.send(
    new QueryCommand({ TableName: env.tableName, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": chatKeys.userGsi(ownerSub) }, ScanIndexForward: false, Limit: limit }),
  );
  return (res.Items ?? []).map((i) => toDto(i as ChatSessionRecord));
}

export async function listChatMessages(sessionId: string, limit = 200): Promise<ChatMessageDto[]> {
  const res: QueryCommandOutput = await ddb.send(
    new QueryCommand({ TableName: env.tableName, KeyConditionExpression: "PK = :pk AND begins_with(SK, :msg)", ExpressionAttributeValues: { ":pk": `CHATSESSION#${sessionId}`, ":msg": chatKeys.messagePrefix }, ScanIndexForward: false, Limit: limit }),
  );
  return (res.Items ?? []).reverse().map((i) => {
    const { seq, role, text, createdAt, evidence, steps, options } = i as ChatMessageDto;
    return { seq, role, text, createdAt, ...(evidence ? { evidence } : {}), ...(steps ? { steps } : {}), ...(options ? { options } : {}) };
  });
}

/** Remove META and every message of a session (the caller has already verified ownership). */
export async function deleteChatSession(sessionId: string): Promise<number> {
  let deleted = 0;
  let cursor: Record<string, unknown> | undefined;
  do {
    const page: QueryCommandOutput = await ddb.send(new QueryCommand({ TableName: env.tableName, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": `CHATSESSION#${sessionId}` }, ProjectionExpression: "PK, SK", ExclusiveStartKey: cursor }));
    for (const item of page.Items ?? []) {
      await ddb.send(new DeleteCommand({ TableName: env.tableName, Key: { PK: item["PK"], SK: item["SK"] } }));
      deleted += 1;
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return deleted;
}
