"""Tests for the repository-owned NAT FastAPI runner composition."""

import asyncio
import json
import sys
import types

import pytest
from nat_helpers import front_end
from nat_helpers.front_end import (
    DaedalusFastApiFrontEndPluginWorker,
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
    assert len(app.included_routers) == 4
    assert len(app.middleware) == 1
    assert [path for path, _endpoint, _kwargs in app.routes] == ["/health/ready"]
    assert app._daedalus_routes_attached is True
    assert unrelated_app.included_routers == []
    assert unrelated_app.middleware == []
    assert unrelated_app.routes == []


def test_daedalus_routes_attach_only_once():
    app = _FakeApp()

    attach_daedalus_routes(app)
    attach_daedalus_routes(app)

    assert len(app.included_routers) == 4
    assert len(app.middleware) == 1
    assert len(app.routes) == 1


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
