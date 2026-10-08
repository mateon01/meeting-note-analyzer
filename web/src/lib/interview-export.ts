import type { InterviewDocument, InterviewExchange, InterviewSpeaker } from "@meeting-notes/shared";

export function interviewSpeakerLabels(speakers: Pick<InterviewSpeaker, "id" | "role">[]): Record<string, string> {
  const names = { interviewer: "면접관", candidate: "후보자", unknown: "미확인 화자" };
  const counts = new Map<string, number>(), seen = new Map<string, number>();
  for (const speaker of speakers) counts.set(speaker.role, (counts.get(speaker.role) ?? 0) + 1);
  return Object.fromEntries(speakers.map((speaker) => {
    const index = (seen.get(speaker.role) ?? 0) + 1; seen.set(speaker.role, index);
    return [speaker.id, names[speaker.role] + ((counts.get(speaker.role) ?? 0) > 1 ? ` ${index}` : "")];
  }));
}

export function readingInterviewNotes(exchange: InterviewExchange) {
  const brief = exchange.readingNotes;
  return {
    topic: brief?.topic ?? exchange.topic,
    question: brief?.question ?? exchange.question,
    answer: brief?.answer ?? exchange.answer.map((point) => point.text),
    hints: brief ? (brief.hint ? [brief.hint] : []) : exchange.briefInterviewerContext ?? briefInterviewerHints(exchange.interviewerContext),
  };
}

export function resumeComparisonText(comparison: NonNullable<InterviewDocument["resumeComparisons"]>[number]): string {
  return comparison.readingNotes?.explanation ?? {
    supported: "면접 답변에서 관련 경험을 확인했습니다.",
    gap: "면접 답변에서 이력서에 적힌 역량과의 차이가 확인됐습니다.",
    uncertain: "면접 내용만으로는 해당 경험을 판단하기 어렵습니다.",
    not_tested: "면접에서 구체적으로 검증하지 않은 항목입니다.",
  }[comparison.status];
}

function text(value: string) {
  return value.replace(/\s+/g, " ").trim()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]#]/g, "\\$&");
}

/** Keep short, source-worded hints; omit bookkeeping and the unrelated interview wrap-up. */
export function briefInterviewerHints(points: readonly { text: string }[]): string[] {
  const hints: string[] = [];
  for (const point of points) {
    const relevant = point.text
      .replace(/(?:이후 구간|이후 대화)[\s\S]*?(?:무관|마무리 절차)[\s\S]*$/u, "")
      .replace(/\([^()]*\bseg-\d+[^()]*\)/giu, "")
      .replace(/\bseg-\d+\b/giu, "")
      .replace(/\s+/g, " ").trim();
    for (const sentence of relevant.split(/(?<=[.!?。])\s+/u)) {
      if (!sentence ||
        /(?:면접|기술 질문).*(?:마무리|종료)|마무리 절차|직무 안내|피드백.*(?:입력|이틀)/u.test(sentence) ||
        /(?:추가|별도).*(?:힌트|정정|모범답안).*(?:기록되지|없었|없음|제시 없이)/u.test(sentence) ||
        /(?:후보자의 독립적 지식|후보자 지식의 근거|후보자 답변으로 (?:간주|볼 수)|요구한 답변 형식)/u.test(sentence) ||
        (/^후보자(?:는|가|의)\s/u.test(sentence) && !/면접관/u.test(sentence))) continue;
      const hint = sentence
        .replace(/^후보자.*?(?:직후|이후|후),?\s*(?=면접관)/u, "답변 후 ")
        .replace(/^(답변 후 )?면접관(?:이|은|는)\s*/u, "$1")
        .replace(/^질문 설정:\s*/u, "")
        .replace(/^질문 범위를 스스로 한정함:\s*/u, "질문 범위: ")
        .replace(/^추가 단서\/맥락을 제공함:\s*/u, "추가 단서: ")
        .replace(/직접 설명을 제공함:\s*/u, "설명: ")
        .trim();
      if (hint && !hints.includes(hint)) hints.push(hint);
    }
  }
  return hints.slice(0, 3);
}

/** Reading copy of recorded Q&A. Resume claims, ratings and internal evidence IDs stay in the full record. */
export function simpleInterviewMarkdown(document: Pick<InterviewDocument, "title" | "exchanges">): string {
  const lines = [`# ${text(document.title)}`, ""];
  let topic: string | undefined;
  for (const exchange of document.exchanges) {
    const notes = readingInterviewNotes(exchange);
    if (notes.topic !== topic) {
      topic = notes.topic;
      lines.push(`## ${text(topic)}`, "");
    }
    const prefix = exchange.questionKind === "primary" ? "Q" : "f/u Q";
    lines.push(`**${prefix}: ${text(notes.question)}**`, "", "**A:**", "");
    if (notes.answer.length) {
      lines.push(...notes.answer.map((point) => `- ${text(point)}`));
    } else {
      lines.push("명확한 답변 없음.");
    }
    lines.push("");
    if (notes.hints.length) {
      lines.push("**면접관 힌트·정정**", "", ...notes.hints.map((hint) => `- ${text(hint)}`), "");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}
