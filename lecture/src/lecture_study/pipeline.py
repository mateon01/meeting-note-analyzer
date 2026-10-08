import logging
from pathlib import Path

from .customization import custom_prompt, request_cache_key, request_context, request_task
from .export import flashcard_csv, markdown
from .model import Model
from .parallel import parallel_map
from .prompts import AUDIENCE_TASK
from .schemas import Audience, Overview, Papers
from .search import GatewaySearch, selected_papers
from .slides import render_deck
from .store import now

log = logging.getLogger(__name__)


def learner_profile(store, model, language, record, sections, segments) -> dict:
    """One bounded call: who the lecture is for, inferred from the lecture itself (title, course, sections, opening minutes)."""
    opening = [{"start": s["start"], "text": s["text"][:600]} for s in segments if s["start"] < 600][:60]
    data = {"outputLanguage": language, "title": record["title"], "course": record.get("course", ""),
            "sections": [{"title": s["title"], "concepts": list(s["concepts"])[:8]} for s in sections[:120]], "openingSpeech": opening}
    return Audience.model_validate(store.cached("audience.json", lambda: model.generate(Audience, AUDIENCE_TASK, data).model_dump())).model_dump()



def research_page(model: Model, search: GatewaySearch, page: dict, max_queries: int = 2, preferences=None) -> dict:
    queries = list(dict.fromkeys(q.strip()[:200] for q in page.get("searchQueries", []) if q.strip()))[:max_queries]
    sources, seen = [], set()
    try:
        for query in queries:
            model.check()
            for result in search.search(query):
                if result["url"] not in seen:
                    seen.add(result["url"])
                    sources.append(result)
        if not sources:
            return {"status": "none", "queries": queries, "papers": []}
        data = {"outputLanguage": page["outputLanguage"], "slide": page["title"], "concepts": page["concepts"], "sources": [{"sourceId": i, **s} for i, s in enumerate(sources)], **(preferences or {})}
        task = "Select up to 3 directly relevant ACADEMIC PAPERS, journal articles or research preprints from the search results. Exclude blogs, generic homepages, product documentation and unrelated papers. Select none if no credible paper matches. Never invent bibliographic details or claim to have read the full paper: relevance and suggested sections to read are based on the provided search snippets. Return only sourceId indices and guidance, in the output language."
        chosen = model.generate(Papers, request_task(task, data), data,
            validate=lambda value: selected_papers(value, sources))
        papers = selected_papers(chosen, sources)
        return {"status": "found" if papers else "none", "queries": queries, "papers": papers}
    except Exception as exc:
        # A failed search is visible and retryable. Never turn a service failure into "no papers found".
        log.warning("paper search failed page=%s type=%s: %s", page["page"], type(exc).__name__, str(exc)[:300])
        return {"status": "failed", "queries": queries, "papers": [], "error": "논문 검색을 완료하지 못했습니다. 다시 시도할 수 있습니다."}


def analyze(store, workdir: Path, check, model=None, search=None, render=render_deck):
    record = store.record()
    custom_prompt(record)  # Validate optional preferences before making model calls.
    model = model or Model(check=check)
    search = search or GatewaySearch()
    if record["assets"].get("video") and not record["assets"].get("slides"):
        from .video_analysis import analyze_video
        return analyze_video(store, workdir, check, model, search, render)
    transcript = store.read(record["transcriptKey"])
    if not transcript:
        raise ValueError("Lecture transcript is missing")
    if not record["assets"].get("slides"):
        from .audio_analysis import analyze_audio
        return analyze_audio(store, check, model, search, record, transcript)
    from .grouped_deck import analyze_deck
    return analyze_deck(store, workdir, check, model, search, record, transcript, render)


def research_groups(pages: list[dict]) -> list[dict]:
    """Pages of one chapter (video topics) are researched once and share the papers; other pages keep their own search."""
    groups, by_chapter = [], {}
    for page in pages:
        chapter = page.get("chapter")
        if not chapter:
            groups.append({"key": f"papers-{page['page']}.json", "pages": [page]})
        elif chapter in by_chapter:
            by_chapter[chapter]["pages"].append(page)
        else:
            by_chapter[chapter] = {"key": f"papers-chapter-{len(by_chapter) + 1}.json", "chapter": chapter, "pages": [page]}
            groups.append(by_chapter[chapter])
    return groups


def research_group(model: Model, search: GatewaySearch, group: dict, preferences=None) -> dict:
    pages = group["pages"]
    if preferences:
        preferences = {**preferences, "requestScope": {**preferences.get("requestScope", {}), "currentSections": [
            {"sourceType": p.get("source", "deck"), "deckPage": p.get("deckPage", p["page"]) if p.get("source", "deck") == "deck" else None}
            for p in pages]}}
    if "chapter" not in group:
        return research_page(model, search, pages[0], preferences=preferences)
    queries = list(dict.fromkeys(q for page in pages for q in page.get("searchQueries", [])))
    concepts = list({c["term"]: c for page in pages for c in page.get("concepts", [])}.values())[:12]
    return research_page(model, search, {"page": pages[0]["page"], "title": group["chapter"], "concepts": concepts, "searchQueries": queries, "outputLanguage": pages[0]["outputLanguage"]}, max_queries=3, preferences=preferences)


