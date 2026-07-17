"""Tests for mcp_patches -- connect_to_server teardown and startup resilience."""

import asyncio
import sys
import types
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import mcp_patches
import pytest

# Add builder root so we can import mcp_patches directly
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcp_patches import (  # noqa: E402
    _MCP_STARTUP_GROUP_TIMEOUT,
    _STARTUP_RESILIENCE_EXCEPTIONS,
    _attempt_pending_mcp_recovery,
    _connect_with_graceful_teardown,
    _extract_root_connection_error,
    _initialize_function_group_for_startup,
    _is_connection_error,
    _is_no_tools_after_degradation_error,
    _known_mcp_function_groups,
    _looks_like_mcp_config,
    _mcp_httpx_auth_for_connection,
    _mcp_recovery_attempted,
    _McpAppError,
    _pending_mcp_recovery,
    _record_possible_mcp_group,
    _record_skipped_function_group,
    _should_recover_function_group_startup_error,
    _should_skip_tool_resolution_error,
    _skipped_function_groups,
    _tool_ref_text,
    mcp_capability_status,
)


def run(coro):
    return asyncio.run(coro)


def _clear_recovery_state():
    _skipped_function_groups.clear()
    _known_mcp_function_groups.clear()
    _pending_mcp_recovery.clear()
    _mcp_recovery_attempted.clear()


def test_capability_status_distinguishes_required_and_optional(monkeypatch):
    _clear_recovery_state()
    try:
        _known_mcp_function_groups.update({"required_mcp", "optional_mcp"})
        _skipped_function_groups.update({"required_mcp", "optional_mcp"})
        monkeypatch.setenv("DAEDALUS_REQUIRED_MCP_GROUPS", "required_mcp")

        assert mcp_capability_status() == {
            "state": "unready",
            "available": [],
            "required": ["required_mcp"],
            "missing_required": ["required_mcp"],
            "unavailable_optional": ["optional_mcp"],
        }
    finally:
        _clear_recovery_state()


def test_pending_group_recovers_once_before_tool_resolution():
    _clear_recovery_state()
    calls = []

    async def _add(_builder, name, config):
        calls.append((name, config))
        return MagicMock(mcp_client=None)

    try:
        _known_mcp_function_groups.add("docs_mcp")
        _skipped_function_groups.add("docs_mcp")
        _pending_mcp_recovery["docs_mcp"] = (("config",), {})

        recovered = run(_attempt_pending_mcp_recovery(object(), _add, ["docs_mcp"]))
        recovered_again = run(
            _attempt_pending_mcp_recovery(object(), _add, ["docs_mcp"])
        )

        assert recovered == ["docs_mcp"]
        assert recovered_again == []
        assert calls == [("docs_mcp", "config")]
        assert "docs_mcp" not in _skipped_function_groups
        assert mcp_capability_status()["state"] == "ready"
    finally:
        _clear_recovery_state()


def test_pending_group_recovery_has_one_shared_deadline(monkeypatch):
    _clear_recovery_state()
    calls = 0

    async def _slow_add(_builder, _name, _config):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return MagicMock(mcp_client=None)

    try:
        monkeypatch.setattr(mcp_patches, "_MCP_RECOVERY_TOTAL_TIMEOUT", 0.01)
        _known_mcp_function_groups.add("slow_mcp")
        _skipped_function_groups.add("slow_mcp")
        _pending_mcp_recovery["slow_mcp"] = (("config",), {})

        assert (
            run(_attempt_pending_mcp_recovery(object(), _slow_add, ["slow_mcp"])) == []
        )
        assert (
            run(_attempt_pending_mcp_recovery(object(), _slow_add, ["slow_mcp"])) == []
        )
        assert calls == 1
        assert "slow_mcp" in _skipped_function_groups
    finally:
        _clear_recovery_state()


# ---------------------------------------------------------------------------
# Helpers: connect_to_server teardown tests
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _streamable_ok():
    """Normal upstream NAT context, no errors."""
    yield MagicMock(name="session")


@asynccontextmanager
async def _streamable_cancel_on_exit():
    """streamablehttp_client that raises CancelledError during __aexit__."""
    yield MagicMock(name="session")
    raise asyncio.CancelledError("terminate_session cancelled")


