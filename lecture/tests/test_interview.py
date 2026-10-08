import copy
import json
import pytest

from lecture_study.interview import analyze_interview, assessment_evidence, clean_feedback_markers, comparison_context, generate_answer, generate_assessment, validate_answer, validate_assessment, validate_resume_comparison
from lecture_study.interview_schemas import InterviewAnswer, InterviewAssessment, InterviewRoster, QuestionIndex, ResumeClaims, ResumeComparison, ResumePage, GroundedPoint, scoped_answer_schema, scoped_assessment_schema
from test_pipeline import FakeStore


def store():
    value = FakeStore(None)
    value.prefix = "interview-results/test/"
    value.rec = {"interviewId": "test", "title": "ML interview", "transcriptKey": "transcript", "settings": {
        "targetLevel": "L6", "criteria": ["domain_depth", "dive_deep"], "roleTitle": "ML engineer", "roleContext": "",
        "notesLanguage": "ko", "opinionLanguage": "en", "interviewerNotes": "면접관이 남긴 별도 메모", "speakerRoles": {},
    }}
    value.values["transcript"] = {"durationSec": 70, "language": "ko", "segments": [
        {"id": "s1", "start": 0, "end": 5, "speaker": "S1", "text": "Focal loss를 설명해 주세요."},
        {"id": "s2", "start": 6, "end": 20, "speaker": "S2", "text": "신뢰도가 높은 예제의 가중치를 키웁니다."},
        {"id": "s3", "start": 21, "end": 25, "speaker": "S1", "text": "어려운 예제에 집중하는 것이 핵심입니다."},
        {"id": "s4", "start": 26, "end": 40, "speaker": "S2", "text": "라이브러리를 사용했고 식은 설명하지 못하겠습니다."},
        {"id": "s5", "start": 41, "end": 45, "speaker": "S1", "text": "실제 성능은 어떻게 확인했나요?"},
        {"id": "s6", "start": 46, "end": 70, "speaker": "S2", "text": "검증셋 정확도를 비교했지만 온라인 A/B 테스트는 하지 않았습니다."},
    ]}
    return value


class Model:
    def __init__(self, confidence=0.95, candidate_role="candidate"):
        self.calls, self.inputs, self.confidence, self.candidate_role = [], [], confidence, candidate_role
    def generate(self, schema, task, data, validate=None, **kwargs):
        self.calls.append(schema); self.inputs.append(copy.deepcopy(data))
        if schema == InterviewRoster:
            value = {"speakers": [
                {"id": "S1", "role": "interviewer", "label": "S1", "confidence": 0.99, "evidenceSegmentIds": ["s1"]},
                {"id": "S2", "role": self.candidate_role, "label": "S2", "confidence": self.confidence, "evidenceSegmentIds": ["s2"]},
            ], "limitations": []}
        elif schema == QuestionIndex:
            value = {"questions": [
                {"segmentId": "s1", "topic": "ML", "question": "Focal loss를 설명해 주세요.", "kind": "primary", "parentSegmentId": None},
                {"segmentId": "s5", "topic": "ML", "question": "성능 검증 방법은?", "kind": "follow_up", "parentSegmentId": "s1"},
            ]}
        elif issubclass(schema, InterviewAnswer):
            first = data["speech"][0]["id"] == "s1"
            value = {"question": data["question"], "answer": [
                {"text": "신뢰도가 높은 예제의 가중치를 키운다고 설명했다.", "segmentIds": ["s2"]},
                {"text": "라이브러리를 사용했고 수식은 설명하지 못한다고 했다.", "segmentIds": ["s4"]},
            ] if first else [{"text": "검증셋 비교는 했고 온라인 A/B 테스트는 하지 않았다.", "segmentIds": ["s6"]}],
                "interviewerContext": [{"text": "면접관이 어려운 예제에 집중한다는 힌트를 제공했다.", "segmentIds": ["s3"]}] if first else [], "uncertainty": []}
        elif schema.__name__ == "InterviewerHints":
            value = {q["id"]: ["어려운 예제에 집중하라는 힌트를 제공함."] for q in data["questions"]}
        elif schema.__name__ == "InterviewReadingNotes":
            value = {q["id"]: {"topic": "ML", "question": q["question"], "answer": q["answer"][:1],
                              "hint": q["interviewerHints"][0] if q["interviewerHints"] else None} for q in data["items"]}
        elif schema.__name__ == "ResumeReadingNotes":
            value = {item["id"]: {"claim": "손실 함수 전문성", "explanation": "답변에서 이력서 주장과의 차이가 확인됐습니다."} for item in data["items"]}
        elif schema.__name__ == "InterviewOverallSummary":
            value = {"barAssessment": "below_bar", "reason": "based on the demonstrated gap in the probed core concept.",
                     "rationale": "The candidate reversed the loss weighting and could not explain the formula independently. The observed answer did not establish the requested depth for the target role."}
        else:
            assert issubclass(schema, InterviewAssessment)
            assert "interviewerNotes" not in data
            assert "criterionGuide" in data
            if data["criterion"] == "domain_depth":
                value = {"rating": 2, "evidenceStatus": "sufficient", "positives": [],
                         "concerns": [{"text": "The candidate reversed the weighting behavior and could not derive the loss independently.", "exchangeIds": ["q1"]}],
                         "levelAssessment": "This answer did not establish the requested depth for the target role.", "followUps": ["Ask for the loss equation and one numerical example."]}
            else:
                value = {"rating": None, "evidenceStatus": "not_observed", "positives": [], "concerns": [],
                         "levelAssessment": "A troubleshooting example was not elicited.", "followUps": ["Ask for a concrete debugging case."]}
        result = schema.model_validate(value)
        if validate: validate(result)
        return result


