"""Only bounded operational labels enter tool telemetry."""

from nat_helpers.phase_timing import PhaseTiming


def test_span_metadata_excludes_credentials_requests_and_content():
    timer = PhaseTiming(
        "tool",
        {
            "tool": "safe-tool",
            "headers": {"authorization": "Bearer secret"},
            "cookies": "secret",
            "query": "private query",
            "url": "https://host/?token=secret",
            "duration_ms": 12.0,
        },
    )
    assert timer.metadata == {"tool": "safe-tool", "duration_ms": 12.0}
