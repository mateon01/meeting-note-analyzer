"""A reviewable overall inclination based on this interview's grounded competency assessments."""
import hashlib
import json
import logging
import re
from typing import Literal

from botocore.exceptions import ClientError
from pydantic import Field, create_model

from .interview_criteria import CRITERION_GUIDE, CRITERION_LEVEL_GUIDE, LABELS, LEVEL_CALIBRATION
from .schemas import Strict

log = logging.getLogger(__name__)
SUMMARY_VERSION = "v3"


class OverallSummaryDraft(Strict):
    barAssessment: Literal["clear", "borderline", "below_bar"]
    reason: str = Field(min_length=1, max_length=600)
    rationale: str = Field(min_length=1, max_length=8000)


SUMMARY_TASK = """Write the overall Summary for a HUMAN INTERVIEWER TO REVIEW, in opinionLanguage.
This is an advisory inclination for the competencies evaluated in THIS interview, not a final hiring action.
Use ONLY the supplied grounded competency assessments. Do not invent interview facts or import example feedback.
Respect targetLevel, roleTitle and roleContext. Do not change any competency rating.
Assess the selected job-related scope; never claim that unasked competencies were failed.
UnassessedCriteria are coverage limitations, not proof of weak competence, and are not negative evidence.
Classify barAssessment:
- clear: convincing independent evidence that the evaluated competencies meet the target-level bar, without
  unresolved material gaps in capabilities required for the selected role and level. Non-blocking development
  areas are compatible with clear; explain why they do not undermine the demonstrated role capability.
- borderline: the evidence leaves a material uncertainty about meeting the actual target-level bar.
  A Mixed rating or a limited-coverage flag does not by itself mean the overall candidate is borderline.
- below_bar: demonstrated material depth, experience, ownership or design gaps below the target-level bar.
The application maps clear to Inclined and BOTH borderline and below_bar to Not Inclined. There is no third decision.
Ratings are evidence summaries, not a mechanical voting rule. Do not require every criterion to score 4 or 5.
Limited coverage can coexist with sufficient positive evidence for the evaluated role scope. Conversely, even
high scores do not justify clear if a material role-critical gap remains unresolved. Do not average scores,
automatically downgrade every Mixed rating, or let tool exposure cancel a material core skill gap.
For each decisive concern, explain its relevance to the selected role and level and distinguish a development
area from a hiring-bar blocker. If recommending Not Inclined, identify the actual blocker or unresolved bar-level
uncertainty; lack of next-level leadership, unasked topics or lack of expert breadth alone is not an L5 blocker.
If recommending Inclined, establish the already demonstrated capabilities, address the strongest concern and
explain why it does not materially prevent target-level performance. Future potential alone is insufficient.
Separate hands-on exposure from explanatory depth, experiments from production ownership, and independent reasoning
from interviewer-supplied hints. Preserve uncertainty and self-report qualifiers; do not infer inability from missing data.
Do not treat the absence of reported misunderstanding as proof of effective communication, or an unestablished
measurement as proof it never occurred. Do not add intent, outcomes or character judgments to the supplied evidence.
If the assessments describe a tested resume shortfall, summarize it without repeating resume claim IDs.
reason: ONE short clause explaining the inclination, e.g. 'based on ...' in English. Do NOT include the decision label.
rationale: usually THREE coherent paragraphs separated by blank lines, about 200–350 English words overall
or comparable detail in Korean. Use less when evidence is thin; these are writing targets, not quotas.
Lead with the role/level judgment and its decisive evidence. Develop the strongest supporting examples and
individual contributions. Address gaps, limitations and why they do or do not change the recommendation.
Do not repeat every competency paragraph or list every question. Avoid repeated caveats and generic praise.
Do not include internal IDs, bullet markers, protected characteristics, personality judgments or hiring-process actions.
Return only barAssessment, reason and rationale.\n""" + LEVEL_CALIBRATION


