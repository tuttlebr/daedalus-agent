"""Session ownership, uncertain mutations, discovery, and header isolation."""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from daedalus_runtime import mcp


@pytest.mark.parametrize("abort", [False, True])
def test_mcp_transport_is_closed_in_its_owning_task(monkeypatch, abort):
    events = []
    tools = [
        SimpleNamespace(name="read", description="Read", inputSchema={"type": "object"})
    ]

    @asynccontextmanager
    async def transport(*args, **kwargs):
        owner = asyncio.current_task()
        events.append("transport-open")
        try:
            yield None, None, None
        finally:
            assert asyncio.current_task() is owner
            events.append("transport-close")

    class Session:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            self.owner = asyncio.current_task()
            events.append("session-open")
            return self

        async def __aexit__(self, *args):
            assert asyncio.current_task() is self.owner
            events.append("session-close")

        async def initialize(self):
            pass

        async def list_tools(self, **kwargs):
            return SimpleNamespace(tools=tools, nextCursor=None)

    monkeypatch.setattr(mcp, "streamable_http_client", transport)
    monkeypatch.setattr(mcp, "ClientSession", Session)

    async def scenario():
        connection = mcp.Connection("https://fixture.invalid/mcp", {}, 1)
        await connection.session()
        assert list(connection.tools) == ["read"]
        if abort:
            connection.abort()
            await connection.task
        else:
            await connection.close()
        assert connection.task.done()

    asyncio.run(scenario())
    assert events == [
        "transport-open",
        "session-open",
        "session-close",
        "transport-close",
    ]


def test_failed_mutation_is_never_replayed_and_only_success_gets_receipt(monkeypatch):
    config = {
        "function_groups": {
            "fixture": {"server": {"url": "https://fixture.invalid/mcp"}}
        }
    }
    session = SimpleNamespace(
        call_tool=AsyncMock(side_effect=RuntimeError("connection lost after write"))
    )
    connection = SimpleNamespace(
        session=AsyncMock(return_value=session),
        close=AsyncMock(),
        tools={
            "write": SimpleNamespace(
                name="write",
                description="Write",
                inputSchema={"type": "object"},
                annotations=None,
            )
        },
    )
    receipt = []

    def allowed(*args, **kwargs):
        kwargs["validated_binding"]["exact"] = True
        return True, ""

    monkeypatch.setattr(
        mcp, "trusted_request_header_from_context", lambda _: "fixture-token"
    )
    monkeypatch.setattr(mcp.approval, "_validate_mcp_approval", allowed)
    monkeypatch.setattr(
        mcp.approval,
        "_record_approved_mcp_receipt",
        lambda **kwargs: receipt.append(kwargs),
    )

    async def scenario():
        manager = mcp.MCPManager(config, SimpleNamespace())
        manager._connection = AsyncMock(return_value=connection)
        result = await manager.call("fixture__write", {}, "alice", AsyncMock())
        assert result["is_error"] and "unknown" in result["content"]
        assert session.call_tool.await_count == 1
        assert connection.close.await_count == 1
        assert not receipt
        session.call_tool.side_effect = None
        session.call_tool.return_value = SimpleNamespace(
            isError=True, model_dump_json=lambda **_: '{"isError":true}'
        )
        assert (await manager.call("fixture__write", {}, "alice", AsyncMock()))[
            "is_error"
        ]
        assert not receipt
        session.call_tool.return_value = SimpleNamespace(
            isError=False, model_dump_json=lambda **_: '{"isError":false}'
        )
        assert not (await manager.call("fixture__write", {}, "alice", AsyncMock()))[
            "is_error"
        ]
        assert len(receipt) == 1

    asyncio.run(scenario())


def test_static_headers_and_oauth_credentials_remain_scoped():
    config = {
        "authentication": {"google": {"_type": "mcp_oauth2"}},
        "function_groups": {
            "github": {"server": {"custom_headers": {"X-MCP-Readonly": "true"}}},
            "docs": {"server": {"auth_provider": "google"}},
        },
    }

    async def token(user, config, emit):
        return "token-" + user

    async def scenario():
        manager = mcp.MCPManager(config, SimpleNamespace(access_token=token))
        assert await manager._headers("github", "alice") == {"X-MCP-Readonly": "true"}
        alice, bob = await asyncio.gather(
            manager._headers("docs", "alice"), manager._headers("docs", "bob")
        )
        assert alice == {"Authorization": "Bearer token-alice"}
        assert bob == {"Authorization": "Bearer token-bob"}
        manager._connection = AsyncMock(side_effect=RuntimeError("unavailable"))
        schemas = await manager.catalogue(["github"], "alice")
        assert schemas[0]["name"] == "github__connect"
        assert not manager.capability_status()["available"]

    asyncio.run(scenario())


def test_deferred_catalogue_keeps_readiness_and_exposes_exact_allowed_schemas():
    config = {
        "function_groups": {
            "lighting": {
                "server": {"url": "https://fixture.invalid/mcp"},
                "defer_discovery": True,
                "discovery_description": "Read and control Philips Hue lights.",
                "include": ["read", "advanced_read"],
            }
        }
    }
    connection = SimpleNamespace(
        tools={
            name: SimpleNamespace(
                name=name,
                description=name,
                inputSchema={
                    "type": "object",
                    "properties": {"id": {"type": "string"}},
                },
            )
            for name in ("read", "advanced_read", "hidden_write")
        }
    )

    async def scenario():
        manager = mcp.MCPManager(config, SimpleNamespace())
        manager._headers = AsyncMock(return_value={})
        manager._connection = AsyncMock(return_value=connection)
        initial = await manager.catalogue(["lighting"], "alice", initial=True)
        assert [s["name"] for s in initial] == ["lighting__connect"]
        assert "Philips Hue" in initial[0]["description"]
        manager._headers.assert_not_awaited()
        manager._connection.assert_not_awaited()

        ready = await manager.catalogue(["lighting"], "runtime-readiness")
        assert [s["name"] for s in ready] == [
            "lighting__read",
            "lighting__advanced_read",
        ]
        for user in ("alice", "bob"):
            connected = await manager.call("lighting__connect", {}, user, AsyncMock())
            assert connected["tools"] == ready
            manager._connection.assert_awaited_with("lighting", user, {})
        assert (await manager.catalogue(["lighting"], "alice", initial=True)) == initial
        config["function_groups"]["lighting"]["initial_tools"] = [
            "read",
            "hidden_write",
        ]
        small = await manager.catalogue(["lighting"], "alice", initial=True)
        assert [s["name"] for s in small] == ["lighting__read", "lighting__connect"]
        assert small[0] == ready[0]
        assert "lighting__advanced_read" in small[1]["description"]
        assert "lighting__hidden_write" not in small[1]["description"]
        assert "lighting__read" not in small[1]["description"]
        # Even an unvalidated caller cannot bypass the include filter using
        # initial_tools. Runtime startup rejects that conflicting declaration.
        assert "lighting__hidden_write" not in {s["name"] for s in small}
        with pytest.raises(ValueError, match="not exposed"):
            await manager.call("lighting__hidden_write", {}, "alice", AsyncMock())
        with pytest.raises(ValueError, match="does not accept arguments"):
            await manager.call("lighting__connect", {"id": "bad"}, "alice", AsyncMock())

    asyncio.run(scenario())
