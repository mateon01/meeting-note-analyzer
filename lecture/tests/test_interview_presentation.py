import copy

import pytest

from lecture_study.interview_presentation import brief_interviewer_context, concise_reading_notes, korean_resume_notes
from test_pipeline import FakeStore


def exchanges():
    return [
        {"id": "q1", "topic": "ML", "question": "두 방식의 차이는?", "answer": [{"text": "Candidate answer stays unchanged.", "segmentIds": ["s2"]}],
         "interviewerContext": [{"text": "면접관이 BERT와 S-BERT를 관련 맥락으로 언급했다. 이후에는 직무 안내와 면접 종료 안내를 제공했다.", "segmentIds": ["s1"]}],
         "resumeClaimIds": ["r1"]},
        {"id": "q2", "topic": "ML", "question": "다른 질문", "answer": [], "interviewerContext": []},
    ]


def test_brief_hints_use_only_interviewer_context_keep_original_evidence_and_are_cached():
    rows, store = exchanges(), FakeStore(None)
    original = copy.deepcopy(rows)
    class Model:
        calls = 0
        def generate(self, schema, task, data, validate=None):
            self.calls += 1
            assert data["questions"] == [{"id": "q1", "question": rows[0]["question"],
                                         "interviewerContext": [rows[0]["interviewerContext"][0]["text"]]}]
            assert "candidate" not in str(data).lower() and "r1" not in str(data)
            value = schema(q1=["BERT·S-BERT를 관련 맥락으로 언급함."])
            validate(value)
            return value
    model = Model()
    result = brief_interviewer_context(rows, model, store.cached, "ko", lambda: None)
    assert rows == original
    assert result[0]["briefInterviewerContext"] == ["BERT·S-BERT를 관련 맥락으로 언급함."]
    assert result[0]["answer"] == original[0]["answer"] and result[0]["interviewerContext"] == original[0]["interviewerContext"]
    assert result[1]["briefInterviewerContext"] == []
    assert brief_interviewer_context(rows, model, store.cached, "ko", lambda: None) == result
    assert model.calls == 1


def test_summary_failures_do_not_discard_successful_notes_and_cancellation_is_not_swallowed():
    rows, store = exchanges(), FakeStore(None)
    class FailedModel:
        error = ValueError("Invalid presentation output")
        def generate(self, *args, **kwargs):
            raise self.error
    model = FailedModel()
    result = brief_interviewer_context(rows, model, store.cached, "ko", lambda: None)
    assert result[0] == rows[0]
    model.error = RuntimeError("Lecture execution is no longer active")
    with pytest.raises(RuntimeError, match="no longer active"):
        brief_interviewer_context(rows, model, store.cached, "ko", lambda: None)


def test_brief_hint_generation_rejects_unrelated_question_keys_and_internal_ids():
    rows, store = exchanges(), FakeStore(None)
    class InvalidModel:
        def generate(self, schema, task, data, validate=None):
            with pytest.raises(ValueError):
                schema.model_validate({"q999": ["Wrong question"]})
            value = schema(q1=["See seg-0001 and r1."])
            validate(value)
            return value
    result = brief_interviewer_context(rows, InvalidModel(), store.cached, "ko", lambda: None)
    assert result[0] == rows[0]  # Preserve the original, not the invalid summary.


def test_reading_copy_has_a_total_quarter_budget_and_keeps_wrong_answers_separate_from_hints():
    rows, store = exchanges(), FakeStore(None)
    wrong = "신뢰도가 높은 예제의 가중치를 키운다고 설명했고 구체적인 식은 설명하지 못한다고 답했다."
    rows[0]["answer"] = [{"text": wrong, "segmentIds": ["s2"]}]
    rows[0]["briefInterviewerContext"] = ["어려운 예제에 집중하라고 설명함."]
    original = copy.deepcopy(rows)
    class Model:
        calls = 0
        def generate(self, schema, task, data, validate=None):
            self.calls += 1
            first = data["items"][0]
            assert first["answer"] == [wrong]
            assert first["interviewerHints"] == rows[0]["briefInterviewerContext"]
            assert first["answerTargetCharacters"] == max(15, round(len(wrong) / 4))
            assert "resumeClaimIds" not in str(data) and "uncertainty" not in str(data)
            value = schema(q1={"topic": "ML", "question": "가중치 방향은?", "answer": ["높은 신뢰도에 가중치 증가, 식은 설명 못함."], "hint": "어려운 예제에 집중하도록 보충"},
                           q2={"topic": "ML", "question": "다른 질문", "answer": [], "hint": None})
            validate(value)
            return value
    model = Model()
    result = concise_reading_notes(rows, model, store.cached, "ko", lambda: None)
    assert result[0]["readingNotes"]["answer"] == ["높은 신뢰도에 가중치 증가, 식은 설명 못함."]
    assert result[1]["readingNotes"]["answer"] == []
    assert rows == original
    assert concise_reading_notes(rows, model, store.cached, "ko", lambda: None) == result
    assert model.calls == 1


def test_reading_copy_cannot_invent_an_answer_to_an_empty_recording():
    rows, store = exchanges()[1:], FakeStore(None)
    class Model:
        def generate(self, schema, task, data, validate=None):
            value = schema(q2={"topic": "ML", "question": "질문", "answer": ["Invented answer"], "hint": None})
            validate(value)
            return value
    assert concise_reading_notes(rows, Model(), store.cached, "ko", lambda: None) == rows


def test_korean_resume_reading_copy_preserves_status_evidence_and_original_review():
    reviews = [{"claimId": "r1", "status": "not_tested", "explanation": "This topic was not probed.",
                "exchangeIds": [], "affectedCriteria": []}]
    claims = [{"id": "r1", "text": "Distributed training expertise."}]
    original = copy.deepcopy(reviews)
    class Model:
        def generate(self, schema, task, data, validate=None):
            assert data["notesLanguage"] == "ko"
            assert data["items"][0]["status"] == "not_tested"
            value = schema(r1={"claim": "분산 학습 경험", "explanation": "면접에서 구체적으로 검증하지 않은 항목입니다."})
            validate(value)
            return value
    result = korean_resume_notes(reviews, claims, Model(), FakeStore(None).cached, lambda: None)
    assert reviews == original
    assert result[0]["status"] == "not_tested" and result[0]["exchangeIds"] == []
    assert result[0]["readingNotes"]["explanation"] == "면접에서 구체적으로 검증하지 않은 항목입니다."
