"""AgentCore background task, fenced by a DynamoDB execution lease and Step Functions heartbeat."""
import logging
import tempfile
import threading
import time
from pathlib import Path

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from botocore.exceptions import ClientError

from .pipeline import analyze
from .model import failure_code
from .schemas import Request
from .store import Store
from .video import prepare_video
from .search import gateway_check

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)
app = BedrockAgentCoreApp()


def claim_id(request: Request) -> str:
    # Fixed-width attempt numbers preserve ordering in DynamoDB string comparisons.
    return f"{request.runId}:{request.attempt:010d}"


def run(request: Request, store: Store, task_id: int):
    sfn = boto3.client("stepfunctions")
    stop, dead = threading.Event(), threading.Event()

    def heartbeat():
        while not stop.wait(120):
            try:
                store.record()
                sfn.send_task_heartbeat(taskToken=request.taskToken)
            except Exception:
                dead.set()
                return

    last_checked, check_lock = [0.0], threading.Lock()

    def check():
        if dead.is_set():
            raise RuntimeError("Lecture task expired")
        with check_lock:
            # Worker threads call this before every model attempt; one consistent read every few seconds is enough.
            if time.monotonic() - last_checked[0] < 5:
                return
            last_checked[0] = time.monotonic()
        store.record()

    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="lecture-") as tmp:
            result = prepare_video(store, Path(tmp), check) if request.phase == "prepare" else analyze(store, Path(tmp), check)
            if request.phase == "prepare":
                store.update(**result)
        check()
        import json
        sfn.send_task_success(taskToken=request.taskToken, output=json.dumps(result))
    except Exception as exc:
        log.exception("lecture run failed lecture=%s", request.lectureId)
        error = failure_code(exc)
        if error == "LectureTransient":
            try:
                # Only a newer Step Functions attempt may resume this phase; earlier attempts remain duplicates.
                store.table.update_item(Key=store.key, UpdateExpression="SET #claim = :retry",
                    ConditionExpression="runId = :run AND #status = :active AND #claim = :claim",
                    ExpressionAttributeNames={"#status": "status", "#claim": "prepareClaim" if request.phase == "prepare" else "analysisClaim"},
                    ExpressionAttributeValues={":run": request.runId, ":active": request.expected_status, ":claim": claim_id(request), ":retry": "retry:" + claim_id(request)})
            except Exception:
                # Never report a retryable failure if the next attempt cannot acquire the phase.
                log.exception("unable to prepare lecture retry lecture=%s", request.lectureId)
                error = "LectureAnalysisFailed"
        try:
            sfn.send_task_failure(taskToken=request.taskToken, error=error, cause=str(exc)[:2000])
        except Exception:
            log.warning("lecture task token already expired")
    finally:
        stop.set()
        thread.join(timeout=2)
        app.complete_async_task(task_id)


@app.entrypoint
def invoke(payload: dict, context=None):
    if payload.get("action") == "check_search":
        # IAM-authenticated operational probe: no lecture data or model invocation.
        try:
            return gateway_check(payload.get("query"))
        except Exception as exc:
            return {"status": "failed", "error": str(exc)[:500]}
    request = Request.model_validate(payload)
    store = Store(request)
    store.record()
    claim = "prepareClaim" if request.phase == "prepare" else "analysisClaim"
    try:
        store.table.update_item(Key=store.key, UpdateExpression="SET #claim = :claim",
            ConditionExpression="runId = :run AND #status = :active AND (attribute_not_exists(#claim) OR (begins_with(#claim, :retryPrefix) AND #claim < :retry))",
            ExpressionAttributeNames={"#status": "status", "#claim": claim},
            ExpressionAttributeValues={":run": request.runId, ":active": request.expected_status, ":claim": claim_id(request), ":retryPrefix": f"retry:{request.runId}:", ":retry": "retry:" + claim_id(request)})
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return {"status": "accepted", "duplicate": True}
        raise
    task_id = app.add_async_task(f"lecture:{request.lectureId}")
    threading.Thread(target=run, args=(request, store, task_id), daemon=True).start()
    return {"status": "accepted"}


if __name__ == "__main__":
    app.run()
