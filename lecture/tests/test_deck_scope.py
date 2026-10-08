import copy
import json

import pymupdf
import pytest

from lecture_study.deck_scope import DeckPlan, DeckScope, parse_page_range, scope_pages, validate_plan
from lecture_study.pipeline import analyze
from lecture_study.schemas import Alignment, SlideReading, Study
from test_pipeline import FakeModel, FakeSearch, FakeStore


@pytest.mark.parametrize("text,expected", [
    ("38-47", list(range(38, 48))), ("3–5, 9, 4", [3, 4, 5, 9]), ("1～2，7", [1, 2, 7]),
])
def test_explicit_ranges_are_inclusive_sorted_and_deduplicated(text, expected):
    assert parse_page_range(text) == expected


@pytest.mark.parametrize("text", ["0-4", "5-2", "2-9", "", "1-3 junk", "all", "1,"])
def test_invalid_range_is_not_silently_widened_or_clamped(text):
    with pytest.raises(ValueError):
        parse_page_range(text, 8)


@pytest.mark.parametrize("prompt,expected", [
    ("첨부 슬라이드의 38~47페이지 위주로 정리할 것.", list(range(38, 48))),
    ("슬라이드 18페이지까지 다루고 있어. 수식을 쉽게 설명해 줘.", list(range(1, 19))),
    ("Focus on slides 38-47.", list(range(38, 48))),
])
def test_common_prompt_ranges_are_hard_limits_without_model_calls(prompt, expected):
    assert scope_pages(None, None, {"customPrompt": prompt}, 73) == expected
    with pytest.raises(ValueError):
        scope_pages(None, None, {"customPrompt": prompt}, 10)


def test_invalid_model_extracted_scope_fails_before_reading_slides():
    class Store:
        def cached(self, key, build):
            return build()
    class Model:
        calls = 0
        def generate(self, *args, **kwargs):
            self.calls += 1
            return DeckScope(mode="selected", pages=[999])
    model = Model()
    with pytest.raises(ValueError, match="Requested pages"):
        scope_pages(Store(), model, {"customPrompt": "마지막 장 다음 페이지"}, 10)
    assert model.calls == 1  # Never "repair" an invalid input range by switching to all pages.


def test_group_plan_cannot_add_omit_repeat_or_reorder_source_pages():
    for pages in ([[3, 4], [4, 5]], [[3], [5]], [[5], [3, 4]], [[3, 4], [5, 6]]):
        value = DeckPlan(groups=[{"title": "Topic", "pages": group, "depth": "standard"} for group in pages])
        with pytest.raises(ValueError):
            validate_plan(value, [3, 4, 5])


def test_only_selected_slides_reach_models_and_study_is_generated_per_group(tmp_path):
    deck = tmp_path / "deck.pdf"
    with pymupdf.open() as pdf:
        for page in range(1, 9):
            pdf.new_page().insert_text((30, 30), f"{'SELECTED' if 3 <= page <= 6 else 'EXCLUDED'} page {page}")
        pdf.save(deck)
    store = FakeStore(deck)
    store.rec.update(slideRange="3-6", customPrompt="1–8페이지를 자세히 설명")  # Explicit field takes precedence.
    transcript = copy.deepcopy(store.values["transcript"])
    store.values[store.prefix + "cache/v2/alignment-0.json"] = {"assignments": [{
        "page": 3, "startSegmentId": "seg-1", "endSegmentId": "seg-1", "confidence": 0.9, "reason": "Specific derivative"}]}
    class Model(FakeModel):
        def generate(self, schema, task, data, **kwargs):
            assert "EXCLUDED" not in json.dumps(data)
            if schema is DeckPlan:
                pages = data["selectedPages"]
                value = DeckPlan(groups=[{"title": f"Topic {i}", "pages": pages[i:i + 2], "depth": "standard"}
                                        for i in range(0, len(pages), 2)])
                kwargs["validate"](value)
                self.calls.append(schema)
                return value
            if schema is Alignment:
                pytest.fail("Validated old slide links should be reused")
            if schema is Study:
                assert len(kwargs["images"]) == 2
            return super().generate(schema, task, data, **kwargs)
    model, search = Model(), FakeSearch()
    search.fail_second = False
    work = tmp_path / "work"; work.mkdir()
    result = analyze(store, work, lambda: None, model=model, search=search)
    doc = store.values[store.prefix + "runs/run-1/document.json"]
    assert doc["selectedPages"] == [3, 4, 5, 6] and doc["originalPageCount"] == 8
    assert [p["sourcePages"] for p in doc["pages"]] == [[3, 4], [5, 6]]
    assert model.calls.count(SlideReading) == 4 and model.calls.count(Study) == 2
    assert sorted(p.name for p in (work / "rendered").glob("*.png")) == ["3.png", "4.png", "5.png", "6.png"]
    assert {i["sourcePage"] for i in result["studyImages"]} == {3, 4, 5, 6}
    assert all(i["key"].startswith(store.prefix + "runs/run-1/") for i in result["studyImages"])
    assert "분석 범위: 3–6페이지" in store.files["runs/run-1/study.md"].decode()
    assert store.values["transcript"] == transcript
    calls = len(model.calls)
    analyze(store, work, lambda: None, model=model, search=search)
    assert len(model.calls) == calls
    store.rec["slideRange"] = "5-6"
    analyze(store, work, lambda: None, model=model, search=search)
    assert store.values[store.prefix + "runs/run-1/document.json"]["selectedPages"] == [5, 6]
    assert model.calls.count(SlideReading) == 4  # Reuse readings, but not the old whole-deck study.
    assert model.calls.count(Study) == 3
