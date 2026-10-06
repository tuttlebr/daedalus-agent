"""OpenTelemetry duration spans, without request or source content."""

import asyncio
import logging
import time
from contextlib import contextmanager
from typing import Any

logger = logging.getLogger(__name__)

# String values must be operational labels, never URLs, queries, identities,
# source bodies, credentials, or exception messages. Counts and flags are safe.
_LABEL_FIELDS = frozenset(
    {
        "operation",
        "server",
        "tool",
        "feed_scope",
        "cache_status",
        "source",
        "request_profile",
        "requested_route_alias",
        "model_profile",
        "outcome",
        "error_type",
    }
)


class PhaseTiming:
    """A best-effort span that never changes the wrapped operation's outcome."""

    def __init__(self, name: str, metadata: dict[str, Any] | None = None):
        self.name = name
        self.metadata: dict[str, Any] = {}
        self.set_metadata(**(metadata or {}))
        self._started = 0.0
        self._manager = None
        self._start = None

    def set_metadata(self, **metadata: Any) -> None:
        for key, value in metadata.items():
            if isinstance(value, (bool, int, float)):
                self.metadata[key] = value
            elif key in _LABEL_FIELDS and isinstance(value, str):
                self.metadata[key] = value[:128]

    def start(self) -> None:
        self._started = time.perf_counter()
        try:
            from opentelemetry import trace

            self._start = trace.get_tracer("daedalus.tools").start_span(
                self.name, attributes=self.metadata
            )
        except Exception:
            self._start = None

    def finish(self, error: BaseException | None = None) -> None:
        self.metadata["duration_ms"] = (time.perf_counter() - self._started) * 1000
        self.metadata["outcome"] = (
            "cancelled"
            if isinstance(error, (asyncio.CancelledError, GeneratorExit))
            else "error"
            if error is not None
            else "success"
        )
        if error is not None:
            self.metadata["error_type"] = type(error).__name__
        if self._start is not None:
            try:
                self._start.set_attributes(self.metadata)
                self._start.end()
            except Exception:
                logger.debug("Tracing unavailable during span completion")


@contextmanager
def phase_timing(name: str, metadata: dict[str, Any] | None = None):
    """Wrap sync or awaited work; record actual start/end, including cancellation."""
    phase = PhaseTiming(name, metadata)
    phase.start()
    error = None
    try:
        yield phase
    except BaseException as exc:
        error = exc
        raise
    finally:
        phase.finish(error)
