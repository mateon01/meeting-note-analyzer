/** Pipeline stages in the exact order they run (the order is a product requirement). */
export const STAGES = [
  "transcript_analysis",
  "topic_segmentation",
  "speaker_attribution",
  "agenda",
  "summary",
  "notes",
  "follow_ups",
  "suggestions",
  "mindmap",
  "meeting_brief",
] as const;
export type Stage = (typeof STAGES)[number];

export const MEETING_STATUSES = [
  "UPLOAD_PENDING",
  "UPLOADED",
  "TRANSCRIBING",
  "ANALYZING",
  "COMPLETED",
  "FAILED",
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const OUTPUT_LANGUAGES = ["ko", "en", "auto"] as const;
export type OutputLanguage = (typeof OUTPUT_LANGUAGES)[number];

export const ACTIVE_STATUSES: readonly MeetingStatus[] = ["UPLOAD_PENDING", "UPLOADED", "TRANSCRIBING", "ANALYZING"];

export const CONSTRAINTS = {
  /** Only mp3 is accepted (product decision). */
  allowedContentTypes: ["audio/mpeg"] as readonly string[],
  maxUploadBytes: 500 * 1024 * 1024,
  /** S3 multipart part size (S3 minimum is 5 MiB except for the last part). */
  uploadPartBytes: 16 * 1024 * 1024,
  /** STT async invocation is capped at 3600s by SageMaker; 4h of audio is the hard input limit. */
  maxAudioDurationSec: 4 * 3600,
  maxActiveMeetingsPerUser: 3,
  /** SageMaker async caps a single invocation at 1 h and queue waiting at 6 h; the pipeline task timeouts derive from these. */
  sttInvocationTimeoutSec: 3600,
  sttQueueTtlSec: 6 * 3600,
  presignedUrlExpirySec: 3600,
  taskTokenTtlSec: 2 * 24 * 3600,
} as const;