@asynccontextmanager
async def _streamable_cancel_scope_on_exit():
    """streamablehttp_client that raises cancel-scope RuntimeError during __aexit__."""
    yield MagicMock(name="session")
    raise RuntimeError("Cancelled via cancel scope abc123")


@asynccontextmanager
async def _streamable_conn_error_on_exit():
    """streamablehttp_client that raises ConnectionError during __aexit__."""
    yield MagicMock(name="session")
    raise ConnectionError("server vanished")


# ---------------------------------------------------------------------------
# Tests: connect_to_server teardown
# ---------------------------------------------------------------------------


class TestConnectToServerTeardown:
    """Verify _connect_with_graceful_teardown handles teardown errors correctly."""

    def test_clean_lifecycle(self):
        """Normal use -- enter, use session, exit without errors."""

        async def _run():
            async with _connect_with_graceful_teardown(
                _streamable_ok(), "http://fake/mcp"
            ) as session:
                assert session is not None
                await asyncio.sleep(0)  # simulate work

        run(_run())

    def test_cancelled_during_use_propagates(self):
        """CancelledError raised while the session is in active use propagates."""

        async def _run():
            with pytest.raises(asyncio.CancelledError):
                async with _connect_with_graceful_teardown(
                    _streamable_ok(), "http://fake/mcp"
                ) as _session:
                    raise asyncio.CancelledError("task cancelled")

        run(_run())

    def test_cancelled_during_teardown_suppressed(self):
        """CancelledError from terminate_session during teardown is suppressed."""

        async def _run():
            # Should NOT raise -- the CancelledError from __aexit__ is suppressed
            async with _connect_with_graceful_teardown(
                _streamable_cancel_on_exit(), "http://fake/mcp"
            ) as _session:
                await asyncio.sleep(0)

        run(_run())

    def test_cancel_scope_during_teardown_suppressed(self):
        """RuntimeError('cancel scope') during teardown is suppressed."""

        async def _run():
            # Should NOT raise
            async with _connect_with_graceful_teardown(
                _streamable_cancel_scope_on_exit(), "http://fake/mcp"
            ) as _session:
                await asyncio.sleep(0)

        run(_run())

    def test_cancel_scope_during_use_converts_to_cancelled(self):
        """RuntimeError('cancel scope') during active use converts to CancelledError."""

        async def _run():
            with pytest.raises(asyncio.CancelledError):
                async with _connect_with_graceful_teardown(
                    _streamable_ok(), "http://fake/mcp"
                ) as _session:
                    raise RuntimeError("Cancelled via cancel scope xyz")

        run(_run())

    def test_connection_error_during_teardown_suppressed(self):
        """Connection errors during teardown are suppressed (transport cleanup)."""

        async def _run():
            # Should NOT raise -- ConnectionError during __aexit__ is suppressed
            async with _connect_with_graceful_teardown(
                _streamable_conn_error_on_exit(), "http://fake/mcp"
            ) as _session:
                await asyncio.sleep(0)

        run(_run())

    def test_exception_group_read_timeout_during_teardown_suppressed(self):
        """ExceptionGroup(ReadTimeout) during teardown is suppressed."""

        @asynccontextmanager
        async def _streamable_eg_read_timeout_on_exit():
            yield MagicMock(name="session")
            raise ExceptionGroup(  # noqa: F821
                "unhandled errors in a TaskGroup",
                [httpx.ReadTimeout("")],
            )

        async def _run():
            # Should NOT raise -- ExceptionGroup(ReadTimeout) during __aexit__
            async with _connect_with_graceful_teardown(
                _streamable_eg_read_timeout_on_exit(),
                "http://fake/mcp",
            ) as _session:
                await asyncio.sleep(0)

        run(_run())

    def test_non_connection_exception_during_teardown_propagates(self):
        """Non-connection exceptions during teardown still propagate."""

        @asynccontextmanager
        async def _streamable_value_error_on_exit():
            yield MagicMock(name="session")
            raise ValueError("unexpected config error")

        async def _run():
            with pytest.raises(ValueError, match="unexpected config error"):
                async with _connect_with_graceful_teardown(
                    _streamable_value_error_on_exit(),
                    "http://fake/mcp",
                ) as _session:
                    await asyncio.sleep(0)

        run(_run())

    def test_unrelated_runtime_error_during_teardown_propagates(self):
        """Non-cancel-scope RuntimeError during teardown still propagates."""

        @asynccontextmanager
        async def _streamable_other_runtime_error():
            yield MagicMock(name="session")
            raise RuntimeError("something unrelated")

        async def _run():
            with pytest.raises(RuntimeError, match="something unrelated"):
                async with _connect_with_graceful_teardown(
                    _streamable_other_runtime_error(),
                    "http://fake/mcp",
                ) as _session:
                    await asyncio.sleep(0)

        run(_run())

    def test_operational_exception_propagates(self):
        """Regular exceptions during active session use propagate normally."""

        async def _run():
            with pytest.raises(ValueError, match="bad input"):
                async with _connect_with_graceful_teardown(
                    _streamable_ok(), "http://fake/mcp"
                ) as _session:
                    raise ValueError("bad input")

        run(_run())


