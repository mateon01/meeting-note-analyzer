import { InvokeEndpointAsyncCommand, SageMakerRuntimeClient } from "@aws-sdk/client-sagemaker-runtime";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import { env, s3 } from "@meeting-notes/backend";
import { pipelineEnv } from "../lib/env.js";
import { setStage } from "../lib/meeting-updates.js";
import { saveTaskToken } from "../lib/task-tokens.js";
import { CONSTRAINTS, LECTURE_INFERENCE_PREFIX } from "@meeting-notes/shared";

const smr = new SageMakerRuntimeClient({});

export interface StartTranscriptionInput {
  kind?: "lecture";
  taskToken: string;
  meetingId: string;
  ownerSub: string;
  audioKey: string;
  languageHint?: string;
  resume?: boolean;
  transcriptKey?: string | null;
}

const sfn = new SFNClient({});

/** Builds the STT request; exported for tests. */
export function buildSttRequest(input: StartTranscriptionInput, bucket: string, mode: string) {
  return {
    meetingId: input.meetingId,
    audio_s3_uri: `s3://${bucket}/${input.audioKey}`,
    language: input.languageHint && input.languageHint !== "auto" ? input.languageHint : null,
    mode,
    hotwords: [] as string[],
    diarization: { enabled: true },
  };
}

export const handler = async (input: StartTranscriptionInput) => {
  if (input.resume && input.transcriptKey) {
    // Retry of a meeting whose transcript already exists: hand the token back at once and let Normalize pass it through.
    await sfn.send(new SendTaskSuccessCommand({ taskToken: input.taskToken, output: JSON.stringify({ skipped: true, transcriptKey: input.transcriptKey }) }));
    return { skipped: true, transcriptKey: input.transcriptKey };
  }
  const inferenceId = `${input.kind === "lecture" ? LECTURE_INFERENCE_PREFIX : ""}${input.meetingId}-${Date.now()}`;
  await saveTaskToken(inferenceId, input.taskToken, input.meetingId);
  await setStage(input.meetingId, "stt", "RUNNING");
  const body = JSON.stringify(buildSttRequest(input, env.dataBucket, pipelineEnv.sttMode));
  // Stage the request JSON in S3 and pass InputLocation: works on every SDK version and has no 128KB inline cap.
  const requestKey = `stt/requests/${inferenceId}.json`;
  await s3.send(new PutObjectCommand({ Bucket: env.dataBucket, Key: requestKey, Body: body, ContentType: "application/json" }));
  const res = await smr.send(
    new InvokeEndpointAsyncCommand({
      EndpointName: pipelineEnv.sttEndpointName,
      ContentType: "application/json",
      Accept: "application/json",
      InferenceId: inferenceId,
      InvocationTimeoutSeconds: CONSTRAINTS.sttInvocationTimeoutSec,
      RequestTTLSeconds: CONSTRAINTS.sttQueueTtlSec,
      InputLocation: `s3://${env.dataBucket}/${requestKey}`,
    }),
  );
  return { inferenceId, outputLocation: res.OutputLocation, failureLocation: res.FailureLocation };
};
