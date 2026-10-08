"""Transcript-only lecture topics, preserving original speech and timestamps."""
from .outline import build_outline
from .parallel import parallel_map
from .prompts import AUDIO_STUDY_TASK, STUDY_CACHE_VERSION
from .schemas import Study
from .study import generate_study
from .customization import request_cache_key, request_context


def analyze_audio(store, check, model, search, record, transcript):
    from .pipeline import finish_lecture, learner_profile
    segments = transcript["segments"]
    if not segments:
        raise ValueError("강의 녹음에서 발언을 찾지 못했습니다.")
    language = record["outputLanguage"] if record["outputLanguage"] != "auto" else transcript.get("language") or "ko"
    store.progress("alignment", 0, 1)
    outline = build_outline(store, model, language, segments, [], [], transcript["durationSec"])
    topics = [{"chapter": chapter["title"], **topic} for chapter in outline["chapters"] for topic in chapter["topics"]]
    if len(topics) > 360:
        raise ValueError("학습 구간이 너무 많습니다. 강의를 나누어 업로드하세요.")
    # Outline validation permits small rounding gaps. Close those gaps so no
    # short utterance disappears between two audio topics.
    previous_end = 0
    for i, topic in enumerate(topics):
        topic["startSec"] = previous_end
        topic["endSec"] = transcript["durationSec"] if i == len(topics) - 1 else min(topic["endSec"], transcript["durationSec"])
        previous_end = topic["endSec"]
    store.progress("alignment", 1, 1)
    audience = learner_profile(store, model, language, record, [{"title": topic["title"], "concepts": []} for topic in topics], segments)

    def build_page(item):
        i, topic = item
        evidence = [{"segmentId": s["id"], "start": s["start"], "end": s["end"], "text": s["text"], "speaker": s.get("speaker", "S1")}
                    for s in segments if s["end"] > topic["startSec"] and s["start"] < topic["endSec"]]
        reading = {"title": topic["title"], "description": topic["summary"], "concepts": []}
        study = Study.model_validate(store.cached(request_cache_key(f"audio-study-{i}.{STUDY_CACHE_VERSION}.json", record),
            lambda: generate_study(model, AUDIO_STUDY_TASK, {"outputLanguage": language, "audience": audience, "reading": reading,
                **request_context(record, sourceType="audio", startSec=topic["startSec"], endSec=topic["endSec"])}, evidence))).model_dump()
        if not evidence:
            study["spokenSummary"] = ""
        return {"page": i + 1, "title": topic["title"], "chapter": topic["chapter"], "source": "audio",
                "sourceFile": record["assets"].get("audio", {}).get("fileName", ""), "slideText": "", "imageKey": "",
                "audioRanges": [{"startSec": topic["startSec"], "endSec": topic["endSec"]}],
                "alignment": {"status": "matched" if evidence else "unmatched", "confidence": 1 if evidence else 0, "method": "audio_time", "reason": "음성 구간과 같은 시간대의 발언"},
                "evidence": evidence, "outputLanguage": language, **study}
    pages = parallel_map(enumerate(topics), build_page, check=check, on_done=lambda n: store.progress("study", n, len(topics)))
    store.update(pageCount=len(pages))
    return finish_lecture(store, model, search, check, record, language, pages, transcript["durationSec"], audience=audience)
