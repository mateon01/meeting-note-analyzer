from typing import Annotated, Literal
from pydantic import Field, create_model
from .schemas import Strict
from .interview_criteria import LABELS


class SpeakerRole(Strict):
    id: str = Field(min_length=1, max_length=20)
    role: Literal["candidate", "interviewer", "unknown"]
    label: str = Field(min_length=1, max_length=100)
    confidence: float = Field(ge=0, le=1)
    evidenceSegmentIds: list[str] = Field(max_length=8)


class InterviewRoster(Strict):
    speakers: list[SpeakerRole] = Field(min_length=1, max_length=30)
    multipleCandidates: bool = False
    limitations: list[str] = Field(max_length=8)


class QuestionStart(Strict):
    segmentId: str = Field(min_length=1)
    topic: str = Field(min_length=1, max_length=120)
    question: str = Field(min_length=1, max_length=1500)
    kind: Literal["primary", "follow_up", "clarification"]
    parentSegmentId: str | None = None


class QuestionIndex(Strict):
    questions: list[QuestionStart] = Field(max_length=80)


class GroundedPoint(Strict):
    text: str = Field(min_length=1, max_length=1600)
    segmentIds: list[str] = Field(min_length=1, max_length=20)


class InterviewAnswer(Strict):
    question: str = Field(min_length=1, max_length=2000)
    answer: list[GroundedPoint] = Field(max_length=24)
    interviewerContext: list[GroundedPoint] = Field(max_length=12)
    uncertainty: list[str] = Field(max_length=10)
    resumeClaimIds: list[str] = Field(default_factory=list, max_length=8)


def scoped_answer_schema(answer_ids, context_ids, resume_ids=()):
    """Expose only IDs actually available to this generation/merge in the tool schema."""
    def point(name, ids):
        ids = tuple(dict.fromkeys(ids))
        if not ids:
            return GroundedPoint
        identifier = Literal.__getitem__(ids)
        return create_model(name, __base__=GroundedPoint,
                            segmentIds=(list[identifier], Field(min_length=1, max_length=20)))
    answer_ids, context_ids, resume_ids = tuple(answer_ids), tuple(context_ids), tuple(resume_ids)
    candidate_point = point("CandidateEvidence", answer_ids)
    context_point = point("ContextEvidence", context_ids)
    resume_identifier = Literal.__getitem__(resume_ids) if resume_ids else str
    return create_model("ScopedInterviewAnswer", __base__=InterviewAnswer,
                        answer=(list[candidate_point], Field(max_length=24 if answer_ids else 0)),
                        interviewerContext=(list[context_point], Field(max_length=12 if context_ids else 0)),
                        resumeClaimIds=(list[resume_identifier], Field(default_factory=list, max_length=8 if resume_ids else 0)))


class AssessmentPoint(Strict):
    exchangeIds: list[str] = Field(min_length=1, max_length=12, description="Required supporting interview question IDs, never resume claim or speech segment IDs.")
    text: str = Field(min_length=1, max_length=3200)


class InterviewAssessment(Strict):
    rating: int | None = Field(default=None, ge=1, le=5)
    evidenceStatus: Literal["sufficient", "limited", "not_observed"]
    positives: list[AssessmentPoint] = Field(max_length=5)
    concerns: list[AssessmentPoint] = Field(max_length=5)
    levelAssessment: str = Field(min_length=1, max_length=2400)
    followUps: list[str] = Field(max_length=6)


def scoped_assessment_schema(exchange_ids):
    """Require citations selected from the evidence visible in this call, including consolidation."""
    ids = tuple(dict.fromkeys(exchange_ids))
    identifier = Literal.__getitem__(ids) if ids else str
    point = create_model("AssessmentEvidence", __base__=AssessmentPoint,
                         exchangeIds=(list[identifier], Field(min_length=1, max_length=12,
                             description="Required: select the actual question IDs supporting this feedback. Resume IDs cannot replace these.")),
                         text=(str, Field(min_length=1, max_length=3200, description="One paragraph, aiming for 70–110 English words or comparable Korean detail: concrete evidence, individual contribution, outcome and target-level implication. No internal IDs.")))
    return create_model("ScopedInterviewAssessment", __base__=InterviewAssessment,
                        positives=(list[point], Field(max_length=3 if ids else 0, description="Up to three substantive strengths paragraphs, grouping related evidence. Empty if unsupported.")),
                        concerns=(list[point], Field(max_length=2 if ids else 0, description="Up to two paragraphs distinguishing development areas from material target-level gaps. Empty if unsupported.")))


class ResumePage(Strict):
    claims: list[Annotated[str, Field(min_length=1, max_length=600)]] = Field(max_length=12)


class ResumeClaim(Strict):
    text: str = Field(min_length=1, max_length=1800)
    pages: list[int] = Field(min_length=1, max_length=20)


class ResumeClaims(Strict):
    claims: list[ResumeClaim] = Field(max_length=60)


class ResumeComparison(Strict):
    status: Literal["supported", "gap", "uncertain", "not_tested"]
    explanation: str = Field(min_length=1, max_length=4000)
    exchangeIds: list[str] = Field(max_length=12)
    affectedCriteria: list[str] = Field(max_length=len(LABELS))
