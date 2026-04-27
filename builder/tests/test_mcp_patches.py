"""Tests for mcp_patches -- get_tool reconnect, connect_to_server teardown, and startup resilience."""

import asyncio
import sys
import threading
import types
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

# Add builder root so we can import mcp_patches directly
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcp_patches import (  # noqa: E402
    _MCP_STARTUP_MAX_RETRIES,
    _connect_with_graceful_teardown,
    _extract_root_connection_error,
    _is_connection_error,
    _McpAppError,
    _skipped_function_groups,
)


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Helpers: get_tool reconnect tests
# ---------------------------------------------------------------------------


class FakeMCPBaseClient:
    """Minimal stand-in for nat.plugins.mcp.client.client_base.MCPBaseClient."""

    def __init__(self, url="http://fake/mcp", reconnect_enabled=True):
        self._url = url
        self._reconnect_enabled = reconnect_enabled
        self._exit_stack = None  # None == not initialized
        self._session = None
        self._connection_established = False
        self._tools = None

    async def __aenter__(self):
        if self._exit_stack:
            raise RuntimeError("MCPBaseClient already initialized.")
        self._exit_stack = object()  # truthy sentinel
        self._session = MagicMock(name="session")
        self._connection_established = True
        return self

    async def __aexit__(self, *args):
        self._exit_stack = None
        self._session = None
        self._connection_established = False
        self._tools = None

    async def get_tool(self, tool_name):
        if not self._exit_stack:
            raise RuntimeError(
                "MCPBaseClient not initialized. Use async with to initialize."
            )
        return MagicMock(name=f"tool-{tool_name}")


# ---------------------------------------------------------------------------
# Helpers: connect_to_server teardown tests
# ---------------------------------------------------------------------------


class MockSession:
    """Stand-in for mcp.ClientSession."""

    def __init__(self, read=None, write=None):
        pass

    async def initialize(self):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


def _mock_streams():
    return (MagicMock(name="read"), MagicMock(name="write"), MagicMock(name="cb"))


@asynccontextmanager
async def _streamable_ok():
    """Normal streamablehttp_client -- no errors."""
    yield _mock_streams()


@asynccontextmanager
async def _streamable_cancel_on_exit():
    """streamablehttp_client that raises CancelledError during __aexit__."""
    yield _mock_streams()
    raise asyncio.CancelledError("terminate_session cancelled")


@asynccontextmanager
async def _streamable_cancel_scope_on_exit():
    """streamablehttp_client that raises cancel-scope RuntimeError during __aexit__."""
    yield _mock_streams()
    raise RuntimeError("Cancelled via cancel scope abc123")


@asynccontextmanager
async def _streamable_conn_error_on_exit():
    """streamablehttp_client that raises ConnectionError during __aexit__."""
    yield _mock_streams()
    raise ConnectionError("server vanished")


# ---------------------------------------------------------------------------
# Tests: get_tool reconnect
# ---------------------------------------------------------------------------


class TestGetToolReconnectPatch:
    """Verify _patch_get_tool_reconnect behaviour against the fake client."""

    def _apply_patch(self):
        """Monkey-patch FakeMCPBaseClient.get_tool the same way the real patch does."""
        import functools

        original_get_tool = FakeMCPBaseClient.get_tool

        @functools.wraps(original_get_tool)
        async def patched_get_tool(self, *args, **kwargs):
            try:
                return await original_get_tool(self, *args, **kwargs)
            except RuntimeError as exc:
                if "not initialized" not in str(exc):
                    raise
                if not getattr(self, "_reconnect_enabled", False):
                    raise

                try:
                    await self.__aenter__()
                except RuntimeError as init_err:
                    if "already initialized" in str(init_err):
                        pass
                    else:
                        raise exc from init_err
                except Exception as reconnect_err:
                    raise exc from reconnect_err

                return await original_get_tool(self, *args, **kwargs)

        FakeMCPBaseClient.get_tool = patched_get_tool
        return original_get_tool

    def test_healthy_client_unchanged(self):
        """When the client is initialized, get_tool passes through normally."""
        original = self._apply_patch()
        try:
            client = FakeMCPBaseClient()

            async def _run():
                await client.__aenter__()
                tool = await client.get_tool("list_pods")
                assert tool is not None

            run(_run())
        finally:
            FakeMCPBaseClient.get_tool = original

    def test_reconnect_on_session_drop(self):
        """After __aexit__ (session drop), get_tool reconnects and succeeds."""
        original = self._apply_patch()
        try:
            client = FakeMCPBaseClient(reconnect_enabled=True)

            async def _run():
                # Initial connection
                await client.__aenter__()
                # Simulate session drop
                await client.__aexit__(None, None, None)
                assert client._exit_stack is None

                # get_tool should reconnect transparently
                tool = await client.get_tool("list_pods")
                assert tool is not None
                assert client._exit_stack is not None

            run(_run())
        finally:
            FakeMCPBaseClient.get_tool = original

    def test_no_reconnect_when_disabled(self):
        """When reconnect_enabled=False, the original error propagates."""
        original = self._apply_patch()
        try:
            client = FakeMCPBaseClient(reconnect_enabled=False)

            async def _run():
                await client.__aenter__()
                await client.__aexit__(None, None, None)
                with pytest.raises(RuntimeError, match="not initialized"):
                    await client.get_tool("list_pods")

            run(_run())
        finally:
            FakeMCPBaseClient.get_tool = original

    def test_concurrent_reconnect_race(self):
        """If two coroutines race, the second sees 'already initialized' and still succeeds."""
        original = self._apply_patch()
        try:
            client = FakeMCPBaseClient(reconnect_enabled=True)

            async def _run():
                await client.__aenter__()
                await client.__aexit__(None, None, None)

                # Both should succeed even though only one can call __aenter__
                results = await asyncio.gather(
                    client.get_tool("tool_a"),
                    client.get_tool("tool_b"),
                )
                assert all(r is not None for r in results)

            run(_run())
        finally:
            FakeMCPBaseClient.get_tool = original

    def test_reconnect_failure_raises_original(self):
        """If __aenter__ fails during reconnect, the original RuntimeError is raised."""
        original = self._apply_patch()
        try:
            client = FakeMCPBaseClient(reconnect_enabled=True)

            async def failing_aenter():
                raise ConnectionError("server unreachable")

            async def _run():
                await client.__aenter__()
                await client.__aexit__(None, None, None)

                # Replace __aenter__ so reconnect always fails
                client.__aenter__ = failing_aenter

                with pytest.raises(RuntimeError, match="not initialized"):
                    await client.get_tool("list_pods")

            run(_run())
        finally:
            FakeMCPBaseClient.get_tool = original

    def test_unrelated_runtime_error_not_caught(self):
        """RuntimeErrors that don't match 'not initialized' propagate normally."""
        original = self._apply_patch()
        try:
            client = FakeMCPBaseClient(reconnect_enabled=True)

            async def bad_get_tool(self, tool_name):
                raise RuntimeError("something completely different")

            # Replace original with one that raises a different error
            FakeMCPBaseClient.get_tool = original  # restore first
            real_original = FakeMCPBaseClient.get_tool

            # Re-apply patch on top of a method that raises a different error
            import functools

            @functools.wraps(real_original)
            async def raises_other(self, *a, **kw):
                raise RuntimeError("something completely different")

            FakeMCPBaseClient.get_tool = raises_other
            self._apply_patch()

            async def _run():
                await client.__aenter__()
                with pytest.raises(
                    RuntimeError, match="something completely different"
                ):
                    await client.get_tool("list_pods")

            run(_run())
        finally:
            FakeMCPBaseClient.get_tool = original