def test_interview_preserves_wrong_answers_hints_followups_and_grounded_opinions():
    data, model = store(), Model()
    result = analyze_interview(data, lambda: None, model=model)
    doc = data.values[data.prefix + data.run_prefix + "document.json"]
    first, followup = doc["exchanges"]
    assert first["answer"][0]["text"].startswith("신뢰도가 높은")
    assert first["interviewerContext"][0]["segmentIds"] == ["s3"]
    assert followup["parentId"] == "q1" and followup["questionKind"] == "follow_up"
    assert first["evidence"][1]["text"] == data.values["transcript"]["segments"][1]["text"]
    assert [a["rating"] for a in doc["assessments"]] == [2, None]
    assert doc["overallSummary"]["recommendation"] == "Not Inclined"
    assert doc["overallSummary"]["exchangeIds"] == ["q1"]
    assert result == {"documentKey": data.prefix + data.run_prefix + "document.json", "markdownKey": data.prefix + data.run_prefix + "interview.md"}
    md = data.files[data.run_prefix + "interview.md"].decode()
    assert "**2: Mild Concern**" in md and "**근거 부족 — 미평가**" in md
    assert "면접관의 힌트" in md and "f/u Q" in md
    assert "면접관이 별도로 입력한 메모" in md and "AI 평가 의견" in md
    assert md.index("### Summary") < md.index("### Domain Depth")
    assert "**Not Inclined**" in md
    assert "FSDP" not in json.dumps(doc) and not any("metadata" in key for key in data.files)
    calls = list(model.calls)
    analyze_interview(data, lambda: None, model=model)
    assert model.calls == calls  # Same recording/settings can resume without new model calls.


def test_unknown_candidate_role_holds_scores_until_the_user_confirms_it():
    data, model = store(), Model(confidence=0.5, candidate_role="unknown")
    analyze_interview(data, lambda: None, model=model)
    doc = data.values[data.prefix + data.run_prefix + "document.json"]
    assert all(a["rating"] is None for a in doc["assessments"])
    assert doc["overallSummary"] is None
    assert not any(issubclass(schema, InterviewAssessment) for schema in model.calls)
    assert data.rec["speakerHints"][1]["confidence"] == 0.5
    data.rec["settings"]["speakerRoles"] = {"S1": "interviewer", "S2": "candidate"}
    analyze_interview(data, lambda: None, model=model)
    doc = data.values[data.prefix + data.run_prefix + "document.json"]
    assert all(s["confirmedByUser"] for s in doc["speakers"])
    assert doc["assessments"][0]["rating"] == 2


