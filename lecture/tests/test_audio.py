import copy
import json

import pytest

from lecture_study.pipeline import analyze
from lecture_study.schemas import Study, VideoOutline
from lecture_study.video import prepare_video, probe_audio, run_media
from test_pipeline import FakeModel, FakeSearch, FakeStore


@pytest.mark.media
def test_real_mp3_prepare_validates_audio_and_preserves_source_key(tmp_path):
    source = tmp_path / "lecture.mp3"
    run_media(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", str(source)])
    store = FakeStore(None)
    store.rec["assets"] = {"audio": {"key": "lecture-uploads/test/audio.mp3"}}
    store.generate_presigned_url = lambda *a, **kw: str(source)
    result = prepare_video(store, tmp_path, lambda: None)
    assert result["preparedAudioKey"] == "lecture-uploads/test/audio.mp3"
    assert result["hasAudio"] and 2 <= result["durationSec"] < 2.2
    assert not store.files  # No visual frames or transcoded copy for MP3.


@pytest.mark.media
def test_renamed_wav_is_not_accepted_as_mp3(tmp_path):
    source = tmp_path / "fake.mp3"
    run_media(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", "-f", "wav", str(source)])
    with pytest.raises(ValueError, match="MP3"):
        probe_audio(str(source))


@pytest.mark.parametrize("duration", [0, -1, 14401, "nan", "inf"])
def test_audio_duration_limits(monkeypatch, duration):
    monkeypatch.setattr("lecture_study.video.run_media", lambda *a: json.dumps({"format": {"format_name": "mp3", "duration": duration}, "streams": [{"codec_type": "audio", "codec_name": "mp3"}]}).encode())
    with pytest.raises(ValueError, match="4시간"):
        probe_audio("unused")


@pytest.mark.parametrize("rounding_gap", [False, True])
def test_audio_topics_keep_all_speech_and_reuse_cached_study(tmp_path, rounding_gap):
    store = FakeStore(None)
    store.rec["assets"] = {"audio": {"key": "audio.mp3", "fileName": "class.mp3"}}
    store.values["transcript"]["durationSec"] = 90
    store.values["transcript"]["segments"] = [
        {"id": "s1", "start": 1, "end": 4, "speaker": "S1", "text": "First explanation"},
        {"id": "s2", "start": 39, "end": 42, "speaker": "S1", "text": "Crosses the topic boundary"},
        {"id": "gap", "start": 40.2, "end": 40.8, "speaker": "S1", "text": "Short interjection"},
        {"id": "s3", "start": 50, "end": 55, "speaker": "S1", "text": "Last explanation"},
    ]
    class Model(FakeModel):
        def generate(self, schema, task, data, **kwargs):
            if schema == VideoOutline:
                assert data["visualSections"] == []
                return VideoOutline.model_validate({"chapters": [{"title": "Course", "topics": [
                    {"title": "First", "summary": "First concept", "startSec": 0, "endSec": 40},
                    {"title": "Second", "summary": "Second concept", "startSec": 41 if rounding_gap else 40, "endSec": 90},
                ]}]})
            if schema == Study:
                assert not kwargs.get("images")
                assert "Audio-only" in task
            return super().generate(schema, task, data, **kwargs)
    model, search = Model(), FakeSearch()
    analyze(store, tmp_path, lambda: None, model=model, search=search)
    doc = store.values[store.prefix + "runs/run-1/document.json"]
    assert [p["source"] for p in doc["pages"]] == ["audio", "audio"]
    assert [[e["segmentId"] for e in p["evidence"]] for p in doc["pages"]] == [["s1", "s2"], ["s2", "gap", "s3"]]
    assert all(p["sourceFile"] == "class.mp3" and not p["imageKey"] for p in doc["pages"])
    assert "음성 주제 요약" in store.files["runs/run-1/study.md"].decode()
    assert "영상 구간" not in store.files["runs/run-1/study.md"].decode()
    previous = copy.copy(model.calls)
    analyze(store, tmp_path, lambda: None, model=model, search=search)
    assert model.calls == previous


def test_audio_with_no_speech_fails_instead_of_inventing_notes(tmp_path):
    store = FakeStore(None)
    store.rec["assets"] = {"audio": {"key": "a.mp3"}}
    store.values["transcript"]["segments"] = []
    model = FakeModel()
    with pytest.raises(ValueError, match="발언"):
        analyze(store, tmp_path, lambda: None, model=model, search=FakeSearch())
    assert not model.calls
