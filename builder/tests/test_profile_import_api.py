"""Tests for the deterministic profile-memory import API."""

import asyncio
import sys
import uuid
from pathlib import Path

import pytest
from pydantic import ValidationError

_BUILDER_ROOT = Path(__file__).resolve().parent.parent
if str(_BUILDER_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUILDER_ROOT))

import nat_helpers.hindsight_client as hindsight_client  # noqa: E402
from profile_import_api import (  # noqa: E402
    ProfileEntry,
    ProfileImportRequest,
    ProfileImportResult,
    build_profile_import_response,
    import_profile_memories,
    router,
)


def run(coro):
    return asyncio.run(coro)


class FakeHindsight:
    def __init__(self):
        self.batch_calls = []
        self.delete_calls = []
        self.deleted = 0

    async def retain_batch(self, **kwargs):
        self.batch_calls.append(kwargs)
        return {"status": "pending", "operation_id": kwargs["operation_id"]}

    async def delete_documents_with_tag(self, **kwargs):
        self.delete_calls.append(kwargs)
        return self.deleted


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


def test_rejects_duplicate_profile_labels():
    with pytest.raises(ValidationError, match="labels must be unique"):
        ProfileImportRequest.model_validate(
            {
                "entries": [
                    {"label": "Identity", "memory": "First value"},
                    {"label": "Identity", "memory": "Second value"},
                ]
            }
        )


def test_import_queues_one_hindsight_batch(monkeypatch):
    fake_hindsight = FakeHindsight()
    monkeypatch.setenv("DAEDALUS_MEMORY_MODE", "hindsight")
    monkeypatch.setattr(
        hindsight_client,
        "client_from_env",
        lambda: fake_hindsight,
    )

    result = run(import_profile_memories(profile_request(), "tuttlebr"))

    assert result.imported == 1
    assert result.queued == 1
    assert result.operation_id
    uuid.UUID(result.operation_id)
    assert len(fake_hindsight.batch_calls) == 1
    call = fake_hindsight.batch_calls[0]
    assert call["user_id"] == "tuttlebr"
    assert call["operation_id"] == result.operation_id
    assert len(call["items"]) == 1
    assert call["items"][0]["content"] == profile_request().entries[0].memory
    assert call["items"][0]["tags"][0] == "source:profile-import"
    assert call["items"][0]["metadata"]["category"] == "identity"
    assert call["items"][0]["metadata"]["profile_version"] == "2026-06-08"


def test_profile_response_returns_202_for_accepted_batch():
    response = type("Response", (), {"status_code": 200})()

    result = build_profile_import_response(
        req=profile_request(),
        user_id="tuttlebr",
        result=ProfileImportResult(
            imported=1,
            replaced=0,
            queued=1,
            operation_id="64ef6194-3f43-4e77-9bb4-d5c5584801cb",
        ),
        response=response,
    )

    assert response.status_code == 202
    assert result.status == "accepted"
    assert result.queued == 1
    assert result.operation_id == "64ef6194-3f43-4e77-9bb4-d5c5584801cb"


def test_replace_mode_deletes_only_hindsight_profile_sources(monkeypatch):
    fake_hindsight = FakeHindsight()
    fake_hindsight.deleted = 2
    monkeypatch.setenv("DAEDALUS_MEMORY_MODE", "hindsight")
    monkeypatch.setattr(hindsight_client, "client_from_env", lambda: fake_hindsight)
    req = ProfileImportRequest.model_validate(
        {
            "profile_version": "2026-06-13",
            "mode": "replace",
            "entries": [
                {
                    "label": "Identity",
                    "memory": "The user prefers to be addressed as Brandon.",
                    "metadata": {"source": "seed_profile", "category": "identity"},
                }
            ],
        }
    )

    result = run(import_profile_memories(req, "tuttlebr"))

    assert result.imported == 1
    assert result.replaced == 2
    assert fake_hindsight.delete_calls == [
        {"user_id": "tuttlebr", "tag": "source:profile-import"}
    ]
