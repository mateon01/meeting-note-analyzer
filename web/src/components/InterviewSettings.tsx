import { AMAZON_LP_CRITERIA, DEFAULT_INTERVIEW_ROLE, TECHNICAL_FIT_CRITERIA, INTERVIEW_CRITERION_LABELS, INTERVIEW_LEVELS, INTERVIEW_LEVEL_GUIDANCE, type InterviewSettings as Settings } from "@meeting-notes/shared";
import { SectionLabel, Segmented } from "./ui";
import { useState } from "react";

export const DEFAULT_INTERVIEW_SETTINGS: Settings = {
  targetLevel: "L6", criteria: ["domain_depth"], roleTitle: DEFAULT_INTERVIEW_ROLE, roleContext: "",
  notesLanguage: "ko", opinionLanguage: "en", interviewerNotes: "", speakerRoles: {},
};
const EXTRA_LPS = new Set(["frugality", "strive_to_be_earths_best_employer", "success_and_scale_bring_broad_responsibility"]);
export const interviewInputClass = "mt-2 w-full rounded-xl bg-surface border border-line px-3 py-3 text-[16px] focus:outline-none focus:border-accent";

export function InterviewSettingsForm({ value, onChange }: { value: Settings; onChange: (next: Settings) => void }) {
  const [allPrinciples, setAllPrinciples] = useState(value.criteria.some((id) => EXTRA_LPS.has(id)));
  const update = (fields: Partial<Settings>) => onChange({ ...value, ...fields });
  const toggle = (id: Settings["criteria"][number]) => update({ criteria: value.criteria.includes(id) ? value.criteria.filter((item) => item !== id) : [...value.criteria, id] });
  return <div className="space-y-5">
    <label className="block"><SectionLabel>목표 레벨</SectionLabel><select aria-label="목표 레벨" value={value.targetLevel} onChange={(e) => update({ targetLevel: e.target.value as Settings["targetLevel"] })} className={interviewInputClass}>{INTERVIEW_LEVELS.map((level) => <option key={level}>{level}</option>)}</select></label>
    <p className="text-xs text-ink-3 leading-relaxed">{INTERVIEW_LEVEL_GUIDANCE[value.targetLevel]}를 살펴봅니다. 공식 직무별 평가 기준이 아닌 참고 가이드이며, 별도 기준은 아래에 입력할 수 있습니다.</p>
    {(["Technical Fit", "Amazon LP"] as const).map((group) => <fieldset key={group}><legend className="text-sm font-semibold mb-2">{group} <span className="font-normal text-xs text-ink-3">복수 선택</span></legend>
      <div className="grid gap-2">{(group === "Technical Fit" ? TECHNICAL_FIT_CRITERIA : AMAZON_LP_CRITERIA.filter((id) => allPrinciples || !EXTRA_LPS.has(id))).map((id) => <label key={id} className={`flex gap-3 items-center rounded-xl border p-3 text-sm cursor-pointer ${value.criteria.includes(id) ? "border-accent/60 bg-accent-soft" : "border-line bg-surface"}`}><input type="checkbox" aria-label={INTERVIEW_CRITERION_LABELS[id]} checked={value.criteria.includes(id)} onChange={() => toggle(id)} /><span>{INTERVIEW_CRITERION_LABELS[id]}
        {id === "technical_communication" && <span className="block mt-1 text-xs font-normal leading-relaxed text-ink-3">기술 지식의 깊이보다, 비전공자·경영진·유관부서 등 상대에 맞게 설명하고 이해를 확인하며 협업과 의사결정을 이끄는 역량</span>}
      </span></label>)}</div>
      {group === "Amazon LP" && !allPrinciples && <button type="button" onClick={() => setAllPrinciples(true)} className="tap mt-2 text-xs text-accent underline">Frugality · Earth’s Best Employer · Success and Scale도 표시</button>}
    </fieldset>)}
    {!value.criteria.length && <p className="text-xs text-danger">평가할 항목을 하나 이상 선택하세요.</p>}
    <label className="block"><SectionLabel>직무</SectionLabel><input aria-label="인터뷰 직무" className={interviewInputClass} value={value.roleTitle} maxLength={120} onChange={(e) => update({ roleTitle: e.target.value })} /></label>
    <label className="block"><SectionLabel>직무별 기대 수준·평가 기준 (선택)</SectionLabel><textarea aria-label="직무별 평가 기준" className={interviewInputClass} rows={3} maxLength={6000} placeholder="예: 모델 개발뿐 아니라 서비스 운영과 팀 간 설계 조율 경험을 확인합니다." value={value.roleContext} onChange={(e) => update({ roleContext: e.target.value })} /></label>
    <div><SectionLabel>인터뷰 노트 언어</SectionLabel><Segmented className="mt-2" value={value.notesLanguage} onChange={(notesLanguage) => update({ notesLanguage })} options={[{ value: "ko", label: "한국어" }, { value: "en", label: "English" }, { value: "auto", label: "녹음 언어" }]} /></div>
    <div><SectionLabel>AI 평가 의견 언어</SectionLabel><Segmented className="mt-2" value={value.opinionLanguage} onChange={(opinionLanguage) => update({ opinionLanguage })} options={[{ value: "ko", label: "한국어" }, { value: "en", label: "English" }]} /></div>
    <label className="block"><SectionLabel>면접관 메모 (선택)</SectionLabel><textarea aria-label="면접관 메모" className={interviewInputClass} rows={4} maxLength={8000} placeholder="직접 관찰한 내용이나 별도로 남기고 싶은 메모. 녹음 내용 및 AI 의견과 구분해 저장합니다." value={value.interviewerNotes} onChange={(e) => update({ interviewerNotes: e.target.value })} /></label>
    <p className="text-xs text-ink-3 leading-relaxed">1 Concern · 2 Mild Concern · 3 Mixed · 4 Mild Strength · 5 Strength. 5점은 여러 구체적 사례로 충분히 입증된 경우에만 제안합니다. 관찰하지 못한 항목은 ‘근거 부족’으로 표시합니다.</p>
  </div>;
}
