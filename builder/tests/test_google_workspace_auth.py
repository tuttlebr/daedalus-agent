"""Tests for user-scoped Google Workspace authorization resets."""

import asyncio
import hashlib
import sys
import types

import pytest
from nat_helpers import google_workspace_auth
from nat_helpers.google_workspace_auth import (
    google_workspace_token_key,
    reset_google_workspace_authorization,
)


def run(coro):
    return asyncio.run(coro)


class FakeHTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def test_token_key_is_service_isolated_and_user_hashed():
    user_id = "opaque-nat-user-id"
    user_hash = hashlib.sha256(user_id.encode()).hexdigest()

    assert google_workspace_token_key("docs", user_id) == (
        f"nat/object_store/docs-mcp-oauth-drive/tokens/{user_hash}"
    )
    assert google_workspace_token_key("calendar", user_id) != (
        google_workspace_token_key("docs", user_id)
    )
    with pytest.raises(ValueError, match="Unknown Google Workspace service"):
        google_workspace_token_key("unknown", user_id)


def test_reset_deletes_token_and_evicts_idle_cached_workflow(monkeypatch):
    deleted_keys = []

    class FakeRedisClient:
        async def delete(self, key):
            deleted_keys.append(key)
            return 1

        async def aclose(self):
            return None

    class FakeRedis:
        @staticmethod
        def from_url(*_args, **_kwargs):
            return FakeRedisClient()

    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.Redis = FakeRedis
    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio)
    monkeypatch.setattr(
        google_workspace_auth,
        "_request_user_id",
        lambda _request: "opaque-nat-user-id",
    )
    monkeypatch.setattr(
        google_workspace_auth,
        "redis_url_from_env",
        lambda: "redis://unused",
    )

    class FakeBuilder:
        exited = False

        async def __aexit__(self, *_args):
            self.exited = True

    builder = FakeBuilder()
    info = types.SimpleNamespace(builder=builder, ref_count=0)
    manager = types.SimpleNamespace(
        _is_workflow_per_user=True,
        _per_user_builders_lock=asyncio.Lock(),
        _per_user_builders={"opaque-nat-user-id": info},
    )

    result = run(reset_google_workspace_authorization("docs", object(), [manager]))

    assert result == {
        "service": "docs",
        "authorizationCleared": True,
        "savedTokenDeleted": True,
        "cachedWorkflowsInvalidated": 1,
    }
    assert deleted_keys == [google_workspace_token_key("docs", "opaque-nat-user-id")]
    assert manager._per_user_builders == {}
    assert builder.exited is True


def test_reset_refuses_while_cached_workflow_is_active(monkeypatch):
    monkeypatch.setattr(google_workspace_auth, "HTTPException", FakeHTTPException)
    monkeypatch.setattr(
        google_workspace_auth,
        "_request_user_id",
        lambda _request: "opaque-nat-user-id",
    )
    info = types.SimpleNamespace(builder=object(), ref_count=1)
    manager = types.SimpleNamespace(
        _is_workflow_per_user=True,
        _per_user_builders_lock=asyncio.Lock(),
        _per_user_builders={"opaque-nat-user-id": info},
    )

    with pytest.raises(FakeHTTPException) as exc_info:
        run(reset_google_workspace_authorization("docs", object(), [manager]))

    assert exc_info.value.status_code == 409
    assert manager._per_user_builders["opaque-nat-user-id"] is info


def test_reset_rejects_unknown_service_before_touching_identity(monkeypatch):
    monkeypatch.setattr(google_workspace_auth, "HTTPException", FakeHTTPException)
    with pytest.raises(FakeHTTPException) as exc_info:
        run(reset_google_workspace_authorization("drive", object(), []))

    assert exc_info.value.status_code == 404
