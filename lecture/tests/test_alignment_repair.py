import pytest

from lecture_study.alignment import page_evidence, resolve_alignment, validate_alignment
from lecture_study.schemas import Alignment, AlignmentResolution
from test_evidence import SEGMENTS, assignment

SLIDES = [{"page": i, "title": f"Concept {i}"} for i in range(1, 4)]


class Resolver:
    def __init__(self, page):
        self.page = page
        self.calls = []

    def generate(self, schema, task, data, validate):
        assert schema is AlignmentResolution
        self.calls.append(data)
        result = schema(choices={d["segment"]["id"]: {
            "page": self.page, "confidence": 0.8, "reason": "The derivative discussed matches this page."
        } for d in data["disputes"]})
        validate(result)
        return result


def overlapping():
    return Alignment(assignments=[assignment(), assignment(page=2, start="seg-2", end="seg-3")])


def test_cross_page_overlap_is_rechecked_without_regenerating_other_links():
    model = Resolver(2)
    result = resolve_alignment(model, overlapping(), SEGMENTS, SLIDES, "ko")
    validate_alignment(result, SEGMENTS, 3)
    assert [s["segmentId"] for s in page_evidence(1, [result], [SEGMENTS])[0]] == ["seg-1"]
    assert [s["segmentId"] for s in page_evidence(2, [result], [SEGMENTS])[0]] == ["seg-2", "seg-3"]
    assert page_evidence(2, [result], [SEGMENTS])[1]["confidence"] == 0.8
    assert len(model.calls) == 1
    assert [d["segment"]["id"] for d in model.calls[0]["disputes"]] == ["seg-2"]
    assert {s["page"] for s in model.calls[0]["slides"]} == {1, 2}
    assert not result.unresolvedSegmentIds


@pytest.mark.parametrize("choice", [None, 3])
def test_inconclusive_or_invalid_repair_preserves_other_evidence_without_guessing(choice):
    result = resolve_alignment(Resolver(choice), overlapping(), SEGMENTS, SLIDES, "ko")
    validate_alignment(result, SEGMENTS, 3)
    assert result.unresolvedSegmentIds == ["seg-2"]
    assert [s["segmentId"] for s in page_evidence(1, [result], [SEGMENTS])[0]] == ["seg-1"]
    assert [s["segmentId"] for s in page_evidence(2, [result], [SEGMENTS])[0]] == ["seg-3"]


def test_same_page_duplicates_are_deduplicated_without_model_calls():
    model = Resolver(1)
    value = Alignment(assignments=[assignment(), assignment(start="seg-2", end="seg-3", confidence=0.6)])
    result = resolve_alignment(model, value, SEGMENTS, SLIDES, "ko")
    validate_alignment(result, SEGMENTS, 3)
    evidence, confidence = page_evidence(1, [result], [SEGMENTS])
    assert [s["segmentId"] for s in evidence] == ["seg-1", "seg-2", "seg-3"]
    assert confidence["confidence"] == 0.6
    assert not model.calls


def test_valid_cached_alignment_is_preserved_exactly():
    value = Alignment(assignments=[assignment(end="seg-1"), assignment(start="seg-2", confidence=0.5)])
    model = Resolver(1)
    assert resolve_alignment(model, value, SEGMENTS, SLIDES, "ko") is value
    assert not model.calls


def test_invalid_source_references_and_cancellation_still_fail():
    with pytest.raises(ValueError, match="unknown"):
        resolve_alignment(Resolver(1), Alignment(assignments=[assignment(start="invented")]), SEGMENTS, SLIDES, "ko")
    class Cancelled:
        def generate(self, *args, **kwargs):
            raise RuntimeError("Cancelled")
    with pytest.raises(RuntimeError, match="Cancelled"):
        resolve_alignment(Cancelled(), overlapping(), SEGMENTS, SLIDES, "ko")


def test_unresolved_speech_cannot_also_be_used_as_evidence():
    with pytest.raises(ValueError, match="unresolved"):
        validate_alignment(Alignment(assignments=[assignment()], unresolvedSegmentIds=["seg-1"]), SEGMENTS, 3)


def test_pipeline_finishes_and_reuses_cache_when_a_boundary_remains_ambiguous(tmp_path):
    import pymupdf
    from lecture_study.pipeline import analyze
    from test_pipeline import FakeModel, FakeSearch, FakeStore

    deck = tmp_path / "input.pdf"
    with pymupdf.open() as pdf:
        for _ in range(2):
            pdf.new_page().insert_text((30, 30), "Gradient descent")
        pdf.save(deck)

    class AmbiguousModel(FakeModel):
        def generate(self, schema, task, data, **kwargs):
            if schema is Alignment:
                value = Alignment(assignments=[assignment(page=p, end="seg-1") for p in (1, 2)])
                kwargs["validate"](value)
                return value
            if schema is AlignmentResolution:
                raise ValueError("Could not select a page")
            return super().generate(schema, task, data, **kwargs)

    store, model, search = FakeStore(deck), AmbiguousModel(), FakeSearch()
    search.fail_second = False
    analyze(store, tmp_path, lambda: None, model=model, search=search)
    document = store.values[store.prefix + "runs/run-1/document.json"]
    assert len(document["pages"]) == 2
    assert all(not p["evidence"] and not p["spokenSummary"] for p in document["pages"])
    assert any("1개 발언" in warning for warning in document["warnings"])
    assert len(store.values["transcript"]["segments"]) == 1
    calls = len(model.calls)
    analyze(store, tmp_path, lambda: None, model=model, search=search)
    assert len(model.calls) == calls