def inclination(bar_assessment):
    return {"clear": "Inclined", "borderline": "Not Inclined", "below_bar": "Not Inclined"}[bar_assessment]


def _reason(text):
    return re.sub(r"^(?:Not Inclined|Inclined)\b[\s,:—–.-]*", "", text.strip(), flags=re.I).strip()


def overall_summary(assessments, settings, level_guide, model, cache, *, reviewable=True):
    """Retain scores and citations in application code; the model only supplies the overall interpretation."""
    observed = [a for a in assessments if a["rating"] is not None and (a["positives"] or a["concerns"])]
    if not reviewable or not observed:
        return None
    references = list(dict.fromkeys(qid for a in observed for field in ("positives", "concerns")
                                    for point in a[field] for qid in point["exchangeIds"]))
    if not references:
        return None
    schema = create_model("InterviewOverallSummary", __base__=OverallSummaryDraft)
    data = {
        "targetLevel": settings["targetLevel"], "levelGuide": level_guide,
        "roleTitle": settings["roleTitle"], "roleContext": settings.get("roleContext", ""),
        "opinionLanguage": settings["opinionLanguage"],
        "unassessedCriteria": [LABELS.get(a["criterion"], a["criterion"]) for a in assessments if a not in observed],
        "assessments": [{"criterion": LABELS.get(a["criterion"], a["criterion"]), "rating": a["rating"],
                        "criterionGuide": CRITERION_GUIDE.get(a["criterion"], "Evaluate the observed behaviors relevant to this Leadership Principle."),
                        "levelGuide": CRITERION_LEVEL_GUIDE.get(a["criterion"], {}).get(settings["targetLevel"], level_guide),
                        "evidenceStatus": a["evidenceStatus"], "levelAssessment": a["levelAssessment"],
                        "positives": [p["text"] for p in a["positives"]],
                        "concerns": [p["text"] for p in a["concerns"]]} for a in observed],
    }
    task = SUMMARY_TASK
    if any(a["criterion"] == "technical_communication" for a in assessments):
        data["communicationContext"] = {
            "criterionGuide": CRITERION_GUIDE["technical_communication"],
            "levelGuide": CRITERION_LEVEL_GUIDE["technical_communication"][settings["targetLevel"]],
        }
        if all(a["criterion"] == "technical_communication" for a in observed):
            data["levelGuide"] = data["communicationContext"]["levelGuide"]
        task += ("\nKeep Technical Communication separate from domain knowledge and architecture. "
                 "Its strengths/gaps concern audience adaptation, shared understanding and stakeholder alignment; "
                 "do not reinterpret its rating as a domain-depth rating or penalize unasked technical dimensions.")
    signature = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]

    def validate(value):
        if not _reason(value.reason):
            raise ValueError("Give a brief reason, not just the inclination label")
        if re.search(r"\b(?:seg-\d+|[qr]\d+|S\d+)\b", value.reason + " " + value.rationale):
            raise ValueError("Summary prose must omit internal source IDs")

    try:
        value = schema.model_validate(cache(f"overall-summary-{SUMMARY_VERSION}-{signature}",
            lambda: model.generate(schema, task, data, validate=validate).model_dump()))
        validate(value)
    except (ValueError, ClientError):
        # A model/format problem is never a reason to recommend against a candidate or discard completed notes.
        log.warning("Overall Summary unavailable; retaining the validated interview assessments")
        return None
    except RuntimeError as error:
        if not str(error).startswith("Lecture model-call limit reached"):
            raise
        log.warning("No model budget left for overall Summary")
        return None
    return {
        "recommendation": inclination(value.barAssessment), "barAssessment": value.barAssessment,
        "reason": re.sub(r"\s+", " ", _reason(value.reason)),
        "rationale": "\n\n".join(re.sub(r"\s+", " ", paragraph).strip()
                                for paragraph in re.split(r"\n\s*\n", value.rationale.strip()) if paragraph.strip()),
        "criterionIds": [a["criterion"] for a in observed], "exchangeIds": references,
    }
