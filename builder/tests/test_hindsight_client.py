"""Contracts for the identity-bound Hindsight client."""

import asyncio
import json

import httpx
import pytest
from nat_helpers.hindsight_client import (
    HindsightClient,
    HindsightError,
    derive_bank_id,
    deterministic_document_id,
    memory_mode,
)


def run(coro):
    return asyncio.run(coro)


def test_bank_ids_are_stable_opaque_and_user_isolated():
    alice_first = derive_bank_id("alice@example.com")
    alice_second = derive_bank_id("alice@example.com")
    bob = derive_bank_id("bob@example.com")

    assert alice_first == alice_second
    assert alice_first != bob
    assert "alice" not in alice_first
    assert alice_first.startswith("du-")


def test_document_id_is_idempotent_and_scoped_to_user():
    first = deterministic_document_id(
        user_id="alice",
        source="turn",
        request_id="request-1",
        content="Remember Python.",
    )
    retry = deterministic_document_id(
        user_id="alice",
        source="turn",
        request_id="request-1",
        content="Remember Python.",
    )
    other_user = deterministic_document_id(
        user_id="bob",
        source="turn",
        request_id="request-1",
        content="Remember Python.",
    )
    assert first == retry
    assert first != other_user


def test_memory_mode_fails_closed_on_invalid_value(monkeypatch):
    monkeypatch.setenv("DAEDALUS_MEMORY_MODE", "maybe")
    with pytest.raises(ValueError, match="disabled, redis, shadow, or hindsight"):
        memory_mode()


def test_retain_uses_derived_bank_bearer_auth_and_idempotent_operation():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "status": "pending",
                "operation_id": "operation-1",
                "bank_id": "leak",
            },
        )

    client = HindsightClient(
        base_url="http://hindsight.test",
        api_key="secret-api-key",
        transport=httpx.MockTransport(handler),
    )
    result = run(
        client.retain(
            user_id="alice",
            content="The user prefers Python.",
            document_id="document-1",
            context="test",
            metadata={"nested": {"value": 1}},
            asynchronous=True,
        )
    )

    assert result == {"status": "pending", "operation_id": "operation-1"}
    assert len(requests) == 1
    request = requests[0]
    assert request.headers["authorization"] == "Bearer secret-api-key"
    assert derive_bank_id("alice") in request.url.path
    assert "alice" not in request.url.path
    body = json.loads(request.content)
    assert body["items"][0]["metadata"]["nested"] == '{"value":1}'
    assert body["items"][0]["observation_scopes"] == "shared"
    assert body["operation_id"]


def test_client_errors_do_not_echo_upstream_body():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="secret user content")

    client = HindsightClient(
        base_url="http://hindsight.test",
        api_key="secret-api-key",
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(HindsightError) as raised:
        run(client.list_documents(user_id="alice"))
    assert "secret user content" not in str(raised.value)
    assert "500" in str(raised.value)
