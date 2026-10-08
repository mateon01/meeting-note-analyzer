import copy

import pytest

from lecture_study.interview import analyze_interview, generate_assessment
from lecture_study.interview_criteria import CRITERION_GUIDE, CRITERION_LEVEL_GUIDE, LABELS
from lecture_study.interview_schemas import InterviewAnswer, InterviewAssessment, QuestionIndex, ResumeComparison
from test_interview import Model, store


class CommunicationModel(Model):
    def generate(self, schema, task, data, validate=None, **kwargs):
        value = None
        if schema == QuestionIndex:
            value = {"questions": [
                {"segmentId": "s1", "topic": "Technical Communication", "question": "청중별로 어떻게 설명하고 합의했나요?", "kind": "primary", "parentSegmentId": None},
                {"segmentId": "s5", "topic": "Technical Communication", "question": "합의 이후 결과는 확인했나요?", "kind": "follow_up", "parentSegmentId": "s1"},
            ]}
        elif issubclass(schema, InterviewAnswer):
            first = data["speech"][0]["id"] == "s1"
            value = {"question": data["question"], "answer": [
                {"text": "재무 임원에게 비용과 위험을, 개발팀에게 API 계약과 지연 예산을 설명했다고 말했다.", "segmentIds": ["s2"]},
                {"text": "보안팀의 우려를 듣고 이해한 내용을 서로 확인한 뒤 결정과 담당자를 문서화했다고 말했다.", "segmentIds": ["s4"]},
            ] if first else [{"text": "일정 합의는 했지만 출시 후 효과는 확인하지 못했다고 말했다.", "segmentIds": ["s6"]}],
                "interviewerContext": [], "uncertainty": []}
        elif issubclass(schema, InterviewAssessment):
            assert data["criterion"] == "technical_communication"
            assert "NOT Domain Depth" in task
            value = {"rating": 3, "evidenceStatus": "limited",
                     "positives": [{"text": "The candidate reported tailoring decision framing for finance and engineering and confirming shared understanding.", "exchangeIds": ["q1"]}],
                     "concerns": [{"text": "The example did not establish whether the communication sustained alignment after the decision.", "exchangeIds": ["q2"]}],
                     "levelAssessment": "Project communication was described; sustained outcomes need further evidence.", "followUps": []}
        elif schema.__name__ == "InterviewOverallSummary":
            assert data["communicationContext"]["criterionGuide"] == CRITERION_GUIDE["technical_communication"]
            assert data["levelGuide"] == CRITERION_LEVEL_GUIDE["technical_communication"][data["targetLevel"]]
            value = {"barAssessment": "borderline", "reason": "based on incomplete evidence of sustained stakeholder alignment.",
                     "rationale": "The described audience adaptation was relevant, but its sustained effect was not established."}
        if value is None:
            return super().generate(schema, task, data, validate=validate, **kwargs)
        self.calls.append(schema); self.inputs.append(copy.deepcopy(data))
        result = schema.model_validate(value)
        if validate:
            validate(result)
        return result


@pytest.mark.parametrize("level", ["L4", "L5", "L6", "L7"])
def test_new_dimension_uses_communication_specific_level_guide_and_exports(level):
    data = store()
    data.rec["settings"].update(criteria=["technical_communication"], targetLevel=level)
    for segment, text in zip(data.values["transcript"]["segments"], [
        "재무 임원과 개발팀에게 기술 결정을 어떻게 설명하고 합의했나요?",
        "재무 임원에게는 비용과 위험, 개발팀에는 API 계약과 지연 예산을 설명했습니다.",
        "다른 팀과 이해한 내용도 확인했나요?",
        "보안팀 우려를 듣고 서로 이해한 내용을 확인했으며 결정과 담당자를 문서화했습니다.",
        "합의 이후 결과도 확인했나요?",
        "일정은 합의했지만 출시 후 효과는 확인하지 못했습니다.",
    ], strict=True):
        segment["text"] = text
    original = copy.deepcopy(data.values["transcript"])
    model = CommunicationModel()
    analyze_interview(data, lambda: None, model=model)
    document = data.values[data.prefix + data.run_prefix + "document.json"]
    assessment = next(d for d in model.inputs if d.get("criterion") == "technical_communication")
    assert assessment["criterionGuide"] == CRITERION_GUIDE["technical_communication"]
    assert assessment["levelGuide"] == CRITERION_LEVEL_GUIDE["technical_communication"][level]
    assert document["assessments"][0]["criterion"] == "technical_communication"
    assert document["overallSummary"]["criterionIds"] == ["technical_communication"]
    assert document["overallSummary"]["recommendation"] == "Not Inclined"
    assert "### Technical Communication" in data.files[data.run_prefix + "interview.md"].decode()
    assert data.values["transcript"] == original
    calls = len(model.calls)
    analyze_interview(data, lambda: None, model=model)
    assert len(model.calls) == calls


def test_communication_scope_survives_partial_assessment_consolidation():
    model = CommunicationModel()
    rows = [{"id": "q1"}, {"id": "q2"}]
    data = {"criterion": "technical_communication"}
    part = generate_assessment(model, data, rows, [], None)
    merged = generate_assessment(model, data, rows, [], "technical_communication", partials=[part, part])
    assert merged["rating"] == 3
    assert merged["concerns"][0]["exchangeIds"] == ["q2"]


def test_resume_comparison_can_reference_all_nineteen_selected_criteria():
    assert len(LABELS) == 19
    value = ResumeComparison(status="not_tested", explanation="Not meaningfully probed.", exchangeIds=[], affectedCriteria=list(LABELS))
    assert "technical_communication" in value.affectedCriteria
