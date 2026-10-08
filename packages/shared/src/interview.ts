import { z } from "zod";
import { CONSTRAINTS, OUTPUT_LANGUAGES } from "./constants.js";
import type { LectureAsset, LectureRecord, LectureUploadPlan } from "./lecture.js";

export const TECHNICAL_FIT_CRITERIA = ["domain_depth", "system_architecture", "technical_communication"] as const;
export const AMAZON_LP_CRITERIA = [
  "customer_obsession", "ownership", "invent_and_simplify", "are_right_a_lot",
  "learn_and_be_curious", "hire_and_develop_the_best", "insist_on_the_highest_standards",
  "think_big", "bias_for_action", "frugality", "earn_trust", "dive_deep",
  "have_backbone_disagree_and_commit", "deliver_results",
  "strive_to_be_earths_best_employer", "success_and_scale_bring_broad_responsibility",
] as const;
export const INTERVIEW_CRITERIA = [...TECHNICAL_FIT_CRITERIA, ...AMAZON_LP_CRITERIA] as const;
export type InterviewCriterion = typeof INTERVIEW_CRITERIA[number];
export const INTERVIEW_CRITERION_LABELS: Record<InterviewCriterion, string> = {
  domain_depth: "Domain Depth", system_architecture: "System Architecture", technical_communication: "Technical Communication",
  customer_obsession: "Customer Obsession", ownership: "Ownership", invent_and_simplify: "Invent and Simplify",
  are_right_a_lot: "Are Right, A Lot", learn_and_be_curious: "Learn and Be Curious",
  hire_and_develop_the_best: "Hire and Develop the Best", insist_on_the_highest_standards: "Insist on the Highest Standards",
  think_big: "Think Big", bias_for_action: "Bias for Action", frugality: "Frugality",
  earn_trust: "Earn Trust", dive_deep: "Dive Deep", have_backbone_disagree_and_commit: "Have Backbone; Disagree and Commit",
  deliver_results: "Deliver Results", strive_to_be_earths_best_employer: "Strive to be Earth’s Best Employer",
  success_and_scale_bring_broad_responsibility: "Success and Scale Bring Broad Responsibility",
};
export const INTERVIEW_LEVELS = ["L4", "L5", "L6", "L7"] as const;
export const DEFAULT_INTERVIEW_ROLE = "AI Specialist Solutions Architect";
export type InterviewLevel = typeof INTERVIEW_LEVELS[number];
/** Working evaluation anchors, not Amazon's official role-specific hiring rubric. */
export const INTERVIEW_LEVEL_GUIDANCE: Record<InterviewLevel, string> = {
  L4: "기본 개념을 설명하고, 범위가 정해진 과제를 구현·검증한 근거",
  L5: "모호한 요구를 구체화하고, 설계·트레이드오프·운영을 독립적으로 책임진 근거",
  L6: "복잡한 문제를 이끌고, 여러 관계자를 조율하며 재사용 가능한 개선과 영향력을 만든 근거",
  L7: "여러 팀에 걸친 기술 방향·장기 전략을 이끌고 지속적인 조직적 효과를 만든 근거",
};
export const INTERVIEW_RATINGS = { 1: "Concern", 2: "Mild Concern", 3: "Mixed", 4: "Mild Strength", 5: "Strength" } as const;
export const INTERVIEW_STAGES = ["stt", "resume", "speakers", "notes", "resume_review", "assessment", "reading"] as const;
export type InterviewStage = typeof INTERVIEW_STAGES[number];
export const INTERVIEW_STAGE_LABELS: Record<InterviewStage, string> = { stt: "음성 전사", resume: "이력서의 직무 경험 읽기", speakers: "면접관·후보자 구분", notes: "질문·답변 정리", resume_review: "이력서와 답변 대조", assessment: "항목별 평가 의견", reading: "핵심 노트 정리" };
export const INTERVIEW_LIMITS = { maxAudioBytes: CONSTRAINTS.maxUploadBytes, maxResumeBytes: 20 * 1024 ** 2, maxResumePages: 20, maxActive: 3, uploadExpirySec: 4 * 3600 } as const;
export const interviewSettingsSchema = z.object({
  targetLevel: z.enum(INTERVIEW_LEVELS).default("L6"),
  criteria: z.array(z.enum(INTERVIEW_CRITERIA)).min(1).max(INTERVIEW_CRITERIA.length)
    .refine((items) => new Set(items).size === items.length, "평가 항목이 중복되었습니다"),
  roleTitle: z.string().trim().max(120).default(DEFAULT_INTERVIEW_ROLE),
  roleContext: z.string().trim().max(6000).default(""),
  notesLanguage: z.enum(OUTPUT_LANGUAGES).default("ko"),
  opinionLanguage: z.enum(["ko", "en"]).default("en"),
  interviewerNotes: z.string().trim().max(8000).default(""),
  speakerRoles: z.record(z.string().regex(/^S\d{1,3}$/), z.enum(["candidate", "interviewer", "unknown"])).default({})
    .refine((roles) => Object.keys(roles).length <= 30, "화자 수가 지원 한도를 초과했습니다"),
});
export type InterviewSettings = z.output<typeof interviewSettingsSchema>;
export const createInterviewSchema = z.object({
  title: z.string().trim().min(1).max(200),
  languageHint: z.enum(["ko", "en", "ja", "zh", "auto"]).default("auto"),
  audio: z.object({ fileName: z.string().trim().min(1).max(255).regex(/\.mp3$/i, "MP3 파일을 선택하세요"),
    fileSize: z.number().int().positive().max(INTERVIEW_LIMITS.maxAudioBytes), contentType: z.literal("audio/mpeg") }),
  resume: z.object({ fileName: z.string().trim().min(1).max(255).regex(/\.pdf$/i, "이력서는 PDF 파일을 선택하세요"),
    fileSize: z.number().int().positive().max(INTERVIEW_LIMITS.maxResumeBytes), contentType: z.literal("application/pdf") }).optional(),
  settings: interviewSettingsSchema,
});
export type CreateInterviewRequest = z.input<typeof createInterviewSchema>;
export interface InterviewRecord {
  PK: string; SK: "META"; GSI1PK: string; GSI1SK: string;
  interviewId: string; owner: string; title: string; languageHint: string; settings: InterviewSettings;
  status: LectureRecord["status"]; assets: { audio: LectureAsset; resume?: LectureAsset };
  stages: Partial<Record<InterviewStage, { status: "RUNNING" | "COMPLETED" | "FAILED"; completed?: number; total?: number }>>;
  currentStage?: InterviewStage; runId?: string; executionArn?: string; analysisClaim?: string; prepareClaim?: string;
  preparedAudioKey?: string; hasAudio?: boolean; durationSec?: number;
  transcriptKey?: string; documentKey?: string; markdownKey?: string; error?: string;
  speakerHints?: { id: string; role: "candidate" | "interviewer" | "unknown"; label: string; confidence: number }[];
  createdAt: string; updatedAt: string; completedAt?: string;
}
export type InterviewDto = Pick<InterviewRecord, "interviewId" | "title" | "settings" | "status" | "stages" | "currentStage" | "durationSec" | "error" | "createdAt" | "updatedAt" | "completedAt" | "speakerHints"> & { audioName: string; resumeName?: string; uploadsComplete: boolean };
export function interviewUploadsComplete(record: Pick<InterviewRecord, "assets">) {
  return record.assets.audio.complete && (!record.assets.resume || record.assets.resume.complete);
}
export function toInterviewDto(record: InterviewRecord): InterviewDto {
  const { interviewId, title, settings, status, stages, currentStage, durationSec, error, createdAt, updatedAt, completedAt, speakerHints } = record;
  return { interviewId, title, settings, status, stages, currentStage, durationSec, error, createdAt, updatedAt, completedAt, speakerHints,
    audioName: record.assets.audio.fileName, resumeName: record.assets.resume?.fileName, uploadsComplete: interviewUploadsComplete(record) };
}
export const completeInterviewUploadSchema = z.object({
  asset: z.enum(["audio", "resume"]).default("audio"), uploadId: z.string().min(1).max(1024),
  parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1).max(256) })).min(1).max(10000),
});
export type CompleteInterviewUpload = z.input<typeof completeInterviewUploadSchema>;
export interface InterviewEvidence { segmentId: string; start: number; end: number; speaker: string; text: string }
export interface InterviewSpeaker {
  id: string; role: "candidate" | "interviewer" | "unknown"; label: string;
  confidence: number; confirmedByUser: boolean; evidence: InterviewEvidence[];
}
export interface InterviewExchange {
  id: string; topic: string; question: string; questionKind: "primary" | "follow_up" | "clarification";
  parentId: string | null; interviewerId: string | null; candidateId: string | null;
  answer: { text: string; segmentIds: string[] }[];
  interviewerContext: { text: string; segmentIds: string[] }[]; uncertainty: string[];
  /** Optional concise wording for reading/export; original interviewerContext remains scoring evidence. */
  briefInterviewerContext?: string[];
  readingNotes?: { topic: string; question: string; answer: string[]; hint: string | null };
  resumeClaimIds?: string[];
  evidence: InterviewEvidence[];
}
export interface InterviewAssessment {
  criterion: InterviewCriterion; rating: 1 | 2 | 3 | 4 | 5 | null;
  evidenceStatus: "sufficient" | "limited" | "not_observed";
  positives: { text: string; exchangeIds: string[]; resumeClaimIds?: string[] }[];
  concerns: { text: string; exchangeIds: string[]; resumeClaimIds?: string[] }[];
  levelAssessment: string; followUps: string[];
}
export interface InterviewOverallSummary {
  recommendation: "Inclined" | "Not Inclined";
  barAssessment: "clear" | "borderline" | "below_bar";
  reason: string; rationale: string;
  criterionIds: InterviewCriterion[];
  exchangeIds: string[];
}
export interface InterviewDocument {
  version: 1; interviewId: string; title: string; generatedAt: string; durationSec: number;
  settings: InterviewSettings; notesLanguage: string;
  speakers: InterviewSpeaker[]; exchanges: InterviewExchange[]; assessments: InterviewAssessment[];
  overallSummary?: InterviewOverallSummary | null;
  overview: string; limitations: string[]; usage?: Record<string, number>;
  resume?: { fileName: string; pageCount: number; claims: { id: string; text: string; pages: number[] }[] } | null;
  resumeComparisons?: { claimId: string; status: "supported" | "gap" | "uncertain" | "not_tested"; explanation: string; readingNotes?: { claim: string; explanation: string }; exchangeIds: string[]; affectedCriteria: InterviewCriterion[] }[];
}
export interface CreateInterviewResponse { interview: InterviewDto; upload: LectureUploadPlan; resumeUpload?: LectureUploadPlan }
export interface InterviewResultLinks { interview: InterviewDto; documentUrl: string | null; transcriptUrl: string | null; audioUrl: string | null; markdownUrl: string | null; resumeUrl?: string | null }
export type InterviewResult = Omit<InterviewResultLinks, "documentUrl"> & { document: InterviewDocument | null };
export const interviewKeys = {
  record: (id: string) => ({ PK: `MEETING#${id}`, SK: "META" as const }), // Separate interview table, shared STT record convention.
  user: (owner: string) => `USER#${owner}`,
  inputPrefix: (owner: string, id: string) => `interview-uploads/${owner}/${id}/`,
  resultPrefix: (id: string) => `interview-results/${id}/`,
  runPrefix: (id: string, runId: string) => `interview-results/${id}/runs/${runId}/`,
};