# ---------------------------------------------------------------------------
# Tests: startup timeout and OAuth bootstrap selection
# ---------------------------------------------------------------------------


class TestMCPStartupBoundary:
    def teardown_method(self):
        _skipped_function_groups.clear()
        _known_mcp_function_groups.clear()

    def test_pydantic_style_mcp_config_is_detected(self):
        config = types.SimpleNamespace(type="mcp_client")
        assert _looks_like_mcp_config((config,), {})

    def test_mcp_connection_error_is_attempted_once(self):
        calls = 0

        async def failing_add(_builder, _name, *_args, **_kwargs):
            nonlocal calls
            calls += 1
            raise httpx.ConnectTimeout("unreachable")

        async def _run():
            return await _initialize_function_group_for_startup(
                failing_add,
                object(),
                "gmail_mcp_server",
                (types.SimpleNamespace(type="mcp_client"),),
                {},
            )

        assert run(_run()) is None
        assert calls == 1
        assert "gmail_mcp_server" in _skipped_function_groups

    def test_mcp_initialization_has_a_hard_time_budget(self, monkeypatch):
        import mcp_patches

        cancelled = asyncio.Event()

        async def hanging_add(_builder, _name, *_args, **_kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        monkeypatch.setattr(mcp_patches, "_MCP_STARTUP_GROUP_TIMEOUT", 0.01)

        async def _run():
            result = await _initialize_function_group_for_startup(
                hanging_add,
                object(),
                "calendar_mcp_server",
                (types.SimpleNamespace(type="mcp_client"),),
                {},
            )
            assert cancelled.is_set()
            return result

        assert run(_run()) is None
        assert "calendar_mcp_server" in _skipped_function_groups
        assert _MCP_STARTUP_GROUP_TIMEOUT > 0

    def test_non_mcp_timeout_still_propagates(self):
        async def timed_out_add(_builder, _name, *_args, **_kwargs):
            raise TimeoutError("database timeout")

        async def _run():
            return await _initialize_function_group_for_startup(
                timed_out_add, object(), "ordinary_group", (), {}
            )

        with pytest.raises(TimeoutError, match="database timeout"):
            run(_run())


class TestMCPBootstrapAuth:
    @staticmethod
    def _client(*, allow_default, default_user_id, auth_user_id):
        config = types.SimpleNamespace(
            allow_default_user_id_for_tool_calls=allow_default,
            default_user_id=default_user_id,
        )
        return types.SimpleNamespace(
            _url="https://gmailmcp.googleapis.com/mcp/v1",
            _auth_provider=types.SimpleNamespace(config=config),
            _httpx_auth=types.SimpleNamespace(user_id=auth_user_id),
        )

    def test_shared_oauth_schema_bootstrap_fails_closed(self):
        client = self._client(
            allow_default=False,
            default_user_id="https://gmailmcp.googleapis.com/mcp",
            auth_user_id="https://gmailmcp.googleapis.com/mcp",
        )

        with pytest.raises(RuntimeError, match="authenticated per-user context"):
            _mcp_httpx_auth_for_connection(client)

    def test_real_user_session_retains_interactive_auth(self):
        client = self._client(
            allow_default=False,
            default_user_id="https://gmailmcp.googleapis.com/mcp",
            auth_user_id="daedalus-user-session",
        )

        assert _mcp_httpx_auth_for_connection(client) is client._httpx_auth

    def test_api_key_or_default_enabled_auth_is_unchanged(self):
        client = self._client(
            allow_default=True,
            default_user_id="service-account",
            auth_user_id="service-account",
        )

        assert _mcp_httpx_auth_for_connection(client) is client._httpx_auth


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

    def test_in_context_chain(self):
        """Async context managers often preserve the transport error in __context__."""
        context = httpx.RemoteProtocolError("server disconnected")
        wrapper = RuntimeError("generator didn't yield")
        wrapper.__context__ = context
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

    def test_remote_protocol_error_is_connection_error(self):
        """GitHub MCP can disconnect mid-response as RemoteProtocolError."""
        assert _is_connection_error(
            httpx.RemoteProtocolError("server disconnected without sending a response")
        )

    def test_remote_protocol_error_in_base_exception_group(self):
        """MCP stream disconnects can be grouped with CancelledError by anyio."""
        err = httpx.RemoteProtocolError("GitHub MCP stream disconnected")
        group = BaseExceptionGroup(  # noqa: F821
            "unhandled errors in a TaskGroup",
            [asyncio.CancelledError("sibling task cancelled"), err],
        )
        assert _is_connection_error(group)
        assert _extract_root_connection_error(group) is err

    def test_anyio_broken_resource_is_connection_error(self):
        """Raw anyio transport errors can escape before httpx wraps them."""
        anyio = pytest.importorskip("anyio")
        assert _is_connection_error(anyio.BrokenResourceError("stream closed"))

    def test_httpx_network_error_base_is_connection_error(self):
        """NetworkError subclasses should be treated as transport instability."""
        assert _is_connection_error(httpx.ReadError("stream reset"))

    def test_read_timeout_in_exception_group(self):
        """ReadTimeout wrapped in ExceptionGroup (anyio TaskGroup cleanup pattern)."""
        eg = ExceptionGroup(  # noqa: F821
            "unhandled errors in a TaskGroup",
            [httpx.ReadTimeout("")],
        )
        assert _is_connection_error(eg)

    @staticmethod
    def _http_status_error(status_code: int, message: str = ""):
        from types import SimpleNamespace

        return httpx.HTTPStatusError(
            message or f"HTTP {status_code}",
            request=None,
            response=SimpleNamespace(status_code=status_code),
        )

    def test_http_500_is_transient_connection_error(self):
        """5xx HTTPStatusError treated as transient — retry/skip during startup."""
        assert _is_connection_error(self._http_status_error(500))

    def test_http_503_is_transient_connection_error(self):
        """503 Service Unavailable is transient."""
        assert _is_connection_error(self._http_status_error(503))

    def test_http_500_in_exception_group(self):
        """5xx HTTPStatusError wrapped in ExceptionGroup (MCP TaskGroup pattern)."""
        eg = ExceptionGroup(  # noqa: F821
            "unhandled errors in a TaskGroup",
            [self._http_status_error(500)],
        )
        assert _is_connection_error(eg)

    def test_http_401_not_connection_error(self):
        """4xx HTTPStatusError is a real config error — must not be skipped."""
        assert not _is_connection_error(self._http_status_error(401))

    def test_http_404_not_connection_error(self):
        """404 is a misconfiguration, not transient."""
        assert not _is_connection_error(self._http_status_error(404))


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

    def test_extracts_connection_error_from_mixed_exception_group(self):
        inner = httpx.RemoteProtocolError("server disconnected")
        eg = ExceptionGroup("group", [ValueError("noise"), inner])  # noqa: F821
        assert _extract_root_connection_error(eg) is inner

    def test_extracts_from_cause_chain(self):
        cause = httpx.ConnectError("refused")
        wrapper = RuntimeError("build failed")
        wrapper.__cause__ = cause
        assert _extract_root_connection_error(wrapper) is cause

    def test_extracts_from_context_chain(self):
        context = httpx.RemoteProtocolError("server disconnected")
        wrapper = RuntimeError("generator didn't yield")
        wrapper.__context__ = context
        assert _extract_root_connection_error(wrapper) is context

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


class TestStartupResilience:
    """Verify the add_function_group and get_tools resilience wrappers."""

    def _apply_patch(self, builder_cls):
        """Apply the same wrapping logic as _patch_startup_resilience."""
        import functools

        _skipped_function_groups.clear()
        _known_mcp_function_groups.clear()

        original_add_fg = builder_cls.add_function_group

        @functools.wraps(original_add_fg)
        async def resilient(self, name, *args, **kwargs):
            _record_possible_mcp_group(name, args, kwargs)
            try:
                return await original_add_fg(self, name, *args, **kwargs)
            except _STARTUP_RESILIENCE_EXCEPTIONS as exc:
                if _is_no_tools_after_degradation_error(exc):
                    _record_skipped_function_group(name)
                    return None
                if _should_recover_function_group_startup_error(exc, name):
                    _extract_root_connection_error(exc)  # for logging
                    _record_skipped_function_group(name)
                    return None
                raise

        builder_cls.add_function_group = resilient

        original_get_tools = builder_cls.get_tools

        async def _resolve_individually(self, tool_names, args, kwargs):
            resolved = []
            for tool_name in tool_names:
                try:
                    result = await original_get_tools(
                        self, [tool_name], *args, **kwargs
                    )
                except _STARTUP_RESILIENCE_EXCEPTIONS as exc:
                    if _should_skip_tool_resolution_error(exc, tool_name):
                        _record_skipped_function_group(tool_name)
                        continue
                    raise
                if result:
                    resolved.extend(result)
            return resolved

        @functools.wraps(original_get_tools)
        async def resilient_get_tools(self, tool_names=None, *args, **kwargs):
            if tool_names and _skipped_function_groups:
                tool_names = [
                    n
                    for n in tool_names
                    if _tool_ref_text(n) not in _skipped_function_groups
                ]
            try:
                return await original_get_tools(self, tool_names, *args, **kwargs)
            except _STARTUP_RESILIENCE_EXCEPTIONS as exc:
                if tool_names and (
                    _is_connection_error(exc)
                    or any(
                        _should_skip_tool_resolution_error(exc, tool_name)
                        for tool_name in tool_names
                    )
                ):
                    return await _resolve_individually(self, tool_names, args, kwargs)
                raise

        builder_cls.get_tools = resilient_get_tools

        return original_add_fg, original_get_tools

    def _restore(self, cls, originals):
        cls.add_function_group, cls.get_tools = originals
        _skipped_function_groups.clear()
        _known_mcp_function_groups.clear()

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

    def test_github_mcp_base_exception_group_skipped(self):
        """GitHub stream disconnect grouped with cancellation should degrade."""

        class FailingBuilder(FakeWorkflowBuilder):
            async def add_function_group(self, name, *args, **kwargs):
                if name == "github_mcp_server":
                    raise BaseExceptionGroup(  # noqa: F821
                        "unhandled errors in a TaskGroup",
                        [
                            asyncio.CancelledError("sibling task cancelled"),
                            httpx.RemoteProtocolError(
                                "GET stream disconnected during reconnect"
                            ),
                        ],
                    )
                return await super().add_function_group(name, *args, **kwargs)

        originals = self._apply_patch(FailingBuilder)
        try:
            builder = FailingBuilder()

            async def _run():
                result = await builder.add_function_group("github_mcp_server")
                assert result is None
                assert "github_mcp_server" in _skipped_function_groups
                assert "github_mcp_server" not in builder.registered

                result2 = await builder.add_function_group("domain_retriever_tool")
                assert result2 == {"name": "domain_retriever_tool"}

            run(_run())
        finally:
            self._restore(FailingBuilder, originals)

    def test_github_mcp_internal_cancelled_error_skipped(self):
        """MCP-internal CancelledError should not bypass startup resilience."""

        class FailingBuilder(FakeWorkflowBuilder):
            async def add_function_group(self, name, *args, **kwargs):
                if name == "github_mcp_server":
                    raise asyncio.CancelledError("GET stream reconnect cancelled")
                return await super().add_function_group(name, *args, **kwargs)

        originals = self._apply_patch(FailingBuilder)
        try:
            builder = FailingBuilder()

            async def _run():
                result = await builder.add_function_group("github_mcp_server")
                assert result is None
                assert "github_mcp_server" in _skipped_function_groups
                assert "github_mcp_server" not in builder.registered

            run(_run())
        finally:
            self._restore(FailingBuilder, originals)

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

    @pytest.mark.parametrize("status_code", [401, 403])
    def test_auth_required_mcp_is_skipped(self, status_code):
        """A headless MCP auth challenge cannot abort application startup."""

        async def auth_fail(_builder, _name, *_args, **_kwargs):
            raise httpx.HTTPStatusError(
                f"{status_code} authentication required",
                request=httpx.Request("POST", "http://fake/mcp"),
                response=types.SimpleNamespace(status_code=status_code),
            )

        async def _run():
            return await _initialize_function_group_for_startup(
                auth_fail,
                object(),
                "auth_fail_mcp",
                (types.SimpleNamespace(type="mcp_client"),),
                {},
            )

        assert run(_run()) is None
        assert "auth_fail_mcp" in _skipped_function_groups
        _skipped_function_groups.clear()

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

    def test_get_tools_omits_deferred_mcp_connection_failure(self):
        """If NAT defers MCP discovery until get_tools(), omit only that MCP group."""

        class DeferredFailBuilder(FakeWorkflowBuilder):
            async def get_tools(self, tool_names=None, wrapper_type=None):
                if tool_names and "github_mcp_server" in tool_names:
                    raise httpx.RemoteProtocolError("GitHub MCP disconnected")
                return await super().get_tools(tool_names, wrapper_type)

        originals = self._apply_patch(DeferredFailBuilder)
        try:
            builder = DeferredFailBuilder()

            async def _run():
                await builder.add_function_group("domain_retriever_tool")
                await builder.add_function_group("ops_confirmation_tool")
                await builder.add_function_group("github_mcp_server")

                tools = await builder.get_tools(
                    tool_names=[
                        "domain_retriever_tool",
                        "github_mcp_server",
                        "ops_confirmation_tool",
                    ]
                )

                assert len(tools) == 2
                assert "github_mcp_server" in _skipped_function_groups

            run(_run())
        finally:
            self._restore(DeferredFailBuilder, originals)

    def test_get_tools_omits_deferred_mcp_base_exception_group(self):
        """Deferred MCP discovery also handles BaseExceptionGroup cancellation."""

        class DeferredFailBuilder(FakeWorkflowBuilder):
            async def get_tools(self, tool_names=None, wrapper_type=None):
                if tool_names and "github_mcp_server" in tool_names:
                    raise BaseExceptionGroup(  # noqa: F821
                        "unhandled errors in a TaskGroup",
                        [
                            asyncio.CancelledError("sibling task cancelled"),
                            httpx.RemoteProtocolError("GitHub MCP disconnected"),
                        ],
                    )
                return await super().get_tools(tool_names, wrapper_type)

        originals = self._apply_patch(DeferredFailBuilder)
        try:
            builder = DeferredFailBuilder()

            async def _run():
                await builder.add_function_group("domain_retriever_tool")
                await builder.add_function_group("ops_confirmation_tool")
                await builder.add_function_group("github_mcp_server")

                tools = await builder.get_tools(
                    tool_names=[
                        "domain_retriever_tool",
                        "github_mcp_server",
                        "ops_confirmation_tool",
                    ]
                )

                assert len(tools) == 2
                assert "github_mcp_server" in _skipped_function_groups

            run(_run())
        finally:
            self._restore(DeferredFailBuilder, originals)

    def test_get_tools_omits_missing_mcp_reference_only(self):
        """A missing MCP group is degraded, while registered non-MCP tools remain."""

        originals = self._apply_patch(FakeWorkflowBuilder)
        try:
            builder = FakeWorkflowBuilder()

            async def _run():
                await builder.add_function_group("domain_retriever_tool")

                tools = await builder.get_tools(
                    tool_names=["domain_retriever_tool", "github_mcp_server"]
                )

                assert len(tools) == 1
                assert "github_mcp_server" in _skipped_function_groups

            run(_run())
        finally:
            self._restore(FakeWorkflowBuilder, originals)

    def test_get_tools_non_mcp_connection_failure_still_raises(self):
        """Do not hide non-MCP startup failures as degraded MCP availability."""

        class DeferredFailBuilder(FakeWorkflowBuilder):
            async def get_tools(self, tool_names=None, wrapper_type=None):
                if tool_names and "domain_retriever_tool" in tool_names:
                    raise httpx.ConnectTimeout("retriever unreachable")
                return await super().get_tools(tool_names, wrapper_type)

        originals = self._apply_patch(DeferredFailBuilder)
        try:
            builder = DeferredFailBuilder()

            async def _run():
                await builder.add_function_group("domain_retriever_tool")
                await builder.add_function_group("ops_confirmation_tool")

                with pytest.raises(httpx.ConnectTimeout):
                    await builder.get_tools(
                        tool_names=[
                            "domain_retriever_tool",
                            "ops_confirmation_tool",
                        ]
                    )

            run(_run())
        finally:
            self._restore(DeferredFailBuilder, originals)

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

    def test_no_tools_after_mcp_degradation_skips_agent_group(self):
        """An agent left with zero tools after MCP skips should not kill startup."""

        class AgentBuilder(FakeWorkflowBuilder):
            async def add_function_group(self, name, *args, **kwargs):
                if name == "github_mcp_server":
                    raise httpx.ConnectTimeout("GitHub MCP unavailable")
                if name == "ops_agent":
                    raise ValueError(
                        "No tools specified for Resilient Tool Calling Agent"
                    )
                return await super().add_function_group(name, *args, **kwargs)

        originals = self._apply_patch(AgentBuilder)
        try:
            builder = AgentBuilder()

            async def _run():
                assert await builder.add_function_group("github_mcp_server") is None
                assert await builder.add_function_group("ops_agent") is None
                assert "github_mcp_server" in _skipped_function_groups
                assert "ops_agent" in _skipped_function_groups

            run(_run())
        finally:
            self._restore(AgentBuilder, originals)


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

    def test_permission_error_escapes_reconnect(self):
        """F-018: a denied mutating call (PermissionError from the approval
        gate) must escape _with_reconnect's ``except Exception`` reconnect
        handler the same way McpError does, and be re-raised unchanged."""
        reconnect_called = False

        async def fake_with_reconnect(coro):
            """Simulates NAT's _with_reconnect: catches Exception → reconnects."""
            nonlocal reconnect_called
            try:
                return await coro()
            except Exception:
                reconnect_called = True  # must NOT happen for PermissionError
                raise

        async def tool_call_denied():
            # Mirrors the approval gate raising PermissionError in wrapped().
            raise PermissionError("requires approval_token")

        async def _run():
            # Mirrors patched_with_reconnect's coro_with_mcp_bypass, which now
            # wraps both McpError and PermissionError.
            async def coro_with_bypass():
                try:
                    return await tool_call_denied()
                except (FakeMcpError, PermissionError) as e:
                    raise _McpAppError(e) from e

            try:
                return await fake_with_reconnect(coro_with_bypass)
            except _McpAppError as wrapper:
                raise wrapper.original from wrapper.__cause__

        with pytest.raises(PermissionError, match="requires approval_token"):
            run(_run())

        assert not reconnect_called, "PermissionError should NOT trigger reconnect"

    def test_tool_client_runtime_error_returns_tool_error(self, monkeypatch):
        """Runtime MCP tool failures must return to the agent as tool output."""
        import mcp_patches

        class FakeMCPToolClient:
            _tool_name = "get_thread"
            _parent_client = types.SimpleNamespace(server_name="gmail_mcp_server")

            async def acall(self, tool_args):
                raise RuntimeError("auth timed out")

        fake_module = types.ModuleType("nat.plugins.mcp.client.client_base")
        fake_module.MCPToolClient = FakeMCPToolClient

        for module_name in (
            "nat",
            "nat.plugins",
            "nat.plugins.mcp",
            "nat.plugins.mcp.client",
        ):
            module = types.ModuleType(module_name)
            module.__path__ = []
            monkeypatch.setitem(sys.modules, module_name, module)
        monkeypatch.setitem(
            sys.modules,
            "nat.plugins.mcp.client.client_base",
            fake_module,
        )
        monkeypatch.setattr(mcp_patches, "_approval_gate_installed", False)

        mcp_patches._patch_tool_client()

        result = run(FakeMCPToolClient().acall({"thread_id": "123"}))

        assert result == (
            '{"error":"mcp_tool_failed","tool":"get_thread",'
            '"error_class":"RuntimeError"}'
        )
