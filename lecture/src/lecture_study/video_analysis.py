"""Visual interpretation and slide matching grounded in actual MP4 frame times."""
import json
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from .outline import build_outline, topic_pages
from .parallel import parallel_map
from .prompts import STUDY_CACHE_VERSION, VIDEO_STUDY_TASK
from .schemas import SlideReading, Study, VideoMatch, VideoObservation


def fingerprint(path: Path):
    with Image.open(path) as image:
        return np.asarray(ImageOps.fit(image.convert("L"), (64, 36)), dtype=np.float32) / 255


def candidates_for(observation: dict, frame, readings: list[dict], fingerprints: list) -> list[int]:
    def terms(text):
        text = re.sub(r"\W+", "", text.lower())
        return {text[i:i + 2] for i in range(len(text) - 1)}
    query = terms(observation["title"] + " ".join(observation["concepts"]))
    def score(i):
        target = terms(readings[i]["title"] + " ".join(readings[i]["concepts"]))
        overlap = len(query & target) / max(1, len(query | target))
        distance = float(np.abs(frame - fingerprints[i]).mean())
        return overlap * 2 - distance
    return sorted(range(len(readings)), key=score, reverse=True)[:4]


def validate_match(match: VideoMatch, candidate_pages: list[int]):
    if match.deckPage is not None and match.deckPage not in candidate_pages:
        raise ValueError("Video match references a slide that was not visually compared")


def evidence_for_ranges(segments: list[dict], ranges: list[dict]) -> list[dict]:
    # Preserve original STT IDs, text and timestamps. A sentence crossing a
    # screen transition can legitimately appear in both neighboring sections.
    return [{"segmentId": s["id"], "start": s["start"], "end": s["end"], "text": s["text"], "speaker": s.get("speaker", "S1")} for s in segments if any(s["end"] > r["startSec"] and s["start"] < r["endSec"] for r in ranges)]


@contextmanager
def scene_images(store, scene: dict, workdir: Path):
    with tempfile.TemporaryDirectory(dir=workdir, prefix="frames-") as directory:
        images = []
        for i, key in enumerate(scene["imageKeys"]):
            if not key.startswith(store.prefix + "video/frames/"):
                raise ValueError("Invalid video frame key")
            path = Path(directory) / f"{i}.jpg"
            store.s3.download_file(store.bucket, key, str(path))
            images.append(path)
        yield images


@contextmanager
def scene_first_frames(store, scenes: list[dict], workdir: Path):
    """The first frame of each given scene, downloaded into one temporary directory."""
    with tempfile.TemporaryDirectory(dir=workdir, prefix="frames-") as directory:
        images = []
        for i, scene in enumerate(scenes):
            key = scene["imageKeys"][0]
            if not key.startswith(store.prefix + "video/frames/"):
                raise ValueError("Invalid video frame key")
            path = Path(directory) / f"{i}.jpg"
            store.s3.download_file(store.bucket, key, str(path))
            images.append(path)
        yield images


def spaced(items: list, limit: int) -> list:
    """Up to `limit` items spread evenly over the list, always keeping the first."""
    if len(items) <= limit:
        return list(items)
    step = len(items) / limit
    return [items[int(i * step)] for i in range(limit)]


def topic_reading(topic: dict, observations: list[dict]) -> dict:
    """A reading of a topic page assembled from its scene observations: the outline summary plus a spread of scenes."""
    selected = [observations[j] for j in topic["sceneIndices"]]
    concepts = list(dict.fromkeys(c for o in selected for c in o["concepts"]))[:20]
    kinds = [o["visualType"] for o in selected]
    description = topic["summary"] + "\n" + "\n".join(f"- {o['title']}: {o['description'][:300]}" for o in spaced(selected, 8))
    return {"title": topic["title"], "description": description[:2400], "concepts": concepts, "visualType": max(set(kinds), key=kinds.count)}


