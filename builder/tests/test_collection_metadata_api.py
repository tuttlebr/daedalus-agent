"""Tests for authenticated, tenant-scoped Milvus metadata."""

import asyncio
import sys
import types
from pathlib import Path

import pytest

_BUILDER_ROOT = Path(__file__).resolve().parent.parent
if str(_BUILDER_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUILDER_ROOT))

import collection_metadata_api as api  # noqa: E402


def test_list_collections_passes_bounded_timeout_to_pymilvus(monkeypatch):
    calls = {}

    class FakeMilvusClient:
        def __init__(self, **kwargs):
            calls["client_kwargs"] = kwargs

        def list_collections(self, **kwargs):
            calls["list_kwargs"] = kwargs
            return ["nvidia"]

        def has_collection(self, name, **kwargs):
            calls["describe_name"] = name
            calls["describe_kwargs"] = kwargs
            return True

        def close(self):
            calls["closed"] = True

    pymilvus = types.ModuleType("pymilvus")
    pymilvus.MilvusClient = FakeMilvusClient
    monkeypatch.setitem(sys.modules, "pymilvus", pymilvus)
    monkeypatch.setenv("MILVUS_METADATA_TIMEOUT_SECONDS", "27")

    timeout = api._metadata_timeout_seconds()
    result = api._list_collections_sync(timeout)

    assert timeout == 10.0
    assert result == ["nvidia"]
    assert calls["client_kwargs"]["alias"].startswith("daedalus-metadata-")
    assert 0 < calls["client_kwargs"]["timeout"] <= 10.0
    assert 0 < calls["list_kwargs"]["timeout"] <= 10.0
    assert calls["describe_name"] == "nvidia"
    assert 0 < calls["describe_kwargs"]["timeout"] <= 10.0
    assert calls["closed"] is True


def test_list_collections_gives_each_owned_client_a_unique_alias(monkeypatch):
    aliases = []

    class FakeMilvusClient:
        def __init__(self, **kwargs):
            aliases.append(kwargs["alias"])

        def list_collections(self, **_kwargs):
            return []

        def has_collection(self, *_args, **_kwargs):
            return False

        def close(self):
            pass

    pymilvus = types.ModuleType("pymilvus")
    pymilvus.MilvusClient = FakeMilvusClient
    monkeypatch.setitem(sys.modules, "pymilvus", pymilvus)

    api._list_collections_sync(3.0)
    api._list_collections_sync(3.0)

    assert len(set(aliases)) == 2
    assert all(alias.startswith("daedalus-metadata-") for alias in aliases)


def test_list_collections_probes_describe_even_when_database_is_empty(monkeypatch):
    calls = {}

    class FakeMilvusClient:
        def __init__(self, **_kwargs):
            pass

        def list_collections(self, **_kwargs):
            return []

        def has_collection(self, name, **kwargs):
            calls["name"] = name
            calls["kwargs"] = kwargs
            return False

        def close(self):
            pass

    pymilvus = types.ModuleType("pymilvus")
    pymilvus.MilvusClient = FakeMilvusClient
    monkeypatch.setitem(sys.modules, "pymilvus", pymilvus)

    assert api._list_collections_sync(3.0) == []
    assert calls["name"] == "__daedalus_rag_readiness__"
    assert 0 < calls["kwargs"]["timeout"] <= 3.0


def test_async_list_collections_passes_same_timeout_to_worker(monkeypatch):
    calls = {}

    def list_collections(timeout):
        calls["timeout"] = timeout
        return []

    monkeypatch.setenv("MILVUS_METADATA_TIMEOUT_SECONDS", "2.5")
    monkeypatch.setattr(api, "_list_collections_sync", list_collections)

    assert asyncio.run(api._list_collections()) == []
    assert calls["timeout"] == 2.5


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