def test_inferred_role_confidence_does_not_blanket_block_attributable_answers():
    data, model = store(), Model(confidence=0.84)
    analyze_interview(data, lambda: None, model=model)
    doc = data.values[data.prefix + data.run_prefix + "document.json"]
    assert doc["assessments"][0]["rating"] == 2
    assert doc["assessments"][1]["rating"] is None  # Unasked competency is still not scored.
    assert doc["speakers"][1]["confidence"] == 0.84
    assert doc["speakers"][1]["confirmedByUser"] is False
    assert any("자동" in item for item in doc["limitations"])


def test_ambiguous_answers_are_excluded_individually_instead_of_blocking_the_interview():
    segments = [{"id": "s1", "speaker": "S1"}, {"id": "s2", "speaker": "S2"}, {"id": "s3", "speaker": "S3"}]
    exchanges = [
        {"id": "q1", "topic": "T", "question": "Q", "interviewerId": "S1", "interviewerContext": [], "uncertainty": [],
         "answer": [{"text": "Known answer", "segmentIds": ["s2"]}, {"text": "Ambiguous answer", "segmentIds": ["s3"]}]},
        {"id": "q2", "topic": "T", "question": "Q2", "interviewerId": "S3", "interviewerContext": [], "uncertainty": [],
         "answer": [{"text": "Unknown question attribution", "segmentIds": ["s2"]}]},
    ]
    rows, omitted = assessment_evidence(exchanges, segments, {"S1": "interviewer", "S2": "candidate", "S3": "unknown"}, "en")
    assert len(rows) == 1 and omitted == 1
    assert rows[0]["answer"] == [{"text": "Known answer", "segmentIds": ["s2"]}]
    assert "not evidence of weak competence" in rows[0]["uncertainty"][-1]
    assert len(exchanges[0]["answer"]) == 2  # Full original notes remain available.


def test_hints_cannot_be_credited_as_candidate_answers():
    value = InterviewAnswer.model_validate({"question": "Q", "answer": [{"text": "Correct explanation", "segmentIds": ["s3"]}], "interviewerContext": [], "uncertainty": []})
    with pytest.raises(ValueError, match="appropriate role"):
        validate_answer(value, store().values["transcript"]["segments"], {"S1": "interviewer", "S2": "candidate"})


@pytest.mark.parametrize("changes", [
    {"rating": 1, "evidenceStatus": "not_observed"},
    {"rating": 3, "evidenceStatus": "limited"},
    {"rating": 4, "concerns": [{"text": "Invented", "exchangeIds": ["q999"]}]},
    {"rating": 5, "positives": [{"text": "One example", "exchangeIds": ["q1"]}]},
])
def test_assessment_rejects_unobserved_scores_invented_citations_and_unsupported_strength(changes):
    value = InterviewAssessment.model_validate({"rating": None, "evidenceStatus": "sufficient", "positives": [], "concerns": [],
                                                "levelAssessment": "Review", "followUps": [], **changes})
    with pytest.raises(ValueError):
        validate_assessment(value, [{"id": "q1"}])


def test_resume_context_stays_separate_and_confirmed_gap_is_carried_into_rating(tmp_path):
    import pymupdf
    pdf = tmp_path / "resume.pdf"
    with pymupdf.open() as document:
        document.new_page().insert_text((30, 30), "Expert-level understanding of focal loss and imbalanced classification.")
        document.save(pdf)
    data = store()
    data.rec["assets"] = {"resume": {"key": str(pdf), "fileName": "resume.pdf", "etag": "resume-v1"}}
    class ResumeModel(Model):
        def generate(self, schema, task, request, validate=None, **kwargs):
            if schema == ResumePage:
                value = schema(claims=["Expert-level understanding of focal loss."])
            elif schema == ResumeClaims:
                value = schema(claims=[{"text": "Expert-level understanding of focal loss.", "pages": [1]}])
            elif schema == ResumeComparison:
                value = schema(status="gap", explanation="The resume claims expert-level understanding, but the candidate reversed the weighting and could not explain the formula.",
                               exchangeIds=["q1"], affectedCriteria=["domain_depth"])
            else:
                value = super().generate(schema, task, request, validate=None, **kwargs)
                if issubclass(schema, InterviewAnswer):
                    assert request["resumeContext"][0]["id"] == "r1"
                    value.resumeClaimIds = ["r1"]
                if issubclass(schema, InterviewAssessment) and request["criterion"] == "domain_depth":
                    assert request["resumeComparisons"][0]["status"] == "gap"
                    value.rating = 1
                    value.concerns[0].text += " This also falls short of the explicit expert-level resume claim."
            if validate: validate(value)
            return value
    analyze_interview(data, lambda: None, model=ResumeModel())
    document = data.values[data.prefix + data.run_prefix + "document.json"]
    assert document["resume"]["claims"][0]["pages"] == [1]
    assert document["resumeComparisons"][0]["status"] == "gap"
    assert document["assessments"][0]["rating"] == 1
    assert "Expert-level" not in document["exchanges"][0]["answer"][0]["text"]
    text = data.files[data.run_prefix + "interview.md"].decode()
    assert "이력서 주장과 면접 답변 대조" in text and "역량 격차 확인" in text
    assert "<summary>이력서 대조 상세 (1개)</summary>" in text
    assert "면접 근거: q1" in text