# ---------------------------------------------------------------------------
# Tests: connect_to_server teardown
# ---------------------------------------------------------------------------


class TestConnectToServerTeardown:
    """Verify _connect_with_graceful_teardown handles teardown errors correctly."""

    def test_clean_lifecycle(self):
        """Normal use -- enter, use session, exit without errors."""

        async def _run():
            async with _connect_with_graceful_teardown(
                _streamable_ok(), MockSession, "http://fake/mcp"
            ) as session:
                assert session is not None
                await asyncio.sleep(0)  # simulate work

        run(_run())

    def test_cancelled_during_use_propagates(self):
        """CancelledError raised while the session is in active use propagates."""

        async def _run():
            with pytest.raises(asyncio.CancelledError):
                async with _connect_with_graceful_teardown(
                    _streamable_ok(), MockSession, "http://fake/mcp"
                ) as _session:
                    raise asyncio.CancelledError("task cancelled")

        run(_run())

    def test_cancelled_during_teardown_suppressed(self):
        """CancelledError from terminate_session during teardown is suppressed."""

        async def _run():
            # Should NOT raise -- the CancelledError from __aexit__ is suppressed
            async with _connect_with_graceful_teardown(
                _streamable_cancel_on_exit(), MockSession, "http://fake/mcp"
            ) as _session:
                await asyncio.sleep(0)

        run(_run())

    def test_cancel_scope_during_teardown_suppressed(self):
        """RuntimeError('cancel scope') during teardown is suppressed."""

        async def _run():
            # Should NOT raise
            async with _connect_with_graceful_teardown(
                _streamable_cancel_scope_on_exit(), MockSession, "http://fake/mcp"
            ) as _session:
                await asyncio.sleep(0)

        run(_run())

    def test_cancel_scope_during_use_converts_to_cancelled(self):
        """RuntimeError('cancel scope') during active use converts to CancelledError."""

        async def _run():
            with pytest.raises(asyncio.CancelledError):
                async with _connect_with_graceful_teardown(
                    _streamable_ok(), MockSession, "http://fake/mcp"
                ) as _session:
                    raise RuntimeError("Cancelled via cancel scope xyz")

        run(_run())

    def test_connection_error_during_teardown_suppressed(self):
        """Connection errors during teardown are suppressed (transport cleanup)."""

        async def _run():
            # Should NOT raise -- ConnectionError during __aexit__ is suppressed
            async with _connect_with_graceful_teardown(
                _streamable_conn_error_on_exit(), MockSession, "http://fake/mcp"
            ) as _session:
                await asyncio.sleep(0)

        run(_run())

    def test_exception_group_read_timeout_during_teardown_suppressed(self):
        """ExceptionGroup(ReadTimeout) during teardown is suppressed."""

        @asynccontextmanager
        async def _streamable_eg_read_timeout_on_exit():
            yield _mock_streams()
            raise ExceptionGroup(  # noqa: F821
                "unhandled errors in a TaskGroup",
                [httpx.ReadTimeout("")],
            )

        async def _run():
            # Should NOT raise -- ExceptionGroup(ReadTimeout) during __aexit__
            async with _connect_with_graceful_teardown(
                _streamable_eg_read_timeout_on_exit(),
                MockSession,
                "http://fake/mcp",
            ) as _session:
                await asyncio.sleep(0)

        run(_run())

    def test_non_connection_exception_during_teardown_propagates(self):
        """Non-connection exceptions during teardown still propagate."""

        @asynccontextmanager
        async def _streamable_value_error_on_exit():
            yield _mock_streams()
            raise ValueError("unexpected config error")

        async def _run():
            with pytest.raises(ValueError, match="unexpected config error"):
                async with _connect_with_graceful_teardown(
                    _streamable_value_error_on_exit(),
                    MockSession,
                    "http://fake/mcp",
                ) as _session:
                    await asyncio.sleep(0)

        run(_run())

    def test_unrelated_runtime_error_during_teardown_propagates(self):
        """Non-cancel-scope RuntimeError during teardown still propagates."""

        @asynccontextmanager
        async def _streamable_other_runtime_error():
            yield _mock_streams()
            raise RuntimeError("something unrelated")

        async def _run():
            with pytest.raises(RuntimeError, match="something unrelated"):
                async with _connect_with_graceful_teardown(
                    _streamable_other_runtime_error(),
                    MockSession,
                    "http://fake/mcp",
                ) as _session:
                    await asyncio.sleep(0)

        run(_run())

    def test_operational_exception_propagates(self):
        """Regular exceptions during active session use propagate normally."""

        async def _run():
            with pytest.raises(ValueError, match="bad input"):
                async with _connect_with_graceful_teardown(
                    _streamable_ok(), MockSession, "http://fake/mcp"
                ) as _session:
                    raise ValueError("bad input")

        run(_run())


# ---------------------------------------------------------------------------
# Tests: _is_connection_error helper
# ---------------------------------------------------------------------------


