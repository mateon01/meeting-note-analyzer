import copy
import json

import pytest

from lecture_study.interview import generate_assessment
from lecture_study.interview_schemas import scoped_assessment_schema
from lecture_study.model import Model
from lecture_study.schemas import Alignment


def response(value):
    return {"stopReason": "tool_use", "usage": {"inputTokens": 10, "outputTokens": 5},
            "output": {"message": {"content": [{"toolUse": {"name": "deliver", "input": value}}]}}}


def assessment():
    return {"rating": 3, "evidenceStatus": "sufficient",
            "positives": [{"text": "Explained the retrieval tradeoff.", "exchangeIds": ["q1"]}],
            "concerns": [{"text": "Could not explain the measured regression.", "exchangeIds": ["q2"]}],
            "levelAssessment": "Mixed evidence at the requested level.", "followUps": []}


def test_missing_assessment_citations_are_repaired_against_source_without_changing_rating():
    valid = assessment()
    invalid = copy.deepcopy(valid)
    invalid["positives"][0].pop("exchangeIds")
    invalid["positives"][0]["resumeClaimIds"] = ["r1"]
    rows = [{"id": "q1", "answer": [{"text": "I compared lexical and semantic retrieval."}]},
            {"id": "q2", "answer": [{"text": "I could not isolate the regression."}]}]

    class Client:
        calls = []
        def converse(self, **kwargs):
            self.calls.append(kwargs)
            if len(self.calls) == 1:
                return response(invalid)
            content = kwargs["messages"][0]["content"]
            source, draft, repair = [item["text"] for item in content]
            assert all(row["answer"][0]["text"] in source for row in rows)
            assert json.loads(draft.split("\n", 1)[1]) == invalid
            assert "positives.0.exchangeIds: Field required" in repair
            assert "positives.0.resumeClaimIds: Extra inputs are not permitted" in repair
            assert "Never invent references" in repair
            return response(valid)

    client = Client()
    model = Model(client=client, max_calls=3)
    result = generate_assessment(model, {}, rows, [], "domain_depth")
    assert result == valid and model.calls == 2


def test_semantic_citation_failure_uses_latest_invalid_draft_and_does_not_accept_unusable_evidence():
    drafts = [assessment() for _ in range(3)]
    drafts[0]["positives"][0].pop("exchangeIds")
    drafts[1]["positives"][0]["exchangeIds"] = ["q999"]
    drafts[2]["positives"][0]["exchangeIds"] = []
    class Client:
        calls = 0
        def converse(self, **kwargs):
            if self.calls:
                draft = kwargs["messages"][0]["content"][-2]["text"]
                assert json.loads(draft.split("\n", 1)[1]) == drafts[self.calls - 1]
            value = drafts[self.calls]
            self.calls += 1
            return response(value)
    model = Model(client=Client(), max_calls=3)
    with pytest.raises(ValueError, match="failed validation after 3 attempts") as error:
        model.generate(scoped_assessment_schema(["q1", "q2"]), "Assess", {})
    assert model.calls == 3
    assert "Explained the retrieval tradeoff" not in str(error.value)
    assert "positives.0.exchangeIds" in str(error.value)


def test_custom_evidence_validation_also_repairs_instead_of_bypassing_checks():
    invalid = assessment()
    invalid["rating"] = 5  # Only one independent positive example.
    class Client:
        calls = 0
        def converse(self, **kwargs):
            self.calls += 1
            if self.calls == 1:
                return response(invalid)
            repair = kwargs["messages"][0]["content"][-1]["text"]
            assert "multiple" in repair.lower()
            return response(assessment())
    model = Model(client=Client(), max_calls=3)
    result = generate_assessment(model, {}, [{"id": "q1"}, {"id": "q2"}], [], None)
    assert result["rating"] == 3 and model.calls == 2


def test_truncation_increases_budget_but_never_accepts_partial_tool_output():
    class Client:
        calls = []
        def converse(self, **kwargs):
            self.calls.append(kwargs)
            result = response({"assignments": []})
            result["stopReason"] = "max_tokens"
            return result
    client = Client()
    model = Model(client=client)
    with pytest.raises(ValueError, match="cut off"):
        model.generate(Alignment, "align", {}, max_output_tokens=16384)
    assert [c["inferenceConfig"]["maxTokens"] for c in client.calls] == [16384, 32768, 32768]
    assert "shorten repeated prose" in client.calls[1]["messages"][0]["content"][-1]["text"]
    assert model.metrics()["modelCalls"] == 3


def test_expanded_output_still_requires_semantically_valid_references():
    class Client:
        calls = []
        def converse(self, **kwargs):
            self.calls.append(kwargs)
            if len(self.calls) == 1:
                return {"stopReason": "max_tokens"}
            return response({"assignments": [{"page": 2, "startSegmentId": "unknown", "endSegmentId": "unknown",
                                             "confidence": 1, "reason": "Unsupported"}]})
    client = Client()
    def validate(value):
        raise ValueError("Unknown source ID")
    with pytest.raises(ValueError, match="Unknown source ID"):
        Model(client=client).generate(Alignment, "align", {}, validate=validate)
    assert [c["inferenceConfig"]["maxTokens"] for c in client.calls] == [8192, 16384, 16384]
