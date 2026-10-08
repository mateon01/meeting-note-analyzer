# Interview notes

Open **인터뷰 → 새 인터뷰**, or select **인터뷰** on the upload page. Upload one candidate's MP3 recording and optionally their PDF resume. Select any combination of Technical Fit and Amazon Leadership Principles, then choose the target level (L4–L7).

## Inputs and settings

| Input | Support |
| --- | --- |
| Recording | MP3, up to 500 MiB and 4 hours |
| Optional resume | PDF, up to 20 MiB and 20 pages, without a password |
| Technical Fit | Domain Depth, System Architecture, Technical Communication |
| Leadership Principles | All 16; the initial list shows 13, with Frugality, Strive to be Earth’s Best Employer, and Success and Scale Bring Broad Responsibility available through the expand button |
| Target level | One of L4, L5, L6, L7 |
| Notes language | Korean, English, or recording language; Korean by default |
| Opinion language | Korean or English; English by default |
| Optional context | Role title (default: AI Specialist Solutions Architect), role-specific expectations, and a separate interviewer memo |

The level guide is a working reference, not Amazon's official role-specific rubric. Enter the expectations for the actual role in **직무별 기대 수준·평가 기준**.

**Technical Communication** evaluates effective communication with stakeholders, non-specialists, C-level executives,
partner departments and internal collaborators. Evidence includes adapting terminology and detail to the audience,
explaining business impact and options, listening and checking understanding, resolving disagreements, and making
decisions and follow-up actions clear. It is separate from Domain Depth: neither deep algorithm knowledge nor fluent
delivery alone establishes communication effectiveness. Concrete communication examples and their outcomes matter;
unasked audience scenarios, accent and personality are not scoring evidence.

Its level guide progresses from clear team communication at L4, to independent project stakeholder alignment at L5,
cross-functional and executive decision communication at L6, and durable alignment across organizations at L7.
These are working expectations, not official Amazon criteria. The criterion can be selected together with other
Technical Fit items and LPs in both new interviews and the existing interview settings editor.

## Notes and opinions

The result separates original questions, follow-up questions, clarifications, candidate answers, and interviewer hints. Answer bullets cite original transcript segments. A mistaken candidate explanation is preserved rather than replaced with a textbook answer. The interviewer memo appears separately and is not presented as recorded speech or used as an automatic score.

The default note view uses concise questions and candidate-answer bullets targeting about one quarter of the detailed answer length. It omits per-question resume context and the long review/uncertainty paragraphs. **전체 답변·녹음 보기** expands the detailed answer and recording. Empty or unclear answers remain empty or briefly qualified; shortening never invents an answer or changes a score. Speaker labels use **면접관** and **후보자** throughout notes, recording references and transcript downloads.

Opinions cover only the selected criteria. With enough evidence, each opinion uses 3–5 narrative paragraphs (roughly 250–450 English words, or comparable detail in Korean), explaining concrete examples, individual contributions, outcomes and target-level implications. Thin evidence gets shorter feedback without filler. Strengths and concerns remain grounded separately, but appear as connected paragraphs rather than (+)/(-) blocks. Internal question/resume IDs are not part of the narrative. **평가 근거·추가 확인** expands the question links, level summary, and follow-up questions; each question links back to the original speech and audio time.

The rating scale is:

| Score | Label |
| --- | --- |
| 1 | Concern |
| 2 | Mild Concern |
| 3 | Mixed |
| 4 | Mild Strength |
| 5 | Strength |

Five is exceptional: the prompt requires multiple concrete examples, demonstrated depth, personal ownership, and impact appropriate to the target level. When relevant evidence exists but coverage is incomplete, the result provides a **잠정 평가** from 1 to 4 with the limits explained. Genuinely unobserved or unusable evidence stays **근거 부족 · 미평가**; an unasked competency is not a low score, and Mixed is not the default for missing information.

Mixed requires independently demonstrated strengths at the target level alongside concerns. Practical exposure, tool names, and answers supplied through hints do not offset material gaps in core reasoning. Where the probed skills are predominantly below the target level, Mild Concern is appropriate despite some hands-on experience. For L6/L7, the assessment examines personal design decisions, alternatives, tradeoffs and depth when those were probed.

L5 emphasizes independent project problem solving, relevant technical judgment, collaboration and delivery. L6 requires stronger scope, judgment and leadership beyond individual implementation; L6 expectations are not imposed on an L5 interview. Feedback distinguishes observed role-critical gaps, development areas compatible with the selected bar, and untested areas. Learn and Be Curious focuses on investigation, experimentation, validation and changed practice; a domain-knowledge mistake is not automatically a weakness in every selected criterion. Team outcomes are attributed only to the candidate's demonstrated contribution.

