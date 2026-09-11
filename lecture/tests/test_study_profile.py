"""Learner-level study materials: inferred audience, math notes, and paper-failure wording."""
import shutil

import pymupdf
from PIL import Image

from lecture_study.export import markdown
from lecture_study.pipeline import analyze
from lecture_study.prompts import STUDY_CACHE_VERSION
from lecture_study.schemas import Audience, Question, Study
from lecture_study.video_analysis import make_study
from test_pipeline import FakeModel, FakeSearch, FakeStore


def make_deck(tmp_path, pages=2):
    deck = tmp_path / "input.pdf"
    with pymupdf.open() as document:
        for i in range(pages):
            document.new_page().insert_text((30, 30), f"Optimization {i + 1}")
        document.save(deck)
    return deck


def run(store, model, tmp_path, search=None):
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    return analyze(store, work, lambda: None, model=model, search=search or FakeSearch())


def test_audience_is_inferred_from_the_lecture_opening_before_study_materials(tmp_path):
    store, model = FakeStore(make_deck(tmp_path)), FakeModel()
    store.values["transcript"]["segments"].append({"id": "seg-2", "start": 700, "end": 710, "speaker": "S1", "text": "Later material"})
    run(store, model, tmp_path)
    assert model.calls.index(Audience) < model.calls.index(Study)
    audience_input = next(data for schema, data in model.inputs if schema == Audience)
    assert audience_input["title"] == "Optimization" and audience_input["course"] == "ML"
    assert [s["text"] for s in audience_input["openingSpeech"]] == ["We update the weights using the gradient."]  # first 10 minutes only
    assert [s["title"] for s in audience_input["sections"]] == ["Page 1", "Page 2"]
    study_input = next(data for schema, data in model.inputs if schema == Study)
    document = store.values[store.prefix + "runs/run-1/document.json"]
    assert study_input["audience"] == document["audience"] == FakeModel.AUDIENCE
    text = store.files["runs/run-1/study.md"].decode()
    assert "## 이 강의의 대상" in text and FakeModel.AUDIENCE["level"] in text


def test_study_cache_is_versioned_with_the_prompt(tmp_path):
    store, model = FakeStore(make_deck(tmp_path, pages=1)), FakeModel()
    store.values[store.prefix + "cache/study-1.json"] = {**FakeModel.STUDY, "searchQueries": []}  # written by an older prompt version
    run(store, model, tmp_path)
    assert model.calls.count(Study) == 1
    assert store.values[store.prefix + f"cache/study-1.{STUDY_CACHE_VERSION}.json"]["mathNotes"] == FakeModel.STUDY["mathNotes"]
    model = FakeModel()
    run(store, model, tmp_path)
    assert model.calls.count(Study) == 0  # the entry for the current prompt version is reused


def test_failed_paper_search_is_distinguished_from_no_papers(tmp_path):
    store, model = FakeStore(make_deck(tmp_path)), FakeModel()
    result = run(store, model, tmp_path)
    document = store.values[store.prefix + "runs/run-1/document.json"]
    assert result["researchFailures"] == 1 and document["pages"][1]["research"]["status"] == "failed"
    assert any("1개 장표의 논문 검색이 완료되지 않았습니다" in warning for warning in document["warnings"])
    text = store.files["runs/run-1/study.md"].decode()
    assert text.count("논문 검색을 완료하지 못했습니다") == 1 and "참고 논문이 없습니다" not in text  # page 1 found a paper, page 2 failed


def test_study_schema_tags_question_difficulty_and_exports_math_notes():
    study = Study.model_validate({**FakeModel.STUDY, "searchQueries": []})
    assert [q.difficulty for q in study.reviewQuestions] == ["basic", "apply"]
    assert Question.model_validate({"question": "q", "answer": "a"}).difficulty == "basic"  # questions cached before difficulty existed
    assert study.mathNotes[0].kind == "definition" and study.mathNotes[0].supplementary is False
    page = {"page": 1, "title": "P", "alignment": {"status": "matched", "confidence": 1}, "evidence": [], "research": {"status": "none", "papers": []}, **study.model_dump()}
    text = markdown({"title": "T", "overview": "o", "learningObjectives": [], "reviewPlan": [], "audience": FakeModel.AUDIENCE, "warnings": [], "pages": [page]})
    assert "### 수식과 정리" in text
    assert "[정의] Gradient step" in text and "$x_{t+1} = x_t - \\eta \\nabla f(x_t)$" in text
    assert "1. Start at $x_t$" in text and "2. Move against the gradient" in text and "직관: Walk downhill." in text
    assert "질문 (기본)" in text and "질문 (적용)" in text
    page["mathNotes"][0]["supplementary"] = True
    assert "강의에서 생략된 증명을 보충" in markdown({"title": "T", "overview": "o", "learningObjectives": [], "reviewPlan": [], "audience": FakeModel.AUDIENCE, "warnings": [], "pages": [page]})


def test_video_study_prompt_carries_the_audience(tmp_path):
    model = FakeModel()
    picture = tmp_path / "frame.png"
    Image.new("RGB", (8, 8)).save(picture)
    make_study(model, "en", {"title": "t", "description": "d", "concepts": []}, [], ["note"], [picture], True, FakeModel.AUDIENCE)
    assert next(data for schema, data in model.inputs if schema == Study)["audience"] == FakeModel.AUDIENCE


def test_video_analysis_infers_audience_before_study(tmp_path):
    frame = tmp_path / "frame.jpg"
    Image.new("RGB", (64, 36)).save(frame)
    store, model = FakeStore(make_deck(tmp_path, pages=1)), FakeModel()
    store.rec["assets"] = {"video": {"key": "video.mp4"}}
    store.rec["videoManifestKey"] = "manifest"
    store.values["manifest"] = {"durationSec": 60, "sampleIntervalSec": 2, "sampledFrames": 30, "groupedScenes": False, "hasAudio": True,
                                "scenes": [{"startSec": 0, "endSec": 60, "frameTimes": [1, 2, 3], "imageKeys": [store.prefix + "video/frames/0.jpg"] * 3}]}
    store.download_file = lambda bucket, key, destination: shutil.copyfile(frame, destination)
    run(store, model, tmp_path)
    assert model.calls.index(Audience) < model.calls.index(Study)
    audience_input = next(data for schema, data in model.inputs if schema == Audience)
    assert [s["title"] for s in audience_input["sections"]] == ["Page 1"]
    assert audience_input["openingSpeech"][0]["text"] == "We update the weights using the gradient."
    assert store.values[store.prefix + "runs/run-1/document.json"]["audience"] == FakeModel.AUDIENCE
    assert store.prefix + "cache/topic-study-0.v1.json" in store.values  # video sections are topic pages now


def test_results_are_written_under_the_run_and_returned_as_keys(tmp_path):
    store, model = FakeStore(make_deck(tmp_path, pages=1)), FakeModel()
    result = run(store, model, tmp_path)
    assert result["documentKey"] == store.prefix + "runs/run-1/document.json"
    assert result["markdownKey"] == store.prefix + "runs/run-1/study.md"
    assert result["flashcardsKey"] == store.prefix + "runs/run-1/flashcards.csv"
    assert set(store.files) >= {"runs/run-1/study.md", "runs/run-1/flashcards.csv", "slides/1.png"}
    assert "study.md" not in store.files and store.prefix + "document.json" not in store.values  # nothing is overwritten in place
