import { z } from "zod";
import { CONSTRAINTS, OUTPUT_LANGUAGES, type OutputLanguage } from "./constants.js";
import type { UploadPartTarget } from "./meeting.js";

export const LECTURE_LIMITS = { maxVideoBytes: 4 * 1024 ** 3, maxAudioBytes: CONSTRAINTS.maxUploadBytes, maxSlidesBytes: 100 * 1024 * 1024, maxPages: 120, maxVideoScenes: 240, maxResultPages: 360, maxActive: 3, uploadExpirySec: 4 * 3600, maxCustomPromptChars: 2000 } as const;
export const SLIDE_TYPES = { pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pdf: "application/pdf" } as const;
export function parseSlideRange(text: string): number[] {
  const pages = new Set<number>();
  for (const part of text.trim().split(/[,，]/)) {
    const match = /^\s*(\d+)\s*(?:[-–—~～]\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error("분석할 페이지는 38-47 또는 3-8, 12처럼 입력하세요");
    const start = Number(match[1]); const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > LECTURE_LIMITS.maxPages) throw new Error("페이지는 1–120 범위에서 입력하세요");
    for (let page = start; page <= end; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}
export function formatSlidePages(pages: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i]!; let end = start;
    while (pages[i + 1] === end + 1) { end++; i++; }
    ranges.push(start === end ? String(start) : `${start}–${end}`);
  }
  return ranges.join(", ");
}
const slideRangeSchema = z.string().trim().max(200).default("").superRefine((value, ctx) => {
  if (value) { try { parseSlideRange(value); } catch (error) { ctx.addIssue({ code: "custom", message: (error as Error).message }); } }
});
export const LECTURE_STAGES = ["video", "stt", "slides", "alignment", "study", "papers"] as const;
export type LectureStage = (typeof LECTURE_STAGES)[number];
export const LECTURE_STAGE_LABELS: Record<LectureStage, string> = { video: "영상 화면·음성 추출", stt: "음성 전사", slides: "화면·장표 읽기", alignment: "영상 구간 연결", study: "학습 자료", papers: "참고 논문" };

const file = z.object({ fileName: z.string().trim().min(1).max(255), fileSize: z.number().int().positive(), contentType: z.string() });
export const createLectureSchema = z.object({
  title: z.string().trim().min(1).max(200),
  course: z.string().trim().max(120).default(""),
  customPrompt: z.string().trim().max(LECTURE_LIMITS.maxCustomPromptChars, "추가 요청은 2,000자 이하로 입력하세요").default(""),
  slideRange: slideRangeSchema,
  outputLanguage: z.enum(OUTPUT_LANGUAGES).default("ko"),
  languageHint: z.enum(["ko", "en", "ja", "zh", "auto"]).default("auto"),
  video: file.extend({ fileSize: z.number().int().positive().max(LECTURE_LIMITS.maxVideoBytes), contentType: z.literal("video/mp4") })
    .refine((f) => /\.mp4$/i.test(f.fileName), "강의 영상은 MP4여야 합니다").optional(),
  audio: file.extend({ fileSize: z.number().int().positive().max(LECTURE_LIMITS.maxAudioBytes), contentType: z.literal("audio/mpeg") })
    .refine((f) => /\.mp3$/i.test(f.fileName), "강의 음성은 MP3여야 합니다").optional(),
  slides: file.extend({ fileSize: z.number().int().positive().max(LECTURE_LIMITS.maxSlidesBytes), contentType: z.enum([SLIDE_TYPES.pptx, SLIDE_TYPES.pdf]) })
    .refine((f) => f.fileName.toLowerCase().endsWith(f.contentType === SLIDE_TYPES.pdf ? ".pdf" : ".pptx"), "장표는 PPTX 또는 PDF여야 합니다").optional(),
}).refine((input) => !!input.video !== !!input.audio, "MP4 영상 또는 MP3 음성 중 하나를 선택하세요")
  .refine((input) => !input.slideRange || !!input.slides, "페이지 범위를 지정하려면 장표를 첨부하세요");
