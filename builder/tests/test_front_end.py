"""Tests for the repository-owned NAT FastAPI runner composition."""

import asyncio
import base64
import json
import sys
import types

import pytest
from nat_helpers import front_end
from nat_helpers.front_end import (
    DaedalusFastApiFrontEndPluginWorker,
    McpApprovalTerminalMiddleware,
    _approval_marker_from_sse_line,
    _terminalize_mcp_approval_stream,
    attach_daedalus_routes,
)


class _FakeApp:
    def __init__(self):
        self.included_routers = []
        self.middleware = []
        self.routes = []

    def add_middleware(self, middleware):
        self.middleware.append(middleware)

    def include_router(self, router):
        self.included_routers.append(router)

    def add_api_route(self, path, endpoint, **kwargs):
        self.routes.append((path, endpoint, kwargs))


class _Response:
    def __init__(self, content, status_code=200):
        self.body = json.dumps(content).encode()
        self.status_code = status_code


def test_daedalus_routes_attach_to_only_the_selected_app():
    app = _FakeApp()
    unrelated_app = _FakeApp()

    assert attach_daedalus_routes(app) is app
    assert len(app.included_routers) == 5
    assert len(app.middleware) == 2
    assert [path for path, _endpoint, _kwargs in app.routes] == [
        "/health/ready",
        "/v1/google-workspace/connections/{service_id}",
    ]
    assert app._daedalus_routes_attached is True
    assert unrelated_app.included_routers == []
    assert unrelated_app.middleware == []
    assert unrelated_app.routes == []


def test_daedalus_routes_attach_only_once():
    app = _FakeApp()

    attach_daedalus_routes(app)
    attach_daedalus_routes(app)

    assert len(app.included_routers) == 5
    assert len(app.middleware) == 2
    assert len(app.routes) == 2


def test_runner_composes_superclass_app():
    app = _FakeApp()
    worker = DaedalusFastApiFrontEndPluginWorker.__new__(
        DaedalusFastApiFrontEndPluginWorker
    )
    worker._test_app = app

    assert worker.build_app() is app
    assert app._daedalus_routes_attached is True


def test_daedalus_route_import_failure_is_fatal(monkeypatch):
    monkeypatch.setitem(sys.modules, "image_api", None)

    with pytest.raises(ImportError):
        attach_daedalus_routes(_FakeApp())


def _approval_marker(*, escaped: bool = False) -> str:
    payload = {
        "version": 1,
        "requestId": "approval_request_12345",
        "serverName": "docs_mcp_server",
        "toolName": "update_doc",
        "target": "doc-1",
        "summary": "Update Google document doc-1 (1 KiB payload)",
        "argumentsSha256": "a" * 64,
    }
    encoded = (
        base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode())
        .decode()
        .rstrip("=")
    )
    if escaped:
        return f"&lt;!--daedalus-mcp-approval:{encoded}--&gt;"
    return f"<!--daedalus-mcp-approval:{encoded}-->"


@pytest.mark.parametrize("escaped", [False, True])
def test_approval_marker_is_extracted_from_completed_tool_step(escaped):
    frame = {
        "name": "Function Complete: <docs_mcp_server__update_doc>",
        "id": "tool-1",
        "parent_id": "root",
        "payload": f"**Function Output:**\n```\n{_approval_marker(escaped=escaped)}\n```",
    }

    marker = _approval_marker_from_sse_line(
        f"intermediate_data: {json.dumps(frame)}".encode()
    )

    assert marker == _approval_marker()


def test_approval_terminal_event_suppresses_the_natural_stream_tail():
    consumed = []
    closed = []
    frame = {
        "name": "Function Complete: <docs_mcp_server__update_doc>",
        "id": "tool-1",
        "parent_id": "root",
        "payload": f"**Function Output:**\n```\n{_approval_marker(escaped=True)}\n```",
    }

    async def upstream():
        try:
            consumed.append("initial")
            yield b'data: {"choices": [{"delta": {}}]}\n'
            consumed.append("approval")
            yield f"intermediate_data: {json.dumps(frame)}\n".encode()
            consumed.append("second-model-cycle")
            yield b'data: {"choices": [{"delta": {"content": "continued"}}]}\n'
        finally:
            closed.append(True)

    async def collect():
        return b"".join(
            [chunk async for chunk in _terminalize_mcp_approval_stream(upstream())]
        )

    output = asyncio.run(collect())

    assert consumed == ["initial", "approval", "second-model-cycle"]
    assert closed == [True]
    assert b"event: mcp_approval_required\n" in output
    assert _approval_marker().encode() in output
    assert b"continued" not in output


