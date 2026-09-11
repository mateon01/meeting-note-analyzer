import threading
import time

import pytest

from lecture_study.model import Model
from lecture_study.parallel import parallel_map


def test_results_keep_input_order_while_running_concurrently(monkeypatch):
    monkeypatch.setenv("LECTURE_WORKERS", "4")
    active, peak, lock = [0], [0], threading.Lock()
    def work(item):
        with lock:
            active[0] += 1; peak[0] = max(peak[0], active[0])
        time.sleep(0.05 * (5 - item))  # earlier items finish later
        with lock:
            active[0] -= 1
        return item * 10
    done = []
    assert parallel_map(range(5), work, check=lambda: None, on_done=done.append) == [0, 10, 20, 30, 40]
    assert peak[0] > 1 and done == [1, 2, 3, 4, 5]


def test_first_failure_stops_the_batch_and_propagates(monkeypatch):
    monkeypatch.setenv("LECTURE_WORKERS", "2")
    started = []
    def work(item):
        started.append(item)
        if item == 1: raise ValueError("boom")
        time.sleep(0.02)
        return item
    with pytest.raises(ValueError, match="boom"):
        parallel_map(range(50), work, check=lambda: None)
    assert len(started) < 50


def test_check_runs_in_the_calling_thread_and_can_abort(monkeypatch):
    monkeypatch.setenv("LECTURE_WORKERS", "2")
    checks = []
    def check():
        checks.append(threading.current_thread().name)
        if len(checks) > 1: raise RuntimeError("Lecture task expired")
    with pytest.raises(RuntimeError, match="expired"):
        parallel_map(range(4), lambda item: time.sleep(0.2) or item, check=check, check_interval=0.05)
    assert set(checks) == {threading.current_thread().name}


def test_model_counters_are_thread_safe(monkeypatch):
    monkeypatch.setenv("LECTURE_WORKERS", "8")
    from lecture_study.schemas import Alignment
    class Client:
        def converse(self, **kwargs):
            time.sleep(0.001)
            return {"stopReason": "tool_use", "usage": {"inputTokens": 3, "outputTokens": 1}, "output": {"message": {"content": [{"toolUse": {"name": "deliver", "input": {"assignments": []}}}]}}}
    model = Model(client=Client())
    parallel_map(range(200), lambda _: model.generate(Alignment, "align", {}), check=lambda: None)
    assert model.metrics() == {"modelCalls": 200, "modelCallLimit": 800, "inputTokens": 600, "outputTokens": 200}