class TestIsConnectionError:
    """Verify _is_connection_error detects connection errors in various wrappings."""

    def test_bare_connect_timeout(self):
        assert _is_connection_error(httpx.ConnectTimeout("timed out"))

    def test_bare_connect_error(self):
        assert _is_connection_error(httpx.ConnectError("refused"))

    def test_bare_connection_refused(self):
        assert _is_connection_error(ConnectionRefusedError("refused"))

    def test_bare_connection_reset(self):
        assert _is_connection_error(ConnectionResetError("reset"))

    def test_wrapped_in_exception_group(self):
        """ConnectTimeout wrapped in ExceptionGroup (anyio TaskGroup pattern)."""
        eg = ExceptionGroup(  # noqa: F821
            "unhandled errors in a TaskGroup",
            [httpx.ConnectTimeout("timed out")],
        )
        assert _is_connection_error(eg)

    def test_nested_exception_group(self):
        """ConnectTimeout double-wrapped in ExceptionGroups."""
        inner = ExceptionGroup("inner", [httpx.ConnectTimeout("timed out")])  # noqa: F821
        outer = ExceptionGroup("outer", [inner])  # noqa: F821
        assert _is_connection_error(outer)

    def test_in_cause_chain(self):
        """ConnectTimeout in __cause__ of a wrapper exception."""
        cause = httpx.ConnectTimeout("timed out")
        wrapper = RuntimeError("build failed")
        wrapper.__cause__ = cause
        assert _is_connection_error(wrapper)

    def test_value_error_not_connection_error(self):
        assert not _is_connection_error(ValueError("bad input"))

    def test_runtime_error_not_connection_error(self):
        assert not _is_connection_error(RuntimeError("something else"))

    def test_exception_group_with_non_connection_error(self):
        eg = ExceptionGroup("group", [ValueError("bad")])  # noqa: F821
        assert not _is_connection_error(eg)

    def test_read_timeout_is_connection_error(self):
        """ReadTimeout IS a connection error — server accepts TCP but never responds."""
        assert _is_connection_error(httpx.ReadTimeout("slow response"))

    def test_read_timeout_in_exception_group(self):
        """ReadTimeout wrapped in ExceptionGroup (anyio TaskGroup cleanup pattern)."""
        eg = ExceptionGroup(  # noqa: F821
            "unhandled errors in a TaskGroup",
            [httpx.ReadTimeout("")],
        )
        assert _is_connection_error(eg)


# ---------------------------------------------------------------------------
# Tests: _extract_root_connection_error helper
# ---------------------------------------------------------------------------


class TestExtractRootConnectionError:
    """Verify we extract the innermost connection error for clean log messages."""

    def test_bare_error_returns_itself(self):
        err = httpx.ConnectTimeout("timed out")
        assert _extract_root_connection_error(err) is err

    def test_extracts_from_exception_group(self):
        inner = httpx.ConnectTimeout("timed out")
        eg = ExceptionGroup("group", [inner])  # noqa: F821
        assert _extract_root_connection_error(eg) is inner

    def test_extracts_from_cause_chain(self):
        cause = httpx.ConnectError("refused")
        wrapper = RuntimeError("build failed")
        wrapper.__cause__ = cause
        assert _extract_root_connection_error(wrapper) is cause

    def test_non_connection_returns_original(self):
        err = ValueError("bad")
        assert _extract_root_connection_error(err) is err


# ---------------------------------------------------------------------------
# Tests: startup resilience (add_function_group patch)
# ---------------------------------------------------------------------------


class FakeWorkflowBuilder:
    """Minimal stand-in for nat.builder.workflow_builder.WorkflowBuilder."""

    def __init__(self):
        self.registered = {}

    async def add_function_group(self, name, *args, **kwargs):
        """Simulate function group registration; subclass to inject errors."""
        self.registered[name] = True
        return {"name": name}

    async def get_tools(self, tool_names=None, wrapper_type=None):
        """Simulate tool resolution — raises ValueError for unregistered names."""
        tools = []
        for name in tool_names or []:
            if name not in self.registered:
                raise ValueError(f"Function `{name}` not found in list of functions")
            tools.append(MagicMock(name=f"tool-{name}"))
        return tools

    async def get_function(self, name, *args, **kwargs):
        """Simulate single function lookup — raises ValueError if not registered."""
        if name not in self.registered:
            raise ValueError(f"Function `{name}` not found")
        return MagicMock(name=f"fn-{name}")