The **종합 의견 (Summary)** card appears above the competency opinions. It gives an advisory **Inclined** or **Not Inclined**, a one-line reason, and usually three paragraphs (roughly 200–350 English words) in the selected opinion language. Borderline always maps to **Not Inclined**. A Mixed rating or limited coverage does not mechanically block Inclined: the synthesis must explain whether the actual role and level are supported and whether concerns materially undermine that conclusion. High scores do not override unresolved role-critical gaps, and future learning potential alone does not establish the bar. Unasked/unrated criteria are not treated as failures. If no reviewable assessment exists, or summary generation fails, no automatic negative recommendation is created.

Summary uses the already grounded competency opinions and their question references. It does not change the scores, draw facts from example feedback, compare candidates, update an applicant's status, or execute a hiring action. The interviewer reviews the draft and makes the final decision. Summary is included in the full Markdown record; the simple Q&A download remains notes only.

## Resume context and gaps

Resume analysis extracts professional claims, with source page numbers, from native text and rendered PDF pages. It ignores unrelated personal details. Resume claims can explain project names or technical context, but are never inserted into the candidate's spoken answer.

The **이력서 대조** tab uses these statuses:

- **답변으로 뒷받침됨:** the answers support the claimed experience or understanding; this remains interview evidence, not independent employment verification.
- **역량 격차 확인:** specific answers show a material shortfall against an explicit skill, understanding, ownership, or scope claim.
- **추가 확인 필요:** the available evidence or speaker attribution is too uncertain.
- **미검증:** the claim was not meaningfully probed.

Each card shows a short Korean claim title and a Korean comparison in one or two sentences. Original resume wording and related questions are expandable. These summaries preserve the existing comparison status and evidence; the assessment language setting still controls competency opinions independently.

Confirmed, relevant gaps remain available in the separate comparison tab and expandable Markdown appendix. The assessment summarizes related gaps together instead of listing resume claim IDs. The model must address the gaps as negative evidence, and is instructed to lower the affected assessment where warranted without double-counting the same issue. Impressive resume text alone cannot raise a rating, and untested or uncertain claims cannot be cited as a penalty or bonus.

## Speaker review and retries

Speaker roles are inferred conservatively. A lower automatic confidence score alone does not block the entire assessment. Answers with unknown speaker roles are excluded from rating evidence individually; clearly attributed answers remain usable. If no candidate answers can be attributed, ratings stay pending role review. Choose **평가 항목·레벨·화자 역할 수정** to check and correct assignments. Multiple acoustic IDs can be assigned to the candidate when diarization split one person into several voices.

Changing the criteria, target level, role context, language, or speaker roles creates a new analysis using the existing transcript. Identical settings and the same resume reuse cached work on retry. Successfully published results stay available while another attempt is running; a failed attempt does not replace them.

Each generated opinion must reference actual questions in its input. If a model output omits a citation or fails validation, the next attempt receives the invalid draft and specific field errors alongside the original evidence. References are never fabricated or made optional to bypass a failed check.

Detailed feedback is retained without the former 650-character shortening step. The assessment and Summary caches are versioned separately from the transcription and question-answer notes: a reanalysis after a feedback update refreshes opinions while reusing completed source work. Previously published results remain unchanged until reanalysis succeeds. Concise Q&A notes and Korean resume comparisons retain their separate presentation formats.

## Downloads

**간소화 노트 다운로드 (.md)** creates the same compact reading copy as the default screen, organized by broad topic as Q → A → f/u Q → A. It uses concise questions and roughly quarter-length candidate-answer bullets, plus at most one essential interviewer cue. It omits resume claims, internal IDs, timestamps, private memos, AI opinions and generic review notices. Brief wording is prepared and cached after assessment and never replaces scoring evidence. Older results without saved reading notes use the original notes. Existing mistakes, qualifications and material limitations are preserved in the summary. The download itself needs no new analysis or network request.

**전체 기록 다운로드 (.md)** saves the complete notes, separate interviewer memo, resume comparisons, and criterion opinions. The original transcript is also available as TXT or Markdown from **전사**. The resume PDF can be opened from the comparison tab.

Exported Markdown contains resume filenames and page references, not signed private download URLs.

Full-record Markdown downloads use the authenticated application API, which reads the latest published file after checking ownership. This avoids dependence on an older signed S3 URL in an open browser tab. Files larger than 4 MiB use a freshly issued direct download URL to stay within the API response size limit.

## Deployment and storage

The interview service is additive inside the existing Lecture stack. It creates a protected interview DynamoDB table and a separate Step Functions workflow, while reusing the SageMaker transcription endpoint and the bounded Python runtime. Interview analysis uses the configured Opus model profile, with a limit of 240 model calls per attempt.

Records and results live in the interview table and `interview-uploads/` / `interview-results/` prefixes. They are not published to the shared meeting memory or knowledge base. API routes require Cognito authentication and enforce ownership.

Interview STT inference IDs use `lecture-i-` so the existing lecture SNS subscription can route their callbacks to the interview token table. The prefix, UUID, and timestamp fit SageMaker's 64-character ID limit.

Deploy with the normal update workflow after reviewing the infrastructure diff. The Lecture stack exposes `InterviewTableName` and `InterviewStateMachineArn`. No existing data table needs to be replaced.
