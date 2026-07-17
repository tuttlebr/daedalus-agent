"""Tests for the backend container entrypoint."""

import logging

import entrypoint
import fastapi
import pytest


def test_runtime_versions_accept_the_pinned_abi(monkeypatch):
    versions = {
        "nvidia-nat-core": "1.7.0",
        "nvidia-nat-mcp": "1.7.0",
        "starlette": "0.48.0",
    }
    monkeypatch.setattr(entrypoint, "version", versions.__getitem__)

    entrypoint._assert_runtime_versions()


@pytest.mark.parametrize(
    "distribution,installed",
    [("nvidia-nat-core", "1.8.0"), ("nvidia-nat-mcp", "1.6.0")],
)
def test_runtime_versions_reject_unknown_nat_abi(monkeypatch, distribution, installed):
    versions = {
        "nvidia-nat-core": "1.7.0",
        "nvidia-nat-mcp": "1.7.0",
        "starlette": "0.48.0",
    }
    versions[distribution] = installed
    monkeypatch.setattr(entrypoint, "version", versions.__getitem__)

    with pytest.raises(RuntimeError, match="Unsupported"):
        entrypoint._assert_runtime_versions()


class _FakeFastAPI:
    """Minimal stand-in for FastAPI so __init__ can be monkeypatched."""

    def __init__(self, *args, **kwargs):
        self.included_routers = []
        self.middleware = []
        self.routes = []

    def add_middleware(self, middleware):
        self.middleware.append(middleware)

    def include_router(self, router):
        self.included_routers.append(router)

    def add_api_route(self, path, endpoint, **kwargs):
        self.routes.append((path, endpoint, kwargs))


def test_daedalus_routes_attached_on_fastapi_construction(monkeypatch):
    # fastapi is a MagicMock under the test harness and cannot have its
    # magic __init__ reassigned; swap in a real class for this test.
    monkeypatch.setattr(fastapi, "FastAPI", _FakeFastAPI)

    entrypoint._patch_fastapi_daedalus_routes(logging.getLogger("test"))

    app = fastapi.FastAPI()
    assert len(app.included_routers) == 3
    assert len(app.middleware) == 1
    assert [path for path, _endpoint, _kwargs in app.routes] == ["/health/ready"]
    assert getattr(app, "_daedalus_routes_attached", False) is True


def test_daedalus_routes_attached_only_once_per_instance(monkeypatch):
    monkeypatch.setattr(fastapi, "FastAPI", _FakeFastAPI)

    entrypoint._patch_fastapi_daedalus_routes(logging.getLogger("test"))

    app = fastapi.FastAPI()
    assert app._daedalus_routes_attached is True
    # Re-running __init__ on an already-attached instance must short-circuit
    # via the marker guard and not re-include the routers. The underlying
    # FastAPI.__init__ does not touch the marker, so it persists here too.
    type(app).__init__(app)
    assert app.included_routers == []
    assert app._daedalus_routes_attached is True


def test_daedalus_route_import_failure_is_fatal(monkeypatch):
    # Force the router import to fail at patch-setup time; this must
    # raise so the container does not boot silently without the
    # /v1/images/*, /v1/documents/*, and /v1/profile/* endpoints.
    monkeypatch.setattr(fastapi, "FastAPI", _FakeFastAPI)
    monkeypatch.setitem(__import__("sys").modules, "image_api", None)

    with pytest.raises(ImportError):
        entrypoint._patch_fastapi_daedalus_routes(logging.getLogger("test"))
