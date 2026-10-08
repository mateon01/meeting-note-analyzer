import { INTERVIEW_STAGES, INTERVIEW_STAGE_LABELS, type InterviewDto } from "@meeting-notes/shared";
import { Pill, ProgressBar } from "./ui";

export const interviewActive = (status: InterviewDto["status"]) => ["UPLOADED", "PREPARING", "TRANSCRIBING", "ANALYZING"].includes(status);
const LABELS: Record<InterviewDto["status"], string> = { UPLOAD_PENDING: "업로드 대기", UPLOADED: "처리 대기", PREPARING: "녹음 확인 중", TRANSCRIBING: "전사 중", ANALYZING: "노트·의견 작성 중", COMPLETED: "노트 준비 완료", FAILED: "처리 실패" };
export function InterviewStatus({ interview }: { interview: InterviewDto }) {
  return <Pill dot tone={interview.status === "COMPLETED" ? "success" : interview.status === "FAILED" ? "danger" : "accent"}>{LABELS[interview.status]}</Pill>;
}
export function InterviewProgress({ interview }: { interview: InterviewDto }) {
  return <ol className="space-y-3">{INTERVIEW_STAGES.filter((stage) => interview.resumeName || !["resume", "resume_review"].includes(stage)).map((stage) => {
    const value = interview.stages[stage];
    return <li key={stage}><div className="flex justify-between text-xs mb-2"><span>{INTERVIEW_STAGE_LABELS[stage]}</span><span>{value?.status === "COMPLETED" ? "완료" : value?.total ? `${value.completed ?? 0} / ${value.total}` : interview.currentStage === stage ? "처리 중" : "대기"}</span></div><ProgressBar value={value?.status === "COMPLETED" ? 100 : value?.total ? 100 * (value.completed ?? 0) / value.total : 0} /></li>;
  })}</ol>;
}
