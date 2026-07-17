"""Tests for authenticated, tenant-scoped Milvus metadata."""

import asyncio
import sys
from pathlib import Path

import pytest

_BUILDER_ROOT = Path(__file__).resolve().parent.parent
if str(_BUILDER_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUILDER_ROOT))

import collection_metadata_api as api  # noqa: E402


def test_metadata_returns_hashed_private_target_and_read_only_shared(monkeypatch):
    monkeypatch.setattr(api, "require_trusted_user", lambda user, token: user)
    private = api.user_upload_collection_name("Alice", "user_uploads")

    async def list_collections():
        return [private, "nvidia", "another-users-private-collection"]

    monkeypatch.setattr(api, "_list_collections", list_collections)
    result = asyncio.run(api._collection_metadata("Alice", "trusted"))

    assert result["userCollection"] == {
        "name": private,
        "displayName": "My documents",
        "scope": "user",
        "exists": True,
        "readable": True,
        "writable": True,
    }
    assert result["writableCollections"] == [result["userCollection"]]
    assert all(not item["writable"] for item in result["sharedCollections"])
    assert {item["name"] for item in result["sharedCollections"]} == set(
        api.SHARED_COLLECTION_NAMES
    )
    assert "another-users-private-collection" not in str(result)


def test_metadata_fails_closed_when_milvus_is_unavailable(monkeypatch):
    class FakeHTTPException(Exception):
        def __init__(self, status_code, detail):
            super().__init__(detail)
            self.status_code = status_code

    monkeypatch.setattr(api, "require_trusted_user", lambda user, token: user)
    monkeypatch.setattr(api, "HTTPException", FakeHTTPException)

    async def list_collections():
        raise TimeoutError("slow")

    monkeypatch.setattr(api, "_list_collections", list_collections)
    with pytest.raises(Exception) as exc_info:
        asyncio.run(api._collection_metadata("alice", "trusted"))
    assert getattr(exc_info.value, "status_code", None) == 503
