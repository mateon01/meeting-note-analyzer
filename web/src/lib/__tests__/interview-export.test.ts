import { expect, it } from "vitest";
import type { InterviewExchange } from "@meeting-notes/shared";
import { briefInterviewerHints, interviewSpeakerLabels, simpleInterviewMarkdown } from "../interview-export";

function exchange(changes: Partial<InterviewExchange> = {}): InterviewExchange {
  return { id: "q1", topic: "Agent", question: "Agent를 설명해 주세요.", questionKind: "primary",
    parentId: null, interviewerId: "S1", candidateId: "S2",
    answer: [{ text: "모델의 온도를 낮추면 항상 같은 결과를 보장한다고 답했다.", segmentIds: ["s2"] }],
    interviewerContext: [{ text: "면접관이 외부 도구의 실행 결과도 고려하라고 보충했다.", segmentIds: ["s3"] }],
    uncertainty: [], resumeClaimIds: ["r32"], evidence: [], ...changes };
}

it("keeps recorded Q&A and follow-ups in order, separately labels hints, and omits resume/evaluation metadata", () => {
  const notes = { title: "인터뷰", exchanges: [
    exchange(), exchange({ id: "q2", questionKind: "follow_up", parentId: "q1", question: "실패하면 어떻게 하나요?",
      answer: [{ text: "세 번 재시도한다고 답했다.", segmentIds: ["s4"] }], interviewerContext: [] }),
    exchange({ id: "q3", topic: "RAG", questionKind: "clarification", question: "검색 단계만 다시 설명해 주세요.",
      answer: [], interviewerContext: [], uncertainty: ["The original recognition is unclear."] }),
  ], resume: { claims: [{ id: "r32", text: "Private resume claim about sent2vec." }] },
  assessments: [{ rating: 2, text: "Private assessment." }] };
  const result = simpleInterviewMarkdown(notes);
  expect(result).toContain("## Agent\n\n**Q: Agent를 설명해 주세요.**");
  expect(result).toContain("항상 같은 결과를 보장한다고 답했다."); // Wrong explanations are not silently corrected.
  expect(result).toContain("**면접관 힌트·정정**\n\n- 외부 도구의 실행 결과도 고려하라고 보충했다.");
  expect(result).toContain("**f/u Q: 실패하면 어떻게 하나요?**");
  expect(result.indexOf("실패하면")).toBeLessThan(result.indexOf("## RAG"));
  expect(result).toContain("명확한 답변 없음.");
  expect(result).not.toContain("일부 발언은 확인이 필요합니다.");
  expect((result.match(/\*\*A:\*\*/g) ?? [])).toHaveLength(3);
  for (const hidden of ["r32", "q1", "s2", "S1", "Private resume", "Private assessment", "sent2vec"]) {
    expect(result).not.toContain(hidden);
  }
});

it("extracts brief hint bullets without candidate reactions, internal IDs or administrative wrap-up", () => {
  const hints = briefInterviewerHints([{ text:
    '면접관이 질문 범위를 스스로 한정함: 알고리즘 상세보다 두 인코더의 근본적인 차이를 질문함. ' +
    '면접관이 추가 단서/맥락을 제공함: BERT와 S-BERT를 관련 맥락으로 언급함. ' +
    '후보자의 첫 답변(seg-0001) 직후, 면접관이 두 입력의 분석에 관한 부분적 단서를 제공함. ' +
    '후보자는 잠시 침묵한 뒤 답변을 이어감. ' +
    '면접관은 기술 질문을 종료하고 면접을 마무리함. ' +
    '따라서 추가 힌트·재질문·모범답안 제시는 기록되지 않음. ' +
    '이후 구간은 본 질문과 무관한 마무리 절차임: 후보자가 직무 범위를 질문하고 면접관이 직무 안내를 제공함. ' +
    '면접관은 피드백을 이틀 내 입력하겠다고 안내함.',
  }]);
  expect(hints).toEqual([
    "질문 범위: 알고리즘 상세보다 두 인코더의 근본적인 차이를 질문함.",
    "추가 단서: BERT와 S-BERT를 관련 맥락으로 언급함.",
    "답변 후 두 입력의 분석에 관한 부분적 단서를 제공함.",
  ]);
});