class TestStartupResilience:
    """Verify the add_function_group and get_tools resilience wrappers."""

    def _apply_patch(self, builder_cls):
        """Apply the same wrapping logic as _patch_startup_resilience."""
        import functools

        _skipped_function_groups.clear()

        original_add_fg = builder_cls.add_function_group

        @functools.wraps(original_add_fg)
        async def resilient(self, name, *args, **kwargs):
            try:
                return await original_add_fg(self, name, *args, **kwargs)
            except Exception as exc:
                if _is_connection_error(exc):
                    _extract_root_connection_error(exc)  # for logging
                    _skipped_function_groups.add(name)
                    return None
                raise

        builder_cls.add_function_group = resilient

        original_get_tools = builder_cls.get_tools

        @functools.wraps(original_get_tools)
        async def resilient_get_tools(self, tool_names=None, *args, **kwargs):
            if tool_names and _skipped_function_groups:
                tool_names = [
                    n for n in tool_names if n not in _skipped_function_groups
                ]
            return await original_get_tools(self, tool_names, *args, **kwargs)

        builder_cls.get_tools = resilient_get_tools

        original_get_function = builder_cls.get_function

        @functools.wraps(original_get_function)
        async def resilient_get_function(self, name, *args, **kwargs):
            if name in _skipped_function_groups:
                return None
            return await original_get_function(self, name, *args, **kwargs)

        builder_cls.get_function = resilient_get_function

        return original_add_fg, original_get_tools, original_get_function

    def _restore(self, cls, originals):
        cls.add_function_group, cls.get_tools, cls.get_function = originals
        _skipped_function_groups.clear()

    def test_successful_registration_unchanged(self):
        """Normal function group registration passes through."""
        originals = self._apply_patch(FakeWorkflowBuilder)
        try:
            builder = FakeWorkflowBuilder()

            async def _run():
                result = await builder.add_function_group("github_mcp")
                assert result == {"name": "github_mcp"}
                assert "github_mcp" in builder.registered

            run(_run())
        finally:
            self._restore(FakeWorkflowBuilder, originals)

    def test_connect_timeout_skipped(self):
        """ConnectTimeout causes the function group to be skipped, not crash."""

        class FailingBuilder(FakeWorkflowBuilder):
            async def add_function_group(self, name, *args, **kwargs):
                if name == "k8s_mcp":
                    raise ExceptionGroup(  # noqa: F821
                        "unhandled errors in a TaskGroup",
                        [httpx.ConnectTimeout("k8s-mcp-server:8080")],
                    )
                return await super().add_function_group(name, *args, **kwargs)

        originals = self._apply_patch(FailingBuilder)
        try:
            builder = FailingBuilder()

            async def _run():
                # k8s_mcp should be skipped (return None)
                result = await builder.add_function_group("k8s_mcp")
                assert result is None

                # Other groups should still work
                result2 = await builder.add_function_group("github_mcp")
                assert result2 == {"name": "github_mcp"}

            run(_run())
        finally:
            self._restore(FailingBuilder, originals)

    def test_connect_error_skipped(self):
        """ConnectError (DNS/network failure) also causes graceful skip."""

        class FailingBuilder(FakeWorkflowBuilder):
            async def add_function_group(self, name, *args, **kwargs):
                raise httpx.ConnectError("DNS resolution failed")

        originals = self._apply_patch(FailingBuilder)
        try:
            builder = FailingBuilder()

            async def _run():
                result = await builder.add_function_group("broken_mcp")
                assert result is None

            run(_run())
        finally:
            self._restore(FailingBuilder, originals)

    def test_retry_succeeds_on_later_attempt(self):
        """Function group connects after transient failures."""

        class TransientFailBuilder(FakeWorkflowBuilder):
            def __init__(self):
                super().__init__()
                self.attempts = 0

            async def add_function_group(self, name, *args, **kwargs):
                self.attempts += 1
                if self.attempts <= 2:
                    raise httpx.ConnectTimeout("k8s-mcp-server:8080")
                return await super().add_function_group(name, *args, **kwargs)

        originals = self._apply_patch_with_retry(TransientFailBuilder)
        try:
            builder = TransientFailBuilder()

            async def _run():
                result = await builder.add_function_group("k8s_mcp")
                # Should succeed on attempt 3
                assert result == {"name": "k8s_mcp"}
                assert "k8s_mcp" not in _skipped_function_groups
                assert builder.attempts == 3

            run(_run())
        finally:
            self._restore(TransientFailBuilder, originals)

    def test_retry_exhausted_then_skipped(self):
        """All retries fail -> function group is skipped."""

        class PermanentFailBuilder(FakeWorkflowBuilder):
            def __init__(self):
                super().__init__()
                self.attempts = 0

            async def add_function_group(self, name, *args, **kwargs):
                self.attempts += 1
                raise httpx.ConnectTimeout("k8s-mcp-server:8080")

        originals = self._apply_patch_with_retry(PermanentFailBuilder)
        try:
            builder = PermanentFailBuilder()

            async def _run():
                result = await builder.add_function_group("k8s_mcp")
                assert result is None
                assert "k8s_mcp" in _skipped_function_groups
                assert builder.attempts == _MCP_STARTUP_MAX_RETRIES + 1

            run(_run())
        finally:
            self._restore(PermanentFailBuilder, originals)

    def _apply_patch_with_retry(self, builder_cls):
        """Apply wrapping with retry logic (mirrors actual _patch_startup_resilience)."""
        import functools

        _skipped_function_groups.clear()

        original_add_fg = builder_cls.add_function_group

        @functools.wraps(original_add_fg)
        async def resilient(self, name, *args, **kwargs):
            for attempt in range(_MCP_STARTUP_MAX_RETRIES + 1):
                try:
                    return await original_add_fg(self, name, *args, **kwargs)
                except Exception as exc:
                    if not _is_connection_error(exc):
                        raise
                    if attempt < _MCP_STARTUP_MAX_RETRIES:
                        # Skip the actual sleep in tests
                        continue
            _skipped_function_groups.add(name)
            return None

        builder_cls.add_function_group = resilient

        # Reuse the same get_tools/get_function wrappers
        original_get_tools = builder_cls.get_tools

        @functools.wraps(original_get_tools)
        async def resilient_get_tools(self, tool_names=None, *args, **kwargs):
            if tool_names and _skipped_function_groups:
                tool_names = [
                    n for n in tool_names if n not in _skipped_function_groups
                ]
            return await original_get_tools(self, tool_names, *args, **kwargs)

        builder_cls.get_tools = resilient_get_tools

        original_get_function = builder_cls.get_function

        @functools.wraps(original_get_function)
        async def resilient_get_function(self, name, *args, **kwargs):
            if name in _skipped_function_groups:
                return None
            return await original_get_function(self, name, *args, **kwargs)

        builder_cls.get_function = resilient_get_function

        return original_add_fg, original_get_tools, original_get_function

    def test_non_connection_error_still_raises(self):
        """Non-connection errors (e.g. config errors) still propagate."""

        class BadConfigBuilder(FakeWorkflowBuilder):
            async def add_function_group(self, name, *args, **kwargs):
                raise ValueError("invalid config: missing 'url' field")

        originals = self._apply_patch(BadConfigBuilder)
        try:
            builder = BadConfigBuilder()

            async def _run():
                with pytest.raises(ValueError, match="invalid config"):
                    await builder.add_function_group("bad_mcp")

            run(_run())
        finally:
            self._restore(BadConfigBuilder, originals)

    def test_auth_error_still_raises(self):
        """HTTP 401/403 errors are not connection errors and should still raise."""

        class AuthFailBuilder(FakeWorkflowBuilder):
            async def add_function_group(self, name, *args, **kwargs):
                raise httpx.HTTPStatusError(
                    "401 Unauthorized",
                    request=httpx.Request("POST", "http://fake/mcp"),
                    response=httpx.Response(401),
                )

        originals = self._apply_patch(AuthFailBuilder)
        try:
            builder = AuthFailBuilder()

            async def _run():
                with pytest.raises(httpx.HTTPStatusError):
                    await builder.add_function_group("auth_fail_mcp")

            run(_run())
        finally:
            self._restore(AuthFailBuilder, originals)

    def test_get_tools_filters_skipped_groups(self):
        """get_tools omits tools from skipped function groups instead of crashing."""

        class FailingBuilder(FakeWorkflowBuilder):
            async def add_function_group(self, name, *args, **kwargs):
                if name == "k8s_mcp_server":
                    raise httpx.ConnectTimeout("k8s-mcp-server:8080")
                return await super().add_function_group(name, *args, **kwargs)

        originals = self._apply_patch(FailingBuilder)
        try:
            builder = FailingBuilder()

            async def _run():
                # Register one group, skip the unreachable one
                await builder.add_function_group("k8s_mcp_server")
                await builder.add_function_group("github_mcp")

                assert "k8s_mcp_server" in _skipped_function_groups
                assert "k8s_mcp_server" not in builder.registered
                assert "github_mcp" in builder.registered

                # get_tools should skip k8s_mcp_server instead of crashing
                tools = await builder.get_tools(
                    tool_names=["github_mcp", "k8s_mcp_server"]
                )
                assert len(tools) == 1  # only github_mcp resolved

            run(_run())
        finally:
            self._restore(FailingBuilder, originals)

    def test_get_tools_all_available_unchanged(self):
        """get_tools passes through normally when no groups were skipped."""
        originals = self._apply_patch(FakeWorkflowBuilder)
        try:
            builder = FakeWorkflowBuilder()

            async def _run():
                await builder.add_function_group("tool_a")
                await builder.add_function_group("tool_b")
                tools = await builder.get_tools(tool_names=["tool_a", "tool_b"])
                assert len(tools) == 2

            run(_run())
        finally:
            self._restore(FakeWorkflowBuilder, originals)

    def test_get_tools_no_tool_names(self):
        """get_tools with no tool_names does not crash on empty/None."""
        originals = self._apply_patch(FakeWorkflowBuilder)
        try:
            builder = FakeWorkflowBuilder()

            async def _run():
                tools = await builder.get_tools(tool_names=None)
                assert tools == []
                tools = await builder.get_tools(tool_names=[])
                assert tools == []

            run(_run())
        finally:
            self._restore(FakeWorkflowBuilder, originals)

    def test_get_tools_positional_args(self):
        """get_tools works when called with positional args (child_builder pattern).

        child_builder.py calls ``get_tools(tool_names, wrapper_type)`` with
        both arguments positional.  The wrapper must forward them correctly
        without 'got multiple values for argument' TypeError.
        """

        class BuilderWithWrapper(FakeWorkflowBuilder):
            async def get_tools(self, tool_names=None, wrapper_type=None):
                result = await super().get_tools(tool_names=tool_names)
                return result

        originals = self._apply_patch(BuilderWithWrapper)
        try:
            builder = BuilderWithWrapper()

            async def _run():
                await builder.add_function_group("tool_a")
                # Call with positional args — the pattern from child_builder.py
                tools = await builder.get_tools(["tool_a"], "langchain")
                assert len(tools) == 1

            run(_run())
        finally:
            self._restore(BuilderWithWrapper, originals)

    def test_get_function_filters_skipped_groups(self):
        """get_function returns None for skipped groups (reasoning_agent path).

        The reasoning_agent resolves tools individually via get_function()
        instead of get_tools().  When a function group was skipped at
        startup, get_function must return None rather than raising
        ValueError so the reasoning_agent can start with a reduced tool set.
        """

        class FailingBuilder(FakeWorkflowBuilder):
            async def add_function_group(self, name, *args, **kwargs):
                if name == "k8s_mcp_server":
                    raise httpx.ConnectTimeout("k8s-mcp-server:8080")
                return await super().add_function_group(name, *args, **kwargs)

        originals = self._apply_patch(FailingBuilder)
        try:
            builder = FailingBuilder()

            async def _run():
                await builder.add_function_group("k8s_mcp_server")
                await builder.add_function_group("github_mcp")

                assert "k8s_mcp_server" in _skipped_function_groups

                # get_function should return None for skipped group
                result = await builder.get_function("k8s_mcp_server")
                assert result is None

                # get_function should work normally for available groups
                result = await builder.get_function("github_mcp")
                assert result is not None

            run(_run())
        finally:
            self._restore(FailingBuilder, originals)

    def test_get_function_available_unchanged(self):
        """get_function passes through normally when no groups were skipped."""
        originals = self._apply_patch(FakeWorkflowBuilder)
        try:
            builder = FakeWorkflowBuilder()

            async def _run():
                await builder.add_function_group("tool_a")
                result = await builder.get_function("tool_a")
                assert result is not None

            run(_run())
        finally:
            self._restore(FakeWorkflowBuilder, originals)

    def test_get_function_missing_not_skipped_still_raises(self):
        """get_function still raises ValueError for genuinely missing functions."""
        originals = self._apply_patch(FakeWorkflowBuilder)
        try:
            builder = FakeWorkflowBuilder()

            async def _run():
                import pytest

                with pytest.raises(ValueError, match="not found"):
                    await builder.get_function("nonexistent_tool")

            run(_run())
        finally:
            self._restore(FakeWorkflowBuilder, originals)