def finish_lecture(store, model, search, check, record, language, pages, duration, video_analysis=None, audience=None, alignment_warnings=None, deck_scope=None):
    preferences = request_context(record, availableDeckPages=[
        number for p in pages if p.get("source", "deck") == "deck" for number in p.get("sourcePages", [p.get("deckPage", p["page"])])
    ])
    # Grouped documents must never reuse overview/paper caches from the per-slide pipeline.
    if deck_scope:
        from .deck_scope import scope_signature
        original_store = store
        signature = scope_signature([p.get("sourcePages", []) for p in pages])
        class GroupedStore:
            def __getattr__(self, name):
                return getattr(original_store, name)
            def cached(self, name, build, **kwargs):
                return original_store.cached(f"grouped-v1-{signature}-{name}", build, **kwargs)
        store = GroupedStore()
    groups = research_groups(pages)
    researched = parallel_map(groups, lambda group: store.cached(request_cache_key(group["key"], record), lambda: research_group(model, search, group, preferences), accept=lambda value: value.get("status") != "failed"),
                              check=check, on_done=lambda n: store.progress("papers", n, len(groups)))
    for group, research in zip(groups, researched, strict=True):
        for page in group["pages"]:
            page["research"] = research
    for page in pages:
        del page["searchQueries"]
        del page["outputLanguage"]
    def overview_task():
        task = "Summarize this lecture and propose a practical ordered review plan with learning objectives. Use only the provided summaries for lecture claims. Study recommendations are suggestions; never predict exam questions. Use the output language."
        task = request_task(task, preferences)
        rows = [{"page": p["page"], "title": p["title"], "summary": p["slideSummary"][:650], "spoken": p["spokenSummary"][:300]} for p in pages]
        if preferences:
            for row, page in zip(rows, pages, strict=True):
                row.update(sourceType=page.get("source", "deck"), deckPage=page.get("deckPage", page["page"]) if page.get("source", "deck") == "deck" else None,
                           sourcePages=page.get("sourcePages", []))
        if len(rows) > 100:
            groups = []
            for i in range(0, len(rows), 60):
                part = store.cached(request_cache_key(f"overview-part-{i}.json", record), lambda i=i: model.generate(Overview, task, {"outputLanguage": language, "pages": rows[i:i + 60], **preferences}).model_dump())
                groups.append({"overview": part["overview"][:2000], "learningObjectives": [x[:300] for x in part["learningObjectives"][:8]]})
            return model.generate(Overview, task, {"outputLanguage": language, "title": record["title"], "parts": groups, **preferences}).model_dump()
        return model.generate(Overview, task, {"outputLanguage": language, "title": record["title"], "course": record["course"], "pages": rows, **preferences}).model_dump()
    overview = Overview.model_validate(store.cached(request_cache_key("overview.json", record), overview_task)).model_dump()
    warnings = list(alignment_warnings or [])
    uncertain = sum(p["alignment"]["status"] != "matched" for p in pages)
    failures = sum(p["research"]["status"] == "failed" for p in pages)
    unit = "학습 구간" if pages and all(p.get("source") == "audio" for p in pages) else "장표"
    if uncertain:
        warnings.append(f"{uncertain}개 {unit}에서 녹음과의 연결이 불확실하거나 대응 발언을 찾지 못했습니다. 항목별 근거를 확인하세요.")
    if video_analysis:
        warnings.append(f"영상 화면은 {video_analysis['sampleIntervalSec']}초 간격의 표본과 구간별 대표 화면을 분석합니다. 빠른 화면 전환이나 연속 동작은 원본 영상에서 확인하세요.")
        if video_analysis["groupedScenes"]:
            warnings.append("화면 변화가 많아 일부 인접 구간을 묶었습니다. 각 구간의 원본 영상을 함께 확인하세요.")
        if not video_analysis["hasAudio"]:
            warnings.append("음성 트랙이 없는 영상입니다. 발언을 만들지 않고 영상 화면으로 학습 자료를 정리했습니다.")
    if failures:
        warnings.append(f"{failures}개 {unit}의 논문 검색이 완료되지 않았습니다. 다시 시도하면 완료된 자료는 재사용합니다.")
    warnings.append("논문 안내는 검색 결과의 제목과 발췌문을 근거로 합니다. 세부 내용과 출판 상태는 연결된 원문에서 확인하세요.")
    document = {"version": 1, "lectureId": record["lectureId"], "title": record["title"], "course": record["course"], "generatedAt": now(), "outputLanguage": language, "durationSec": duration, "audience": audience, **overview, "pages": pages, "warnings": warnings, **({"videoAnalysis": video_analysis} if video_analysis else {})}
    if deck_scope:
        document.update(deck_scope)
    if record.get("slideRange"):
        document["slideRange"] = record["slideRange"]
    if preferences:
        document["customPrompt"] = preferences["customPrompt"]
    document["usage"] = {**(model.metrics() if hasattr(model, "metrics") else {}), **(search.metrics() if hasattr(search, "metrics") else {})}
    check()
    run = store.run_prefix
    store.put(run + "study.md", markdown(document).encode(), "text/markdown; charset=utf-8")
    store.put(run + "flashcards.csv", flashcard_csv(document).encode(), "text/csv; charset=utf-8")
    store.save(run + "document.json", document)
    # Nothing is overwritten in place: the Complete step swaps all three pointers in one record update.
    return {"documentKey": store.prefix + run + "document.json", "markdownKey": store.prefix + run + "study.md", "flashcardsKey": store.prefix + run + "flashcards.csv", "researchFailures": failures, "pageCount": len(pages)}
