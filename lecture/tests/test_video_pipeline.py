import copy
import io
from pathlib import Path

import pymupdf
import pytest

from lecture_study.pipeline import analyze
from lecture_study.schemas import Audience, Overview, Papers, SlideReading, Study, VideoMatch, VideoObservation, VideoOutline
from lecture_study.video import prepare_video
from test_video import make_video, media_test


class Store:
    def __init__(self, source, deck=None):
        self.bucket, self.prefix, self.run_prefix = "test", "lecture-results/test/", "runs/run-1/"
        self.values, self.blobs = {}, {"video.mp4": source.read_bytes()}
        assets = {"video": {"key": "video.mp4", "etag": "fixture-video"}}
        if deck:
            assets["slides"] = {"key": "deck.pdf", "contentType": "application/pdf"}; self.blobs["deck.pdf"] = deck.read_bytes()
        self.rec = {"lectureId": "test", "title": "Video lecture", "course": "ML", "outputLanguage": "en", "assets": assets, "transcriptKey": "transcript"}
        self.source = source; self.s3 = self
    def record(self): return self.rec
    def read(self, key): return copy.deepcopy(self.values.get(key))
    def save(self, suffix, value): self.values[self.prefix + suffix] = copy.deepcopy(value)
    def put(self, suffix, body, content_type): self.blobs[self.prefix + suffix] = body
    def upload_file(self, suffix, path, content_type): self.put(suffix, path.read_bytes(), content_type)
    def download_file(self, bucket, key, destination): Path(destination).write_bytes(self.blobs[key])
    def generate_presigned_url(self, *args, **kwargs): return str(self.source)
    def get_paginator(self, operation): return self
    def paginate(self, **kwargs): yield {"Contents": [{"Key": key} for key in self.blobs if key.startswith(kwargs["Prefix"])]}
    def progress(self, *args): pass
    def update(self, **fields): self.rec.update(fields)
    def cached(self, suffix, build, accept=lambda value: True):
        key = self.prefix + "cache/" + suffix
        if key not in self.values or not accept(self.values[key]): self.values[key] = build()
        return copy.deepcopy(self.values[key])


class Model:
    def __init__(self): self.calls = []
    def check(self): pass
    def generate(self, schema, task, data, image=None, images=None, validate=None):
        self.calls.append(schema)
        if schema == SlideReading:
            value = {"title": "Gradient descent" if "Gradient" in data["text"] else "Not presented", "description": "Attached slide", "concepts": ["Gradient"]}
        elif schema == VideoObservation:
            assert len(images) == 3 and all(p.stat().st_size > 0 for p in images)
            first = data["startSec"] < 30 or data["startSec"] >= 60
            value = {"title": "Gradient descent" if first else "Board example", "description": "The board equation changes across the frames", "concepts": ["Gradient"], "visualType": "slide" if first else "demo"}
        elif schema == VideoMatch:
            assert len(images) == data["videoImageCount"] + len(data["candidates"])
            value = {"deckPage": 1, "confidence": 0.95, "reason": "Same displayed slide"}
        elif schema == VideoOutline:
            assert data["visualSections"] and data["windowStart"] == 0 and data["windowEnd"] == 90
            value = {"chapters": [{"title": "Optimization", "topics": [{"title": "Gradient descent", "startSec": 0, "endSec": 60, "summary": "Intro"}, {"title": "Board example", "startSec": 60, "endSec": 90, "summary": "Board"}]}]}
        elif schema == Audience:
            value = {"level": "Undergraduate first course", "priorKnowledge": ["Calculus"], "lectureGoal": "Understand a gradient step"}
        elif schema == Study:
            assert data["audience"]["level"] == "Undergraduate first course"
            value = {"slideSummary": "Visual teaching content", "spokenSummary": "A statement from speech", "explanation": "Supplemental explanation", "concepts": [{"term": "Gradient", "explanation": "Derivative"}], "reviewQuestions": [{"question": "What changes?", "answer": "Weights"}], "flashcards": [{"front": "Gradient?", "back": "Derivative"}], "searchQueries": ["gradient research paper"]}
        elif schema == Papers:
            value = {"papers": [{"sourceId": 0, "relevance": "Related method", "readingFocus": "Algorithm"}]}
        else:
            value = {"overview": "This class explains optimization using visual examples.", "learningObjectives": ["Understand optimization"], "reviewPlan": ["Review the video example"]}
        result = schema.model_validate(value)
        if validate: validate(result)
        return result


class Search:
    def search(self, query): return [{"title": "Optimization paper", "url": "https://arxiv.org/abs/1412.6980", "snippet": "Optimization method"}]


@media_test
@pytest.mark.parametrize("with_deck,silent", [(False, False), (True, False), (False, True)])
def test_real_video_to_visual_study_with_optional_deck_and_silent_track(tmp_path, with_deck, silent):
    source = tmp_path / "video.mp4"; make_video(source, audio=not silent, scene_seconds=30)
    deck = None
    if with_deck:
        deck = tmp_path / "deck.pdf"
        with pymupdf.open() as doc:
            doc.new_page().insert_text((30, 30), "Gradient descent")
            doc.new_page().insert_text((30, 30), "Not presented")
            doc.save(deck)
    store, model = Store(source, deck), Model()
    work = tmp_path / "work"; work.mkdir()
    prepared = prepare_video(store, work, lambda: None)
    store.rec.update(prepared)
    assert prepared["hasAudio"] is not silent
    assert prepare_video(store, work, lambda: None) == prepared  # Manifest/audio/frame cache is complete.
    speech = [] if silent else [{"id": f"seg-{index}", "start": index, "end": index + 0.8, "speaker": "S1", "text": f"speech {index}"} for index in (1, 31, 61)]
    store.values["transcript"] = {"durationSec": 90, "language": "en", "segments": speech}
    analyze(store, work, lambda: None, model=model, search=Search())
    document = store.values[store.prefix + "runs/run-1/document.json"]
    assert document["videoAnalysis"]["sceneCount"] == 3
    assert any(p["source"] == "video" for p in document["pages"])
    assert model.calls.count(VideoObservation) == 3 and model.calls.count(VideoOutline) == 1
    if not with_deck:
        # Three scenes become two topic pages cut along the outline; both belong to one chapter and share its papers.
        first, second = document["pages"]
        assert [p["title"] for p in (first, second)] == ["Gradient descent", "Board example"]
        assert [len(p["videoRanges"]) for p in (first, second)] == [2, 1] and first["chapter"] == second["chapter"] == "Optimization"
        assert model.calls.count(Papers) == 1 and first["research"] == second["research"]
    if with_deck:
        first, unseen, extra = document["pages"]
        assert first["deckPage"] == 1 and len(first["videoRanges"]) == 2
        assert [segment["segmentId"] for segment in first["evidence"]] == ["seg-1", "seg-61"]
        assert unseen["videoRanges"] == [] and unseen["spokenSummary"] == ""
        assert extra["source"] == "video" and extra["visualType"] == "demo" and extra["chapter"] == "Optimization"
    if silent:
        assert all(not p["evidence"] and not p["spokenSummary"] for p in document["pages"])
        assert any("음성 트랙" in warning for warning in document["warnings"])
    assert b"https://arxiv.org/abs/1412.6980" in store.blobs[store.prefix + "runs/run-1/study.md"]