def test_approval_asgi_middleware_allows_clean_backend_unwind():
    continued = []
    sent = []
    frame = {
        "name": "Function Complete: <docs_mcp_server__update_doc>",
        "id": "tool-1",
        "parent_id": "root",
        "payload": _approval_marker(escaped=True),
    }

    async def app(_scope, _receive, send):
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"text/event-stream")],
            }
        )
        await send(
            {
                "type": "http.response.body",
                "body": f"intermediate_data: {json.dumps(frame)}\n".encode(),
                "more_body": True,
            }
        )
        continued.append(True)
        await send(
            {
                "type": "http.response.body",
                "body": b'data: {"choices": [{"delta": {"content": "continued"}}]}\n',
                "more_body": False,
            }
        )

    async def receive():
        return {"type": "http.request"}

    async def send(message):
        sent.append(message)

    middleware = McpApprovalTerminalMiddleware(app)
    asyncio.run(
        middleware(
            {
                "type": "http",
                "method": "POST",
                "path": "/v1/chat/completions",
            },
            receive,
            send,
        )
    )

    assert continued == [True]
    assert sent[-1]["more_body"] is False
    body = b"".join(message.get("body", b"") for message in sent)
    assert b"event: mcp_approval_required" in body
    assert b"continued" not in body


def test_agent_graph_treats_approval_marker_as_terminal_tool_result():
    messages = [
        types.SimpleNamespace(type="ai", content=""),
        types.SimpleNamespace(
            type="tool",
            content=_approval_marker(escaped=True),
            name="docs_mcp_server__update_doc",
        ),
    ]

    assert front_end._has_terminal_mcp_approval(messages)
    assert not front_end._has_terminal_mcp_approval(
        [types.SimpleNamespace(type="tool", content="ordinary result")]
    )


def test_readiness_fails_when_required_mcp_capability_is_missing(monkeypatch):
    import mcp_patches

    monkeypatch.setattr(front_end, "JSONResponse", _Response)
    monkeypatch.setattr(front_end.os.path, "exists", lambda _path: False)
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", True)
    monkeypatch.setattr(
        mcp_patches,
        "mcp_capability_status",
        lambda: {
            "state": "unready",
            "available": [],
            "required": ["required_mcp"],
            "missing_required": ["required_mcp"],
            "unavailable_optional": [],
        },
    )

    response = asyncio.run(front_end.readiness_response())

    assert response.status_code == 503
    assert json.loads(response.body)["reason"] == (
        "required_mcp_capability_unavailable"
    )


def test_readiness_reports_optional_mcp_degradation(monkeypatch):
    import mcp_patches

    class _ReadyRedis:
        closed = False

        async def ping(self):
            return True

        async def aclose(self):
            self.closed = True

    client = _ReadyRedis()
    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.Redis = types.SimpleNamespace(
        from_url=lambda *_args, **_kwargs: client
    )
    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio)
    monkeypatch.setenv("DAEDALUS_MEMORY_MODE", "disabled")
    monkeypatch.setattr(front_end, "JSONResponse", _Response)
    monkeypatch.setattr(front_end.os.path, "exists", lambda _path: False)
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", True)
    monkeypatch.setattr(
        mcp_patches,
        "mcp_capability_status",
        lambda: {
            "state": "degraded",
            "available": ["healthy_mcp"],
            "required": [],
            "missing_required": [],
            "unavailable_optional": ["optional_mcp"],
        },
    )
    response = asyncio.run(front_end.readiness_response())
    payload = json.loads(response.body)

    assert response.status_code == 200
    assert payload["status"] == "degraded"
    assert payload["mcp"]["unavailable_optional"] == ["optional_mcp"]
    assert client.closed is True


