from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

from lecture_study import main


def client_error(code):
    return ClientError({"Error": {"Code": code, "Message": "test failure"}}, "Converse")


class ClaimTable:
    """In-memory conditional writes for exercising callback and redelivery order."""

    def __init__(self, record):
        self.record = record
        self.fail_retry_write = False

    def update_item(self, **kwargs):
        values = kwargs["ExpressionAttributeValues"]
        claim = kwargs["ExpressionAttributeNames"]["#claim"]
        current = self.record.get(claim)
        allowed = self.record["runId"] == values[":run"] and self.record["status"] == values[":active"]
        if kwargs["UpdateExpression"] == "SET #claim = :retry":
            if self.fail_retry_write:
                raise client_error("AccessDeniedException")
            allowed = allowed and current == values[":claim"]
            next_value = values[":retry"]
        else:
            allowed = allowed and (current is None or (
                ":retryPrefix" in values and current.startswith(values[":retryPrefix"]) and current < values[":retry"]
            ))
            next_value = values.get(":claim", values[":run"])
        if not allowed:
            raise client_error("ConditionalCheckFailedException")
        self.record[claim] = next_value


@pytest.fixture
def runtime(monkeypatch):
    payload = {"lectureId": "00000000-0000-0000-0000-00000000000a", "runId": "00000000-0000-0000-0000-00000000000b",
               "ownerSub": "owner", "taskToken": "token-0", "phase": "analyze", "attempt": 0}
    record = {"runId": payload["runId"], "status": "ANALYZING"}
    table = ClaimTable(record)
    work = Mock()
    sfn = SimpleNamespace(send_task_failure=Mock(), send_task_success=Mock())
    store = SimpleNamespace(table=table, key={"PK": "test", "SK": "META"}, record=lambda: record, update=lambda **fields: record.update(fields))

    class Thread:
        def __init__(self, target, args=(), **kwargs): self.target, self.args = target, args
        def start(self):
            if self.target is main.run: self.target(*self.args)
        def join(self, **kwargs): pass

    monkeypatch.setattr(main, "Store", lambda request: store)
    monkeypatch.setattr(main, "analyze", work)
    monkeypatch.setattr(main, "prepare_video", work)
    monkeypatch.setattr(main.boto3, "client", lambda name, **kwargs: sfn)
    monkeypatch.setattr(main.threading, "Thread", Thread)
    monkeypatch.setattr(main.app, "add_async_task", Mock(return_value=1))
    monkeypatch.setattr(main.app, "complete_async_task", Mock())
    return SimpleNamespace(payload=payload, record=record, table=table, work=work, sfn=sfn)


@pytest.mark.parametrize("phase,claim,status", [("prepare", "prepareClaim", "PREPARING"), ("analyze", "analysisClaim", "ANALYZING")])
def test_transient_retries_run_again_but_old_and_duplicate_attempts_do_not(runtime, phase, claim, status):
    runtime.payload["phase"] = phase
    runtime.record["status"] = status
    runtime.work.side_effect = [client_error("ServiceUnavailableException"), client_error("ThrottlingException"), {"done": True}]
    for attempt in range(3):
        payload = {**runtime.payload, "attempt": attempt, "taskToken": f"token-{attempt}"}
        assert main.invoke(payload) == {"status": "accepted"}
        assert runtime.work.call_count == attempt + 1
        # Replaying any previous attempt must not reclaim the phase, even between retries.
        for old in range(attempt + 1):
            assert main.invoke({**runtime.payload, "attempt": old, "taskToken": f"token-{old}"}) == {"status": "accepted", "duplicate": True}
        assert runtime.work.call_count == attempt + 1
    assert [call.kwargs["error"] for call in runtime.sfn.send_task_failure.call_args_list] == ["LectureTransient", "LectureTransient"]
    runtime.sfn.send_task_success.assert_called_once_with(taskToken="token-2", output='{"done": true}')
    assert runtime.record[claim] == f"{runtime.payload['runId']}:0000000002"


def test_runtime_retry_count_can_skip_attempts_that_never_started(runtime):
    runtime.work.side_effect = [client_error("ServiceUnavailableException"), {"done": True}]
    main.invoke(runtime.payload)
    assert main.invoke({**runtime.payload, "attempt": 10, "taskToken": "token-10"}) == {"status": "accepted"}
    assert runtime.work.call_count == 2
    assert main.invoke({**runtime.payload, "attempt": 9, "taskToken": "token-9"})["duplicate"] is True


def test_stale_failure_cannot_release_a_newer_run_claim(runtime):
    def interrupted(*args):
        runtime.record.update(runId="new-run", analysisClaim="new-run:0000000000")
        raise client_error("ServiceUnavailableException")
    runtime.work.side_effect = interrupted
    main.invoke(runtime.payload)
    assert runtime.record["analysisClaim"] == "new-run:0000000000"
    assert runtime.sfn.send_task_failure.call_args.kwargs["error"] == "LectureAnalysisFailed"


def test_failure_to_prepare_retry_is_reported_without_scheduling_a_blocked_attempt(runtime):
    runtime.table.fail_retry_write = True
    runtime.work.side_effect = client_error("ServiceUnavailableException")
    main.invoke(runtime.payload)
    assert runtime.sfn.send_task_failure.call_args.kwargs["error"] == "LectureAnalysisFailed"
    assert main.invoke(runtime.payload)["duplicate"] is True
    assert runtime.work.call_count == 1


def test_permanent_errors_keep_the_claim_and_do_not_request_a_retry(runtime):
    runtime.work.side_effect = ValueError("invalid lecture")
    main.invoke(runtime.payload)
    assert runtime.sfn.send_task_failure.call_args.kwargs["error"] == "LectureAnalysisFailed"
    assert not runtime.record["analysisClaim"].startswith("retry:")
    assert main.invoke(runtime.payload)["duplicate"] is True


def test_old_payloads_default_to_the_first_attempt(runtime):
    runtime.work.return_value = {"done": True}
    del runtime.payload["attempt"]
    assert main.invoke(runtime.payload) == {"status": "accepted"}
    assert runtime.record["analysisClaim"].endswith(":0000000000")


@pytest.mark.parametrize("code,expected", [("ThrottlingException", "LectureTransient"), ("TaskTimedOut", "LectureAnalysisFailed")])
def test_heartbeat_failure_keeps_its_classification_in_the_runtime(runtime, monkeypatch, code, expected):
    error = client_error(code)
    def heartbeat(store, sfn, token, stop, errors):
        errors.append(error)
    monkeypatch.setattr(main, "heartbeat_loop", heartbeat)

    class Thread:
        def __init__(self, target, args=(), **kwargs): self.target, self.args = target, args
        def start(self): self.target(*self.args)
        def join(self, **kwargs): pass

    monkeypatch.setattr(main.threading, "Thread", Thread)
    runtime.work.side_effect = lambda store, workdir, check: check()
    main.invoke(runtime.payload)
    assert runtime.sfn.send_task_failure.call_args.kwargs["error"] == expected
    assert runtime.record["analysisClaim"].startswith("retry:") == (expected == "LectureTransient")
    runtime.sfn.send_task_success.assert_not_called()
