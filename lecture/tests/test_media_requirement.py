from pathlib import Path

import pytest

pytest_plugins = ["pytester"]


def configure(pytester, available):
    gate = Path(__file__).with_name("conftest.py").read_text()
    replacement = "lambda binary: '/test/' + binary" if available else "lambda binary: None"
    pytester.makeconftest(gate + f"\nshutil.which = {replacement}\n")


def test_required_media_rejects_missing_binaries(pytester):
    configure(pytester, available=False)
    pytester.makepyfile("def test_placeholder(): pass")
    result = pytester.runpytest_subprocess("--require-media")
    assert result.ret == pytest.ExitCode.USAGE_ERROR
    result.stderr.fnmatch_lines(["*Required media tools are missing: ffmpeg, ffprobe*"])


def test_optional_media_skips_without_binaries(pytester):
    configure(pytester, available=False)
    pytester.makepyfile("""import pytest
@pytest.mark.media
def test_video(): pass
""")
    pytester.runpytest_subprocess("-q").assert_outcomes(skipped=1)


@pytest.mark.parametrize("body", ["pytest.skip('missing codec')", "pytest.xfail('not supported')"])
def test_required_media_never_accepts_skipped_execution(pytester, body):
    configure(pytester, available=True)
    pytester.makepyfile(f"""import pytest
@pytest.mark.media
def test_video(): {body}
""")
    result = pytester.runpytest_subprocess("--require-media", "-q")
    result.assert_outcomes(failed=1)
    assert result.ret == pytest.ExitCode.TESTS_FAILED


def test_required_media_rejects_setup_skips(pytester):
    configure(pytester, available=True)
    pytester.makepyfile("""import pytest
@pytest.mark.media
@pytest.mark.skip(reason='not installed')
def test_video(): pass
""")
    result = pytester.runpytest_subprocess("--require-media", "-q")
    result.assert_outcomes(errors=1)
    assert result.ret == pytest.ExitCode.TESTS_FAILED


def test_required_media_rejects_selection_without_video_tests(pytester):
    configure(pytester, available=True)
    pytester.makepyfile("def test_placeholder(): pass")
    result = pytester.runpytest_subprocess("--require-media")
    assert result.ret == pytest.ExitCode.USAGE_ERROR


def test_required_media_accepts_executed_video_tests(pytester):
    configure(pytester, available=True)
    pytester.makepyfile("""import pytest
@pytest.mark.media
def test_video(): pass
""")
    result = pytester.runpytest_subprocess("--require-media", "-q")
    result.assert_outcomes(passed=1)
    assert result.ret == pytest.ExitCode.OK
