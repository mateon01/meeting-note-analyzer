import { SageMakerRuntimeClient } from "@aws-sdk/client-sagemaker-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { CONSTRAINTS, isInterviewInference, isLectureInference } from "@meeting-notes/shared";

const backend = vi.hoisted(() => ({ s3: { send: vi.fn() }, env: { dataBucket: "bucket", tableName: "table" } }));
vi.mock("@meeting-notes/backend", async (original) => ({ ...await original<typeof import("@meeting-notes/backend")>(), ...backend }));
vi.mock("../src/lib/env.js", () => ({ env: { dataBucket: "bucket" }, pipelineEnv: { sttEndpointName: "stt-endpoint", sttMode: "intended" } }));
vi.mock("../src/lib/meeting-updates.js", () => ({ setStage: vi.fn() }));
vi.mock("../src/lib/task-tokens.js", () => ({ saveTaskToken: vi.fn() }));
import { handler } from "../src/handlers/start-transcription.js";

const send = vi.spyOn(SageMakerRuntimeClient.prototype, "send");
beforeEach(() => {
  vi.resetAllMocks();
  backend.s3.send.mockResolvedValue({});
  send.mockResolvedValue({ OutputLocation: "s3://bucket/stt/output/x", FailureLocation: "s3://bucket/stt/failure/x" } as never);
});

it("lets a request wait in the STT queue for six hours while keeping SageMaker's one-hour processing cap", async () => {
  await handler({ taskToken: "token", meetingId: "m1", ownerSub: "u1", audioKey: "uploads/u1/m1/audio.mp3" });
  const input = (send.mock.calls[0]![0] as unknown as { input: Record<string, unknown> }).input;
  expect(input).toMatchObject({ EndpointName: "stt-endpoint", RequestTTLSeconds: CONSTRAINTS.sttQueueTtlSec, InvocationTimeoutSeconds: CONSTRAINTS.sttInvocationTimeoutSec });
  expect(CONSTRAINTS.sttQueueTtlSec).toBe(6 * 3600); // SageMaker maximum
  expect(CONSTRAINTS.sttInvocationTimeoutSec).toBe(3600); // SageMaker maximum
});
it("keeps interview inference IDs within SageMaker's limit and the shared callback namespace", async () => {
  await handler({ kind: "interview", taskToken: "token", meetingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownerSub: "owner", audioKey: "interview-uploads/owner/id/audio.mp3" });
  const input = (send.mock.calls[0]![0] as unknown as { input: { InferenceId: string } }).input;
  expect(input.InferenceId.length).toBeLessThanOrEqual(64);
  expect(isInterviewInference(input.InferenceId)).toBe(true);
  expect(isLectureInference(input.InferenceId)).toBe(true);
});