def test_untested_resume_claims_cannot_become_penalties_or_bonuses():
    review = {"claimId": "r1", "status": "not_tested", "exchangeIds": [], "affectedCriteria": ["domain_depth"]}
    # Resume-only evidence cannot support a score: opinion points need interview question references.
    value = InterviewAssessment(rating=3, evidenceStatus="sufficient", positives=[], concerns=[], levelAssessment="Review", followUps=[])
    with pytest.raises(ValueError, match="rating requires concrete interview evidence"):
        validate_assessment(value, [{"id": "q1"}], [review], "domain_depth")
    value = ResumeComparison(status="gap", explanation="No question was asked", exchangeIds=[], affectedCriteria=["domain_depth"])
    with pytest.raises(ValueError, match="without interview evidence"):
        validate_resume_comparison(value, [{"id": "q1"}], ["domain_depth"])
    related = ResumeComparison(status="not_tested", explanation="The project was mentioned but this skill was not probed.",
                               exchangeIds=["q1"], affectedCriteria=["domain_depth"])
    validate_resume_comparison(related, [{"id": "q1"}], ["domain_depth"])


def test_confirmed_resume_gap_cannot_be_ignored_in_an_optimistic_rating():
    value = InterviewAssessment(rating=4, evidenceStatus="sufficient", positives=[{"text": "Good project", "exchangeIds": ["q1"]}],
                                concerns=[], levelAssessment="Strong", followUps=[])
    with pytest.raises(ValueError, match="negative evidence"):
        validate_assessment(value, [{"id": "q1"}], [{"claimId": "r1", "status": "gap", "exchangeIds": ["q1"], "affectedCriteria": ["domain_depth"]}], "domain_depth")


def test_related_resume_gaps_can_share_a_concern_and_all_references_are_exported():
    from lecture_study.interview_export import markdown
    reviews = [{"claimId": rid, "status": "gap", "exchangeIds": ["q1"], "affectedCriteria": ["domain_depth"],
                "explanation": "Related skill claim exceeds the demonstrated depth."} for rid in ["r1", "r2"]]
    value = InterviewAssessment(rating=2, evidenceStatus="sufficient", positives=[],
        concerns=[{"text": "The related expert-level claims were not supported by the answer.", "exchangeIds": ["q1"]}],
        levelAssessment="Concrete concerns on the probed skill.", followUps=[])
    validate_assessment(value, [{"id": "q1"}], reviews, "domain_depth")
    data, model = store(), Model()
    analyze_interview(data, lambda: None, model=model)
    doc = data.values[data.prefix + data.run_prefix + "document.json"]
    doc["resume"] = {"fileName": "resume.pdf", "claims": [
        {"id": rid, "text": "Related expert-level claim", "pages": [1]} for rid in ["r1", "r2"]]}
    doc["resumeComparisons"] = reviews
    doc["assessments"] = [{"criterion": "domain_depth", **value.model_dump()}]
    text = markdown(doc)
    opinion = text.split("## AI 평가 의견", 1)[1].split("## 이력서 주장", 1)[0]
    assert "r1" not in opinion and "r2" not in opinion
    assert "### r1:" in text and "### r2:" in text
    assert "면접 근거: q1" in opinion.split("<details>", 1)[1]


