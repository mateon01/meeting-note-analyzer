from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from lecture_study.main import HEARTBEAT_DELAYS, heartbeat_loop
from lecture_study.model import failure_code


class Stop:
    def __init__(self, cancel_delay=None):
        self.waits = []
        self.cancel_delay = cancel_delay

    def wait(self, delay):
        self.waits.append(delay)
        return delay == self.cancel_delay or self.waits.count(120) > 1


def client_error(code):
    return ClientError({"Error": {"Code": code, "Message": "test failure"}}, "SendTaskHeartbeat")


@pytest.mark.parametrize("error", [client_error("ThrottlingException"), EndpointConnectionError(endpoint_url="https://example.test")])
def test_temporary_heartbeat_errors_recover_without_expiring_the_task(error):
    store = SimpleNamespace(record=Mock())
    sfn = SimpleNamespace(send_task_heartbeat=Mock(side_effect=[error, {}]))
    stop, errors = Stop(), []
    heartbeat_loop(store, sfn, "token", stop, errors)
    assert not errors
    assert store.record.call_count == sfn.send_task_heartbeat.call_count == 2
    assert stop.waits == [120, 1, 120]


@pytest.mark.parametrize("code", ["ProvisionedThroughputExceededException", "RequestLimitExceeded", "InternalServerError"])
def test_transient_lease_reads_retry_before_sending_the_heartbeat(code):
    store = SimpleNamespace(record=Mock(side_effect=[client_error(code), {}]))
    sfn = SimpleNamespace(send_task_heartbeat=Mock())
    errors = []
    heartbeat_loop(store, sfn, "token", Stop(), errors)
    assert not errors
    assert store.record.call_count == 2
    sfn.send_task_heartbeat.assert_called_once_with(taskToken="token")


@pytest.mark.parametrize("code", ["TaskTimedOut", "InvalidToken", "TaskDoesNotExist", "AccessDeniedException"])
def test_terminal_heartbeat_errors_stop_without_retry(code):
    error = client_error(code)
    store = SimpleNamespace(record=Mock())
    sfn = SimpleNamespace(send_task_heartbeat=Mock(side_effect=error))
    stop, errors = Stop(), []
    heartbeat_loop(store, sfn, "token", stop, errors)
    assert errors == [error]
    assert stop.waits == [120]
    assert failure_code(errors[0]) == "LectureAnalysisFailed"


def test_lost_execution_lease_stops_before_sending_a_heartbeat():
    error = RuntimeError("Lecture execution is no longer active")
    store = SimpleNamespace(record=Mock(side_effect=error))
    sfn = SimpleNamespace(send_task_heartbeat=Mock())
    errors = []
    heartbeat_loop(store, sfn, "token", Stop(), errors)
    assert errors == [error]
    sfn.send_task_heartbeat.assert_not_called()


def test_exhausted_heartbeat_retries_preserve_the_transient_error():
    error = client_error("ThrottlingException")
    store = SimpleNamespace(record=Mock())
    sfn = SimpleNamespace(send_task_heartbeat=Mock(side_effect=error))
    stop, errors = Stop(), []
    heartbeat_loop(store, sfn, "token", stop, errors)
    assert errors == [error]
    assert failure_code(errors[0]) == "LectureTransient"
    assert stop.waits == [120, *HEARTBEAT_DELAYS]
    assert sfn.send_task_heartbeat.call_count == len(HEARTBEAT_DELAYS) + 1


def test_shutdown_interrupts_heartbeat_backoff():
    store = SimpleNamespace(record=Mock())
    sfn = SimpleNamespace(send_task_heartbeat=Mock(side_effect=client_error("ThrottlingException")))
    errors = []
    heartbeat_loop(store, sfn, "token", Stop(cancel_delay=1), errors)
    assert not errors
    assert sfn.send_task_heartbeat.call_count == 1
