#!/usr/bin/env python3
"""Exercise MCP lifecycle recovery with the pinned NAT/SDK and a loopback server."""

import asyncio
import socket
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import anyio
import mcp_patches
import uvicorn
import yaml
from mcp.server.fastmcp import FastMCP
from nat.builder.workflow_builder import WorkflowBuilder
from nat.plugins.mcp.client.client_base import MCPStreamableHTTPClient
from nat.plugins.mcp.client.client_config import MCPClientConfig
from nat.plugins.mcp.client.client_impl import MCPFunctionGroup


def require(condition, message):
    if not condition:
        raise RuntimeError(f"MCP lifecycle runtime contract failed: {message}")


class FailingTransportClient(MCPStreamableHTTPClient):
    """Fail a child task while the real SDK transport is open and idle."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fail_transport = asyncio.Event()
        self.owners = []
        self.closed_by = []

    @asynccontextmanager
    async def connect_to_server(self):
        self.fail_transport = asyncio.Event()

        async def fail():
            await self.fail_transport.wait()
            raise ConnectionError("injected transport failure")

        self.owners.append(asyncio.current_task())
        try:
            async with anyio.create_task_group() as tasks:
                tasks.start_soon(fail)
                async with super().connect_to_server() as session:
                    yield session
                tasks.cancel_scope.cancel()
        finally:
            self.closed_by.append(asyncio.current_task())


async def stop_transport(client):
    task = client._lifecycle_task
    client.fail_transport.set()
    done, _ = await asyncio.wait((task,), timeout=3)
    require(bool(done), "failed transport left the owner running")
    require(not client.is_connected, "dead owner still advertised a connection")
    require(client._session is None, "failed transport retained its SDK session")
    require(client._exit_stack is None, "failed transport retained its exit stack")
    require(client.owners == client.closed_by, "transport exited in a different task")


async def check_mcp_lifecycle():
    mcp_patches._patch_mcp_lifecycle_recovery()
    mcp_patches._patch_mcp_session_recovery()
    from nat.plugins.mcp.client.client_base import MCPToolClient

    if not getattr(MCPToolClient.acall, "_daedalus_approval_gate", False):
        mcp_patches._patch_tool_client()
    calls = []
    server = FastMCP("lifecycle-contract", json_response=True)

    @server.tool()
    def echo(value: str) -> str:
        calls.append(value)
        return value

    @server.tool()
    def set_light_state(value: str) -> str:
        # A loopback-only mutation fixture; never contacts a Hue bridge.
        calls.append(value)
        return value

    @server.tool()
    def new_control(value: str) -> str:
        calls.append(value)
        return value

    @server.tool()
    def excluded_control(value: str) -> str:
        calls.append(value)
        return value

    # Bind before starting Uvicorn to avoid a free-port race.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        url = f"http://127.0.0.1:{listener.getsockname()[1]}/mcp"
        http_server = uvicorn.Server(
            uvicorn.Config(server.streamable_http_app(), log_level="error")
        )
        server_task = asyncio.create_task(http_server.serve(sockets=[listener]))
        try:
            async with asyncio.timeout(5):
                while not http_server.started:
                    if server_task.done():
                        await server_task
                        raise RuntimeError("MCP contract server failed to start")
                    await asyncio.sleep(0.01)
            async with asyncio.timeout(25):
                await check_clients(url, calls)
                await check_operator_approval(url, calls)
                await check_group_approval(url, calls)
        finally:
            http_server.should_exit = True
            await asyncio.wait_for(server_task, timeout=5)
    print(
        "MCP lifecycle runtime contract passed: owner cleanup, reconnect, "
        "session replacement, concurrent leases, operator approval, group discovery, "
        "mutation non-replay, and shutdown"
    )


async def check_group_approval(url, calls):
    """Discover unlisted tools through NAT, then execute under group defaults."""
    name = "hue_mcp_server"
    for filters in ({}, {"include": []}, {"exclude": ["excluded_control"]}):
        raw = {
            "_type": "mcp_client",
            "approval_policy": "auto_approve",
            "tool_overrides": {"echo": {"approval_policy": "approval_required"}},
            "server": {"transport": "streamable-http", "url": url},
            **filters,
        }
        with TemporaryDirectory() as directory:
            config = Path(directory) / "config.yaml"
            config.write_text(yaml.safe_dump({"function_groups": {name: raw}}))
            mcp_patches.configure_mcp_approval_policy(config)
        async with WorkflowBuilder() as builder:
            group = await builder.add_function_group(
                name, MCPClientConfig.model_validate(raw)
            )
            functions = await group.get_accessible_functions()
            expected = {"echo", "set_light_state", "new_control", "excluded_control"}
            expected -= set(filters.get("exclude", []))
            require(
                set(functions) == {f"{name}__{leaf}" for leaf in expected},
                "NAT discovery did not respect omitted/empty include and exclude",
            )
            value = f"group-default-{len(calls)}"
            result = await functions[f"{name}__new_control"].acall_invoke(
                {"value": value}
            )
            require(result == value, "newly discovered tool did not inherit approval")
            require(
                calls.count(value) == 1, "group-authorized tool call count mismatch"
            )
            denied = await functions[f"{name}__echo"].acall_invoke(
                {"value": "group-denied"}
            )
            require(
                "execution credential" in denied,
                "group default bypassed exact approval_required override",
            )
            require(
                "group-denied" not in calls, "approval-required tool reached server"
            )
            tool = await group.mcp_client.get_tool("new_control")
            original_call = group.mcp_client._session.call_tool

            async def lost_response(*args, **kwargs):
                await original_call(*args, **kwargs)
                raise ConnectionError("response lost after group-authorized execution")

            lost_value = f"group-lost-{len(calls)}"
            with patch.object(group.mcp_client._session, "call_tool", lost_response):
                outcome = await tool.acall({"value": lost_value})
            require(
                "mcp_tool_failed" in outcome, "ambiguous group call reported success"
            )
            require(calls.count(lost_value) == 1, "group-authorized mutation replayed")


async def check_operator_approval(url, calls):
    with TemporaryDirectory() as directory:
        config = Path(directory) / "config.yaml"
        config.write_text(
            yaml.safe_dump(
                {
                    "function_groups": {
                        "hue_mcp_server": {
                            "_type": "mcp_client",
                            "include": ["set_light_state", "echo"],
                            "tool_overrides": {
                                "set_light_state": {"approval_policy": "auto_approve"}
                            },
                            "server": {"transport": "streamable-http", "url": url},
                        }
                    },
                }
            )
        )
        mcp_patches.configure_mcp_approval_policy(config)
    async with MCPStreamableHTTPClient(url, reconnect_max_attempts=1) as client:
        tool = await client.get_tool("set_light_state")
        result = await tool.acall({"value": "operator-authorized"})
        require(result == "operator-authorized", "operator-authorized call was gated")
        require(calls.count("operator-authorized") == 1, "operator call count mismatch")
        unapproved = await client.get_tool("echo")
        try:
            await unapproved.acall({"value": "unapproved"})
        except PermissionError:
            pass
        else:
            raise RuntimeError("operator approval leaked to another tool")
        require("unapproved" not in calls, "unapproved tool reached the server")

        original_call = client._session.call_tool

        async def lost_response(*args, **kwargs):
            await original_call(*args, **kwargs)
            raise ConnectionError("response lost after operator-authorized execution")

        with patch.object(client._session, "call_tool", lost_response):
            outcome = await tool.acall({"value": "operator-response-lost"})
        require(
            "mcp_tool_failed" in outcome, "ambiguous operator call reported success"
        )
        require(
            calls.count("operator-response-lost") == 1, "operator mutation replayed"
        )
        require(client._reconnect_enabled, "operator call changed reconnect setting")


async def check_clients(url, calls):
    client = FailingTransportClient(
        url, reconnect_max_attempts=1, reconnect_initial_backoff=0
    )
    async with client:
        require("echo" in await client.get_tools(), "tool discovery failed")
        result = await client.call_tool("echo", {"value": "before"})
        require(not result.isError, "initial call failed")
        await stop_transport(client)
        # This exercises NAT's actual _with_reconnect path after the worker dies.
        result = await client.call_tool("echo", {"value": "after"})
        require(not result.isError, "read did not recover its transport")
        require(client.is_connected, "reconnected client is unavailable")
        require(len(client.owners) == 2, "reconnect did not create one new owner")

        # Simulate loss of the response after the server performed a mutation.
        # The approval adapter must suppress NAT's automatic replay.
        tool = await client.get_tool("echo")
        original_call = client._session.call_tool

        async def lost_response(*args, **kwargs):
            await original_call(*args, **kwargs)
            raise ConnectionError("response lost after execution")

        with (
            patch.object(client._session, "call_tool", lost_response),
            patch.object(
                mcp_patches,
                "_validate_mcp_approval",
                return_value=(True, "approved"),
            ),
        ):
            outcome = await tool.acall({"value": "mutation"})
        require(
            "mcp_tool_failed" in outcome, "ambiguous mutation was reported as success"
        )
        require(calls.count("mutation") == 1, "ambiguous mutation was replayed")
        require(client._reconnect_enabled, "mutation changed reconnect configuration")
    require(client.owners == client.closed_by, "normal exit leaked a transport")
    try:
        await client._reconnect()
    except RuntimeError:
        pass
    else:
        raise RuntimeError("closed MCP client was resurrected")
    require(len(client.owners) == 2, "reconnect after close opened a transport")

    # A worker cancelled during connect must wake its command caller.
    class CancelDuringConnect(MCPStreamableHTTPClient):
        async def _connect_connection(self):
            raise asyncio.CancelledError()

    broken = CancelDuringConnect(url)
    try:
        async with asyncio.timeout(2):
            async with broken:
                raise RuntimeError("cancelled initialization succeeded")
    except RuntimeError as exc:
        require("lifecycle stopped" in str(exc), "initialization failure was hidden")

    config = MCPClientConfig(
        server={"transport": "streamable-http", "url": url},
        tool_call_timeout=timedelta(seconds=3),
    )
    group = MCPFunctionGroup(config=config)
    group._client_config = config
    with patch(
        "nat.plugins.mcp.client.client_base.MCPStreamableHTTPClient",
        FailingTransportClient,
    ):
        try:
            async with group._session_usage_context("contract-session") as first:
                require("echo" in await first.get_tools(), "session discovery failed")
                await stop_transport(first)
                async with group._session_usage_context("contract-session") as busy:
                    require(busy is None, "active lease was replaced")
                require(
                    group._sessions["contract-session"].client is first,
                    "active session was removed",
                )

            both_entered = asyncio.Event()
            clients = []

            async def use():
                async with group._session_usage_context("contract-session") as fresh:
                    clients.append(fresh)
                    if len(clients) == 2:
                        both_entered.set()
                    await both_entered.wait()
                    result = await fresh.call_tool("echo", {"value": "cached"})
                    require(not result.isError, "replacement session call failed")

            await asyncio.gather(use(), use())
            require(
                clients[0] is clients[1], "concurrent calls created duplicate clients"
            )
            require(clients[0] is not first, "stopped session was reused")
            require(group._sessions["contract-session"].ref_count == 0, "lease leaked")
        finally:
            await group.cleanup_sessions(max_age=timedelta(seconds=-1))
    require(not group._sessions, "session shutdown leaked cached clients")


if __name__ == "__main__":
    asyncio.run(check_mcp_lifecycle())
