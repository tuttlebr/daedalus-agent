"""Structured operational logs with an explicit content-free field allowlist."""

from __future__ import annotations

import contextlib
import contextvars
import datetime
import json
import logging
import math
import os
import re
import sys

_context = contextvars.ContextVar("runtime_log_context", default={})
_labels = {
    "run_id",
    "component",
    "phase",
    "tool",
    "group",
    "model",
    "outcome",
    "error_class",
    "reason",
}
_numbers = {
    "elapsed_ms",
    "http_status",
    "tool_count",
    "group_count",
    "native_tools",
    "message_count",
    "model_calls",
    "tool_calls",
    "input_tokens",
    "output_tokens",
    "reported_usage_calls",
    "active_runs",
    "pid",
    "port",
    "exit_code",
}
_flags = {"is_error", "terminal", "approval_required", "context_available"}
_label = re.compile(r"[A-Za-z0-9_.:/-]{1,256}\Z")


def safe_fields(fields):
    result = {}
    for key, value in fields.items():
        if key in _labels and isinstance(value, str):
            result[key] = value if _label.fullmatch(value) else "invalid_label"
        elif key in _numbers and type(value) in {int, float} and math.isfinite(value):
            result[key] = value
        elif key in _flags and isinstance(value, bool):
            result[key] = value
    return result


class JsonFormatter(logging.Formatter):
    def format(self, record):
        # Exception messages, tracebacks, and arbitrary extra fields are excluded.
        event = record.msg
        if not isinstance(event, str) or not re.fullmatch(r"[a-z_]+", event):
            event = "runtime_diagnostic"
        return json.dumps(
            {
                "timestamp": datetime.datetime.fromtimestamp(
                    record.created, datetime.UTC
                ).isoformat(timespec="milliseconds"),
                "level": record.levelname,
                "target": record.name,
                "fields": {
                    "event": event,
                    **safe_fields(getattr(record, "runtime_fields", {})),
                },
            },
            separators=(",", ":"),
        )


def configure_logging(component="python_tools"):
    logger = logging.getLogger("daedalus_runtime")
    if not any(
        getattr(handler, "daedalus_handler", False) for handler in logger.handlers
    ):
        handler = logging.StreamHandler(sys.stdout)
        handler.daedalus_handler = True
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    logger.setLevel(
        {
            "DEBUG": logging.DEBUG,
            "INFO": logging.INFO,
            "WARN": logging.WARNING,
            "WARNING": logging.WARNING,
            "ERROR": logging.ERROR,
            "CRITICAL": logging.CRITICAL,
        }.get(level, logging.INFO)
    )
    logger.propagate = False
    _context.set({"component": component})


@contextlib.contextmanager
def log_context(**fields):
    token = _context.set({**_context.get(), **safe_fields(fields)})
    try:
        yield
    finally:
        _context.reset(token)


def log_event(event, *, level=logging.INFO, **fields):
    logging.getLogger("daedalus_runtime").log(
        level,
        event,
        extra={
            "runtime_fields": {
                "component": "python_tools",
                **_context.get(),
                **safe_fields(fields),
            }
        },
    )
