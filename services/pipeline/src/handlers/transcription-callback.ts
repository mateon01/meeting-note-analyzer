import type { SNSEvent } from "aws-lambda";
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import { getTaskToken, deleteTaskToken } from "../lib/task-tokens.js";
import { isInterviewInference, isLectureInference } from "@meeting-notes/shared";
import { requireEnv } from "@meeting-notes/backend";

const sfn = new SFNClient({});

/** Shape of the SageMaker async inference SNS notification (success documented; failure observed in the field). */
export interface SttNotification {
  invocationStatus?: "Completed" | "Failed" | string;
  inferenceId?: string;
  eventName?: string;
  failureReason?: string;
  requestParameters?: { inputLocation?: string; endpointName?: string; contentType?: string };
  responseParameters?: { outputLocation?: string; contentType?: string };
}

/**
 * Endpoint-side failures that a second attempt is likely to survive: SageMaker replaced or could not reach the
 * instance ("server error (0)", "could not get a response"), as opposed to the container rejecting the audio (4xx).
 */
export function classifySttFailure(reason: string | undefined): "SttTransient" | "SttFailed" {
  const r = (reason ?? "").toLowerCase();
  const transient = ["server error (0)", "could not get a response", "internal server error", "service unavailable", "timed out", "connection reset"];
  return transient.some((t) => r.includes(t)) ? "SttTransient" : "SttFailed";
}

function isStaleToken(err: unknown): boolean {
  const name = (err as { name?: string }).name ?? "";
  return name === "TaskTimedOut" || name === "InvalidToken" || name === "TaskDoesNotExist";
}

export async function handleNotification(msg: SttNotification): Promise<"success" | "failure" | "ignored"> {
  if (!msg.inferenceId) {
    console.warn("notification without inferenceId", msg);
    return "ignored";
  }
  const kind = process.env["STT_CALLBACK_KIND"] ?? "meeting";
  if (!["meeting", "lecture"].includes(kind)) throw new Error("Invalid STT_CALLBACK_KIND");
  // Also protect the handler while a changed SNS filter is propagating.
  if (isLectureInference(msg.inferenceId) !== (kind === "lecture")) return "ignored";
  const interviewTable = isInterviewInference(msg.inferenceId) ? requireEnv("INTERVIEW_TABLE_NAME") : undefined;
  const rec = interviewTable ? await getTaskToken(msg.inferenceId, interviewTable) : await getTaskToken(msg.inferenceId);
  if (!rec) {
    console.info("duplicate or expired STT notification", { inferenceId: msg.inferenceId, status: msg.invocationStatus });
    return "ignored";
  }
  const removeToken = () => interviewTable ? deleteTaskToken(msg.inferenceId!, rec.taskToken, interviewTable) : deleteTaskToken(msg.inferenceId!, rec.taskToken);
  try {
    if (msg.invocationStatus === "Completed" && msg.responseParameters?.outputLocation) {
      await sfn.send(
        new SendTaskSuccessCommand({
          taskToken: rec.taskToken,
          output: JSON.stringify({ inferenceId: msg.inferenceId, outputLocation: msg.responseParameters.outputLocation }),
        }),
      );
      await removeToken();
      return "success";
    }
    await sfn.send(
      new SendTaskFailureCommand({
        taskToken: rec.taskToken,
        error: classifySttFailure(msg.failureReason),
        cause: (msg.failureReason ?? `invocationStatus=${msg.invocationStatus ?? "unknown"}`).slice(0, 32768),
      }),
    );
    await removeToken();
    return "failure";
  } catch (err) {
    if (isStaleToken(err)) {
      await removeToken();
      console.info("STT task already finished", { inferenceId: msg.inferenceId });
      return "ignored";
    }
    throw err;
  }
}

export const handler = async (event: SNSEvent) => {
  for (const record of event.Records) {
    let msg: SttNotification;
    try {
      msg = JSON.parse(record.Sns.Message) as SttNotification;
    } catch {
      console.error("unparseable SNS message", record.Sns.Message);
      continue;
    }
    const outcome = await handleNotification(msg);
    console.log(JSON.stringify({ inferenceId: msg.inferenceId, status: msg.invocationStatus, outcome }));
  }
};
