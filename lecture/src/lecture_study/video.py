"""Bounded MP4 decoding, timestamped visual samples, and audio on the video timeline.

The runtime streams S3 through short-lived presigned URLs; it never downloads a
multi-gigabyte video into its scratch filesystem. Only small fingerprints are
kept while scanning. Representative frames are uploaded as they are extracted.
"""
import json
import math
import os
import re
import selectors
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np

SAMPLE_SECONDS = 2
MAX_DURATION = 4 * 3600
MAX_SCENES = 240
FRAME_WIDTH, FRAME_HEIGHT = 160, 90


def _stop(process):
    if process.poll() is None:
        process.kill()
    process.wait(timeout=10)


def run_media(command: list[str], check=lambda: None, timeout: int = 180) -> bytes:
    """Never put a presigned URL or a complete command into exception/log output."""
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        process = subprocess.Popen(command, stdout=out, stderr=err)
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                check()
                if time.monotonic() >= deadline:
                    raise ValueError("강의 파일 처리 시간이 초과되었습니다. 파일을 나누어 업로드하세요.")
                time.sleep(0.2)
            if process.returncode:
                raise ValueError("강의 파일을 읽지 못했습니다. MP4/MP3 파일과 코덱을 확인하세요.")
            out.seek(0)
            return out.read(1024 * 1024)
        finally:
            _stop(process)


def input_args(source: str) -> list[str]:
    return ["-rw_timeout", "30000000", "-i", source] if source.startswith("https://") else ["-i", source]


