"""Tests for the deterministic profile-memory import API."""

import asyncio
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

_BUILDER_ROOT = Path(__file__).resolve().parent.parent
if str(_BUILDER_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUILDER_ROOT))

import profile_import_api  # noqa: E402
from profile_import_api import (  # noqa: E402
    ProfileEntry,
    ProfileImportRequest,
    build_profile_memory_items,
    import_profile_memories,
    router,
)


def run(coro):
    return asyncio.run(coro)


class FakeMemoryEditor:
    def __init__(self):
        self.added = []

    async def add_items(self, items):
        self.added.extend(items)


class FakeMemoryItem:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def profile_request() -> ProfileImportRequest:
    return ProfileImportRequest.model_validate(
        {
            "profile_version": "2026-06-08",
            "mode": "append",
            "user_id": "Brandon Tuttle",
            "entries": [
                {
                    "label": "Identity",
                    "memory": "The user prefers to be addressed as Brandon.",
                    "tags": ["user_profile", "user_profile"],
                    "metadata": {
                        "source": "seed_profile",
                        "category": "identity",
                    },
                }
            ],
        }
    )


def test_router_exists():
    assert router is not None


def test_profile_request_ignores_client_user_id():
    req = profile_request()

    assert not hasattr(req, "user_id")
    assert req.entries[0].label == "Identity"
    assert req.entries[0].memory == "The user prefers to be addressed as Brandon."


def test_rejects_blank_memory():
    with pytest.raises(ValidationError):
        ProfileEntry.model_validate({"label": "Blank", "memory": "  "})


def test_build_profile_memory_items_uses_authenticated_user():
    req = profile_request()

    items = build_profile_memory_items(
        req,
        "tuttlebr",
        FakeMemoryItem,
        imported_at="2026-06-08T14:30:00+00:00",
    )

    assert len(items) == 1
    item = items[0]
    assert item.user_id == "tuttlebr"
    assert item.memory == "The user prefers to be addressed as Brandon."
    assert item.conversation == [
        {
            "role": "user",
            "content": "The user prefers to be addressed as Brandon.",
        }
    ]
    assert item.tags == ["user_profile", "identity"]
    assert item.metadata["label"] == "Identity"
    assert item.metadata["source"] == "seed_profile"
    assert item.metadata["category"] == "identity"
    assert item.metadata["profile_version"] == "2026-06-08"
    assert item.metadata["imported_at"] == "2026-06-08T14:30:00+00:00"


def test_key_value_pairs_merge_under_metadata():
    req = ProfileImportRequest.model_validate(
        {
            "entries": [
                {
                    "label": "Style",
                    "memory": "Use concise responses.",
                    "metadata": {"key_value_pairs": {"existing": True}},
                    "key_value_pairs": {"retrieval_anchor": "concise"},
                }
            ]
        }
    )

    item = build_profile_memory_items(req, "tuttlebr", FakeMemoryItem)[0]

    assert item.metadata["key_value_pairs"] == {
        "existing": True,
        "retrieval_anchor": "concise",
    }


def test_import_profile_memories_calls_editor_add_items_once():
    editor = FakeMemoryEditor()

    imported = run(import_profile_memories(profile_request(), "tuttlebr", editor))

    assert imported == 1
    assert len(editor.added) == 1
    assert editor.added[0].user_id == "tuttlebr"


def test_embedding_config_fails_when_missing(monkeypatch):
    profile_import_api._embedding_adapter.cache_clear()
    monkeypatch.delenv("EMBEDDING_API_KEY", raising=False)
    monkeypatch.setenv("EMBEDDING_BASE_URL", "https://example.invalid/v1")
    monkeypatch.setenv("EMBEDDING_MODEL", "example/model")

    with pytest.raises(RuntimeError, match="EMBEDDING_API_KEY"):
        profile_import_api._embedding_adapter()
