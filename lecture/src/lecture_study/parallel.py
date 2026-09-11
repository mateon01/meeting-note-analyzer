"""Page-level model work on a few threads. Results keep input order, the first error stops the batch, and the
liveness check runs in the calling thread so a cancelled task is noticed even while workers are busy."""
import os
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait


def workers() -> int:
    return max(1, min(8, int(os.environ.get("LECTURE_WORKERS", "4"))))


def parallel_map(items, fn, *, check, on_done=None, check_interval: float = 5.0) -> list:
    items = list(items)
    if not items:
        return []
    results: list = [None] * len(items)
    with ThreadPoolExecutor(max_workers=min(workers(), len(items))) as pool:
        pending = {pool.submit(fn, item): i for i, item in enumerate(items)}
        finished_count = 0
        try:
            while pending:
                finished, _ = wait(list(pending), timeout=check_interval, return_when=FIRST_COMPLETED)
                check()
                for future in finished:
                    results[pending.pop(future)] = future.result()
                    finished_count += 1
                    if on_done:
                        on_done(finished_count)
        except BaseException:
            for future in pending:
                future.cancel()
            raise
    return results
