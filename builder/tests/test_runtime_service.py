"""Cleanup reports preserve unknown usage instead of rejecting failed runs."""

import json
import sys
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("outcome", ["completed", "failed"])
def test_cleanup_report_accepts_partial_runtime_usage(monkeypatch, outcome):
    # Redis startup is outside the report-validation contract. The lightweight
    # suite supplies only the synchronous Redis stub.
    monkeypatch.setitem(sys.modules, "redis.asyncio", SimpleNamespace(Redis=object))
    from daedalus_runtime.service import RunReport

    report = RunReport.model_validate_json(
        json.dumps(
            {
                "outcome": outcome,
                "metrics": {
                    "model_calls": 2,
                    "input_tokens": None,
                    "output_tokens": 12,
                    "cached_tokens": None,
                    "reported_input_tokens": 8,
                    "reported_usage_calls": 1,
                },
            }
        )
    )
    assert report.metrics["input_tokens"] is None
    assert report.metrics["cached_tokens"] is None
    assert report.metrics["output_tokens"] == 12
    assert report.metrics["reported_input_tokens"] == 8
