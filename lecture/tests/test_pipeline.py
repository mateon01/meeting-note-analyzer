import copy
import csv
import io
import shutil
import pymupdf
from lecture_study.pipeline import analyze
from lecture_study.schemas import Alignment, Audience, Overview, Papers, SlideReading, Study, VideoObservation, VideoOutline
from lecture_study.export import flashcard_csv
from lecture_study.deck_scope import DeckPlan, DeckScope


class FakeStore:
    def __init__(self, deck):
        self.bucket, self.prefix, self.run_prefix = "test", "lecture-results/test/", "runs/run-1/"
        self.values, self.files = {}, {}
        self.rec = {"lectureId": "test", "owner": "alice", "title": "Optimization", "course": "ML", "outputLanguage": "en", "transcriptKey": "transcript", "assets": {"slides": {"contentType": "application/pdf", "key": str(deck)}}}
        self.values["transcript"] = {"durationSec": 60, "language": "en", "segments": [{"id": "seg-1", "start": 10, "end": 20, "speaker": "S1", "text": "We update the weights using the gradient."}]}
        self.s3 = self
    def download_file(self, bucket, source, destination): shutil.copyfile(source, destination)
    def record(self): return self.rec
    def read(self, key): return copy.deepcopy(self.values.get(key))
    def progress(self, *args): pass
    def update(self, **kwargs): self.rec.update(kwargs)
    def put(self, suffix, body, content_type): self.files[suffix] = body
    def save(self, suffix, value): self.values[self.prefix + suffix] = copy.deepcopy(value)
    def cached(self, suffix, build, accept=lambda value: True):
        key = self.prefix + "cache/" + suffix
        if key not in self.values or not accept(self.values[key]): self.values[key] = build()
        return copy.deepcopy(self.values[key])


class FakeModel:
    AUDIENCE = {"level": "Undergraduate first optimization course", "priorKnowledge": ["Single-variable calculus"], "lectureGoal": "Understand one gradient step"}
    STUDY = {"slideSummary": "Optimization with gradients", "spokenSummary": "The lecturer discussed weight updates", "explanation": "The learning rate scales the gradient step.",
             "concepts": [{"term": "Gradient", "explanation": "Direction of increase"}],
             "reviewQuestions": [{"question": "Why subtract the gradient?", "answer": "To descend locally", "difficulty": "basic"}, {"question": "Apply one step to $f(x)=x^2$.", "answer": "$x - 2\\eta x$", "difficulty": "apply"}],
             "flashcards": [{"front": "What is a gradient?", "back": "Derivative vector"}],
             "mathNotes": [{"kind": "definition", "name": "Gradient step", "statement": "$x_{t+1} = x_t - \\eta \\nabla f(x_t)$", "steps": ["Start at $x_t$", "Move against the gradient"], "intuition": "Walk downhill.", "supplementary": False}]}

    def __init__(self): self.calls, self.inputs = [], []
    def check(self): pass
    def generate(self, schema, task, data, image=None, validate=None, images=None, **kwargs):
        self.calls.append(schema); self.inputs.append((schema, copy.deepcopy(data)))
        if schema == SlideReading: value = {"title": f"Page {data['page']}", "description": "Gradient descent", "concepts": ["Gradient"]}
        elif schema == VideoObservation: value = {"title": "Page 1", "description": "Gradient descent on screen", "concepts": ["Gradient"], "visualType": "slide"}
        elif schema == Alignment: value = {"assignments": [{"page": 1, "startSegmentId": "seg-1", "endSegmentId": "seg-1", "confidence": 0.9, "reason": "The weight update matches this slide"}]}
        elif schema == Audience: value = self.AUDIENCE
        elif schema == DeckScope:
            selected = [p for p in (1, 2) if f"{p}페이지" in data["request"]]
            value = {"mode": "selected" if selected else "all", "pages": selected}
        elif schema == DeckPlan:
            value = {"groups": [{"title": s["title"], "pages": [s["page"]], "depth": "standard"} for s in data["slides"]]}
        elif schema == Study: value = {**self.STUDY, "searchQueries": [f"gradient optimization research paper {data['reading'].get('page', 1)}"]}
        elif schema == Papers: value = {"papers": [{"sourceId": 0, "relevance": "Optimization methods", "readingFocus": "Algorithm"}]}
        elif schema == VideoOutline: value = {"chapters": [{"title": "Optimization", "topics": [{"title": "Gradient descent", "startSec": data["windowStart"], "endSec": data["windowEnd"], "summary": "One topic spans the window"}]}]}
        else: value = {"overview": "This lecture introduces gradient-based optimization.", "learningObjectives": ["Explain a gradient step"], "reviewPlan": ["Review the derivation", "Answer the practice question"]}
        result = schema.model_validate(value)
        if validate: validate(result)
        return result


class FakeSearch:
    def __init__(self): self.fail_second = True; self.queries = []
    def search(self, query):
        self.queries.append(query)
        if self.fail_second and query.endswith("2"): raise RuntimeError("Simulated search outage")
        return [{"title": "Optimization paper", "url": "https://arxiv.org/abs/1412.6980", "snippet": "A method for stochastic optimization"}]


def test_deck_to_study_exports_with_unmatched_speech_and_retryable_research(tmp_path):
    deck = tmp_path / "input.pdf"
    with pymupdf.open() as document:
        for i in range(2): document.new_page().insert_text((30, 30), f"Optimization {i + 1}")
        document.save(deck)
    store, model, search = FakeStore(deck), FakeModel(), FakeSearch()
    work = tmp_path / "work"; work.mkdir()
    result = analyze(store, work, lambda: None, model=model, search=search)
    document = store.values[store.prefix + "runs/run-1/document.json"]
    assert result["researchFailures"] == 1
    assert len(document["pages"]) == 2
    assert document["pages"][0]["evidence"][0]["text"] == store.values["transcript"]["segments"][0]["text"]
    assert document["pages"][1]["spokenSummary"] == ""
    assert document["pages"][1]["alignment"]["status"] == "unmatched"
    assert document["pages"][1]["research"]["status"] == "failed"
    assert "https://arxiv.org/abs/1412.6980" in store.files["runs/run-1/study.md"].decode()
    assert len(list(csv.reader(io.StringIO(store.files["runs/run-1/flashcards.csv"].decode("utf-8-sig"))))) == 3
    initial_calls = len(model.calls)
    search.fail_second = False
    result = analyze(store, work, lambda: None, model=model, search=search)
    assert result["researchFailures"] == 0
    assert model.calls[initial_calls:] == [Papers]  # Only failed research is regenerated.
    assert len(search.queries) == 3


def test_flashcard_export_does_not_execute_spreadsheet_formulas():
    doc = {"title": "@lecture", "pages": [{"page": 1, "flashcards": [{"front": "=CMD()", "back": "+SUM(1,2)"}]}]}
    rows = list(csv.reader(io.StringIO(flashcard_csv(doc).lstrip("\ufeff"))))
    assert rows[1] == ["'=CMD()", "'+SUM(1,2)", "1", "'@lecture"]
