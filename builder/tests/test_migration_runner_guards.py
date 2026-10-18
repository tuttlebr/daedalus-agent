"""Native contract gates must fail when their test filter selects nothing."""

import subprocess
import sys
from pathlib import Path

import pytest

MIGRATION = Path(__file__).resolve().parents[1] / "migration"


@pytest.fixture
def image_check(monkeypatch):
    monkeypatch.syspath_prepend(str(MIGRATION))
    import image_check

    return image_check


def fake_cargo(tmp_path, monkeypatch, *, output, status=0):
    tool = tmp_path / "cargo"
    tool.write_text(
        f"#!{sys.executable}\n"
        "import sys\n"
        f"sys.stdout.write({output!r})\n"
        "sys.stderr.write('Running unittests src/main.rs\\n')\n"
        f"raise SystemExit({status})\n"
    )
    tool.chmod(0o700)
    monkeypatch.setenv("PATH", f"{tmp_path}:{__import__('os').environ['PATH']}")


EMPTY = "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored\n"
SELECTED = (
    "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored\n"
    "running 1 test\ntest a::actual ... ok\n\n"
    "test result: ok. 1 passed; 0 failed; 0 ignored\n"
)


def test_filter_that_matches_no_test_fails(image_check, tmp_path, monkeypatch):
    fake_cargo(tmp_path, monkeypatch, output=EMPTY)
    with pytest.raises(RuntimeError, match="selected no tests"):
        image_check.run("cargo", "test", "--locked", "renamed", "--", "--ignored")


def test_selected_native_test_passes_and_output_is_kept(
    image_check, tmp_path, monkeypatch, capsys
):
    fake_cargo(tmp_path, monkeypatch, output=SELECTED)
    result = image_check.run("cargo", "test", "a::actual", "--", "--ignored")
    assert result.returncode == 0
    assert "1 passed" in result.stdout
    assert "test a::actual ... ok" in capsys.readouterr().out


def test_failing_native_test_still_raises(image_check, tmp_path, monkeypatch):
    fake_cargo(
        tmp_path, monkeypatch, output="test result: FAILED. 0 passed;", status=101
    )
    with pytest.raises(subprocess.CalledProcessError):
        image_check.run("cargo", "test", "a::actual", "--", "--ignored")


def test_build_only_and_captured_invocations_keep_subprocess_semantics(
    image_check, tmp_path, monkeypatch
):
    fake_cargo(tmp_path, monkeypatch, output=EMPTY)
    image_check.run("cargo", "test", "--no-run", "--message-format=json")
    captured = image_check.run(
        "cargo", "test", "--locked", capture_output=True, text=True
    )
    assert captured.stdout == EMPTY
