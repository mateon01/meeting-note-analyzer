"""Transcript batching and strict evidence validation. No proportional timing guesses."""
import json
import logging
from .schemas import Alignment, AlignmentResolution, Assignment

log = logging.getLogger(__name__)


def transcript_batches(segments: list[dict], budget: int = 18000) -> list[list[dict]]:
    if not segments or len(segments) > 30000 or len({s["id"] for s in segments}) != len(segments):
        raise ValueError("Transcript is empty, too large, or contains duplicate segment IDs")
    batches, current, size = [], [], 0
    for segment in segments:
        if segment["start"] < 0 or segment["end"] < segment["start"]:
            raise ValueError("Invalid transcript timestamps")
        length = len(json.dumps(segment, ensure_ascii=False))
        if length > budget:
            raise ValueError("A transcript segment exceeds the analysis limit")
        if current and size + length > budget:
            batches.append(current)
            current, size = [], 0
        current.append(segment)
        size += length
    if current:
        batches.append(current)
    return batches


def validate_alignment_sources(value: Alignment, segments: list[dict], page_count: int) -> None:
    indices = {s["id"]: i for i, s in enumerate(segments)}
    for match in value.assignments:
        if match.page > page_count or match.startSegmentId not in indices or match.endSegmentId not in indices:
            raise ValueError("Alignment references an unknown page or segment ID")
        start, end = indices[match.startSegmentId], indices[match.endSegmentId]
        if end < start:
            raise ValueError("Alignment segment range is reversed")
    if len(set(value.unresolvedSegmentIds)) != len(value.unresolvedSegmentIds) or any(s not in indices for s in value.unresolvedSegmentIds):
        raise ValueError("Unresolved alignment references an unknown or duplicate segment ID")


def validate_alignment(value: Alignment, segments: list[dict], page_count: int) -> None:
    validate_alignment_sources(value, segments, page_count)
    indices = {s["id"]: i for i, s in enumerate(segments)}
    used: set[int] = set()
    for match in value.assignments:
        start, end = indices[match.startSegmentId], indices[match.endSegmentId]
        covered = set(range(start, end + 1))
        if used & covered:
            raise ValueError("A transcript segment was assigned to more than one slide")
        used |= covered
    if used & {indices[s] for s in value.unresolvedSegmentIds}:
        raise ValueError("An unresolved segment cannot also be assigned to a slide")


def resolve_alignment(model, value: Alignment, segments: list[dict], slides: list[dict], language: str) -> Alignment:
    """Preserve sound links; recheck only speech assigned to different pages.

    Same-page duplicates need no semantic decision. Cross-page disputes get one
    explicit page choice per segment, or remain unassigned when inconclusive.
    """
    validate_alignment_sources(value, segments, len(slides))
    try:
        validate_alignment(value, segments, len(slides))
        return value
    except ValueError:
        pass
    indices = {s["id"]: i for i, s in enumerate(segments)}
    proposed: dict[int, list[Assignment]] = {}
    for match in value.assignments:
        for i in range(indices[match.startSegmentId], indices[match.endSegmentId] + 1):
            proposed.setdefault(i, []).append(match)
    disputed = [i for i, matches in proposed.items() if len({m.page for m in matches}) > 1]
    decisions = {}
    for offset in range(0, len(disputed), 16):
        group = disputed[offset:offset + 16]
        candidates = {segments[i]["id"]: {m.page for m in proposed[i]} for i in group}
        pages = set().union(*candidates.values())
        def validate_resolution(result):
            if set(result.choices) != set(candidates):
                raise ValueError("Return exactly one choice keyed by each disputed segment ID")
            if any(choice.page is not None and choice.page not in candidates[sid] for sid, choice in result.choices.items()):
                raise ValueError("Each chosen page must be among that segment's supplied candidate pages")
        try:
            result = model.generate(AlignmentResolution,
                "Resolve conflicting slide links for ONLY the disputed recording segments. Return choices keyed by "
                "each exact disputed segment ID: one candidate page or null if the evidence cannot distinguish them. "
                "Use the segment's specific explanation and neighboring speech to identify the best supported page. "
                "Neighboring speech is context, not another segment to assign. Do not choose by page order, timing "
                "proportions, or the original confidence alone. Keep reasons concise in the output language.",
                {"outputLanguage": language, "slides": [s for s in slides if s["page"] in pages],
                 "disputes": [{"segment": segments[i],
                               "candidates": [{"page": m.page, "reason": m.reason} for m in proposed[i]],
                               "before": segments[max(0, i - 1):i],
                               "after": segments[i + 1:i + 2]} for i in group]},
                validate=validate_resolution)
            decisions.update(result.choices)
        except ValueError:
            # A malformed optional resolution must not discard validated work.
            # Transport failures/cancellation still propagate to the normal retry.
            log.warning("Could not resolve %d disputed transcript segments", len(group))

    unresolved = set(value.unresolvedSegmentIds)
    assignments = []
    for i in sorted(proposed):
        matches = proposed[i]
        sid = segments[i]["id"]
        if len({m.page for m in matches}) > 1:
            choice = decisions.get(sid)
            if choice is None or choice.page is None:
                unresolved.add(sid)
                continue
            matches = [m for m in matches if m.page == choice.page]
            confidence = min(choice.confidence, *(m.confidence for m in matches))
            reason = choice.reason
        else:
            confidence = min(m.confidence for m in matches)
            reason = matches[0].reason
        unresolved.discard(sid)
        page = matches[0].page
        if assignments and assignments[-1].page == page and indices[assignments[-1].endSegmentId] == i - 1:
            assignments[-1].endSegmentId = sid
            assignments[-1].confidence = min(assignments[-1].confidence, confidence)
        else:
            assignments.append(Assignment(page=page, startSegmentId=sid, endSegmentId=sid, confidence=confidence, reason=reason))
    result = Alignment(assignments=assignments, unresolvedSegmentIds=sorted(unresolved, key=indices.__getitem__))
    validate_alignment(result, segments, len(slides))
    return result


def page_evidence(page: int, alignments: list[Alignment], batches: list[list[dict]]) -> tuple[list[dict], dict]:
    evidence, matches, seen = [], [], set()
    for value, segments in zip(alignments, batches, strict=True):
        indices = {s["id"]: i for i, s in enumerate(segments)}
        for match in value.assignments:
            if match.page != page:
                continue
            matches.append(match)
            for segment in segments[indices[match.startSegmentId]:indices[match.endSegmentId] + 1]:
                if segment["id"] in seen:
                    continue
                seen.add(segment["id"])
                evidence.append({"segmentId": segment["id"], "start": segment["start"], "end": segment["end"], "text": segment["text"], "speaker": segment.get("speaker", "S1")})
    evidence.sort(key=lambda s: s["start"])
    # Conservative: one uncertain window keeps the page marked uncertain, even if other windows are clear.
    confidence = min((m.confidence for m in matches), default=0)
    return evidence, {"status": "matched" if confidence >= 0.75 else "uncertain" if matches else "unmatched", "confidence": confidence, "reason": " / ".join(dict.fromkeys(m.reason for m in matches))[:1800]}
