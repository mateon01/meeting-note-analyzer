from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Request(Strict):
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
    assignments: list[Assignment] = Field(max_length=120)


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


class MathNote(Strict):
    kind: Literal["definition", "theorem", "lemma", "formula", "example"]
    name: str = Field(min_length=1, max_length=200)
    statement: str = Field(min_length=1, max_length=2000)
    steps: list[str] = Field(max_length=12)
    intuition: str = Field(max_length=1500)
    supplementary: bool = False


class Study(Strict):
    slideSummary: str = Field(min_length=1, max_length=3000)
    spokenSummary: str = Field(max_length=5000)
    explanation: str = Field(min_length=1, max_length=5000)
    concepts: list[Concept] = Field(max_length=12)
    mathNotes: list[MathNote] = Field(default_factory=list, max_length=6)
    reviewQuestions: list[Question] = Field(max_length=5)
    flashcards: list[Flashcard] = Field(max_length=8)
    searchQueries: list[str] = Field(max_length=2)


class Audience(Strict):
    level: str = Field(min_length=1, max_length=200)
    priorKnowledge: list[str] = Field(max_length=10)
    lectureGoal: str = Field(min_length=1, max_length=1000)


class PaperChoice(Strict):
    sourceId: int = Field(ge=0)
    relevance: str = Field(min_length=1, max_length=800)
    readingFocus: str = Field(min_length=1, max_length=800)


class Papers(Strict):
    papers: list[PaperChoice] = Field(max_length=3)


class Overview(Strict):
    overview: str = Field(min_length=20, max_length=5000)
    learningObjectives: list[str] = Field(min_length=1, max_length=15)
    reviewPlan: list[str] = Field(min_length=1, max_length=15)