export type CreateLectureRequest = z.input<typeof createLectureSchema>;
export type LectureAsset = { key: string; uploadId: string; fileName: string; fileSize: number; contentType: string; complete: boolean; etag?: string };
export interface LectureRecord {
  PK: string; SK: "META"; GSI1PK: string; GSI1SK: string;
  lectureId: string; owner: string; title: string; course: string;
  customPrompt?: string;
  slideRange?: string;
  selectedPages?: number[];
  originalPageCount?: number;
  studyImages?: { page: number; sourcePage: number; key: string }[];
  status: "UPLOAD_PENDING" | "UPLOADED" | "PREPARING" | "TRANSCRIBING" | "ANALYZING" | "COMPLETED" | "FAILED";
  outputLanguage: OutputLanguage; languageHint: string;
  assets: { video?: LectureAsset; audio?: LectureAsset; slides?: LectureAsset };
  stages: Partial<Record<LectureStage, { status: "RUNNING" | "COMPLETED" | "FAILED"; completed?: number; total?: number }>>;
  currentStage?: LectureStage; runId?: string; executionArn?: string; analysisClaim?: string; prepareClaim?: string;
  preparedAudioKey?: string; videoManifestKey?: string; hasAudio?: boolean;
  /** Published result files (one run); absent on lectures completed before per-run results, whose files sit at the result prefix root. */
  transcriptKey?: string; documentKey?: string; markdownKey?: string; flashcardsKey?: string; pageCount?: number; durationSec?: number; researchFailures?: number;
  error?: string; createdAt: string; updatedAt: string; completedAt?: string;
}
export type LectureDto = Omit<LectureRecord, "PK" | "SK" | "GSI1PK" | "GSI1SK" | "assets" | "analysisClaim" | "prepareClaim" | "preparedAudioKey" | "videoManifestKey" | "runId" | "executionArn" | "transcriptKey" | "documentKey" | "markdownKey" | "flashcardsKey" | "studyImages"> & {
  videoName?: string; audioName?: string; slidesName?: string; uploadsComplete: boolean;
};
export function lectureUploadsComplete(rec: Pick<LectureRecord, "assets">): boolean {
  if (rec.assets.video) return rec.assets.video.complete && (!rec.assets.slides || rec.assets.slides.complete);
  return !!rec.assets.audio?.complete && (!rec.assets.slides || rec.assets.slides.complete);
}
export function toLectureDto(rec: LectureRecord): LectureDto {
  const { PK, SK, GSI1PK, GSI1SK, assets, analysisClaim, prepareClaim, preparedAudioKey, videoManifestKey, runId, executionArn, transcriptKey, documentKey, markdownKey, flashcardsKey, studyImages, ...dto } = rec;
  return { ...dto, videoName: assets.video?.fileName, audioName: assets.audio?.fileName, slidesName: assets.slides?.fileName, uploadsComplete: lectureUploadsComplete(rec) };
}
export interface LectureUploadPlan { uploadId: string; partSize: number; parts: UploadPartTarget[]; expiresAt: string }
export interface CreateLectureResponse { lecture: LectureDto; uploads: { video?: LectureUploadPlan; audio?: LectureUploadPlan; slides?: LectureUploadPlan } }
export const completeLectureUploadSchema = z.object({
  asset: z.enum(["video", "audio", "slides"]), uploadId: z.string().min(1).max(1024),
  parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1).max(256) })).min(1).max(10000),
});
export type CompleteLectureUpload = z.infer<typeof completeLectureUploadSchema>;
export interface LectureEvidence { segmentId: string; start: number; end: number; text: string; speaker: string }
export interface LecturePaper { title: string; url: string; snippet: string; publishedDate?: string; relevance: string; readingFocus: string; source: "agentcore_web_search" }
export interface LectureMathNote {
  kind: "definition" | "theorem" | "lemma" | "formula" | "example"; name: string; statement: string; steps: string[]; intuition: string; supplementary: boolean;
  symbols?: { symbol: string; meaning: string }[];
  assumptions?: string[];
  sourceCheck?: { status: "consistent" | "corrected" | "uncertain"; explanation: string; correctedStatement: string } | null;
}
/** Who the lecture is for, inferred from the lecture itself; study materials are pitched at this level. */
export interface LectureAudience { level: string; priorKnowledge: string[]; lectureGoal: string }
export interface LecturePage {
  page: number; title: string; slideText: string; imageKey: string;
  source?: "deck" | "video" | "audio"; deckPage?: number; sourceFile?: string;
  sourcePages?: number[];
  sourceImages?: { page: number; imageKey: string }[];
  depth?: "brief" | "standard" | "detailed";
  relatedPages?: { page: number; topic: string }[];
  audioRanges?: { startSec: number; endSec: number }[];
  /** Video topic pages carry the outline chapter they belong to; pages of one chapter share their paper research. */
  chapter?: string;
  visualType?: "slide" | "whiteboard" | "demo" | "speaker" | "other";
  videoRanges?: { startSec: number; endSec: number; frameSec: number }[];
  slideSummary: string; spokenSummary: string; explanation: string;
  alignment: { status: "matched" | "uncertain" | "unmatched"; confidence: number; reason: string; method?: "video_time" | "audio_time" | "visual_match" | "semantic" };
  evidence: LectureEvidence[];
  concepts: { term: string; explanation: string }[];
  /** Text fields may contain LaTeX ($...$ inline, $$...$$ display). Documents generated before math notes existed lack mathNotes. */
  mathNotes?: LectureMathNote[];
  reviewQuestions: { question: string; answer: string; difficulty?: "basic" | "understand" | "apply" }[];
  flashcards: { front: string; back: string }[];
  research: { status: "found" | "none" | "failed"; queries: string[]; papers: LecturePaper[]; error?: string };
}
export interface LectureDocument {
  version: 1; lectureId: string; title: string; course: string; generatedAt: string; outputLanguage: string;
  customPrompt?: string;
  slideRange?: string;
  grouped?: boolean;
  selectedPages?: number[];
  originalPageCount?: number;
  overview: string; learningObjectives: string[]; reviewPlan: string[]; durationSec: number;
  audience?: LectureAudience | null;
  pages: LecturePage[]; warnings: string[];
  videoAnalysis?: { sampleIntervalSec: number; sceneCount: number; sampledFrames: number; groupedScenes: boolean; hasAudio: boolean };
  /** Counts for this analysis attempt; token counts include acknowledged model responses only. */
  usage?: Record<string, number>;
}
export interface LectureResultResponse {
  lecture: LectureDto; document: LectureDocument | null; audioUrl: string | null; videoUrl?: string | null; slidesUrl: string | null;
  transcriptUrl?: string | null;
  markdownUrl: string | null; flashcardsUrl: string | null; pageImages: { page: number; sourcePage?: number; url: string }[];
}
/** HTTP API response: large study documents bypass Lambda/API Gateway payload limits. */
export type LectureResultLinks = Omit<LectureResultResponse, "document"> & { documentUrl: string | null };
export const lectureKeys = {
  record: (id: string) => ({ PK: `MEETING#${id}`, SK: "META" }), // Separate table; compatible with the shared STT callbacks.
  user: (sub: string) => `USER#${sub}`,
  inputPrefix: (sub: string, id: string) => `lecture-uploads/${sub}/${id}/`,
  resultPrefix: (id: string) => `lecture-results/${id}/`,
  runPrefix: (id: string, runId: string) => `lecture-results/${id}/runs/${runId}/`,
};

export const createLectureShareSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().email().max(254)).min(1).max(20).transform((values) => [...new Set(values)]),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});
export interface LectureShare {
  shareId: string; lectureId: string; emails: string[]; createdAt: string; expiresAt: string; revokedAt?: string; url: string;
}
export interface GuestLectureResult {
  document: LectureDocument;
  images: { page: number; sourcePage?: number; url: string }[];
  expiresAt: string;
}