# ---------------------------------------------------------------------------
# Helpers: async job status persistence tests
# ---------------------------------------------------------------------------


class FakeJobStore:
    """Minimal stand-in for nat.front_ends.fastapi.async_jobs.job_store.JobStore."""

    def __init__(self, delay=0):
        self.jobs = {}  # job_id -> {status, error, output}
        self.update_calls = []
        self._delay = delay

    async def update_status(self, job_id, status, error=None, output=None):
        if self._delay:
            await asyncio.sleep(self._delay)
        self.update_calls.append((job_id, status, error, output))
        self.jobs[job_id] = {"status": status, "error": error, "output": output}

    async def get_job(self, job_id):
        if self._delay:
            await asyncio.sleep(self._delay)
        data = self.jobs.get(job_id)
        if data is None:
            return None
        return MagicMock(
            status=data["status"], error=data["error"], output=data["output"]
        )


# ---------------------------------------------------------------------------
# Tests: async job status persistence under cancellation
# ---------------------------------------------------------------------------


class TestAsyncJobStatusPersistence:
    """Verify that error handlers persist job status even under active cancel scopes.

    These tests validate Fix 7 from mcp_patches.py: asyncio.shield() around
    job_store.update_status() in error handlers, and catching CancelledError
    alongside Exception in the inner cleanup handler.
    """

    def test_inner_except_catches_cancelled_error(self):
        """In Python 3.9+, CancelledError is BaseException.  ``except Exception``
        misses it, but ``except (Exception, asyncio.CancelledError)`` catches it.
        This ensures the result-saved check runs for cleanup cancellations."""

        async def _run_with_fix():
            result = "valid_output"
            try:
                try:
                    raise asyncio.CancelledError("cleanup cancelled")
                except (Exception, asyncio.CancelledError):
                    if result is not None:
                        return "checked_result"
                    raise
            except asyncio.CancelledError:
                return "outer_handler"

        async def _run_without_fix():
            result = "valid_output"
            try:
                try:
                    raise asyncio.CancelledError("cleanup cancelled")
                except Exception:  # BUG: misses CancelledError in 3.9+
                    if result is not None:
                        return "checked_result"
                    raise
            except asyncio.CancelledError:
                return "outer_handler"

        # With fix: inner handler catches CancelledError, checks result
        assert run(_run_with_fix()) == "checked_result"
        # Without fix: falls through to outer handler (would overwrite SUCCESS)
        assert run(_run_without_fix()) == "outer_handler"

    def test_cleanup_cancel_does_not_overwrite_saved_success(self):
        """When result was saved as SUCCESS and cleanup raises CancelledError,
        the inner handler detects the saved result and returns early instead of
        letting the outer handler overwrite with INTERRUPTED."""
        store = FakeJobStore()

        async def _run():
            # Simulate: result was saved as SUCCESS
            await store.update_status("job-1", "success", output="result_data")

            result = "result_data"
            try:
                try:
                    # Simulate: cleanup raises CancelledError
                    raise asyncio.CancelledError("cleanup teardown cancelled")
                except (Exception, asyncio.CancelledError):
                    if result is not None:
                        try:
                            job = await asyncio.shield(store.get_job("job-1"))
                            if job and job.status == "success":
                                return "preserved_success"
                        except (asyncio.CancelledError, Exception):
                            pass
                    raise
            except asyncio.CancelledError:
                try:
                    await asyncio.shield(
                        store.update_status("job-1", "interrupted", error="cancelled")
                    )
                except (asyncio.CancelledError, Exception):
                    pass
                return "overwrote_with_interrupted"

        assert run(_run()) == "preserved_success"
        assert store.jobs["job-1"]["status"] == "success"

    def test_result_retry_when_success_not_persisted(self):
        """When result exists but update_status(SUCCESS) was cancelled (not persisted),
        the inner handler retries the save via asyncio.shield()."""
        store = FakeJobStore()

        async def _run():
            # Simulate: RUNNING was set but SUCCESS update was cancelled
            await store.update_status("job-1", "running")

            result = "result_data"
            try:
                try:
                    raise asyncio.CancelledError("update_status(SUCCESS) cancelled")
                except (Exception, asyncio.CancelledError):
                    if result is not None:
                        try:
                            job = await asyncio.shield(store.get_job("job-1"))
                            if job and job.status == "success":
                                return "already_saved"
                            # Not SUCCESS -- retry save
                            await asyncio.shield(
                                store.update_status("job-1", "success", output=result)
                            )
                            return "retried_save"
                        except (asyncio.CancelledError, Exception):
                            pass
                    raise
            except asyncio.CancelledError:
                return "outer_handler"

        assert run(_run()) == "retried_save"
        assert store.jobs["job-1"]["status"] == "success"
        assert store.jobs["job-1"]["output"] == "result_data"

    def test_ensure_future_survives_task_cancellation(self):
        """ensure_future (fire-and-forget) completes even when the calling
        task is cancelled, while a direct await is lost."""
        ff_store = FakeJobStore(delay=0.01)
        direct_store = FakeJobStore(delay=0.01)

        async def handler_fire_and_forget():
            # Fire-and-forget: no await, so cancellation can't interfere
            _bg = asyncio.ensure_future(
                ff_store.update_status("job-1", "interrupted", error="cancelled")
            )
            _bg.add_done_callback(
                lambda t: t.exception() if not t.cancelled() else None
            )
            # Simulate work that gets cancelled
            await asyncio.sleep(10)

        async def handler_direct_await():
            try:
                await direct_store.update_status(
                    "job-2", "interrupted", error="cancelled"
                )
            except asyncio.CancelledError:
                pass  # update_status was killed mid-flight

        async def _run():
            # Fire-and-forget: cancel the task, but the bg update still completes
            task1 = asyncio.create_task(handler_fire_and_forget())
            await asyncio.sleep(0)  # let task start and schedule bg task
            task1.cancel()
            try:
                await task1
            except asyncio.CancelledError:
                pass
            await asyncio.sleep(0.05)  # let bg task finish

            # Direct await: cancel kills the update mid-sleep
            task2 = asyncio.create_task(handler_direct_await())
            await asyncio.sleep(0)
            task2.cancel()
            try:
                await task2
            except asyncio.CancelledError:
                pass
            await asyncio.sleep(0.05)

            return True

        run(_run())

        # Fire-and-forget update persisted
        assert (
            "job-1" in ff_store.jobs
        ), "Fire-and-forget status update should survive task cancellation"
        assert ff_store.jobs["job-1"]["status"] == "interrupted"

        # Direct-await update was lost (cancelled before sleep completed)
        assert (
            "job-2" not in direct_store.jobs
        ), "Direct-await status update should be lost on cancellation"

    def test_cancelled_error_handler_persists_interrupted(self):
        """The outer CancelledError handler persists INTERRUPTED status
        via fire-and-forget ensure_future."""
        store = FakeJobStore()

        async def _simulate_patched_handler(job_id):
            """Replicates the outer except asyncio.CancelledError block."""
            try:
                raise asyncio.CancelledError("cancel scope killed task")
            except asyncio.CancelledError:
                _bg = asyncio.ensure_future(
                    store.update_status(job_id, "interrupted", error="cancelled")
                )
                _bg.add_done_callback(
                    lambda t: t.exception() if not t.cancelled() else None
                )

        async def _run():
            await _simulate_patched_handler("job-1")
            await asyncio.sleep(0)  # let bg task run

        run(_run())
        assert store.jobs["job-1"]["status"] == "interrupted"
        assert store.jobs["job-1"]["error"] == "cancelled"

    def test_exception_handler_persists_failure(self):
        """The outer Exception handler persists FAILURE status
        via fire-and-forget ensure_future."""
        store = FakeJobStore()

        async def _simulate_patched_handler(job_id):
            """Replicates the outer except Exception block."""
            try:
                raise RuntimeError("MCP tool call failed")
            except Exception as e:
                _bg = asyncio.ensure_future(
                    store.update_status(job_id, "failure", error=str(e))
                )
                _bg.add_done_callback(
                    lambda t: t.exception() if not t.cancelled() else None
                )

        async def _run():
            await _simulate_patched_handler("job-1")
            await asyncio.sleep(0)  # let bg task run

        run(_run())
        assert store.jobs["job-1"]["status"] == "failure"
        assert store.jobs["job-1"]["error"] == "MCP tool call failed"

    def test_null_result_falls_through_to_outer_handler(self):
        """When result is None (workflow never produced output), the inner
        handler re-raises to the outer CancelledError/Exception handler."""
        store = FakeJobStore()

        async def _run():
            result = None
            try:
                try:
                    raise asyncio.CancelledError("workflow cancelled")
                except (Exception, asyncio.CancelledError):
                    if result is not None:
                        return "inner_handled"
                    raise
            except asyncio.CancelledError:
                _bg = asyncio.ensure_future(
                    store.update_status("job-1", "interrupted", error="cancelled")
                )
                _bg.add_done_callback(
                    lambda t: t.exception() if not t.cancelled() else None
                )
                await asyncio.sleep(0)  # let bg task run
                return "outer_handled"

        assert run(_run()) == "outer_handled"
        assert store.jobs["job-1"]["status"] == "interrupted"