def make_study(model, language, reading, evidence, visual_notes, pictures, matched=True, audience=None):
    task = VIDEO_STUDY_TASK
    groups, current, size = [], [], 0
    for item in evidence:
        length = len(json.dumps(item, ensure_ascii=False))
        if length > 30000:
            raise ValueError("A speech segment exceeds the study context limit")
        if current and size + length > 30000:
            groups.append(current); current, size = [], 0
        current.append(item); size += length
    groups.append(current)
    base = {"outputLanguage": language, "audience": audience, "reading": reading, "videoMatched": matched, "visualObservations": [n[:600] for n in visual_notes]}
    if len(groups) == 1:
        return model.generate(Study, task, {**base, "recordedSpeech": groups[0]}, images=pictures).model_dump()
    # Long revisits to one attached slide are summarized in bounded speech
    # windows, then consolidated; speech is never silently cut to fit a prompt.
    parts = [model.generate(Study, task, {**base, "recordedSpeech": group}, images=pictures).model_dump() for group in groups]
    while len(parts) > 1:
        parts = [model.generate(Study, task + " Consolidate these study notes without adding lecture claims.", {"outputLanguage": language, "audience": audience, "notes": parts[i:i + 4]}).model_dump() for i in range(0, len(parts), 4)]
    return parts[0]