def test_readiness_degrades_rather_than_failing_on_hindsight_outage(monkeypatch):
    import mcp_patches
    from nat_helpers import hindsight_client

    class _ReadyRedis:
        async def ping(self):
            return True

        async def aclose(self):
            return None

    class _UnavailableHindsight:
        async def health(self):
            raise RuntimeError("unavailable")

    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.Redis = types.SimpleNamespace(
        from_url=lambda *_args, **_kwargs: _ReadyRedis()
    )
    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio)
    monkeypatch.setenv("DAEDALUS_MEMORY_MODE", "hindsight")
    monkeypatch.setattr(
        hindsight_client,
        "client_from_env",
        lambda: _UnavailableHindsight(),
    )
    monkeypatch.setattr(front_end, "JSONResponse", _Response)
    monkeypatch.setattr(front_end.os.path, "exists", lambda _path: False)
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", True)
    monkeypatch.setattr(
        mcp_patches,
        "mcp_capability_status",
        lambda: {
            "state": "ready",
            "available": [],
            "required": [],
            "missing_required": [],
            "unavailable_optional": [],
        },
    )

    # Default policy: chat completes without Hindsight (automatic recall is
    # best-effort), so an outage must not eject the pod from its Service.
    monkeypatch.delenv("DAEDALUS_MEMORY_READINESS_MODE", raising=False)
    response = asyncio.run(front_end.readiness_response())

    assert response.status_code == 200
    body = json.loads(response.body)
    assert body["status"] == "degraded"
    assert body["memory"] == {"state": "hindsight", "hindsight": "unavailable"}

    # Operators who genuinely need memory can still opt into a hard dependency.
    monkeypatch.setenv("DAEDALUS_MEMORY_READINESS_MODE", "required")
    strict = asyncio.run(front_end.readiness_response())

    assert strict.status_code == 503
    assert json.loads(strict.body) == {
        "status": "unready",
        "reason": "hindsight_unavailable",
        "memory": {"state": "hindsight", "hindsight": "unavailable"},
    }


def test_readiness_rejects_invalid_memory_readiness_mode(monkeypatch):
    monkeypatch.setenv("DAEDALUS_MEMORY_READINESS_MODE", "sometimes")
    with pytest.raises(ValueError):
        front_end._memory_readiness_mode()


def test_readiness_reports_authenticated_milvus_failure(monkeypatch):
    import mcp_patches

    class _ReadyRedis:
        async def ping(self):
            return True

        async def aclose(self):
            return None

    async def unavailable():
        raise RuntimeError("credential rejected")

    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.Redis = types.SimpleNamespace(
        from_url=lambda *_args, **_kwargs: _ReadyRedis()
    )
    metadata = types.ModuleType("collection_metadata_api")
    metadata._list_collections = unavailable
    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio)
    monkeypatch.setitem(sys.modules, "collection_metadata_api", metadata)
    monkeypatch.setenv("DAEDALUS_MEMORY_MODE", "disabled")
    monkeypatch.setenv("DAEDALUS_RAG_READINESS_MODE", "required")
    monkeypatch.setattr(front_end, "JSONResponse", _Response)
    monkeypatch.setattr(front_end.os.path, "exists", lambda _path: False)
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", True)
    monkeypatch.setattr(
        mcp_patches,
        "mcp_capability_status",
        lambda: {
            "state": "ready",
            "available": [],
            "required": [],
            "missing_required": [],
            "unavailable_optional": [],
        },
    )

    response = asyncio.run(front_end.readiness_response())

    assert response.status_code == 503
    assert json.loads(response.body) == {
        "status": "unready",
        "reason": "milvus_unavailable",
        "rag": {"state": "unavailable", "reason": "milvus_unavailable"},
    }


def test_readiness_degrades_instead_of_restarting_when_milvus_is_optional(monkeypatch):
    import mcp_patches

    class _ReadyRedis:
        async def ping(self):
            return True

        async def aclose(self):
            return None

    async def unavailable():
        raise RuntimeError("upstream unavailable")

    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.Redis = types.SimpleNamespace(
        from_url=lambda *_args, **_kwargs: _ReadyRedis()
    )
    metadata = types.ModuleType("collection_metadata_api")
    metadata._list_collections = unavailable
    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio)
    monkeypatch.setitem(sys.modules, "collection_metadata_api", metadata)
    monkeypatch.setenv("DAEDALUS_MEMORY_MODE", "disabled")
    monkeypatch.setenv("DAEDALUS_RAG_READINESS_MODE", "degraded")
    monkeypatch.setattr(front_end, "JSONResponse", _Response)
    monkeypatch.setattr(front_end.os.path, "exists", lambda _path: False)
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", True)
    monkeypatch.setattr(
        mcp_patches,
        "mcp_capability_status",
        lambda: {
            "state": "ready",
            "available": [],
            "required": [],
            "missing_required": [],
            "unavailable_optional": [],
        },
    )

    response = asyncio.run(front_end.readiness_response())
    payload = json.loads(response.body)

    assert response.status_code == 200
    assert payload["status"] == "degraded"
    assert payload["rag"] == {
        "state": "unavailable",
        "reason": "milvus_unavailable",
    }


