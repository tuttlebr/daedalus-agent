"""Tests for mcp_patches -- get_tool reconnect and connect_to_server teardown."""

import asyncio
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Add builder root so we can import mcp_patches directly
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcp_patches import _connect_with_graceful_teardown  # noqa: E402


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

    def test_unrelated_exception_during_teardown_propagates(self):
        """Non-cancellation exceptions during teardown still propagate."""

        async def _run():
            with pytest.raises(ConnectionError, match="server vanished"):
                async with _connect_with_graceful_teardown(
                    _streamable_conn_error_on_exit(), MockSession, "http://fake/mcp"
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
