import { InvokeAgentRuntimeCommand, BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import { deletePrefix, env, getLecture, lectureKbMetadata, notifyUser, readJson, releaseLectureSlot, requireEnv, s3, updateLectureRun } from "@meeting-notes/backend";
import { lectureKeys, lectureUploadsComplete, sttOutputSchema, type Transcript } from "@meeting-notes/shared";
import { handler as startStt } from "./start-transcription.js";
import { normalize } from "./normalize-transcript.js";
import { parseS3Uri } from "../lib/s3-uri.js";

interface Input { op: "register" | "prepare" | "transcribe" | "normalize" | "analyze" | "complete" | "failed"; lectureId: string; runId: string; taskToken?: string; attempt?: number; stt?: { skipped?: boolean; silent?: boolean; outputLocation?: string }; result?: { documentKey: string; markdownKey: string; flashcardsKey: string; researchFailures: number; pageCount: number }; error?: unknown }
const agent = new BedrockAgentCoreClient({});
const sfn = new SFNClient({});

export const handler = async (input: Input) => {
  const rec = await getLecture(input.lectureId);
  if (!rec || rec.runId !== input.runId) throw new Error("Lecture execution is no longer active");
  const update = (fields: Record<string, unknown>) => updateLectureRun(input.lectureId, input.runId, fields);
  switch (input.op) {
    case "register": {
      if (!lectureUploadsComplete(rec)) throw new Error("Lecture uploads must be complete");
      if (!["UPLOADED", "PREPARING"].includes(rec.status)) throw new Error("Lecture cannot be claimed from its current state");
      await update({ status: "PREPARING" });
      return { lectureId: input.lectureId, runId: input.runId };
    }
    case "transcribe": {
      if (!input.taskToken) throw new Error("STT task token required");
      await update({ status: "TRANSCRIBING" });
      if (rec.hasAudio === false) {
        await sfn.send(new SendTaskSuccessCommand({ taskToken: input.taskToken, output: JSON.stringify({ silent: true }) }));
        return { silent: true };
      }
      // Reuse the existing SageMaker request/callback protocol, using the lecture table's token namespace.
      let transcriptKey = rec.transcriptKey;
      if (transcriptKey) {
        try { await s3.send(new HeadObjectCommand({ Bucket: env.dataBucket, Key: transcriptKey })); }
        catch (error) { if ((error as { name?: string }).name !== "NotFound") throw error; transcriptKey = undefined; }
      }
      const audioKey = rec.preparedAudioKey ?? rec.assets.audio?.key;
      if (!audioKey) throw new Error("Prepared lecture audio is missing");
      return startStt({ kind: "lecture", taskToken: input.taskToken, meetingId: input.lectureId, ownerSub: rec.owner, audioKey, languageHint: rec.languageHint, resume: !!transcriptKey, transcriptKey });
    }
    case "normalize": {
      if (input.stt?.skipped && rec.transcriptKey) { await update({ status: "ANALYZING" }); return { transcriptKey: rec.transcriptKey }; }
      let transcript: Transcript;
      if (input.stt?.silent && rec.hasAudio === false) {
        transcript = normalize({ version: 1, meetingId: input.lectureId, language: null, durationSec: rec.durationSec ?? 0, mode: "intended", model: "silent-video", speakers: [], segments: [], stats: {} });
      } else {
        if (!input.stt?.outputLocation) throw new Error("Missing lecture STT output");
        const source = parseS3Uri(input.stt.outputLocation);
        if (source.bucket !== env.dataBucket || !source.key.startsWith("stt/output/")) throw new Error("Invalid lecture STT output location");
        const obj = await s3.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key }));
        transcript = normalize(sttOutputSchema.parse(JSON.parse(await obj.Body!.transformToString())));
      }
      if (!transcript.segments.length && !rec.assets.video) throw new Error("No speech was found in the lecture recording");
      const key = `${lectureKeys.resultPrefix(input.lectureId)}transcript.json`;
      await s3.send(new PutObjectCommand({ Bucket: env.dataBucket, Key: key, Body: JSON.stringify(transcript), ContentType: "application/json" }));
      await update({ transcriptKey: key, durationSec: rec.durationSec ?? transcript.durationSec, status: "ANALYZING", stages: { ...rec.stages, stt: { status: "COMPLETED" } } });
      return { transcriptKey: key };
    }
    case "prepare":
    case "analyze": {
      const phase = input.op;
      if (!input.taskToken || rec.status !== (phase === "prepare" ? "PREPARING" : "ANALYZING")) throw new Error("Lecture task is not ready");
      const response = await agent.send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn: requireEnv("LECTURE_RUNTIME_ARN"), qualifier: "DEFAULT", runtimeSessionId: `lecture-${input.lectureId}-${input.runId}-${phase}${input.attempt ? `-r${input.attempt}` : ""}`,
        contentType: "application/json", accept: "application/json",
        payload: Buffer.from(JSON.stringify({ lectureId: input.lectureId, runId: input.runId, ownerSub: rec.owner, taskToken: input.taskToken, phase, attempt: input.attempt ?? 0 })),
      }));
      const accepted = JSON.parse(await response.response!.transformToString());
      if (accepted.status !== "accepted") throw new Error("Lecture runtime did not accept the task");
      return { accepted: true };
    }
    case "complete": {
      // One attempt writes under runs/{runId}/; publishing is a single record update, so a failed attempt never leaves mixed files.
      const runPrefix = lectureKeys.runPrefix(input.lectureId, input.runId);
      const result = input.result;
      if (!result || result.documentKey !== `${runPrefix}document.json` || result.markdownKey !== `${runPrefix}study.md` || result.flashcardsKey !== `${runPrefix}flashcards.csv`) throw new Error("Lecture result files are not under this run");
      const doc = await readJson(result.documentKey);
      if (!doc) throw new Error("Lecture document missing");
      await s3.send(new PutObjectCommand({ Bucket: env.dataBucket, Key: `${result.markdownKey}.metadata.json`, Body: lectureKbMetadata(rec, doc as Parameters<typeof lectureKbMetadata>[1]), ContentType: "application/json" }));
      await update({ status: "COMPLETED", ...result, completedAt: new Date().toISOString() });
      await releaseSlot(rec.owner);
      await removePreviousRun(rec.documentKey, input.lectureId, runPrefix);
      // This operation runs in its own Lambda with TABLE_NAME pointing to the original push-subscription table.
      try { await notifyUser(rec.owner, { title: "강의 학습 자료가 준비되었습니다", body: rec.title, tag: `lecture-${input.lectureId}`, url: `${process.env["WEB_ORIGIN"]}/lectures/${input.lectureId}` }); }
      catch (error) { console.warn("lecture push failed", String(error)); }
      return { lectureId: input.lectureId };
    }
    case "failed": {
      const message = (typeof input.error === "string" ? input.error : JSON.stringify(input.error)).slice(0, 1800);
      await update({ status: "FAILED", error: message || "Lecture processing failed" });
      await releaseSlot(rec.owner);
      // Files of an attempt that never got published would otherwise linger (and be indexed without a sidecar).
      const runPrefix = lectureKeys.runPrefix(input.lectureId, input.runId);
      if (!rec.documentKey?.startsWith(runPrefix)) { try { await deletePrefix(runPrefix); } catch (error) { console.warn("failed-run cleanup failed", String(error)); } }
      return { failed: true };
    }
  }
};

/** After a successful publish, drop the superseded run (or the root-level files of a lecture completed before per-run results) so the knowledge base stops indexing it. */
async function removePreviousRun(previousDocumentKey: string | undefined, lectureId: string, runPrefix: string) {
  if (!previousDocumentKey || previousDocumentKey.startsWith(runPrefix)) return;
  const root = lectureKeys.resultPrefix(lectureId);
  try {
    const run = previousDocumentKey.match(/^(.*\/runs\/[^/]+\/)document\.json$/)?.[1];
    if (run && run.startsWith(root)) await deletePrefix(run);
    else if (previousDocumentKey === `${root}document.json`) await s3.send(new DeleteObjectsCommand({ Bucket: env.dataBucket, Delete: { Objects: ["document.json", "study.md", "flashcards.csv", "study.md.metadata.json"].map((name) => ({ Key: root + name })) } }));
  } catch (error) { console.warn("previous lecture run cleanup failed", String(error)); }
}

/** Best effort: a missed release is healed from the real active count on the owner's next claim. */
async function releaseSlot(owner: string) {
  try { await releaseLectureSlot(owner); } catch (error) { console.warn("lecture slot release failed", String(error)); }
}