def test_limited_but_relevant_evidence_can_receive_a_labeled_provisional_rating():
    from lecture_study.interview_export import markdown
    value = InterviewAssessment(rating=2, evidenceStatus="limited", positives=[],
        concerns=[{"text": "A material gap in the probed concept.", "exchangeIds": ["q1"]}],
        levelAssessment="The rating is provisional and limited to this observed topic.", followUps=[])
    validate_assessment(value, [{"id": "q1"}])
    data = store()
    analyze_interview(data, lambda: None, model=Model())
    doc = data.values[data.prefix + data.run_prefix + "document.json"]
    doc["assessments"] = [{"criterion": "domain_depth", **value.model_dump()}]
    assert "잠정 평가" in markdown(doc)
    value.rating = None
    with pytest.raises(ValueError, match="provisional rating"):
        validate_assessment(value, [{"id": "q1"}])
    value.rating = 5
    with pytest.raises(ValueError, match="sufficient evidence"):
        validate_assessment(value, [{"id": "q1"}])


def test_opinion_schema_does_not_require_the_model_to_recreate_resume_reference_metadata():
    from pydantic import ValidationError
    value = {"rating": 2, "evidenceStatus": "sufficient", "positives": [],
             "concerns": [{"text": "Observed shortfall", "exchangeIds": ["q1"]}],
             "levelAssessment": "Review", "followUps": []}
    InterviewAssessment.model_validate(value)
    value["concerns"][0]["resumeClaimIds"] = ["invented"]  # Resume references are attached from validated comparisons.
    with pytest.raises(ValidationError):
        InterviewAssessment.model_validate(value)


def test_assessment_schema_requires_real_question_citations_for_every_point():
    from pydantic import ValidationError
    schema = scoped_assessment_schema(["q1", "q2"])
    valid = {"rating": 3, "evidenceStatus": "sufficient",
             "positives": [{"text": "A demonstrated skill", "exchangeIds": ["q1"]}],
             "concerns": [{"text": "An observed gap", "exchangeIds": ["q2"]}],
             "levelAssessment": "Mixed evidence", "followUps": []}
    schema.model_validate(valid)
    for field in ("positives", "concerns"):
        for point in [
            {"text": "Missing references"},
            {"text": "Empty references", "exchangeIds": []},
            {"text": "Resume alone", "exchangeIds": ["r1"]},
            {"text": "Invented question", "exchangeIds": ["q999"]},
            {"text": "Obsolete field", "exchangeIds": ["q1"], "resumeClaimIds": ["r1"]},
        ]:
            with pytest.raises(ValidationError):
                schema.model_validate({**valid, field: [point]})
    definition = schema.model_json_schema()["$defs"]["AssessmentEvidence"]
    assert "exchangeIds" in definition["required"]
    assert definition["properties"]["exchangeIds"]["items"]["enum"] == ["q1", "q2"]
    assert definition["additionalProperties"] is False


def test_assessment_merge_can_only_cite_evidence_in_its_selected_partials():
    from pydantic import ValidationError
    partial = {"rating": 3, "evidenceStatus": "limited",
               "positives": [{"text": "Observed strength", "exchangeIds": ["q1"]}],
               "concerns": [{"text": "Observed gap", "exchangeIds": ["q2"]}],
               "levelAssessment": "Provisional", "followUps": []}
    class MergeModel:
        def generate(self, schema, task, data, validate=None):
            assert data["evidencePolicy"]["exchangeIds"] == ["q1", "q2"]
            assert data["partialAssessments"] == [partial]
            with pytest.raises(ValidationError):
                schema.model_validate({**partial, "positives": [{"text": "Unseen evidence", "exchangeIds": ["q3"]}]})
            value = schema.model_validate(partial)
            validate(value)
            return value
    result = generate_assessment(MergeModel(), {}, [{"id": "q1"}, {"id": "q2"}, {"id": "q3"}], [], None, [partial])
    assert result == partial


