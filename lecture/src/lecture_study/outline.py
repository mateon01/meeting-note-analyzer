"""Topic outline for video sections: speech with timestamps and the visual section titles are cut into chapters and
2-6 minute topics, and each unmatched video scene joins the topic that contains its midpoint."""
from .schemas import VideoOutline

MIN_TOPIC_SEC = 30
WINDOW_SEC = 2700
OUTLINE_TASK = """Outline this window of a recorded lecture into chapters and topics using the timestamped speech and the list of visual sections. Chapters are the lecture's major parts (about 3-8 per hour). Topics are coherent stretches of roughly 2-6 minutes in which one idea, example, derivation or demonstration is developed; do not cut at every slide change. Topics must be in chronological order, contiguous (each starts where the previous ends) and together cover the whole window from windowStart to windowEnd. Take times from the speech and the visual sections; never invent them. Titles name the specific content taught; summary is one or two sentences grounded in the speech. Write titles and summaries in the output language."""


def validate_outline(outline: VideoOutline, start: float, end: float) -> None:
    topics = [t for c in outline.chapters for t in c.topics]
    if not topics:
        raise ValueError("The outline needs at least one topic")
    previous = None
    for topic in topics:
        if topic.endSec <= topic.startSec or (previous is not None and topic.startSec < previous - 1):
            raise ValueError("Topics must be in chronological order without overlap")
        if previous is not None and topic.startSec - previous > 2:
            raise ValueError("Topics must cover the window without gaps")
        if topic.endSec - topic.startSec < MIN_TOPIC_SEC and len(topics) > 1:
            raise ValueError(f"Topic '{topic.title}' is too short; merge stretches under {MIN_TOPIC_SEC}s into a neighbour")
        previous = topic.endSec
    if abs(topics[0].startSec - start) > 2 or abs(topics[-1].endSec - end) > 2:
        raise ValueError(f"Topics must cover the whole window from {start:.0f}s to {end:.0f}s")


def transcript_windows(duration: float, window_sec: int = WINDOW_SEC) -> list[tuple[int, int]]:
    """Balanced windows no longer than window_sec, so a long recording never ends with a tiny tail window."""
    count = max(1, -(-int(duration) // window_sec))
    bounds = [round(i * duration / count) for i in range(count + 1)]
    return list(zip(bounds, bounds[1:]))


def build_outline(store, model, language: str, segments: list[dict], scenes: list[dict], observations: list[dict], duration: float) -> dict:
    def build():
        chapters = []
        for start, end in transcript_windows(duration):
            speech = [{"start": round(s["start"], 1), "end": round(s["end"], 1), "text": s["text"][:400]} for s in segments if s["end"] > start and s["start"] < end]
            visual = [{"startSec": scene["startSec"], "endSec": scene["endSec"], "title": observation["title"], "visualType": observation["visualType"]}
                      for scene, observation in zip(scenes, observations) if scene["endSec"] > start and scene["startSec"] < end]
            value = model.generate(VideoOutline, OUTLINE_TASK, {"outputLanguage": language, "windowStart": start, "windowEnd": end, "visualSections": visual, "speech": speech},
                                   validate=lambda outline, s=start, e=end: validate_outline(outline, s, e))
            chapters.extend(value.model_dump()["chapters"])
        return {"chapters": chapters}
    return store.cached("outline.v1.json", build)


def topic_pages(outline: dict, scenes: list[dict], unassigned: set[int]) -> list[dict]:
    """One entry per topic that owns at least one unassigned scene; a scene belongs to the topic containing its midpoint,
    and scenes past the last topic end join the last topic so no video time is dropped."""
    topics = [{"chapter": chapter["title"], "title": topic["title"], "summary": topic["summary"], "startSec": topic["startSec"], "endSec": topic["endSec"], "sceneIndices": []}
              for chapter in outline["chapters"] for topic in chapter["topics"]]
    if not topics:
        return []
    for i in sorted(unassigned):
        midpoint = (scenes[i]["startSec"] + scenes[i]["endSec"]) / 2
        next((t for t in topics if midpoint < t["endSec"]), topics[-1])["sceneIndices"].append(i)
    return [t for t in topics if t["sceneIndices"]]
