import { z } from "zod";

/** Namespace shared by the SageMaker inference ID and SNS message-body filters. */
export const LECTURE_INFERENCE_PREFIX = "lecture-";
// Interviews share the lecture SNS subscription, then route to their own token table.
// Keep UUID + timestamp + prefix within SageMaker's 64-character inference ID limit.
export const INTERVIEW_INFERENCE_PREFIX = `${LECTURE_INFERENCE_PREFIX}i-`;
export function isLectureInference(inferenceId: string): boolean { return inferenceId.startsWith(LECTURE_INFERENCE_PREFIX); }
export function isInterviewInference(inferenceId: string): boolean { return inferenceId.startsWith(INTERVIEW_INFERENCE_PREFIX); }

/** Output written by the SageMaker STT container (CrisperWhisper + pyannote). */
export const sttWordSchema = z.object({ w: z.string(), s: z.number(), e: z.number(), p: z.number().nullable().optional() });

export const sttSegmentSchema = z.object({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  speaker: z.string(),
  text: z.string(),
  words: z.array(sttWordSchema).default([]),
});

export const sttSpeakerSchema = z.object({ id: z.string(), talkTimeSec: z.number() });

export const sttOutputSchema = z.object({
  version: z.literal(1),
  meetingId: z.string(),
  language: z.string().nullable(),
  languageProbability: z.number().nullable().optional(),
  durationSec: z.number(),
  mode: z.enum(["intended", "verbatim"]),
  model: z.string(),
  speakers: z.array(sttSpeakerSchema),
  segments: z.array(sttSegmentSchema),
  stats: z.record(z.unknown()).default({}),
});
export type SttOutput = z.infer<typeof sttOutputSchema>;
export type SttSegment = z.infer<typeof sttSegmentSchema>;

export const speakerCorrectionSchema = z.object({
  id: z.string(),
  kind: z.enum(["label", "merge", "relabel"]),
  from: z.array(z.string()),
  to: z.string(),
  proposedLabel: z.string().optional(),
  status: z.enum(["applied", "review_required"]),
  reason: z.string(),
  issues: z.array(z.string()),
  evidence: z.array(z.object({ segmentId: z.string(), quote: z.string() })),
  segmentIds: z.array(z.string()),
});
export type SpeakerCorrection = z.infer<typeof speakerCorrectionSchema>;

/** Normalized transcript stored at transcripts/{id}/transcript.json (same shape, guaranteed sorted + ids). */
export const transcriptSchema = sttOutputSchema.extend({
  normalizedAt: z.string(),
  attributed: z.boolean().optional(),
  speakerAttribution: z.object({ version: z.literal(2), corrections: z.array(speakerCorrectionSchema) }).optional(),
  segments: z.array(sttSegmentSchema.extend({
    originalSpeaker: z.string().optional(),
    speakerLabel: z.string().optional(),
    speakerCorrectionIds: z.array(z.string()).optional(),
    speakerReviewRequired: z.boolean().optional(),
  })),
  speakers: z.array(sttSpeakerSchema.extend({ label: z.string().optional(), reviewRequired: z.boolean().optional(), proposedLabel: z.string().optional(), nameConfirmedByUser: z.boolean().optional() })),
});
export type Transcript = z.infer<typeof transcriptSchema>;
