"""Selected slides -> a few coherent lessons, with one analysis per topic group."""
from pathlib import Path

from .alignment import page_evidence, resolve_alignment, transcript_batches, validate_alignment, validate_alignment_sources
from .customization import request_cache_key, request_context
from .deck_scope import GROUP_VERSION, group_reading, plan_groups, scope_pages, scope_signature
from .parallel import parallel_map
from .prompts import STUDY_CACHE_VERSION, STUDY_TASK
from .schemas import Alignment, SlideReading, Study
from .slides import deck_page_count, render_deck
from .study import deck_context, generate_study


def analyze_deck(store, workdir: Path, check, model, search, record, transcript, render=render_deck):
    from .pipeline import finish_lecture, learner_profile
    language = record["outputLanguage"]
    if language == "auto":
        language = transcript.get("language") or "ko"
    asset = record["assets"]["slides"]
    deck = workdir / ("slides.pdf" if asset["contentType"] == "application/pdf" else "slides.pptx")
    check()
    store.s3.download_file(store.bucket, asset["key"], str(deck))
    total = deck_page_count(deck)
    selected = scope_pages(store, model, record, total)
    # No image rendering, native-text extraction or model reading of excluded slides.
    slides = render(deck, workdir / "rendered", selected_pages=selected)
    store.progress("slides", 0, len(slides))
    def read_slide(slide):
        key = f"{'deck' if record['assets'].get('video') else 'slide'}-{slide['page']}.json"
        reading = SlideReading.model_validate(store.cached(key, lambda: model.generate(SlideReading,
            "Read this selected slide accurately. Describe its diagrams, visible formulas, labels and constraints "
            "in the output language. Mark unreadable symbols instead of guessing. Notes are not recorded speech.",
            {"outputLanguage": language, "page": slide["page"], "nativeText": slide["text"], "authorNotes": slide["speakerNotes"]},
            image=slide["image"]).model_dump())).model_dump()
        return {"page": slide["page"], **reading}
    readings = parallel_map(slides, read_slide, check=check, on_done=lambda n: store.progress("slides", n, len(slides)))
    plan = plan_groups(store, model, record, readings, selected, language)
    scope_key = scope_signature(selected)
    plan_key = scope_signature([g.model_dump() for g in plan.groups])
    cache_prefix = f"grouped-{GROUP_VERSION}-{scope_key}-{plan_key}"
    segments = [{k: s[k] for k in ("id", "start", "end", "speaker", "text")} for s in transcript["segments"]]
    batches = transcript_batches(segments) if segments else []
    group_readings = [{"page": i + 1, **group_reading(g, readings)} for i, g in enumerate(plan.groups)]
    # Infer the audience from selected topics, never from cached readings outside the scope.
    class ScopedAudienceStore:
        def cached(self, name, build):
            return store.cached(f"{cache_prefix}-{name}", build)
    audience = learner_profile(ScopedAudienceStore(), model, language, record, group_readings, segments)
    context = deck_context(record, slides, readings)
    mapping = {p: i + 1 for i, g in enumerate(plan.groups) for p in g.pages}
    alignments = []
    for i, batch in enumerate(batches):
        check()
        def align(i=i, batch=batch):
            # Previously validated page links can be regrouped without another model call.
            old = store.read(store.prefix + f"cache/v2/alignment-{i}.json") if not record["assets"].get("video") else None
            if old is not None:
                old = Alignment.model_validate(old)
                validate_alignment(old, batch, total)
                proposal = Alignment(assignments=[m.model_copy(update={"page": mapping[m.page]}) for m in old.assignments if m.page in mapping])
            else:
                proposal = model.generate(Alignment,
                    "Link recording segments ONLY to the supplied selected topic groups. The assignment page is the "
                    "group ID, not a physical slide number. Use exact segment IDs and specific conceptual evidence, "
                    "never proportional timing or slide order. Ranges must not overlap. Leave speech about excluded "
                    "slides or unrelated topics unassigned. Reasons must be concise and in the output language.",
                    {"outputLanguage": language, "groups": group_readings, "segments": batch},
                    validate=lambda value: validate_alignment_sources(value, batch, len(plan.groups)))
            return resolve_alignment(model, proposal, batch, group_readings, language).model_dump()
        value = Alignment.model_validate(store.cached(f"{cache_prefix}-alignment-{i}.json", align))
        validate_alignment(value, batch, len(plan.groups))
        alignments.append(value)
        store.progress("alignment", i + 1, len(batches))
    if not batches:
        store.progress("alignment", 0, 0)

    def build_group(item):
        i, group = item
        members = [s for s in slides if s["page"] in group.pages]
        evidence, alignment = page_evidence(i + 1, alignments, batches)
        alignment["method"] = "semantic"
        preferences = request_context(record, sourceType="deck", deckPages=group.pages)
        task = STUDY_TASK + (
            "\nThis ONE section is a topic group spanning sourcePages. Explain it once as a connected lesson, "
            "not as repeated per-slide summaries. Cite physical page numbers only from sourcePages or sourceContext. "
            "For brief depth, use a short orientation and no filler questions/cards or unnecessary derivations. "
            "For standard/detailed depth, explain the key ideas and necessary mathematical steps without repeating "
            "them across summary, concepts, cards and questions."
        )
        def study():
            return generate_study(model, task,
                {"outputLanguage": language, "audience": audience, "reading": group_readings[i], "sourcePages": group.pages,
                 "depth": group.depth, "nativeText": "\n\n".join(f"Page {s['page']}:\n{s['text'][:8000]}" for s in members),
                 "alignment": alignment, "sourceContext": context, **preferences},
                evidence, [s["image"] for s in members])
        value = Study.model_validate(store.cached(request_cache_key(f"{cache_prefix}-study-{i}.{STUDY_CACHE_VERSION}.json", record), study)).model_dump()
        if not evidence:
            value["spokenSummary"] = ""
        # Published previews are immutable per run; old results stay usable while rebuilding.
        images = []
        for slide in members:
            key = store.run_prefix + f"source-slides/{slide['page']}.png"
            store.put(key, slide["image"].read_bytes(), "image/png")
            images.append({"page": slide["page"], "imageKey": store.prefix + key})
        return {"page": i + 1, "source": "deck", "deckPage": group.pages[0], "sourcePages": group.pages,
                "sourceImages": images, "depth": group.depth, "title": group.title, "sourceFile": context["fileName"],
                "slideText": "\n\n".join(f"Page {s['page']}:\n{s['text']}" for s in members),
                "imageKey": images[0]["imageKey"], "alignment": alignment, "evidence": evidence, "outputLanguage": language, **value}
    pages = parallel_map(enumerate(plan.groups), build_group, check=check, on_done=lambda n: store.progress("study", n, len(plan.groups)))
    unresolved = sum(len(a.unresolvedSegmentIds) for a in alignments)
    warnings = [f"{unresolved}개 발언의 학습 묶음을 확정하지 못했습니다. 원본 전사에서 확인할 수 있습니다."] if unresolved else []
    result = finish_lecture(store, model, search, check, record, language, pages, transcript["durationSec"],
                            audience=audience, alignment_warnings=warnings,
                            deck_scope={"selectedPages": selected, "originalPageCount": total, "grouped": True})
    return {**result, "selectedPages": selected, "originalPageCount": total,
            "studyImages": [{"page": p["page"], "sourcePage": image["page"], "key": image["imageKey"]}
                            for p in pages for image in p["sourceImages"]]}
