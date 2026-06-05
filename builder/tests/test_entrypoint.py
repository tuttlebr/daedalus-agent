"""Tests for the backend container entrypoint."""

import logging
import os

import entrypoint
import fastapi
import pytest


def test_optional_tool_env_defaults_do_not_seed_unlisted_keys(monkeypatch):
    monkeypatch.delenv("UNLISTED_OPTIONAL_KEY", raising=False)

    entrypoint._configure_optional_tool_env(logging.getLogger("test"))

    assert "UNLISTED_OPTIONAL_KEY" not in os.environ


def test_optional_tool_env_defaults_leave_existing_env_untouched(monkeypatch):
    monkeypatch.setenv("UNLISTED_OPTIONAL_KEY", "real-key")

    entrypoint._configure_optional_tool_env(logging.getLogger("test"))

    assert os.environ["UNLISTED_OPTIONAL_KEY"] == "real-key"


class _FakeFastAPI:
    """Minimal stand-in for FastAPI so __init__ can be monkeypatched."""

    def __init__(self, *args, **kwargs):
        self.included_routers = []

    def include_router(self, router):
        self.included_routers.append(router)


def test_daedalus_routes_attached_on_fastapi_construction(monkeypatch):
    # fastapi is a MagicMock under the test harness and cannot have its
    # magic __init__ reassigned; swap in a real class for this test.
    monkeypatch.setattr(fastapi, "FastAPI", _FakeFastAPI)

    entrypoint._patch_fastapi_daedalus_routes(logging.getLogger("test"))

    app = fastapi.FastAPI()
    assert len(app.included_routers) == 2
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
    # /v1/images/* and /v1/documents/* endpoints.
    monkeypatch.setattr(fastapi, "FastAPI", _FakeFastAPI)
    monkeypatch.setitem(__import__("sys").modules, "image_api", None)

    with pytest.raises(ImportError):
        entrypoint._patch_fastapi_daedalus_routes(logging.getLogger("test"))
