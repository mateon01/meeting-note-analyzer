from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Request(Strict):
    kind: Literal["lecture", "interview"] = "lecture"
    lectureId: str = Field(pattern=r"^[0-9a-f-]{36}$")
    runId: str = Field(pattern=r"^[0-9a-f-]{36}$")
    ownerSub: str = Field(min_length=1, max_length=128)
    taskToken: str = Field(min_length=1, max_length=4096)
    phase: Literal["prepare", "analyze"] = "analyze"
    attempt: int = Field(default=0, ge=0, le=999_999_999)

    @property
    def expected_status(self):
        return "PREPARING" if self.phase == "prepare" else "ANALYZING"


class VideoObservation(Strict):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=2400)
    concepts: list[str] = Field(max_length=20)
    visualType: Literal["slide", "whiteboard", "demo", "speaker", "other"]


class VideoTopic(Strict):
    title: str = Field(min_length=1, max_length=200)
    startSec: float = Field(ge=0)
    endSec: float = Field(ge=0)
    summary: str = Field(min_length=1, max_length=600)


class VideoChapter(Strict):
    title: str = Field(min_length=1, max_length=200)
    topics: list[VideoTopic] = Field(min_length=1, max_length=40)


class VideoOutline(Strict):
    chapters: list[VideoChapter] = Field(min_length=1, max_length=30)


class VideoMatch(Strict):
    deckPage: int | None = Field(default=None, ge=1, le=120)
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(max_length=1000)


class SlideReading(Strict):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=2400)
    concepts: list[str] = Field(max_length=20)


class Assignment(Strict):
    page: int = Field(ge=1, le=120)
    startSegmentId: str
    endSegmentId: str
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(min_length=1, max_length=600)


class Alignment(Strict):
    # A repaired proposal can split ranges at disputed boundaries.
    assignments: list[Assignment] = Field(max_length=1000)
    unresolvedSegmentIds: list[str] = Field(default_factory=list, max_length=1000)


class SegmentChoice(Strict):
    page: int | None = Field(ge=1, le=120)
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(min_length=1, max_length=600)


class AlignmentResolution(Strict):
    choices: dict[str, SegmentChoice]


class Concept(Strict):
    term: str = Field(min_length=1, max_length=200)
    explanation: str = Field(min_length=1, max_length=1500)


class Question(Strict):
    question: str = Field(min_length=1, max_length=1000)
    answer: str = Field(min_length=1, max_length=2000)
    difficulty: Literal["basic", "understand", "apply"] = "basic"


class Flashcard(Strict):
    front: str = Field(min_length=1, max_length=500)
    back: str = Field(min_length=1, max_length=1200)


class MathSymbol(Strict):
    symbol: str = Field(min_length=1, max_length=200)
    meaning: str = Field(min_length=1, max_length=600)


class SourceCheck(Strict):
    status: Literal["consistent", "corrected", "uncertain"]
    explanation: str = Field(min_length=1, max_length=2000)
    correctedStatement: str = Field(default="", max_length=2000)


class RelatedPage(Strict):
    page: int = Field(ge=1, le=120)
    topic: str = Field(min_length=1, max_length=300)


class MathNote(Strict):
    kind: Literal["definition", "theorem", "lemma", "formula", "example"]
    name: str = Field(min_length=1, max_length=200)
    statement: str = Field(min_length=1, max_length=2000)
    steps: list[str] = Field(max_length=12)
    intuition: str = Field(max_length=1500)
    supplementary: bool = False
    symbols: list[MathSymbol] = Field(default_factory=list, max_length=16)
    assumptions: list[str] = Field(default_factory=list, max_length=8)
    sourceCheck: SourceCheck | None = None


class Study(Strict):
    slideSummary: str = Field(min_length=1, max_length=3000)
    spokenSummary: str = Field(max_length=5000)
    explanation: str = Field(min_length=1, max_length=5000)
    concepts: list[Concept] = Field(max_length=12)
    mathNotes: list[MathNote] = Field(default_factory=list, max_length=6)
    relatedPages: list[RelatedPage] = Field(default_factory=list, max_length=8)
    reviewQuestions: list[Question] = Field(max_length=5)
    flashcards: list[Flashcard] = Field(max_length=8)
    searchQueries: list[str] = Field(max_length=2)


class Audience(Strict):
    level: str = Field(min_length=1, max_length=200)
    priorKnowledge: list[str] = Field(max_length=10)
    lectureGoal: str = Field(min_length=1, max_length=1000)


class PaperChoice(Strict):
    sourceId: int = Field(ge=0)
    # Generous bounds: the model tends to write long Korean guidance and a fourth choice; the selector trims to 3 and 800.
    relevance: str = Field(min_length=1, max_length=2000)
    readingFocus: str = Field(min_length=1, max_length=2000)


class Papers(Strict):
    papers: list[PaperChoice] = Field(max_length=6)


class Overview(Strict):
    overview: str = Field(min_length=20, max_length=5000)
    learningObjectives: list[str] = Field(min_length=1, max_length=15)
    reviewPlan: list[str] = Field(min_length=1, max_length=15)
