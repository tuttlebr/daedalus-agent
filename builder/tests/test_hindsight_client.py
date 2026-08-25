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
    with pytest.raises(ValueError, match="disabled or hindsight"):
        memory_mode()


def test_memory_mode_defaults_to_hindsight(monkeypatch):
    monkeypatch.delenv("DAEDALUS_MEMORY_MODE", raising=False)

    assert memory_mode() == "hindsight"


def test_client_defaults_to_shared_daedalus_service(monkeypatch):
    monkeypatch.delenv("HINDSIGHT_API_URL", raising=False)

    client = HindsightClient(api_key="secret-api-key")

    assert client._base_url == "http://hindsight-api.daedalus.svc.cluster.local:8888"


def test_recall_uses_default_api_timeout(monkeypatch):
    seen_timeout: dict[str, float] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen_timeout.update(request.extensions["timeout"])
        return httpx.Response(200, json={"results": []})

    monkeypatch.delenv("HINDSIGHT_API_TIMEOUT_SECONDS", raising=False)
    client = HindsightClient(
        base_url="http://hindsight.test",
        api_key="secret-api-key",
        transport=httpx.MockTransport(handler),
    )

    assert run(client.recall(user_id="alice", query="daily summary")) == []
    assert seen_timeout["read"] == 60.0


def test_recall_honors_timeout_environment_override(monkeypatch):
    seen_timeout: dict[str, float] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen_timeout.update(request.extensions["timeout"])
        return httpx.Response(200, json={"results": []})

    monkeypatch.setenv("HINDSIGHT_API_TIMEOUT_SECONDS", "75")
    client = HindsightClient(
        base_url="http://hindsight.test",
        api_key="secret-api-key",
        transport=httpx.MockTransport(handler),
    )

    assert run(client.recall(user_id="alice", query="daily summary")) == []
    assert seen_timeout["read"] == 75.0


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


def test_retain_batch_submits_one_durable_async_operation():
    requests: list[httpx.Request] = []
    operation_id = "64ef6194-3f43-4e77-9bb4-d5c5584801cb"

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "success": True,
                "bank_id": "leak",
                "items_count": 2,
                "async": True,
                "operation_id": operation_id,
            },
        )

    client = HindsightClient(
        base_url="http://hindsight.test",
        api_key="secret-api-key",
        transport=httpx.MockTransport(handler),
    )
    result = run(
        client.retain_batch(
            user_id="alice",
            operation_id=operation_id,
            items=[
                {
                    "content": "The user prefers Python.",
                    "document_id": "profile-1",
                    "context": "profile import",
                    "metadata": {"rank": 1},
                    "tags": ["profile", "profile"],
                    "timestamp": "unset",
                },
                {
                    "content": "The user prefers concise answers.",
                    "document_id": "profile-2",
                    "context": "profile import",
                },
            ],
        )
    )

    assert result == {
        "success": True,
        "items_count": 2,
        "async": True,
        "operation_id": operation_id,
    }
    assert len(requests) == 1
    body = json.loads(requests[0].content)
    assert body["async"] is True
    assert body["operation_id"] == operation_id
    assert [item["document_id"] for item in body["items"]] == [
        "profile-1",
        "profile-2",
    ]
    assert body["items"][0]["metadata"] == {"rank": "1"}
    assert body["items"][0]["tags"] == ["profile"]
    assert body["items"][0]["timestamp"] == "unset"


def test_retain_batch_rejects_duplicate_document_ids_before_request():
    client = HindsightClient(
        base_url="http://hindsight.test",
        api_key="secret-api-key",
        transport=httpx.MockTransport(
            lambda _request: pytest.fail("request should not be sent")
        ),
    )

    with pytest.raises(ValueError, match="document IDs must be unique"):
        run(
            client.retain_batch(
                user_id="alice",
                operation_id="64ef6194-3f43-4e77-9bb4-d5c5584801cb",
                items=[
                    {"content": "one", "document_id": "profile-1"},
                    {"content": "two", "document_id": "profile-1"},
                ],
            )
        )


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


def test_bootstrap_pages_reflect_and_operation_routes_remain_bank_bound():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path.endswith("/config") and request.method == "GET":
            return httpx.Response(200, json={"bank_id": "leak", "overrides": {}})
        if path.endswith("/config") and request.method == "PATCH":
            return httpx.Response(200, json={"bank_id": "leak", "overrides": {}})
        if path.endswith("/knowledge-base/tree"):
            return httpx.Response(200, json={"roots": []})
        if path.endswith("/knowledge-base/pages"):
            return httpx.Response(
                201, json={"page_id": "kp-1", "operation_id": "op-page"}
            )
        if path.endswith("/knowledge-base/search"):
            return httpx.Response(200, json={"results": [{"id": "kp-1"}], "total": 1})
        if path.endswith("/knowledge-base/pages/kp-1"):
            return httpx.Response(200, json={"id": "kp-1", "body": "Profile"})
        if path.endswith("/knowledge-base/nodes/kp-1") and request.method == "DELETE":
            return httpx.Response(200, json={"deleted": True})
        if path.endswith("/reflect"):
            return httpx.Response(
                200, json={"text": "A bounded brief", "bank_id": "leak"}
            )
        if path.endswith("/operations/op-1/retry"):
            return httpx.Response(200, json={"success": True})
        if path.endswith("/operations/op-1"):
            return httpx.Response(
                200,
                json={
                    "operation_id": "op-1",
                    "status": "completed",
                    "result_metadata": {"unit_ids_count": 1},
                    "bank_id": "leak",
                },
            )
        raise AssertionError(f"unexpected request {request.method} {path}")

    client = HindsightClient(
        base_url="http://hindsight.test",
        api_key="secret-api-key",
        transport=httpx.MockTransport(handler),
    )

    async def exercise():
        await client.get_bank_config(user_id="alice")
        await client.update_bank_config(
            user_id="alice", updates={"enable_observations": True}
        )
        await client.knowledge_tree(user_id="alice")
        await client.create_knowledge_page(
            user_id="alice", name="Profile", source_query="Summarize"
        )
        await client.search_knowledge_pages(user_id="alice", query="profile")
        await client.get_knowledge_page(user_id="alice", page_id="kp-1")
        await client.delete_knowledge_node(user_id="alice", node_id="kp-1")
        brief = await client.reflect(user_id="alice", query="Summarize memory")
        operation = await client.get_operation(user_id="alice", operation_id="op-1")
        await client.retry_operation(user_id="alice", operation_id="op-1")
        return brief, operation

    brief, operation = run(exercise())
    assert brief == "A bounded brief"
    assert operation["result_metadata"]["unit_ids_count"] == 1
    assert "bank_id" not in operation
    assert all(derive_bank_id("alice") in request.url.path for request in requests)
    assert all("alice" not in request.url.path for request in requests)