def analyze_video(store, workdir, check, model, search, render):
    from .pipeline import finish_lecture, learner_profile
    record = store.record()
    manifest = store.read(record["videoManifestKey"])
    transcript = store.read(record["transcriptKey"])
    if not manifest or not transcript:
        raise ValueError("Prepared video or transcript is missing")
    scenes = manifest["scenes"]
    language = record["outputLanguage"] if record["outputLanguage"] != "auto" else transcript.get("language") or "ko"
    deck, readings = [], []
    if record["assets"].get("slides"):
        asset = record["assets"]["slides"]
        source = workdir / ("slides.pdf" if asset["contentType"] == "application/pdf" else "slides.pptx")
        store.s3.download_file(store.bucket, asset["key"], str(source))
        deck = render(source, workdir / "deck")
        def read_slide(slide):
            reading = store.cached(f"deck-{slide['page']}.json", lambda slide=slide: model.generate(SlideReading, "Read this attached slide and author notes accurately in the output language. Describe diagrams and equations. Author notes are not recorded speech; do not infer that the slide was shown in the video.", {"outputLanguage": language, "text": slide["text"], "notes": slide["speakerNotes"]}, image=slide["image"]).model_dump())
            return SlideReading.model_validate(reading).model_dump()
        readings = parallel_map(deck, read_slide, check=check, on_done=lambda n: store.progress("slides", n, len(deck) + len(scenes)))
    def observe_scene(item):
        i, scene = item
        def observe(scene=scene):
            with scene_images(store, scene, workdir) as images:
                value = model.generate(VideoObservation,
                    "Analyze these ACTUAL VIDEO FRAMES in chronological order. Describe the displayed slide, handwritten derivation, code demonstration or other visual teaching content and changes BETWEEN the frames. Do not invent unseen motion or intermediate steps. Classify the visual type; if the scene only shows a speaker say so. Slide matching is a separate step. Use the output language.",
                    {"outputLanguage": language, "startSec": scene["startSec"], "endSec": scene["endSec"], "frameTimes": scene["frameTimes"]}, images=images)
                return value.model_dump()
        return VideoObservation.model_validate(store.cached(f"scene-{i}.json", observe)).model_dump()
    observations = parallel_map(enumerate(scenes), observe_scene, check=check, on_done=lambda n: store.progress("slides", len(deck) + n, len(deck) + len(scenes)))
    audience = learner_profile(store, model, language, record, readings + observations, transcript["segments"])
    fingerprints = [fingerprint(slide["image"]) for slide in deck]
    def match_scene(item):
        i, scene = item
        def match(scene=scene, observation=observations[i]):
            if not deck or observation["visualType"] not in ("slide", "whiteboard"):
                return {"deckPage": None, "confidence": 0, "reason": "영상의 별도 학습 구간"}
            with scene_images(store, scene, workdir) as images:
                indices = candidates_for(observation, fingerprint(images[0]), readings, fingerprints)
                pages = [deck[j]["page"] for j in indices]
                return model.generate(VideoMatch,
                    "Compare the actual video frames against the candidate deck images. The first images are chronological VIDEO frames; following images are DECK candidates in the given order. Match a deckPage only when it is visibly the SAME slide across the video frames (annotations and a small webcam overlay are allowed). A topical similarity is not enough. If the frames show different slides, a different example, unreadable content, or no candidate matches, return null. Give a conservative confidence and reason in the output language.",
                    {"outputLanguage": language, "videoImageCount": len(images), "observation": observation, "candidates": [{"page": deck[j]["page"], "title": readings[j]["title"]} for j in indices]},
                    images=images + [deck[j]["image"] for j in indices], validate=lambda value: validate_match(value, pages)).model_dump()
        return VideoMatch.model_validate(store.cached(f"match-{i}.json", match))
    matches = parallel_map(enumerate(scenes), match_scene, check=check, on_done=lambda n: store.progress("alignment", n, len(scenes)))
    # Every attached page remains available; scenes that cannot be reliably
    # matched are separate video sections, so board work/demos are not discarded.
    entries = [{"deckIndex": i, "sceneIndices": [j for j, match in enumerate(matches) if match.deckPage == slide["page"] and match.confidence >= 0.85]} for i, slide in enumerate(deck)]
    assigned = {j for entry in entries for j in entry["sceneIndices"]}
    unassigned = {i for i in range(len(scenes)) if i not in assigned}
    if unassigned:
        # Video sections become topic pages of a few minutes each, cut along the speech rather than at every screen change.
        outline = build_outline(store, model, language, transcript["segments"], scenes, observations, manifest["durationSec"])
        entries += [{"deckIndex": None, "sceneIndices": topic["sceneIndices"], "topic": topic} for topic in topic_pages(outline, scenes, unassigned)]

    def build_page(item):
        i, entry = item
        selected = entry["sceneIndices"]
        deck_index = entry["deckIndex"]
        ranges = [{"startSec": scenes[j]["startSec"], "endSec": scenes[j]["endSec"], "frameSec": scenes[j]["frameTimes"][0]} for j in selected]
        evidence = evidence_for_ranges(transcript["segments"], ranges)
        reading = readings[deck_index] if deck_index is not None else topic_reading(entry["topic"], observations)
        def study_and_image():
            if deck_index is not None:
                pictures = [deck[deck_index]["image"]]
                study = store.cached(f"page-study-{i}.{STUDY_CACHE_VERSION}.json", lambda: make_study(model, language, reading, evidence, [observations[j]["description"] for j in selected], pictures, bool(selected), audience))
                image_bytes = pictures[0].read_bytes()
            else:
                notes = [observations[j]["description"] for j in spaced(selected, 12)]
                with scene_first_frames(store, [scenes[j] for j in spaced(selected, 6)], workdir) as pictures:
                    study = store.cached(f"topic-study-{i}.v1.json", lambda: make_study(model, language, reading, evidence, notes, pictures, True, audience))
                    # Keep the existing PNG preview/download contract.
                    import io
                    output = io.BytesIO()
                    with Image.open(pictures[0]) as image:
                        image.save(output, format="PNG")
                    image_bytes = output.getvalue()
            store.put(f"slides/{i + 1}.png", image_bytes, "image/png")
            return Study.model_validate(study).model_dump()
        study = study_and_image()
        if not evidence:
            study["spokenSummary"] = ""
        confidence = min((matches[j].confidence for j in selected), default=0) if deck_index is not None else 1
        alignment = {"status": "matched" if selected else "unmatched", "confidence": confidence, "method": "visual_match" if deck_index is not None else "video_time", "reason": " / ".join(matches[j].reason for j in selected)[:1800] if deck_index is not None else "영상 구간과 같은 시간대의 발언"}
        return {"page": i + 1, "title": reading["title"], "source": "deck" if deck_index is not None else "video", **({"deckPage": deck[deck_index]["page"]} if deck_index is not None else {"chapter": entry["topic"]["chapter"]}), "visualType": (observations[selected[0]]["visualType"] if selected else "slide") if deck_index is not None else reading["visualType"], "videoRanges": ranges, "slideText": deck[deck_index]["text"] if deck_index is not None else reading["description"], "imageKey": store.prefix + f"slides/{i + 1}.png", "alignment": alignment, "evidence": evidence, "outputLanguage": language, **study}
    pages = parallel_map(enumerate(entries), build_page, check=check, on_done=lambda n: store.progress("study", n, len(entries)))
    store.update(pageCount=len(pages))
    return finish_lecture(store, model, search, check, record, language, pages, manifest["durationSec"], {"sampleIntervalSec": manifest["sampleIntervalSec"], "sceneCount": len(scenes), "sampledFrames": manifest["sampledFrames"], "groupedScenes": manifest["groupedScenes"], "hasAudio": manifest["hasAudio"]}, audience=audience)
