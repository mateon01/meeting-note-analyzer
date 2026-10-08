import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, env } from "@meeting-notes/backend";
import { CONSTRAINTS, meetingKeys, type TaskTokenRecord } from "@meeting-notes/shared";

export async function saveTaskToken(inferenceId: string, taskToken: string, meetingId: string): Promise<void> {
  const rec: TaskTokenRecord = {
    ...meetingKeys.taskToken(inferenceId),
    SK: "TOKEN",
    taskToken,
    meetingId,
    createdAt: new Date().toISOString(),
    ttl: Math.floor(Date.now() / 1000) + CONSTRAINTS.taskTokenTtlSec,
  };
  await ddb.send(new PutCommand({ TableName: env.tableName, Item: rec }));
}

export async function getTaskToken(inferenceId: string, tableName = env.tableName): Promise<TaskTokenRecord | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: tableName, Key: meetingKeys.taskToken(inferenceId), ConsistentRead: true }));
  return res.Item as TaskTokenRecord | undefined;
}

/** Delete only after Step Functions acknowledges the callback (or confirms it is stale). */
export async function deleteTaskToken(inferenceId: string, taskToken: string, tableName = env.tableName): Promise<void> {
  try {
    await ddb.send(new DeleteCommand({ TableName: tableName, Key: meetingKeys.taskToken(inferenceId),
      ConditionExpression: "taskToken = :token", ExpressionAttributeValues: { ":token": taskToken } }));
  } catch (error) {
    if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
  }
}