def test_feedback_refresh_preserves_detailed_paragraphs_citations_and_cached_source_notes(monkeypatch):
    import lecture_study.interview as module
    data = store()
    with monkeypatch.context() as legacy:
        legacy.setattr(module, "ASSESSMENT_VERSION", "v6")
        analyze_interview(data, lambda: None, model=Model())
    old_document = copy.deepcopy(data.values[data.prefix + data.run_prefix + "document.json"])
    paragraphs = [("Reported validation work with explicit outcome limitations. " * 14).strip(),
                  "This second finding groups distinct implementation evidence.",
                  "The observed misconception remains a material gap in the selected competency."]
    class NarrativeModel(Model):
        def generate(self, schema, task, source, validate=None, **kwargs):
            if issubclass(schema, InterviewAssessment) and source["criterion"] == "domain_depth":
                self.calls.append(schema)
                result = schema(rating=2, evidenceStatus="sufficient",
                    positives=[{"text": text, "exchangeIds": ["q2"]} for text in paragraphs[:2]],
                    concerns=[{"text": paragraphs[2], "exchangeIds": ["q1"]}],
                    levelAssessment="The material misconception is below the probed target-level requirement.", followUps=[])
                validate(result)
                return result
            return super().generate(schema, task, source, validate=validate, **kwargs)
    model = NarrativeModel()
    analyze_interview(data, lambda: None, model=model)
    document = data.values[data.prefix + data.run_prefix + "document.json"]
    assessment = document["assessments"][0]
    assert [p["text"] for p in assessment["positives"] + assessment["concerns"]] == paragraphs
    assert [p["exchangeIds"] for p in assessment["positives"] + assessment["concerns"]] == [["q2"], ["q2"], ["q1"]]
    assert document["exchanges"] == old_document["exchanges"]
    assert not any(issubclass(schema, (InterviewAnswer, InterviewRoster, QuestionIndex)) for schema in model.calls)
    markdown = data.files[data.run_prefix + "interview.md"].decode()
    assert "\n\n".join(paragraphs) in markdown
    assert "(+) " not in markdown and "(-) " not in markdown
    calls = list(model.calls)
    analyze_interview(data, lambda: None, model=model)
    assert model.calls == calls


def test_long_model_comparisons_are_preserved_while_assessment_context_stays_bounded():
    explanation = ("Evidence-backed explanation. " * 100).strip()
    comparison = ResumeComparison(status="gap", explanation=explanation, exchangeIds=["q1"], affectedCriteria=["domain_depth"])
    reviews = [{"claimId": f"r{i + 1}", **comparison.model_dump()} for i in range(60)]
    context = comparison_context(reviews)
    assert reviews[0]["explanation"] == explanation  # Published detail is not truncated.
    assert all(item["explanationTruncated"] for item in context)
    assert context[0]["exchangeIds"] == ["q1"] and context[0]["status"] == "gap"
    assert len(json.dumps(context)) < 40_000


def test_feedback_markers_are_added_only_once_without_changing_evidence():
    value = clean_feedback_markers({"positives": [{"text": "(+) Concrete example", "exchangeIds": ["q1"]}],
                                   "concerns": [{"text": "(−) (-) Conceptual gap", "exchangeIds": ["q2"], "resumeClaimIds": ["r1"]}]})
    assert value["positives"][0]["text"] == "Concrete example"
    assert value["concerns"][0] == {"text": "Conceptual gap", "exchangeIds": ["q2"], "resumeClaimIds": ["r1"]}


def test_resume_rejects_excess_pages_and_non_pdf_before_transcription(tmp_path):
    import pymupdf
    from lecture_study.interview_resume import validate_resume_file
    pdf = tmp_path / "oversized.pdf"
    with pymupdf.open() as document:
        for _ in range(21): document.new_page()
        document.save(pdf)
    data = store(); data.rec["assets"] = {"resume": {"key": str(pdf), "fileName": "resume.pdf"}}
    work = tmp_path / "work"; work.mkdir()
    with pytest.raises(ValueError, match="20페이지"):
        validate_resume_file(data, work)
    from PIL import Image
    image = tmp_path / "renamed.png"
    Image.new("RGB", (8, 8)).save(image)
    data.rec["assets"]["resume"]["key"] = str(image)
    with pytest.raises(ValueError, match="이력서"):
        validate_resume_file(data, work)