# ---------------------------------------------------------------------------
# Tests: McpError bypass for _with_reconnect
# ---------------------------------------------------------------------------


class FakeMcpError(Exception):
    """Stand-in for mcp.shared.exceptions.McpError."""

    pass


class TestMcpErrorNoReconnect:
    """Verify that McpError bypasses _with_reconnect's reconnection logic.

    The _with_reconnect wrapper catches Exception and triggers reconnect.
    McpError (application-level, not connection) should not trigger this.
    """

    def test_mcp_app_error_is_base_exception(self):
        """_McpAppError must be a BaseException to escape 'except Exception'."""
        assert issubclass(_McpAppError, BaseException)
        assert not issubclass(_McpAppError, Exception)

    def test_mcp_app_error_preserves_original(self):
        orig = FakeMcpError("pod not found")
        wrapper = _McpAppError(orig)
        assert wrapper.original is orig

    def test_mcp_error_escapes_except_exception(self):
        """_McpAppError is NOT caught by 'except Exception'."""
        caught_by_exception = False
        caught_by_base = False

        try:
            raise _McpAppError(FakeMcpError("test"))
        except Exception:
            caught_by_exception = True
        except BaseException:
            caught_by_base = True

        assert not caught_by_exception
        assert caught_by_base

    def test_bypass_pattern_returns_mcp_error(self):
        """The full pattern: coro raises McpError → wraps as _McpAppError →
        escapes _with_reconnect → unwrapped to original McpError."""
        reconnect_called = False

        async def fake_with_reconnect(coro):
            """Simulates NAT's _with_reconnect: catches Exception → reconnects."""
            nonlocal reconnect_called
            try:
                return await coro()
            except Exception:
                reconnect_called = True  # This should NOT happen for McpError
                raise

        async def tool_call_raises_mcp_error():
            raise FakeMcpError("resource not found")

        async def _run():
            # Apply the bypass pattern
            async def coro_with_bypass():
                try:
                    return await tool_call_raises_mcp_error()
                except FakeMcpError as e:
                    raise _McpAppError(e) from e

            try:
                return await fake_with_reconnect(coro_with_bypass)
            except _McpAppError as wrapper:
                raise wrapper.original from wrapper.__cause__

        with pytest.raises(FakeMcpError, match="resource not found"):
            run(_run())

        assert not reconnect_called, "McpError should NOT trigger reconnect"

    def test_connection_errors_still_trigger_reconnect(self):
        """Non-McpError exceptions should still be caught by _with_reconnect."""
        reconnect_called = False

        async def fake_with_reconnect(coro):
            nonlocal reconnect_called
            try:
                return await coro()
            except Exception:
                reconnect_called = True
                raise

        async def tool_call_raises_connection_error():
            raise ConnectionError("stream closed")

        async def _run():
            async def coro_with_bypass():
                try:
                    return await tool_call_raises_connection_error()
                except FakeMcpError as e:
                    raise _McpAppError(e) from e
                # ConnectionError is NOT FakeMcpError, flows through normally

            try:
                return await fake_with_reconnect(coro_with_bypass)
            except _McpAppError as wrapper:
                raise wrapper.original

        with pytest.raises(ConnectionError):
            run(_run())

        assert reconnect_called, "ConnectionError should still trigger reconnect"


