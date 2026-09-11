import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from lecture_study.schemas import VideoMatch
from lecture_study.video import choose_scenes, extract_audio, probe_video, run_media, scan_video
from lecture_study.video_analysis import evidence_for_ranges, validate_match

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
media_test = pytest.mark.skipif(not HAS_FFMPEG, reason="FFmpeg integration tests run in the lecture container")


def make_video(destination: Path, colors=("white", "navy", "white"), audio=True, offset=0, scene_seconds=4):
    command = ["ffmpeg", "-y", "-v", "error"]
    for color in colors:
        command += ["-f", "lavfi", "-i", f"color=c={color}:s=640x360:r=10:d={scene_seconds}"]
    if audio:
        if offset:
            command += ["-itsoffset", str(offset)]
        command += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={len(colors) * scene_seconds - offset}"]
    command += ["-filter_complex", "".join(f"[{i}:v]" for i in range(len(colors))) + f"concat=n={len(colors)}:v=1:a=0[v]", "-map", "[v]"]
    if audio:
        command += ["-map", f"{len(colors)}:a", "-c:a", "aac"]
    command += ["-c:v", "libx264", "-pix_fmt", "yuv420p", str(destination)]
    run_media(command)


@media_test
def test_real_mp4_scene_boundaries_and_revisits(tmp_path):
    source = tmp_path / "lecture.mp4"; make_video(source)
    info = probe_video(str(source))
    manifest = scan_video(str(source), tmp_path, info["durationSec"])
    assert info["hasAudio"] is True
    assert [(s["startSec"], s["endSec"]) for s in manifest["scenes"]] == [(0, 4), (4, 8), (8, 12)]
    assert manifest["sampledFrames"] == 6
    assert manifest["groupedScenes"] is False


@media_test
def test_delayed_audio_keeps_the_original_video_timeline(tmp_path):
    source = tmp_path / "delayed.mp4"; make_video(source, colors=("white", "navy"), offset=2)
    output = tmp_path / "audio.mp3"
    extract_audio(str(source), output, 8)
    pcm = run_media(["ffmpeg", "-v", "error", "-i", str(output), "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"])
    samples = np.frombuffer(pcm, dtype=np.float32)
    assert abs(len(samples) / 16000 - 8) < 0.1
    assert np.max(np.abs(samples[:int(1.8 * 16000)])) < 0.01
    assert np.max(np.abs(samples[int(2.2 * 16000):int(3 * 16000)])) > 0.05


@media_test
def test_silent_mp4_is_a_valid_visual_lecture(tmp_path):
    source = tmp_path / "silent.mp4"; make_video(source, audio=False)
    assert probe_video(str(source))["hasAudio"] is False
    assert len(scan_video(str(source), tmp_path, 12)["scenes"]) == 3


def test_scene_limits_preserve_whole_timeline_and_expose_grouping():
    scenes, grouped = choose_scenes([(i * 2, 0.1) for i in range(1, 1000)], 2000, max_scenes=20)
    assert grouped and len(scenes) == 20
    assert scenes[0]["startSec"] == 0 and scenes[-1]["endSec"] == 2000
    assert all(a["endSec"] == b["startSec"] for a, b in zip(scenes, scenes[1:]))


def test_timestamp_evidence_includes_revisits_but_excludes_other_sections():
    segments = [{"id": f"seg-{i}", "start": i, "end": i + 0.8, "text": f"speech {i}"} for i in range(12)]
    evidence = evidence_for_ranges(segments, [{"startSec": 0, "endSec": 4}, {"startSec": 8, "endSec": 12}])
    assert [s["segmentId"] for s in evidence] == [f"seg-{i}" for i in [0, 1, 2, 3, 8, 9, 10, 11]]
    with pytest.raises(ValueError):
        validate_match(VideoMatch(deckPage=3, confidence=0.99, reason="Invented mapping"), [1, 2])


def test_media_errors_never_expose_signed_urls(monkeypatch):
    class Process:
        returncode = 1
        def poll(self): return 1
        def wait(self, **kwargs): return 1
    monkeypatch.setattr("lecture_study.video.subprocess.Popen", lambda *args, **kwargs: Process())
    with pytest.raises(ValueError) as error:
        run_media(["ffmpeg", "-i", "https://private.s3.amazonaws.com/video?X-Amz-Security-Token=secret"])
    assert "secret" not in str(error.value)
    assert "https" not in str(error.value)