it("preserves interviewer-provided numbers and explanations without turning them into candidate answers", () => {
  const hints = briefInterviewerHints([{ text:
    "질문 설정: 면접관이 BERT 15%와 이미지 오토인코더 50~70%라는 마스킹 비율을 직접 제공함. " +
    "면접관이 요구한 답변 형식은 왜 다른지 직관적으로 설명하는 것임. " +
    "후보자 답변 이후 면접관이 직접 설명을 제공함: 이미지는 상하좌우 위치 정보를 활용할 수 있다고 설명함. " +
    "마스킹이 항상 좋은 것은 아니지만 일반화된 가중치를 학습할 수 있다고 정리함. " +
    "이 설명은 면접관이 제공한 것이며 후보자의 독립적 지식으로 볼 수 없음.",
  }]);
  expect(hints).toHaveLength(3);
  expect(hints[0]).toContain("BERT 15%");
  expect(hints[0]).toContain("50~70%");
  expect(hints[1]).toContain("상하좌우");
  expect(hints[2]).toContain("항상 좋은 것은 아니지만");
  expect(hints.join(" ")).not.toContain("독립적 지식");
});

it("uses saved concise hint wording and respects an empty summary for administrative-only context", () => {
  const result = simpleInterviewMarkdown({ title: "Interview", exchanges: [
    exchange({ briefInterviewerContext: ["두 입력의 분석에 관한 단서를 제공함."] }),
    exchange({ id: "q2", question: "마지막 질문", briefInterviewerContext: [] }),
  ] });
  expect(result).toContain("**면접관 힌트·정정**\n\n- 두 입력의 분석에 관한 단서를 제공함.");
  expect(result).not.toContain("외부 도구의 실행 결과");
  expect((result.match(/\*\*면접관 힌트·정정\*\*/g) ?? [])).toHaveLength(1);
});

it("uses compressed questions and answers in downloads without copying the original long notes", () => {
  const q = exchange({ readingNotes: { topic: "Agent", question: "결과를 항상 같게 만들 수 있나요?",
    answer: ["온도를 낮추면 항상 같은 결과라고 답함."], hint: null } });
  const result = simpleInterviewMarkdown({ title: "Interview", exchanges: [q] });
  expect(result).toContain("**Q: 결과를 항상 같게 만들 수 있나요?**");
  expect(result).toContain("- 온도를 낮추면 항상 같은 결과라고 답함.");
  expect(result).not.toContain(q.answer[0]!.text);
  expect(result).not.toContain("면접관 힌트·정정");
  expect(q.answer[0]!.text).toContain("항상 같은 결과"); // Detailed source remains intact.
});

it("uses role names instead of acoustic speaker IDs, distinguishing multiple interviewers when needed", () => {
  expect(interviewSpeakerLabels([{ id: "S1", role: "interviewer" }, { id: "S2", role: "candidate" }]))
    .toEqual({ S1: "면접관", S2: "후보자" });
  expect(interviewSpeakerLabels([{ id: "S1", role: "interviewer" }, { id: "S2", role: "interviewer" }, { id: "S3", role: "unknown" }]))
    .toEqual({ S1: "면접관 1", S2: "면접관 2", S3: "미확인 화자" });
});

it("renders transcript text as literal Markdown content instead of injecting headings or HTML", () => {
  const result = simpleInterviewMarkdown({ title: "<script>example</script>", exchanges: [
    exchange({ question: "질문\n# 새 제목", answer: [{ text: "**확정** <img src=x> [링크]", segmentIds: ["s2"] }] }),
  ] });
  expect(result).not.toContain("<script>");
  expect(result).not.toContain("\n# 새 제목");
  expect(result).toContain("\\*\\*확정\\*\\* &lt;img src=x&gt; \\[링크\\]");
});
