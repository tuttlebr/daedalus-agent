"""Duration spans in NAT's active trace, without request or source content."""

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
            from nat.builder.context import Context
            from nat.data_models.intermediate_step import (
                IntermediateStepPayload,
                IntermediateStepType,
            )

            self._manager = Context.get().intermediate_step_manager
            self._start = IntermediateStepPayload(
                event_type=IntermediateStepType.CUSTOM_START,
                name=self.name,
                metadata=dict(self.metadata),
            )
            self._manager.push_intermediate_step(self._start)
        except Exception:
            self._manager = None
            logger.debug("Phase start unavailable: %s", self.name, exc_info=True)

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
            self.metadata["error_type"] = type(error).__name__[:128]
        if self._manager is None or self._start is None:
            return
        try:
            from nat.data_models.intermediate_step import (
                IntermediateStepPayload,
                IntermediateStepType,
                StreamEventData,
            )

            self._manager.push_intermediate_step(
                IntermediateStepPayload(
                    event_type=IntermediateStepType.CUSTOM_END,
                    UUID=self._start.UUID,
                    name=self.name,
                    metadata=dict(self.metadata),
                    data=StreamEventData(output=dict(self.metadata)),
                )
            )
        except Exception:
            logger.debug("Phase end unavailable: %s", self.name, exc_info=True)


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


def timed_model_runnable(binding, metadata: dict[str, Any]):
    """Delegate streaming unchanged while timing the complete model response.

    RunnableLambda aggregates chunks only for ainvoke. During astream it yields
    each original chunk immediately, retaining the model's callback context and
    LangGraph message events. Closing a partial stream closes the provider too.
    """
    from contextlib import aclosing

    from langchain_core.runnables import RunnableConfig, RunnableLambda

    async def stream(messages, config: RunnableConfig):
        with phase_timing("daedalus.agent.model", metadata):
            async with aclosing(binding.astream(messages, config=config)) as chunks:
                async for chunk in chunks:
                    yield chunk

    return RunnableLambda(stream, name="TimedModelResponse")