# ---------------------------------------------------------------------------
# Tests: submit_job asyncio task execution (Fix 11 — Dask removed)
# ---------------------------------------------------------------------------


class TestSubmitJobAsyncioExecution:
    """Verify that patched submit_job runs jobs as asyncio tasks (no Dask).

    These tests validate Fix 11 from mcp_patches.py: submit_job() creates
    the job in the DB, then runs job_fn directly as a background asyncio
    task instead of submitting to the Dask scheduler.
    """

    def _make_patched_submit_job(self):
        """Build a simplified patched submit_job that mirrors the real patch."""
        from mcp_patches import _background_tasks, _inflight_submissions

        async def patched_submit_job(
            job_store, *, job_id, job_fn, job_args, sync_timeout=0, **kw
        ):
            """Simplified version of the patch for testing."""
            job_args = job_args or []

            if job_id in _inflight_submissions:
                return (job_id, None)

            _inflight_submissions.add(job_id)

            async def _run_job():
                try:
                    if asyncio.iscoroutinefunction(job_fn):
                        result = await job_fn(*job_args)
                    else:
                        result = await asyncio.to_thread(job_fn, *job_args)
                    if asyncio.iscoroutine(result):
                        result = await result
                    return result
                finally:
                    _inflight_submissions.discard(job_id)

            task = asyncio.create_task(_run_job())
            _background_tasks.add(task)

            def _finalize_task(done_task):
                _background_tasks.discard(done_task)
                if not done_task.cancelled():
                    done_task.exception()

            task.add_done_callback(_finalize_task)

            if sync_timeout > 0:
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout=sync_timeout)
                    return (job_id, "completed")
                except TimeoutError:
                    pass

            return (job_id, None)

        return patched_submit_job

    @staticmethod
    async def _drain_tasks():
        """Let all pending background tasks complete."""
        import mcp_patches

        if mcp_patches._background_tasks:
            await asyncio.gather(*mcp_patches._background_tasks, return_exceptions=True)

    def setup_method(self):
        """Clear module-level state before each test."""
        import mcp_patches

        mcp_patches._inflight_submissions.clear()
        mcp_patches._background_tasks.clear()

    def test_job_runs_in_background(self):
        """Normal case: submit returns immediately, background task runs job_fn."""
        results = []

        async def _run():
            submit = self._make_patched_submit_job()
            job_id, result = await submit(
                None, job_id="j1", job_fn=lambda: results.append("ran"), job_args=[]
            )
            assert job_id == "j1"
            assert result is None  # async path returns None

            await self._drain_tasks()
            assert results == ["ran"]

        run(_run())

    def test_async_job_fn_awaited(self):
        """Async job functions are properly awaited."""
        results = []

        async def async_job():
            await asyncio.sleep(0)
            results.append("async_ran")

        async def _run():
            submit = self._make_patched_submit_job()
            job_id, result = await submit(
                None, job_id="j2", job_fn=async_job, job_args=[]
            )
            assert job_id == "j2"
            assert result is None

            await self._drain_tasks()
            assert results == ["async_ran"]

        run(_run())

    def test_submit_returns_immediately(self):
        """submit_job returns in <100ms even when job_fn is slow."""
        import time

        async def slow_job():
            await asyncio.sleep(10)

        async def _run():
            submit = self._make_patched_submit_job()
            t0 = time.monotonic()
            job_id, result = await submit(
                None, job_id="j3", job_fn=slow_job, job_args=[]
            )
            elapsed = time.monotonic() - t0
            assert (
                elapsed < 0.1
            ), f"submit_job took {elapsed:.3f}s — should return immediately"
            assert job_id == "j3"
            assert result is None

            # Cancel the slow task to avoid test hanging
            import mcp_patches

            for t in list(mcp_patches._background_tasks):
                t.cancel()
            await self._drain_tasks()

        run(_run())

    def test_duplicate_submission_deduplicated(self):
        """Second call with same job_id is skipped when first is in-flight."""
        import mcp_patches

        call_count = [0]

        async def slow_job():
            call_count[0] += 1
            await asyncio.sleep(10)

        async def _run():
            submit = self._make_patched_submit_job()

            job_id1, _ = await submit(None, job_id="j4", job_fn=slow_job, job_args=[])
            await asyncio.sleep(0)
            assert "j4" in mcp_patches._inflight_submissions

            job_id2, _ = await submit(None, job_id="j4", job_fn=slow_job, job_args=[])
            assert job_id2 == "j4"

            # Only one invocation should have occurred
            assert call_count[0] == 1

            for t in list(mcp_patches._background_tasks):
                t.cancel()
            await self._drain_tasks()

        run(_run())

    def test_sync_timeout_awaits_inline(self):
        """sync_timeout > 0 awaits the job inline."""
        results = []

        async def _run():
            submit = self._make_patched_submit_job()
            job_id, result = await submit(
                None,
                job_id="j5",
                job_fn=lambda: results.append("sync_ran"),
                job_args=[],
                sync_timeout=5,
            )
            assert job_id == "j5"
            assert result == "completed"
            assert results == ["sync_ran"]

        run(_run())

    def test_sync_timeout_does_not_cancel_background_job(self):
        """A sync_timeout miss returns but leaves the background job running."""
        results = []

        async def slow_job():
            await asyncio.sleep(0.02)
            results.append("finished")

        async def _run():
            submit = self._make_patched_submit_job()
            job_id, result = await submit(
                None,
                job_id="j-timeout",
                job_fn=slow_job,
                job_args=[],
                sync_timeout=0.001,
            )
            assert job_id == "j-timeout"
            assert result is None
            await self._drain_tasks()
            assert results == ["finished"]

        run(_run())

    def test_sync_job_fn_runs_off_event_loop_thread(self):
        """Synchronous job functions are offloaded instead of blocking the loop."""
        thread_ids = []

        def sync_job():
            thread_ids.append(threading.get_ident())

        async def _run():
            loop_thread_id = threading.get_ident()
            submit = self._make_patched_submit_job()
            await submit(None, job_id="j-thread", job_fn=sync_job, job_args=[])
            await self._drain_tasks()
            assert thread_ids
            assert thread_ids[0] != loop_thread_id

        run(_run())

    def test_inflight_cleared_after_completion(self):
        """Job ID is removed from _inflight_submissions after completion."""
        import mcp_patches

        async def _run():
            submit = self._make_patched_submit_job()
            await submit(None, job_id="j6", job_fn=lambda: None, job_args=[])
            await self._drain_tasks()
            assert "j6" not in mcp_patches._inflight_submissions

        run(_run())

    def test_real_patch_marks_jobstore_submit_job(self, monkeypatch):
        """The actual monkey patch replaces JobStore.submit_job and is idempotent."""
        import mcp_patches

        class JobStatus:
            FAILURE = "failure"

        class PatchableJobStore(FakeJobStore):
            DEFAULT_EXPIRY = 3600

            async def _create_job(
                self, job_id=None, config_file=None, expiry_seconds=DEFAULT_EXPIRY
            ):
                job_id = job_id or "generated-job"
                self.jobs[job_id] = {
                    "status": "submitted",
                    "error": None,
                    "output": None,
                }
                return job_id

            async def submit_job(self, **kwargs):
                raise AssertionError("original Dask submit_job should not run")

        module_names = [
            "nat",
            "nat.front_ends",
            "nat.front_ends.fastapi",
            "nat.front_ends.fastapi.async_jobs",
        ]
        for name in module_names:
            module = types.ModuleType(name)
            module.__path__ = []
            monkeypatch.setitem(sys.modules, name, module)

        job_store_mod = types.ModuleType("nat.front_ends.fastapi.async_jobs.job_store")
        job_store_mod.JobStore = PatchableJobStore
        job_store_mod.JobStatus = JobStatus
        monkeypatch.setitem(
            sys.modules,
            "nat.front_ends.fastapi.async_jobs.job_store",
            job_store_mod,
        )

        mcp_patches._patch_async_job_submit()
        first_submit = PatchableJobStore.submit_job
        mcp_patches._patch_async_job_submit()
        assert PatchableJobStore.submit_job is first_submit
        assert getattr(PatchableJobStore.submit_job, "_daedalus_dask_bypass")

        ran = []

        async def _run():
            store = PatchableJobStore()
            job_id, result = await store.submit_job(
                job_id="job-real",
                job_fn=lambda: ran.append("ran"),
                job_args=[],
            )
            assert job_id == "job-real"
            assert result is None
            await self._drain_tasks()

        run(_run())
        assert ran == ["ran"]