def probe_video(source: str, check=lambda: None) -> dict:
    raw = run_media(["ffprobe", "-v", "error", *input_args(source), "-show_format", "-show_streams", "-of", "json"], check, 90)
    info = json.loads(raw)
    videos = [s for s in info.get("streams", []) if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")]
    audios = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    duration = float(info.get("format", {}).get("duration", 0))
    if not videos or "mp4" not in info.get("format", {}).get("format_name", "").split(","):
        raise ValueError("재생 가능한 MP4 영상 트랙이 필요합니다.")
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError("강의 영상 길이는 4시간 이하여야 합니다.")
    if videos[0].get("width", 0) * videos[0].get("height", 0) > 3840 * 2160:
        raise ValueError("4K 이하 해상도의 영상을 업로드하세요.")
    return {"durationSec": duration, "hasAudio": bool(audios), "videoCodec": videos[0].get("codec_name"), "width": videos[0].get("width"), "height": videos[0].get("height")}


def probe_audio(source: str, check=lambda: None) -> dict:
    info = json.loads(run_media(["ffprobe", "-v", "error", *input_args(source), "-show_format", "-show_streams", "-of", "json"], check, 90))
    audios = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    if "mp3" not in info.get("format", {}).get("format_name", "").split(",") or not audios or audios[0].get("codec_name") != "mp3":
        raise ValueError("재생 가능한 MP3 음성 파일이 필요합니다.")
    duration = float(info.get("format", {}).get("duration", 0))
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError("강의 음성 길이는 4시간 이하여야 합니다.")
    return {"durationSec": duration, "hasAudio": True}


def extract_audio(source: str, destination: Path, duration: float, check=lambda: None):
    # first_pts=0 inserts silence for a delayed audio track. apad preserves the
    # complete video timeline, so STT timestamps can seek the original MP4.
    run_media(["ffmpeg", "-nostdin", "-y", "-v", "error", "-threads", "2", *input_args(source), "-map", "0:a:0", "-vn",
        "-af", "aresample=16000:async=1:first_pts=0,apad", "-ac", "1", "-ar", "16000", "-t", str(duration), "-c:a", "libmp3lame", "-b:a", "64k", str(destination)], check, 1800)


def change_score(previous: bytes, current: bytes) -> float:
    a = np.frombuffer(previous, dtype=np.uint8).reshape(FRAME_HEIGHT, FRAME_WIDTH).astype(np.int16)
    b = np.frombuffer(current, dtype=np.uint8).reshape(FRAME_HEIGHT, FRAME_WIDTH).astype(np.int16)
    changed = np.abs(a - b) > 20
    # Screen borders and a small bottom-right webcam overlay should not split
    # every slide whenever the presenter moves or the pointer blinks.
    changed[-FRAME_HEIGHT // 4:, -FRAME_WIDTH // 4:] = False
    return float(changed[3:-3, 3:-3].mean())


def choose_scenes(candidates: list[tuple[float, float]], duration: float, max_scenes: int = MAX_SCENES) -> tuple[list[dict], bool]:
    candidates = [(t, score) for t, score in candidates if 0 < t < duration]
    grouped = len(candidates) + 1 > max_scenes
    if grouped:
        # Keep coverage across the entire recording, then keep the strongest
        # remaining changes. Coalescing is explicit in the result, never hidden.
        anchors = {min(range(len(candidates)), key=lambda i: abs(candidates[i][0] - t)) for t in range(300, math.ceil(duration), 300)}
        keep = set(sorted(anchors)[:max_scenes - 1])
        for i in sorted(range(len(candidates)), key=lambda i: -candidates[i][1]):
            if len(keep) >= max_scenes - 1:
                break
            keep.add(i)
        candidates = [candidates[i] for i in sorted(keep)]
    boundaries = sorted({0.0, *[round(t, 3) for t, _ in candidates], duration})
    scenes = [{"scene": i + 1, "startSec": start, "endSec": end} for i, (start, end) in enumerate(zip(boundaries, boundaries[1:])) if end > start]
    return scenes, grouped


def scan_video(source: str, workdir: Path, duration: float, check=lambda: None) -> dict:
    log_path = workdir / "frame-times.log"
    frame_size = FRAME_WIDTH * FRAME_HEIGHT
    filters = f"fps=1/{SAMPLE_SECONDS},scale={FRAME_WIDTH}:{FRAME_HEIGHT}:force_original_aspect_ratio=decrease,pad={FRAME_WIDTH}:{FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2,showinfo"
    candidates, count, last_change = [], 0, 0
    reference = None
    with log_path.open("wb") as error_log:
        process = subprocess.Popen(["ffmpeg", "-nostdin", "-v", "info", "-threads", "2", *input_args(source), "-map", "0:v:0", "-an", "-filter_threads", "1", "-vf", filters, "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"], stdout=subprocess.PIPE, stderr=error_log)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline, buffer = time.monotonic() + 3600, bytearray()
        try:
            while True:
                check()
                if time.monotonic() > deadline or error_log.tell() > 16 * 1024 * 1024:
                    raise ValueError("영상 화면 분석 한도를 초과했습니다. 영상을 나누어 업로드하세요.")
                if not selector.select(timeout=1):
                    continue
                chunk = os.read(process.stdout.fileno(), frame_size * 8)
                if not chunk:
                    break
                buffer.extend(chunk)
                while len(buffer) >= frame_size:
                    frame = bytes(buffer[:frame_size]); del buffer[:frame_size]
                    score = change_score(reference, frame) if reference is not None else 0
                    if reference is None or score >= 0.018 or count - last_change >= 300 // SAMPLE_SECONDS:
                        if reference is not None:
                            candidates.append((count, score))
                        reference, last_change = frame, count
                    count += 1
                    if count > MAX_DURATION // SAMPLE_SECONDS + 4:
                        raise ValueError("영상 화면 수가 지원 한도를 초과했습니다.")
            process.wait(timeout=10)
            if process.returncode or buffer or not count:
                raise ValueError("영상 프레임을 읽지 못했습니다.")
        finally:
            selector.close()
            process.stdout.close()
            _stop(process)
    times = [float(t) for t in re.findall(r"\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:([-\d.eE+]+)", log_path.read_text(errors="replace"))]
    if len(times) != count or any(not math.isfinite(t) for t in times):
        raise ValueError("영상 프레임 시간 정보를 검증하지 못했습니다.")
    scenes, grouped = choose_scenes([(max(0, times[i]), score) for i, score in candidates], duration)
    log_path.unlink()
    return {"scenes": scenes, "sampleIntervalSec": SAMPLE_SECONDS, "sampledFrames": count, "groupedScenes": grouped}


def frame_times(scene: dict) -> list[float]:
    start, end = scene["startSec"], scene["endSec"]
    length = end - start
    return sorted({round(max(start, min(end - min(0.05, length / 10), start + offset)), 3) for offset in (min(1, length / 4), length / 2, max(0, length - min(1, length / 4)))})


def extract_frame(source: str, at: float, destination: Path, check=lambda: None):
    run_media(["ffmpeg", "-nostdin", "-y", "-v", "error", "-threads", "2", "-ss", str(max(0, at)), *input_args(source), "-map", "0:v:0", "-an", "-frames:v", "1", "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease", "-q:v", "4", str(destination)], check, 120)
    if not destination.exists() or destination.stat().st_size == 0:
        raise ValueError("영상 대표 화면을 추출하지 못했습니다.")


def prepare_video(store, workdir: Path, check):
    record = store.record()
    asset = record["assets"].get("video")
    if not asset:
        audio = record["assets"].get("audio")
        if not audio:
            raise ValueError("강의 영상 또는 음성이 없습니다.")
        source = store.s3.generate_presigned_url("get_object", Params={"Bucket": store.bucket, "Key": audio["key"]}, ExpiresIn=300)
        return {"preparedAudioKey": audio["key"], **probe_audio(source, check)}
    manifest_key = store.prefix + "video/manifest.json"
    existing = store.read(manifest_key)
    if existing and existing.get("sourceEtag") == asset.get("etag"):
        required = {key for scene in existing["scenes"] for key in scene["imageKeys"]}
        if existing.get("audioKey"):
            required.add(existing["audioKey"])
        present = set()
        for page in store.s3.get_paginator("list_objects_v2").paginate(Bucket=store.bucket, Prefix=store.prefix + "video/"):
            present.update(item["Key"] for item in page.get("Contents", []))
        if required <= present:
            return {"preparedAudioKey": existing.get("audioKey"), "hasAudio": existing["hasAudio"], "durationSec": existing["durationSec"], "videoManifestKey": manifest_key}
    started = time.monotonic()
    last_check = 0.0
    def bounded_check():
        nonlocal last_check
        if time.monotonic() - last_check >= 5:
            check()
            last_check = time.monotonic()
        if time.monotonic() - started > 6600:
            raise ValueError("영상 전처리 시간이 초과되었습니다. 영상을 나누어 업로드하세요.")
    # Every new command gets a fresh URL. No URL is persisted in the manifest.
    source = lambda: store.s3.generate_presigned_url("get_object", Params={"Bucket": store.bucket, "Key": asset["key"]}, ExpiresIn=7200)
    info = probe_video(source(), bounded_check)
    store.progress("video", 0, 1)
    audio_key = None
    if info["hasAudio"]:
        audio = workdir / "audio.mp3"
        extract_audio(source(), audio, info["durationSec"], bounded_check)
        audio_key = store.prefix + "video/audio.mp3"
        store.upload_file("video/audio.mp3", audio, "audio/mpeg")
        audio.unlink()
    manifest = {"version": 1, **info, **scan_video(source(), workdir, info["durationSec"], bounded_check), "sourceEtag": asset.get("etag"), "audioKey": audio_key}
    for i, scene in enumerate(manifest["scenes"]):
        scene["frameTimes"] = frame_times(scene)
        scene["imageKeys"] = []
        for j, timestamp in enumerate(scene["frameTimes"]):
            bounded_check()
            image = workdir / "frame.jpg"
            extract_frame(source(), timestamp, image, bounded_check)
            suffix = f"video/frames/{i + 1}-{j}.jpg"
            store.upload_file(suffix, image, "image/jpeg")
            image.unlink()
            scene["imageKeys"].append(store.prefix + suffix)
        store.progress("video", i + 1, len(manifest["scenes"]))
    store.save("video/manifest.json", manifest)
    return {"preparedAudioKey": audio_key, "hasAudio": info["hasAudio"], "durationSec": info["durationSec"], "videoManifestKey": manifest_key}
