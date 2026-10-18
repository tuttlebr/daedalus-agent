"""Exercise exploration authority and artifact boundaries through the real registry."""

import asyncio
import base64
import hashlib
import hmac
import json
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
import yaml
from daedalus_runtime import exploration
from daedalus_runtime.tools import ToolRegistry
from pydantic import ValidationError


@pytest.fixture
def adapter(monkeypatch):
    from llm_sandbox import llm_sandbox_function as sandbox

    monkeypatch.setenv("EXPLORATION_BASE_URL", "http://exploration.invalid")
    monkeypatch.setenv("EXPLORATION_GRANT_KEY", "synthetic-adapter-key-" * 4)
    monkeypatch.setattr(
        sandbox, "_trusted_scope_from_context", lambda: ("alice", "chat")
    )
    publisher = AsyncMock(return_value="published")
    monkeypatch.setattr(sandbox, "_publish_artifact", publisher)
    return sandbox, publisher


def registry(**config):
    return ToolRegistry(
        {"functions": {"explore": {"_type": "sandbox_exploration", **config}}}
    )


def transport(monkeypatch, handler):
    client = httpx.AsyncClient
    monkeypatch.setattr(
        exploration.httpx,
        "AsyncClient",
        lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs),
    )


def test_grant_has_exact_scope_and_verified_signature():
    key = "synthetic-adapter-key-" * 4
    token = exploration.grant(key, ("alice", "chat"), 1000)
    header, payload, signature = token.split(".")

    def decode(value):
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

    assert json.loads(decode(header)) == {"alg": "HS256", "typ": "JWT"}
    assert json.loads(decode(payload)) == {
        "iss": "daedalus-agent",
        "aud": "daedalus-exploration",
        "iat": 1000,
        "exp": 1120,
        "owner": hashlib.sha256(b"alice").hexdigest(),
        "scope": hashlib.sha256(b"alice\0chat").hexdigest(),
        "profile": "compute-offline-v1",
    }
    assert hmac.compare_digest(
        decode(signature),
        hmac.digest(key.encode(), f"{header}.{payload}".encode(), "sha256"),
    )


def test_registry_validates_before_transport_and_requires_scope(adapter, monkeypatch):
    async def exercise():
        calls = []
        transport(
            monkeypatch,
            lambda request: calls.append(request)
            or httpx.Response(200, json={"version": 2}),
        )
        tools = registry(description="Explore offline")
        try:
            tool = await tools.get_function("explore")
            assert tool.schema("explore")["description"] == "Explore offline"
            assert (
                tool.schema("explore")["parameters"]
                == exploration.CONTRACT["parameters"]
            )
            for args in [
                {"operation": "capabilities", "owner": "other"},
                {"operation": "publish_file"},
                {"operation": "unknown"},
                {"operation": "events", "after": False},
            ]:
                with pytest.raises(ValidationError):
                    await tool.ainvoke(args)
            assert not calls
            monkeypatch.setattr(adapter[0], "_trusted_scope_from_context", lambda: None)
            await tools.close()
            tools_without_scope = registry()
            tool = await tools_without_scope.get_function("explore")
            with pytest.raises(ValueError, match="trusted user"):
                await tool.ainvoke({"operation": "capabilities"})
            await tools_without_scope.close()
            assert not calls
        finally:
            await tools.close()

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "mutation", [None, "sha256", "size", "runId", "path", "contentBase64"]
)
def test_publication_requires_integrity_and_provenance(adapter, monkeypatch, mutation):
    async def exercise():
        artifact = {
            "contentBase64": "dGVzdA==",
            "size": 4,
            "sha256": hashlib.sha256(b"test").hexdigest(),
            "runId": "run",
            "path": "report.txt",
        }
        if mutation:
            artifact[mutation] = {"size": 3, "path": None}.get(mutation, "invalid")
        calls = []

        def respond(request):
            calls.append(request)
            return httpx.Response(200, json=artifact)

        transport(monkeypatch, respond)
        tools = registry()
        try:
            tool = await tools.get_function("explore")
            args = {"operation": "publish_file", "runId": "run", "path": "report.txt"}
            if mutation:
                with pytest.raises(ValueError):
                    await tool.ainvoke(args)
                adapter[1].assert_not_awaited()
            else:
                assert await tool.ainvoke(args) == "published"
                assert adapter[1].await_args.kwargs == {
                    "scope": ("alice", "chat"),
                    "source_path": "report.txt",
                    "collected_file": artifact,
                    "request_id": "run",
                }
            assert len(calls) == 1
            assert json.loads(calls[0].content) == {**args, "operation": "artifact"}
            assert calls[0].url.path == "/v2/tool"
            assert calls[0].headers["authorization"].startswith("Bearer ")
        finally:
            await tools.close()

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "args",
    [
        {"operation": "capabilities"},
        {"operation": "publish_file", "runId": "run", "path": "report.txt"},
    ],
)
def test_rejected_requests_are_tool_errors(adapter, monkeypatch, args):
    async def exercise():
        detail = {"detail": "idempotencyKey reused with different arguments"}
        transport(monkeypatch, lambda request: httpx.Response(409, json=detail))
        tools = registry()
        try:
            tool = await tools.get_function("explore")
            result = await tool.ainvoke(args)
            assert result == (
                "Error: Exploration service returned HTTP 409: " + json.dumps(detail)
            )
            adapter[1].assert_not_awaited()
        finally:
            await tools.close()

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "endpoint",
    [
        "file:///tmp/explore",
        "http://user:secret@explore",
        "http://explore?query",
        "http://explore#fragment",
    ],
)
def test_invalid_endpoint_rejected_at_registration(adapter, monkeypatch, endpoint):
    async def exercise():
        monkeypatch.setenv("EXPLORATION_BASE_URL", endpoint)
        tools = registry()
        try:
            with pytest.raises(ValueError, match="endpoint"):
                await tools.get_function("explore")
        finally:
            await tools.close()

    asyncio.run(exercise())


@pytest.mark.requires_helm
@pytest.mark.parametrize(
    "setting, present",
    [
        (None, True),
        ("backend.networkPolicy.enabled=false", False),
        ("backend.default.enabled=false", False),
        ("exploration.enabled=false", False),
        ("backend.networkPolicy.cilium.enabled=true", True),
    ],
)
def test_exploration_egress_follows_network_policy_enablement(setting, present):
    command = [
        "helm",
        "template",
        "test",
        str(Path(__file__).parents[2] / "helm/daedalus"),
    ]
    if setting:
        command += ["--set", setting]
    resources = list(yaml.safe_load_all(subprocess.check_output(command, text=True)))
    policies = [
        item
        for item in resources
        if item
        and item["kind"] == "NetworkPolicy"
        and item["metadata"]["name"] == "test-daedalus-exploration"
    ]
    assert len(policies) == int(present)
    if present:
        assert policies[0]["spec"]["egress"] == [
            {
                "to": [
                    {
                        "namespaceSelector": {
                            "matchLabels": {
                                "kubernetes.io/metadata.name": "daedalus-exploration"
                            }
                        },
                        "podSelector": {"matchLabels": {"app": "exploration-api"}},
                    }
                ],
                "ports": [{"protocol": "TCP", "port": 8080}],
            }
        ]
