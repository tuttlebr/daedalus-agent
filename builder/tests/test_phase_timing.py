"""Real phase boundaries, failure semantics, and private-data exclusion."""

import asyncio
import sys
from types import SimpleNamespace

import pytest
from nat_helpers.phase_timing import phase_timing


@pytest.fixture
def phase_events(monkeypatch):
    events = []
    clock = [10.0]
    span = SimpleNamespace(attributes={})

    def finish():
        events.append(
            SimpleNamespace(
                event_type="end", UUID="fixture-span", metadata=dict(span.attributes)
            )
        )

    span.set_attributes = span.attributes.update
    span.end = finish

    def start(name, attributes):
        events.append(
            SimpleNamespace(
                event_type="start", UUID="fixture-span", metadata=dict(attributes)
            )
        )
        return span

    trace = SimpleNamespace(get_tracer=lambda _: SimpleNamespace(start_span=start))
    monkeypatch.setitem(sys.modules, "opentelemetry", SimpleNamespace(trace=trace))
    monkeypatch.setattr("nat_helpers.phase_timing.time.perf_counter", lambda: clock[0])
    return events, clock


def test_duration_spans_the_operation_and_excludes_sensitive_payloads(phase_events):
    events, clock = phase_events
    with phase_timing(
        "daedalus.fixture.fetch",
        {
            "operation": "fetch",
            "query": "private query",
            "url": "https://secret.example",
        },
    ) as phase:
        assert len(events) == 1
        assert events[0].event_type == "start"
        clock[0] += 4.125
        phase.set_metadata(cache_hit=True, output_chars=120)
    assert len(events) == 2
    assert events[0].UUID == events[1].UUID
    assert events[1].event_type == "end"
    assert events[1].metadata == {
        "operation": "fetch",
        "cache_hit": True,
        "output_chars": 120,
        "duration_ms": 4125.0,
        "outcome": "success",
    }
    assert "private" not in repr(events)
    assert "secret" not in repr(events)


@pytest.mark.parametrize(
    ("error", "outcome"),
    [
        (RuntimeError("private exception"), "error"),
        (asyncio.CancelledError(), "cancelled"),
    ],
)
def test_failure_and_cancellation_close_span_and_propagate(
    phase_events, error, outcome
):
    events, clock = phase_events
    with pytest.raises(type(error)) as raised:
        with phase_timing("daedalus.fixture.fetch"):
            clock[0] += 2
            raise error
    assert raised.value is error
    assert events[-1].metadata["outcome"] == outcome
    assert events[-1].metadata["duration_ms"] == 2000
    assert events[-1].metadata["error_type"] == type(error).__name__
    assert "private exception" not in repr(events)


def test_broken_tracing_does_not_break_the_operation(phase_events, monkeypatch):
    monkeypatch.setitem(sys.modules, "opentelemetry", None)
    with phase_timing("daedalus.fixture.fetch"):
        result = "completed"
    assert result == "completed"
