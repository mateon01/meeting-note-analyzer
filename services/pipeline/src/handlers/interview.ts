import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { deletePrefix, env, getInterview, notifyUser, readJson, releaseInterviewSlot, requireEnv, s3, updateInterviewRun } from "@meeting-notes/backend";
import { interviewKeys, interviewUploadsComplete, sttOutputSchema, type InterviewDocument } from "@meeting-notes/shared";
import { handler as startStt } from "./start-transcription.js";
import { normalize } from "./normalize-transcript.js";
import { parseS3Uri } from "../lib/s3-uri.js";

interface Input {
  op: "register" | "prepare" | "transcribe" | "normalize" | "analyze" | "complete" | "failed";
  interviewId: string; runId: string; taskToken?: string; attempt?: number;
  stt?: { skipped?: boolean; outputLocation?: string };
  result?: { documentKey: string; markdownKey: string }; error?: unknown;
}
const agent = new BedrockAgentCoreClient({});
export const handler = async (input: Input) => {
  const record = await getInterview(input.interviewId);
  if (!record || record.runId !== input.runId) throw new Error("Interview execution is no longer active");
  if (["COMPLETED", "FAILED"].includes(record.status)) {
    if (input.op === "complete" || input.op === "failed") return { interviewId: input.interviewId, alreadyFinished: true };
    throw new Error("Interview execution has already finished");
  }
  const update = (fields: Record<string, unknown>) => updateInterviewRun(input.interviewId, input.runId, fields);
  const runPrefix = interviewKeys.runPrefix(input.interviewId, input.runId);
  switch (input.op) {
    case "register":
      if (!interviewUploadsComplete(record) || !["UPLOADED", "PREPARING"].includes(record.status)) throw new Error("Interview upload is not ready");
      await update({ status: "PREPARING" });
      return { interviewId: input.interviewId, runId: input.runId };
    case "transcribe": {
      if (!input.taskToken) throw new Error("STT task token required");
      await update({ status: "TRANSCRIBING" });
      let transcriptKey = record.transcriptKey;
      if (transcriptKey) {
        try { await s3.send(new HeadObjectCommand({ Bucket: env.dataBucket, Key: transcriptKey })); }
        catch (error) { if ((error as { name?: string }).name !== "NotFound") throw error; transcriptKey = undefined; }
      }
      return startStt({ kind: "interview", taskToken: input.taskToken, meetingId: input.interviewId, ownerSub: record.owner,
        audioKey: record.preparedAudioKey ?? record.assets.audio.key, languageHint: record.languageHint, resume: !!transcriptKey, transcriptKey });
    }
    case "normalize": {
      if (input.stt?.skipped && record.transcriptKey) { await update({ status: "ANALYZING" }); return { transcriptKey: record.transcriptKey }; }
      if (!input.stt?.outputLocation) throw new Error("Missing interview STT output");
      const source = parseS3Uri(input.stt.outputLocation);
      if (source.bucket !== env.dataBucket || !source.key.startsWith("stt/output/")) throw new Error("Invalid STT output location");
      const object = await s3.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key }));
      const transcript = normalize(sttOutputSchema.parse(JSON.parse(await object.Body!.transformToString())));
      if (transcript.meetingId !== input.interviewId || !transcript.segments.length) throw new Error("Valid interview speech was not found");
      const key = `${interviewKeys.resultPrefix(input.interviewId)}transcript.json`;
      await s3.send(new PutObjectCommand({ Bucket: env.dataBucket, Key: key, Body: JSON.stringify(transcript), ContentType: "application/json" }));
      await update({ transcriptKey: key, durationSec: transcript.durationSec, status: "ANALYZING", stages: { ...record.stages, stt: { status: "COMPLETED" } } });
      return { transcriptKey: key };
    }
    case "prepare":
    case "analyze": {
      if (!input.taskToken || record.status !== (input.op === "prepare" ? "PREPARING" : "ANALYZING")) throw new Error("Interview task is not ready");
      const response = await agent.send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn: requireEnv("LECTURE_RUNTIME_ARN"), qualifier: "DEFAULT",
        runtimeSessionId: `interview-${input.interviewId}-${input.runId}-${input.op}-r${input.attempt ?? 0}`,
        contentType: "application/json", accept: "application/json",
        payload: Buffer.from(JSON.stringify({ kind: "interview", lectureId: input.interviewId, runId: input.runId, ownerSub: record.owner,
          phase: input.op, attempt: input.attempt ?? 0, taskToken: input.taskToken })),
      }));
      if (JSON.parse(await response.response!.transformToString()).status !== "accepted") throw new Error("Interview runtime did not accept the task");
      return { accepted: true };
    }
    case "complete": {
      const result = input.result;
      if (!result || result.documentKey !== `${runPrefix}document.json` || result.markdownKey !== `${runPrefix}interview.md`) throw new Error("Interview result files are not under this run");
      const document = await readJson<InterviewDocument>(result.documentKey);
      if (!document || document.interviewId !== input.interviewId) throw new Error("Interview document missing or mismatched");
      // Interview records never enter the meeting memory or searchable knowledge-base prefixes.
      try { await updateInterviewRun(input.interviewId, input.runId, { status: "COMPLETED", ...result, completedAt: new Date().toISOString() }, [], "ANALYZING"); }
      catch (error) {
        if ((error as { name?: string }).name === "ConditionalCheckFailedException") return { alreadyFinished: true };
        throw error;
      }
      await releaseSlot(record.owner);
      const previous = record.documentKey?.match(/^(.*\/runs\/[^/]+\/)document\.json$/)?.[1];
      if (previous && previous !== runPrefix && previous.startsWith(interviewKeys.resultPrefix(input.interviewId))) {
        try { await deletePrefix(previous); } catch (error) { console.warn("previous interview run cleanup failed", String(error)); }
      }
      try { await notifyUser(record.owner, { title: "인터뷰 노트가 준비되었습니다", body: record.title, tag: `interview-${input.interviewId}`, url: `${process.env["WEB_ORIGIN"]}/interviews/${input.interviewId}` }); }
      catch (error) { console.warn("interview push failed", String(error)); }
      return { interviewId: input.interviewId };
    }
    case "failed":
      try { await updateInterviewRun(input.interviewId, input.runId, { status: "FAILED", error: (typeof input.error === "string" ? input.error : JSON.stringify(input.error) ?? "Interview processing failed").slice(0, 1800) }, [], record.status); }
      catch (error) {
        if ((error as { name?: string }).name === "ConditionalCheckFailedException") return { alreadyFinished: true };
        throw error;
      }
      await releaseSlot(record.owner);
      if (!record.documentKey?.startsWith(runPrefix)) {
        try { await deletePrefix(runPrefix); } catch (error) { console.warn("unpublished interview cleanup failed", String(error)); }
      }
      return { failed: true };
  }
};
async function releaseSlot(owner: string) {
  try { await releaseInterviewSlot(owner); } catch (error) { console.warn("interview slot release failed", String(error)); }
}
