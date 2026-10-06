"""Log correlation and privacy at the real application logging boundary."""

import asyncio
import io
import json
import logging

import pytest
from daedalus_runtime.logging import (
    JsonFormatter,
    configure_logging,
    log_context,
    log_event,
)


@pytest.fixture
def output(monkeypatch):
    logger = logging.getLogger("daedalus_runtime")
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.daedalus_handler = True
    handler.setFormatter(JsonFormatter())
    monkeypatch.setattr(logger, "handlers", [handler])
    monkeypatch.setattr(logger, "propagate", False)
    previous_level = logger.level
    logger.setLevel(logging.INFO)
    try:
        yield stream
    finally:
        logger.setLevel(previous_level)


def records(output):
    return [json.loads(line)["fields"] for line in output.getvalue().splitlines()]


def test_allowlist_excludes_payload_credentials_identity_and_raw_exceptions(output):
    with log_context(run_id="fixture-run", user_id="PRIVATE_USER"):
        log_event(
            "tool_execution_failed",
            level=logging.WARNING,
            tool="fixture__read",
            error_class="RuntimeError",
            elapsed_ms=12.5,
            arguments={"credential": "PRIVATE_ARGUMENT"},
            content="PRIVATE_RESULT",
            prompt="PRIVATE_PROMPT",
            api_key="PRIVATE_KEY",
            url="https://private.example/?token=PRIVATE_URL",
            exc_info=True,
        )
    log = records(output)[0]
    assert log == {
        "event": "tool_execution_failed",
        "component": "python_tools",
        "run_id": "fixture-run",
        "tool": "fixture__read",
        "error_class": "RuntimeError",
        "elapsed_ms": 12.5,
    }
    assert "PRIVATE" not in output.getvalue()
    # The formatter also refuses arbitrary logger messages and traceback text.
    try:
        raise RuntimeError("PRIVATE_EXCEPTION")
    except RuntimeError:
        logging.getLogger("daedalus_runtime").exception("PRIVATE_RAW_MESSAGE")
    assert "PRIVATE" not in output.getvalue()


def test_context_stays_with_each_concurrent_run_and_is_reset(output):
    async def work(run):
        with log_context(run_id=run):
            log_event("tool_execution_started")
            await asyncio.sleep(0)
            log_event("tool_execution_finished")

    async def exercise():
        await asyncio.gather(work("first"), work("second"))

    asyncio.run(exercise())
    log_event("outside_run")
    assert [record.get("run_id") for record in records(output)] == [
        "first",
        "second",
        "first",
        "second",
        None,
    ]


def test_levels_and_repeated_configuration_do_not_duplicate_logs(output, monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "WARN")
    configure_logging()
    configure_logging()
    log_event("hidden_info")
    log_event("visible_warning", level=logging.WARNING)
    assert [record["event"] for record in records(output)] == ["visible_warning"]
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    configure_logging()
    log_event("discovery_detail", level=logging.DEBUG)
    assert records(output)[-1]["event"] == "discovery_detail"


def test_invalid_labels_and_values_cannot_forge_lines(output):
    log_event(
        "fixture_event",
        run_id="private\nforged",
        elapsed_ms=float("nan"),
        tool="a" * 257,
        http_status="PRIVATE_STATUS",
    )
    assert records(output) == [
        {
            "event": "fixture_event",
            "component": "python_tools",
            "run_id": "invalid_label",
            "tool": "invalid_label",
        }
    ]