def test_interviewer_context_can_cite_both_a_hint_and_the_candidates_reaction():
    value = InterviewAnswer(question="Q", answer=[{"text": "Candidate's explanation", "segmentIds": ["s2"]}],
                            interviewerContext=[{"text": "The interviewer offered a hint, and the candidate acknowledged the limit.", "segmentIds": ["s3", "s4"]}],
                            uncertainty=[])
    validate_answer(value, store().values["transcript"]["segments"], {"S1": "interviewer", "S2": "candidate"})


def test_joint_context_does_not_allow_candidate_only_context_or_interviewer_credit():
    speech = store().values["transcript"]["segments"]
    roles = {"S1": "interviewer", "S2": "candidate"}
    value = InterviewAnswer(question="Q", answer=[], interviewerContext=[{"text": "Attributed hint", "segmentIds": ["s2"]}], uncertainty=[])
    with pytest.raises(ValueError, match=r"interviewerContext\[0\] has no interviewer evidence"):
        validate_answer(value, speech, roles)
    value.interviewerContext = []
    value.answer = [GroundedPoint(text="Borrowed interviewer knowledge", segmentIds=["s2", "s3"])]
    with pytest.raises(ValueError, match=r"answer\[0\] cites interviewer speech: s3"):
        validate_answer(value, speech, roles)


def test_tool_schema_restricts_each_field_to_available_evidence():
    from pydantic import ValidationError
    schema = scoped_answer_schema(["s2"], ["s1", "s2"], ["r1"])
    valid = {"question": "Q", "answer": [{"text": "Candidate answer", "segmentIds": ["s2"]}],
             "interviewerContext": [{"text": "Hint and reaction", "segmentIds": ["s1", "s2"]}], "uncertainty": [], "resumeClaimIds": ["r1"]}
    schema.model_validate(valid)
    for invalid in [
        {**valid, "answer": [{"text": "Borrowed hint", "segmentIds": ["s1"]}]},
        {**valid, "interviewerContext": [{"text": "Outside this question", "segmentIds": ["s999"]}]},
        {**valid, "resumeClaimIds": ["r999"]},
    ]:
        with pytest.raises(ValidationError):
            schema.model_validate(invalid)
    empty = scoped_answer_schema([], [])
    empty.model_validate({"question": "Q", "answer": [], "interviewerContext": [], "uncertainty": []})
    with pytest.raises(ValidationError):
        empty.model_validate({**valid, "resumeClaimIds": []})


def test_consolidation_keeps_roles_and_limits_evidence_to_its_partial_notes(monkeypatch):
    speech = store().values["transcript"]["segments"]
    roles = {"S1": "interviewer", "S2": "candidate"}
    monkeypatch.setattr("lecture_study.interview.transcript_batches", lambda rows, budget: [rows[:2], rows[2:4], rows[4:]])
    merges = []
    class MergeModel:
        def generate(self, schema, task, data, validate=None):
            if "speech" in data:
                assert all(s["role"] == roles[s["speaker"]] for s in data["speech"])
                candidate = next(s["id"] for s in data["speech"] if s["role"] == "candidate")
                interviewer = next(s["id"] for s in data["speech"] if s["role"] == "interviewer")
                value = {"question": "Q", "answer": [{"text": candidate, "segmentIds": [candidate]}],
                         "interviewerContext": [{"text": "Hint and reaction", "segmentIds": [interviewer, candidate]}], "uncertainty": []}
            else:
                merges.append(data)
                assert data["roles"] == roles
                value = {"question": "Q", "answer": [p for part in data["partialNotes"] for p in part["answer"]],
                         "interviewerContext": [p for part in data["partialNotes"] for p in part["interviewerContext"]], "uncertainty": []}
            result = schema.model_validate(value)
            if validate: validate(result)
            return result
    result = generate_answer(MergeModel(), {}, "Q", speech, roles, set())
    assert len(result["answer"]) == 3 and len(merges) == 2
    assert merges[0]["evidencePolicy"]["answerSegmentIds"] == ["s2", "s4"]
    assert "s6" not in merges[0]["evidencePolicy"]["contextSegmentIds"]
    assert merges[1]["evidencePolicy"]["answerSegmentIds"] == ["s2", "s4", "s6"]
