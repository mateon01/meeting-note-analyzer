import shutil

import pytest


def pytest_addoption(parser):
    parser.addoption("--require-media", action="store_true", help="Require real MP4 tests to run without skips")


def pytest_configure(config):
    config.addinivalue_line("markers", "media: integration tests requiring ffmpeg and ffprobe")
    missing = [binary for binary in ("ffmpeg", "ffprobe") if not shutil.which(binary)]
    if config.getoption("--require-media") and missing:
        raise pytest.UsageError(f"Required media tools are missing: {', '.join(missing)}")


def pytest_collection_modifyitems(items):
    if not all(shutil.which(binary) for binary in ("ffmpeg", "ffprobe")):
        for item in items:
            if item.get_closest_marker("media"):
                item.add_marker(pytest.mark.skip(reason="Install ffmpeg and ffprobe to run MP4 integration tests"))


def pytest_collection_finish(session):
    if session.config.getoption("--require-media") and not any(item.get_closest_marker("media") for item in session.items):
        raise pytest.UsageError("No required media tests were selected")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if item.config.getoption("--require-media") and item.get_closest_marker("media") and report.skipped:
        report.outcome = "failed"
        report.longrepr = f"{item.nodeid}: required media test was skipped"
        if hasattr(report, "wasxfail"):
            del report.wasxfail