def test_readiness_degrades_when_required_collection_is_missing(monkeypatch):
    import mcp_patches

    class _ReadyRedis:
        async def ping(self):
            return True

        async def aclose(self):
            return None

    async def available():
        return ["nvidia"]

    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.Redis = types.SimpleNamespace(
        from_url=lambda *_args, **_kwargs: _ReadyRedis()
    )
    metadata = types.ModuleType("collection_metadata_api")
    metadata._list_collections = available
    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio)
    monkeypatch.setitem(sys.modules, "collection_metadata_api", metadata)
    monkeypatch.setenv("DAEDALUS_MEMORY_MODE", "disabled")
    monkeypatch.setenv("DAEDALUS_RAG_READINESS_MODE", "degraded")
    monkeypatch.setenv("DAEDALUS_REQUIRED_COLLECTIONS", "nvidia kubernetes")
    monkeypatch.setattr(front_end, "JSONResponse", _Response)
    monkeypatch.setattr(front_end.os.path, "exists", lambda _path: False)
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", True)
    monkeypatch.setattr(
        mcp_patches,
        "mcp_capability_status",
        lambda: {
            "state": "ready",
            "available": [],
            "required": [],
            "missing_required": [],
            "unavailable_optional": [],
        },
    )

    response = asyncio.run(front_end.readiness_response())
    payload = json.loads(response.body)

    assert response.status_code == 200
    assert payload["status"] == "degraded"
    assert payload["rag"]["missingRequiredCollections"] == ["kubernetes"]


def test_readiness_fails_when_required_collection_is_missing(monkeypatch):
    import mcp_patches

    class _ReadyRedis:
        async def ping(self):
            return True

        async def aclose(self):
            return None

    async def available():
        return ["nvidia"]

    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.Redis = types.SimpleNamespace(
        from_url=lambda *_args, **_kwargs: _ReadyRedis()
    )
    metadata = types.ModuleType("collection_metadata_api")
    metadata._list_collections = available
    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio)
    monkeypatch.setitem(sys.modules, "collection_metadata_api", metadata)
    monkeypatch.setenv("DAEDALUS_MEMORY_MODE", "disabled")
    monkeypatch.setenv("DAEDALUS_RAG_READINESS_MODE", "required")
    monkeypatch.setenv("DAEDALUS_REQUIRED_COLLECTIONS", "nvidia,kubernetes")
    monkeypatch.setattr(front_end, "JSONResponse", _Response)
    monkeypatch.setattr(front_end.os.path, "exists", lambda _path: False)
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", True)
    monkeypatch.setattr(
        mcp_patches,
        "mcp_capability_status",
        lambda: {
            "state": "ready",
            "available": [],
            "required": [],
            "missing_required": [],
            "unavailable_optional": [],
        },
    )

    response = asyncio.run(front_end.readiness_response())
    payload = json.loads(response.body)

    assert response.status_code == 503
    assert payload["reason"] == "required_collections_unavailable"
    assert payload["rag"]["missingRequiredCollections"] == ["kubernetes"]


def test_readiness_reports_milvus_collection_count(monkeypatch):
    import mcp_patches

    class _ReadyRedis:
        async def ping(self):
            return True

        async def aclose(self):
            return None

    async def available():
        return ["nvidia", "kubernetes"]

    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.Redis = types.SimpleNamespace(
        from_url=lambda *_args, **_kwargs: _ReadyRedis()
    )
    metadata = types.ModuleType("collection_metadata_api")
    metadata._list_collections = available
    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio)
    monkeypatch.setitem(sys.modules, "collection_metadata_api", metadata)
    monkeypatch.setenv("DAEDALUS_MEMORY_MODE", "disabled")
    monkeypatch.setenv("DAEDALUS_RAG_READINESS_MODE", "required")
    monkeypatch.setattr(front_end, "JSONResponse", _Response)
    monkeypatch.setattr(front_end.os.path, "exists", lambda _path: False)
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", True)
    monkeypatch.setattr(
        mcp_patches,
        "mcp_capability_status",
        lambda: {
            "state": "ready",
            "available": [],
            "required": [],
            "missing_required": [],
            "unavailable_optional": [],
        },
    )

    response = asyncio.run(front_end.readiness_response())
    payload = json.loads(response.body)

    assert response.status_code == 200
    assert payload["rag"] == {"state": "ready", "collectionCount": 2}
