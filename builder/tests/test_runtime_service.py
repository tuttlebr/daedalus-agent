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


class _App:
    """Record route handlers; conftest replaces FastAPI with a MagicMock."""

    def __init__(self, **_kwargs):
        self.routes = {}
        self.state = SimpleNamespace()

    def _route(self, method, path):
        return lambda handler: self.routes.setdefault((method, path), handler)

    def post(self, path):
        return self._route("POST", path)

    def get(self, path):
        return self._route("GET", path)

    def delete(self, path):
        return self._route("DELETE", path)

    def add_middleware(self, *_args, **_kwargs):
        pass


class _Escape(BaseException):
    """A non-Exception escape that bypasses the handler's own error result."""


def _explicit_call(monkeypatch, call, executor_state):
    import asyncio

    monkeypatch.setitem(sys.modules, "redis.asyncio", SimpleNamespace(Redis=object))
    import daedalus_runtime.service as service
    import nat_helpers.front_end as front_end

    monkeypatch.setattr(service, "FastAPI", _App)
    monkeypatch.setattr(service, "StreamingResponse", lambda body, **_kw: body)
    monkeypatch.setattr(service, "authenticated_user_id_from_context", lambda: "alice")
    monkeypatch.setattr(front_end, "attach_daedalus_routes", lambda app: app)
    app = service.create_app("/unused.yaml")
    app.state.tools = SimpleNamespace(
        workflow={"tools": ["leaf_tool"]},
        mcp=SimpleNamespace(groups={}),
        call=call,
    )
    handler = app.routes[("POST", "/runtime/v1/tools/call")]
    body = service.ExplicitToolCall.model_validate(
        {
            "name": "leaf_tool",
            "arguments": {},
            "context": {
                "version": 1,
                "query": "q",
                "available_tools": ["leaf_tool"],
                "executor_state": executor_state,
            },
        }
    )
    request = SimpleNamespace(headers={}, app=app)

    async def consume():
        lines = []
        stream = await handler(body, request)
        try:
            async for line in stream:
                lines.append(json.loads(line))
        except _Escape:
            pass
        return lines

    return asyncio.run(consume())


def test_null_executor_state_members_are_treated_as_empty(monkeypatch):
    async def call(_body, run, _emit, *, explicit):
        assert explicit and run.artifacts.briefing_execution == {}
        return {"content": "ok"}

    (event,) = _explicit_call(
        monkeypatch,
        call,
        {
            "attempts": None,
            "briefing_execution": None,
            "nonretryable_mcp_results": None,
        },
    )
    assert event["event"] == "result"
    assert event["data"]["executor_state"] == {
        "attempts": {},
        "briefing_execution": {},
        "nonretryable_mcp_results": {},
    }


def test_fallback_terminal_result_returns_executor_state(monkeypatch):
    async def call(_body, run, _emit, *, explicit):
        run.artifacts.attempts["leaf_tool"] += 1
        raise _Escape

    (event,) = _explicit_call(monkeypatch, call, {"attempts": {"leaf_tool": 2}})
    assert event["event"] == "result"
    assert event["data"]["is_error"] is True
    assert event["data"]["loaded_skills"] == []
    # The caller stores this state for the next call of the tool.
    assert event["data"]["executor_state"]["attempts"] == {"leaf_tool": 3}


@pytest.mark.parametrize(
    "case,hint",
    [
        ("valid", ""),
        ("time", "explicit UTC offset"),
        ("source", "HTTP(S) URL"),
        ("duplicate", "must be unique"),
        ("evidence", "require evidence"),
        ("extra", "declared fields"),
    ],
)
def test_autonomy_validation_uses_worker_contract_without_private_diagnostics(
    monkeypatch, case, hint
):
    import asyncio

    from autonomous_agent.prompt import StructuredOutputError, parse_structured_output

    monkeypatch.setitem(sys.modules, "redis.asyncio", SimpleNamespace(Redis=object))
    import daedalus_runtime.service as service
    import nat_helpers.front_end as front_end

    monkeypatch.setattr(service, "FastAPI", _App)
    monkeypatch.setattr(service, "authenticated_user_id_from_context", lambda: "alice")
    monkeypatch.setattr(front_end, "attach_daedalus_routes", lambda app: app)
    app = service.create_app("/unused.yaml")
    body = {
        "outcome": {
            "status": "completed",
            "summary": "PRIVATE-SUMMARY",
            "evidence": [{"description": "Fixture read"}],
        },
        "games": [
            {
                "sourceKey": "fixture",
                "sourceUrl": "https://example.org/game",
                "sport": "football",
                "opponent": "Fixture",
                "status": "scheduled",
                "start": "2099-11-09T12:00:00-05:00",
            }
        ],
    }
    if case == "time":
        body["games"][0]["start"] = "PRIVATE-TIMESTAMP"
    elif case == "source":
        body["games"][0]["sourceUrl"] = "https://user:PRIVATE-PASSWORD@example.org/game"
    elif case == "duplicate":
        body["games"] *= 2
    elif case == "evidence":
        body["outcome"]["evidence"] = []
    elif case == "extra":
        body["outcome"]["PRIVATE-KEY"] = "PRIVATE-VALUE"
    result = asyncio.run(app.routes[("POST", "/runtime/v1/autonomy/validate")](body))
    if case == "valid":
        assert result == {"problem": ""}
        parse_structured_output(json.dumps(body))
    else:
        assert hint in result["problem"]
        assert "PRIVATE" not in result["problem"]
        with pytest.raises(StructuredOutputError) as error:
            parse_structured_output(json.dumps(body))
        assert str(error.value) == result["problem"]
