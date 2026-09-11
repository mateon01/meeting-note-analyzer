import pytest

from lecture_study.outline import topic_pages, transcript_windows, validate_outline
from lecture_study.schemas import VideoOutline


def outline(*topics, chapter="Optimization"):
    return VideoOutline.model_validate({"chapters": [{"title": chapter, "topics": [{"title": t, "startSec": s, "endSec": e, "summary": "about " + t} for t, s, e in topics]}]})


def scenes(count, length=30):
    return [{"scene": i + 1, "startSec": i * length, "endSec": (i + 1) * length, "frameTimes": [i * length + 1], "imageKeys": [f"lecture-results/test/video/frames/{i}.jpg"]} for i in range(count)]


def test_outline_must_be_ordered_contiguous_and_inside_the_window():
    validate_outline(outline(("a", 0, 120), ("b", 120, 240)), 0, 240)
    with pytest.raises(ValueError, match="order"):
        validate_outline(outline(("a", 0, 120), ("b", 100, 240)), 0, 240)
    with pytest.raises(ValueError, match="cover"):
        validate_outline(outline(("a", 0, 120), ("b", 120, 200)), 0, 240)
    with pytest.raises(ValueError, match="cover"):
        validate_outline(outline(("a", 30, 240)), 0, 240)
    with pytest.raises(ValueError, match="short"):
        validate_outline(outline(("a", 0, 10), ("b", 10, 240)), 0, 240)


def test_scenes_are_grouped_into_topic_pages_by_their_midpoints():
    twelve = scenes(12)  # 0..360 s
    pages = topic_pages(outline(("intro", 0, 100), ("method", 100, 250), ("results", 250, 360)).model_dump(), twelve, set(range(12)))
    assert [p["title"] for p in pages] == ["intro", "method", "results"]
    assert [p["sceneIndices"] for p in pages] == [[0, 1, 2], [3, 4, 5, 6, 7], [8, 9, 10, 11]]  # scene 4 (90-120, mid 105) belongs to "method"
    assert pages[0]["chapter"] == "Optimization" and pages[1]["summary"] == "about method"


def test_topics_without_unassigned_scenes_are_dropped_and_edges_are_absorbed():
    twelve = scenes(12)
    pages = topic_pages(outline(("intro", 0, 100), ("slides", 100, 250), ("results", 250, 360)).model_dump(), twelve, {0, 1, 2, 9, 10, 11})
    assert [(p["title"], p["sceneIndices"]) for p in pages] == [("intro", [0, 1, 2]), ("results", [9, 10, 11])]
    # A scene outside every topic range still lands in the nearest edge topic instead of disappearing.
    late = scenes(13)
    pages = topic_pages(outline(("only", 0, 360)).model_dump(), late, set(range(13)))
    assert pages[0]["sceneIndices"] == list(range(13))


def test_long_transcripts_are_outlined_in_time_windows():
    assert transcript_windows(3000, window_sec=2700) == [(0, 1500), (1500, 3000)]  # balanced, not a 2700 + 300 tail
    assert transcript_windows(2700, window_sec=2700) == [(0, 2700)]
    assert transcript_windows(8000, window_sec=2700) == [(0, 2667), (2667, 5333), (5333, 8000)]
