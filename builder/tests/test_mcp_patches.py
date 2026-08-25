"""Tests for mcp_patches -- connect_to_server teardown and startup resilience."""

import asyncio
import contextvars
import logging
import sys
import types
from contextlib import asynccontextmanager
from datetime import timedelta
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
    _call_with_current_mcp_oauth_callback,
    _connect_with_graceful_teardown,
    _extract_root_connection_error,
    _initialize_function_group_for_startup,
    _is_connection_error,
    _is_mcp_authentication_required_error,
    _is_no_tools_after_degradation_error,
    _known_mcp_function_groups,
    _looks_like_mcp_config,
    _mcp_httpx_auth_for_connection,
    _mcp_oauth_request_bindings,
    _mcp_recovery_attempted,
    _McpAppError,
    _McpAuthFailureLevelFilter,
    _patch_mcp_auth_context_propagation,
    _patch_mcp_auth_transport_timeout,
    _patch_mcp_http_auth_timeout,
    _patch_mcp_request_auth_binding,
    _patch_per_user_mcp_builder_recovery,
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


def test_cached_mcp_transport_uses_current_oauth_callback(monkeypatch):
    """The long-lived transport task must not retain an older request callback."""
    current_callback = object()
    stale_callback = object()
    callback_state = {"value": stale_callback}

    class FakeContext:
        @staticmethod
        def scope(**kwargs):
            class Scope:
                def __enter__(self):
                    self.previous = callback_state["value"]
                    callback_state["value"] = kwargs["user_auth_callback"]

                def __exit__(self, *_args):
                    callback_state["value"] = self.previous

            return Scope()

    class FakeAuthAdapter:
        async def _get_auth_headers(self, request=None, response=None):
            return {"callback": callback_state["value"]}

    context_module = types.ModuleType("nat.builder.context")
    context_module.Context = FakeContext
    client_module = types.ModuleType("nat.plugins.mcp.client.client_base")
    client_module.AuthAdapter = FakeAuthAdapter
    for module_name in (
        "nat",
        "nat.builder",
        "nat.plugins",
        "nat.plugins.mcp",
        "nat.plugins.mcp.client",
    ):
        module = types.ModuleType(module_name)
        module.__path__ = []
        monkeypatch.setitem(sys.modules, module_name, module)
    monkeypatch.setitem(sys.modules, "nat.builder.context", context_module)
    monkeypatch.setitem(
        sys.modules,
        "nat.plugins.mcp.client.client_base",
        client_module,
    )

    _patch_mcp_auth_context_propagation()
    adapter = FakeAuthAdapter()
    adapter._daedalus_user_auth_callback = current_callback

    assert run(adapter._get_auth_headers()) == {"callback": current_callback}
    assert callback_state["value"] is stale_callback


def test_bound_oauth_token_miss_is_not_silently_converted_to_empty_headers(
    monkeypatch,
):
    """A bound interactive request must not continue anonymously after auth fails."""

    class FakeContext:
        @staticmethod
        def scope(**_kwargs):
            class Scope:
                def __enter__(self):
                    return None

                def __exit__(self, *_args):
                    return None

            return Scope()

    class FakeAuthAdapter:
        async def _get_auth_headers(self, request=None, response=None):
            return {}

    context_module = types.ModuleType("nat.builder.context")
    context_module.Context = FakeContext
    client_module = types.ModuleType("nat.plugins.mcp.client.client_base")
    client_module.AuthAdapter = FakeAuthAdapter
    for module_name in (
        "nat",
        "nat.builder",
        "nat.plugins",
        "nat.plugins.mcp",
        "nat.plugins.mcp.client",
    ):
        module = types.ModuleType(module_name)
        module.__path__ = []
        monkeypatch.setitem(sys.modules, module_name, module)
    monkeypatch.setitem(sys.modules, "nat.builder.context", context_module)
    monkeypatch.setitem(
        sys.modules,
        "nat.plugins.mcp.client.client_base",
        client_module,
    )

    _patch_mcp_auth_context_propagation()
    adapter = FakeAuthAdapter()
    adapter._daedalus_user_auth_callback = object()

    with pytest.raises(RuntimeError, match="did not produce credentials"):
        run(adapter._get_auth_headers())


def test_protected_resource_401_invalidates_cached_token_before_reauthentication(
    monkeypatch,
):
    """A locally unexpired token rejected by Google must not be reused."""
    events = []

    class FakeContext:
        @staticmethod
        def scope(**_kwargs):
            class Scope:
                def __enter__(self):
                    return None

                def __exit__(self, *_args):
                    return None

            return Scope()

    class FakeStorage:
        async def delete(self, user_id):
            events.append(("delete", user_id))

    class FakeAuthAdapter:
        def __init__(self):
            self.user_id = "opaque-user-id"
            self.auth_provider = types.SimpleNamespace(_token_storage=FakeStorage())

        async def _get_auth_headers(self, request=None, response=None):
            events.append(("authenticate", getattr(response, "status_code", None)))
            return {"Authorization": "Bearer replacement"}

    context_module = types.ModuleType("nat.builder.context")
    context_module.Context = FakeContext
    client_module = types.ModuleType("nat.plugins.mcp.client.client_base")
    client_module.AuthAdapter = FakeAuthAdapter
    for module_name in (
        "nat",
        "nat.builder",
        "nat.plugins",
        "nat.plugins.mcp",
        "nat.plugins.mcp.client",
    ):
        module = types.ModuleType(module_name)
        module.__path__ = []
        monkeypatch.setitem(sys.modules, module_name, module)
    monkeypatch.setitem(sys.modules, "nat.builder.context", context_module)
    monkeypatch.setitem(
        sys.modules,
        "nat.plugins.mcp.client.client_base",
        client_module,
    )

    _patch_mcp_auth_context_propagation()
    adapter = FakeAuthAdapter()
    adapter._daedalus_user_auth_callback = object()
    credentials_ready = asyncio.Event()
    adapter._daedalus_credentials_ready_event = credentials_ready

    response = types.SimpleNamespace(status_code=401)
    assert run(adapter._get_auth_headers(response=response)) == {
        "Authorization": "Bearer replacement"
    }
    assert events == [("delete", "opaque-user-id"), ("authenticate", 401)]
    assert credentials_ready.is_set()


def test_non_401_authentication_does_not_invalidate_cached_token(monkeypatch):
    """Token deletion is restricted to a protected-resource rejection."""
    deleted = []

    class FakeContext:
        @staticmethod
        def scope(**_kwargs):
            class Scope:
                def __enter__(self):
                    return None

                def __exit__(self, *_args):
                    return None

            return Scope()

    class FakeStorage:
        async def delete(self, user_id):
            deleted.append(user_id)

    class FakeAuthAdapter:
        user_id = "opaque-user-id"
        auth_provider = types.SimpleNamespace(_token_storage=FakeStorage())

        async def _get_auth_headers(self, request=None, response=None):
            return {"Authorization": "Bearer existing"}

    context_module = types.ModuleType("nat.builder.context")
    context_module.Context = FakeContext
    client_module = types.ModuleType("nat.plugins.mcp.client.client_base")
    client_module.AuthAdapter = FakeAuthAdapter
    for module_name in (
        "nat",
        "nat.builder",
        "nat.plugins",
        "nat.plugins.mcp",
        "nat.plugins.mcp.client",
    ):
        module = types.ModuleType(module_name)
        module.__path__ = []
        monkeypatch.setitem(sys.modules, module_name, module)
    monkeypatch.setitem(sys.modules, "nat.builder.context", context_module)
    monkeypatch.setitem(
        sys.modules,
        "nat.plugins.mcp.client.client_base",
        client_module,
    )

    _patch_mcp_auth_context_propagation()
    adapter = FakeAuthAdapter()
    adapter._daedalus_user_auth_callback = object()
    response = types.SimpleNamespace(status_code=403)

    assert run(adapter._get_auth_headers(response=response)) == {
        "Authorization": "Bearer existing"
    }
    assert deleted == []


def test_http_auth_handler_uses_deployment_oauth_timeout(monkeypatch):
    """The hidden NAT five-minute default is replaced by the deployment budget."""

    class FakeHTTPAuthenticationFlowHandler:
        def __init__(
            self,
            add_flow_cb=None,
            remove_flow_cb=None,
            auth_timeout_seconds=300.0,
        ):
            self.auth_timeout_seconds = auth_timeout_seconds

    handler_module = types.ModuleType(
        "nat.front_ends.fastapi.auth_flow_handlers.http_flow_handler"
    )
    handler_module.HTTPAuthenticationFlowHandler = FakeHTTPAuthenticationFlowHandler
    for module_name in (
        "nat",
        "nat.front_ends",
        "nat.front_ends.fastapi",
        "nat.front_ends.fastapi.auth_flow_handlers",
    ):
        module = types.ModuleType(module_name)
        module.__path__ = []
        monkeypatch.setitem(sys.modules, module_name, module)
    monkeypatch.setitem(
        sys.modules,
        "nat.front_ends.fastapi.auth_flow_handlers.http_flow_handler",
        handler_module,
    )
    monkeypatch.setenv("DAEDALUS_MCP_OAUTH_TIMEOUT_SECONDS", "600")

    _patch_mcp_http_auth_timeout()

    assert FakeHTTPAuthenticationFlowHandler().auth_timeout_seconds == 600
    assert (
        FakeHTTPAuthenticationFlowHandler(auth_timeout_seconds=123).auth_timeout_seconds
        == 123
    )


def test_terminal_mcp_refresh_failure_is_promoted_to_error():
    """The exact terminal NAT refresh message must not remain an INFO record."""
    record = logging.LogRecord(
        "nat.plugins.mcp.client.client_base",
        logging.INFO,
        __file__,
        1,
        "Failed to refresh auth after 401: %s",
        ("credentials missing",),
        None,
    )

    assert _McpAuthFailureLevelFilter().filter(record) is True
    assert record.levelno == logging.ERROR
    assert record.levelname == "ERROR"


def test_oauth_callback_binding_serializes_cached_client_calls():
    """Concurrent turns for one cached client cannot replace each other's callback."""
    auth = types.SimpleNamespace()
    parent = types.SimpleNamespace(
        _httpx_auth=auth,
        _tool_call_timeout=timedelta(seconds=1),
        _auth_flow_timeout=timedelta(seconds=1),
    )
    marker_one = object()
    marker_two = object()
    active = 0
    max_active = 0

    async def _run():
        async def callback_one(_config, _method):
            return marker_one

        async def callback_two(_config, _method):
            return marker_two

        async def invoke(marker):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await asyncio.sleep(0)
            assert await auth._daedalus_user_auth_callback(None, None) is marker
            active -= 1
            return marker

        return await asyncio.gather(
            _call_with_current_mcp_oauth_callback(
                parent,
                callback_one,
                lambda: invoke(marker_one),
            ),
            _call_with_current_mcp_oauth_callback(
                parent,
                callback_two,
                lambda: invoke(marker_two),
            ),
        )

    assert run(_run()) == [marker_one, marker_two]
    assert max_active == 1
    assert not hasattr(auth, "_daedalus_user_auth_callback")


def test_oauth_callback_runs_in_active_request_context():
    """Frontend OAuth ContextVars must survive the cached transport boundary."""
    execution_id = contextvars.ContextVar("execution_id", default="stale-execution")
    auth = types.SimpleNamespace()
    parent = types.SimpleNamespace(
        _httpx_auth=auth,
        _tool_call_timeout=timedelta(seconds=1),
        _auth_flow_timeout=timedelta(seconds=1),
    )

    async def _run():
        execution_id.set("current-execution")

        async def callback(_config, _method):
            return execution_id.get()

        async def invoke_from_transport():
            execution_id.set("cached-transport-execution")
            return await auth._daedalus_user_auth_callback(None, None)

        return await _call_with_current_mcp_oauth_callback(
            parent,
            callback,
            invoke_from_transport,
        )

    assert run(_run()) == "current-execution"
    assert not hasattr(auth, "_daedalus_user_auth_callback")


def test_http_request_binding_replaces_cached_workflow_callback(monkeypatch):
    """A later HTTP turn must not emit OAuth to the cached creation request."""
    _mcp_oauth_request_bindings.clear()

    class FakeSession:
        user_id = "opaque-user-id"

    class FakeSessionManager:
        @asynccontextmanager
        async def session(
            self,
            user_id=None,
            http_connection=None,
            user_message_id=None,
            conversation_id=None,
            user_input_callback=None,
            user_authentication_callback=None,
        ):
            yield FakeSession()

    session_module = types.ModuleType("nat.runtime.session")
    session_module.SessionManager = FakeSessionManager
    for module_name in ("nat", "nat.runtime"):
        module = types.ModuleType(module_name)
        module.__path__ = []
        monkeypatch.setitem(sys.modules, module_name, module)
    monkeypatch.setitem(sys.modules, "nat.runtime.session", session_module)

    _patch_mcp_request_auth_binding()
    manager = FakeSessionManager()
    parent = types.SimpleNamespace(
        _httpx_auth=types.SimpleNamespace(user_id="opaque-user-id")
    )
    stale_context = None

    async def first_callback(_config, _method):
        return "first-request"

    async def second_callback(_config, _method):
        return "second-request"

    async def _run():
        nonlocal stale_context
        async with manager.session(user_authentication_callback=first_callback):
            stale_context = contextvars.copy_context()
        assert _mcp_oauth_request_bindings == {}

        async with manager.session(user_authentication_callback=second_callback):
            assert stale_context is not None

            async def resolve_from_cached_context():
                callback, request_context = (
                    mcp_patches._current_mcp_oauth_request_binding(parent)
                )
                assert callback is not None
                task = request_context.run(
                    asyncio.create_task,
                    callback(None, None),
                )
                return await task

            task = stale_context.run(
                asyncio.create_task,
                resolve_from_cached_context(),
            )
            assert await task == "second-request"

        assert _mcp_oauth_request_bindings == {}

    run(_run())


def test_http_request_binding_fails_closed_when_concurrent_context_is_unknown(
    monkeypatch,
):
    """An unowned cached task cannot choose between concurrent user requests."""
    _mcp_oauth_request_bindings.clear()

    class FakeSession:
        user_id = "opaque-user-id"

    class FakeSessionManager:
        @asynccontextmanager
        async def session(
            self,
            user_id=None,
            http_connection=None,
            user_message_id=None,
            conversation_id=None,
            user_input_callback=None,
            user_authentication_callback=None,
        ):
            yield FakeSession()

    session_module = types.ModuleType("nat.runtime.session")
    session_module.SessionManager = FakeSessionManager
    for module_name in ("nat", "nat.runtime"):
        module = types.ModuleType(module_name)
        module.__path__ = []
        monkeypatch.setitem(sys.modules, module_name, module)
    monkeypatch.setitem(sys.modules, "nat.runtime.session", session_module)

    _patch_mcp_request_auth_binding()
    manager = FakeSessionManager()
    parent = types.SimpleNamespace(
        _httpx_auth=types.SimpleNamespace(user_id="opaque-user-id")
    )

    async def first_callback(_config, _method):
        return "first-request"

    async def second_callback(_config, _method):
        return "second-request"

    async def _run():
        async with manager.session(user_authentication_callback=first_callback):
            first_context = contextvars.copy_context()
            async with manager.session(user_authentication_callback=second_callback):
                current_callback, _ = mcp_patches._current_mcp_oauth_request_binding(
                    parent
                )
                assert current_callback is second_callback

                async def resolve_first_context():
                    callback, _ = mcp_patches._current_mcp_oauth_request_binding(parent)
                    return callback

                first_task = first_context.run(
                    asyncio.create_task,
                    resolve_first_context(),
                )
                assert await first_task is first_callback

                async def resolve_without_owner():
                    callback, _ = mcp_patches._current_mcp_oauth_request_binding(parent)
                    return callback

                unknown_task = contextvars.Context().run(
                    asyncio.create_task,
                    resolve_without_owner(),
                )
                assert await unknown_task is None

        assert _mcp_oauth_request_bindings == {}

    run(_run())


def test_missing_oauth_callback_fails_when_interaction_is_needed():
    """A token miss without an interactive frontend must fail instead of wait."""
    auth = types.SimpleNamespace()
    parent = types.SimpleNamespace(
        _httpx_auth=auth,
        _tool_call_timeout=timedelta(seconds=1),
        _auth_flow_timeout=timedelta(seconds=1),
    )

    async def invoke():
        await auth._daedalus_user_auth_callback(None, None)

    with pytest.raises(RuntimeError, match="unavailable for the current request"):
        run(_call_with_current_mcp_oauth_callback(parent, None, invoke))

    assert not hasattr(auth, "_daedalus_user_auth_callback")


def test_authenticated_mcp_response_uses_ordinary_tool_timeout():
    """Browser auth completion must not leave the MCP read on its long timeout."""
    auth = types.SimpleNamespace()
    parent = types.SimpleNamespace(
        _httpx_auth=auth,
        _tool_call_timeout=timedelta(seconds=0.01),
        _auth_flow_timeout=timedelta(seconds=1),
    )

    async def callback(_config, _method):
        return object()

    async def invoke():
        await auth._daedalus_user_auth_callback(None, None)
        auth._daedalus_credentials_ready_event.set()
        await asyncio.Event().wait()

    with pytest.raises(
        TimeoutError,
        match="0.01 seconds after credentials became available",
    ) as exc_info:
        run(_call_with_current_mcp_oauth_callback(parent, callback, invoke))

    assert not _is_mcp_authentication_required_error(exc_info.value)
    assert not hasattr(auth, "_daedalus_user_auth_callback")
    assert not hasattr(auth, "_daedalus_auth_started_event")
    assert not hasattr(auth, "_daedalus_credentials_ready_event")


def test_interactive_auth_pauses_the_ordinary_tool_timeout():
    """A browser flow gets its auth budget even when the tool timeout is short."""
    auth = types.SimpleNamespace()
    parent = types.SimpleNamespace(
        _httpx_auth=auth,
        _tool_call_timeout=timedelta(seconds=0.01),
        _auth_flow_timeout=timedelta(seconds=0.2),
    )

    async def callback(_config, _method):
        await asyncio.sleep(0.03)
        return "authorized"

    async def invoke():
        result = await auth._daedalus_user_auth_callback(None, None)
        auth._daedalus_credentials_ready_event.set()
        return result

    assert (
        run(_call_with_current_mcp_oauth_callback(parent, callback, invoke))
        == "authorized"
    )


def test_mcp_auth_transport_keeps_time_for_cached_token_rejection(monkeypatch):
    """A mid-call 401 retains enough transport time for browser reauthentication."""

    class FakeMCPBaseClient:
        async def _get_tool_call_timeout(self):
            return self._tool_call_timeout

    client_module = types.ModuleType("nat.plugins.mcp.client.client_base")
    client_module.MCPBaseClient = FakeMCPBaseClient
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
        client_module,
    )

    _patch_mcp_auth_transport_timeout()
    client = FakeMCPBaseClient()
    client.server_name = "google-docs-transport"
    client._tool_call_timeout = timedelta(seconds=60)
    client._auth_flow_timeout = timedelta(seconds=600)
    client._auth_provider = object()

    monkeypatch.setattr(
        mcp_patches,
        "_PER_USER_MCP_OAUTH_SERVERS",
        frozenset({"docs_mcp_server"}),
    )
    monkeypatch.setitem(
        mcp_patches._mcp_server_group_names,
        "google-docs-transport",
        "docs_mcp_server",
    )
    assert run(client._get_tool_call_timeout()) == timedelta(seconds=600)

    # Shared API-key clients retain the ordinary upstream timeout.
    client.server_name = "x_mcp_server"
    assert run(client._get_tool_call_timeout()) == timedelta(seconds=60)
    client._auth_provider = None
    assert run(client._get_tool_call_timeout()) == timedelta(seconds=60)


def test_disconnected_per_user_mcp_builder_is_rebuilt(monkeypatch):
    """A stopped cached MCP lifecycle is replaced before the next request."""
    original_calls = []
    cleanup_calls = []

    class FakeBuilder:
        def __init__(self, connected):
            client = types.SimpleNamespace(is_connected=connected)
            group = types.SimpleNamespace(mcp_client=client)
            self._per_user_function_groups = {
                "google_docs_mcp": types.SimpleNamespace(instance=group)
            }

        async def __aexit__(self, *_args):
            cleanup_calls.append(self)

    class FakeSessionManager:
        async def _get_or_create_per_user_builder(self, user_id):
            original_calls.append(user_id)
            builder_info = self._per_user_builders.get(user_id)
            if builder_info is None:
                builder = FakeBuilder(connected=True)
                builder_info = types.SimpleNamespace(
                    builder=builder,
                    workflow=object(),
                    ref_count=0,
                )
                self._per_user_builders[user_id] = builder_info
            return builder_info.builder, builder_info.workflow

    session_module = types.ModuleType("nat.runtime.session")
    session_module.SessionManager = FakeSessionManager
    for module_name in ("nat", "nat.runtime"):
        module = types.ModuleType(module_name)
        module.__path__ = []
        monkeypatch.setitem(sys.modules, module_name, module)
    monkeypatch.setitem(sys.modules, "nat.runtime.session", session_module)

    _patch_per_user_mcp_builder_recovery()
    manager = FakeSessionManager()
    old_builder = FakeBuilder(connected=False)
    manager._per_user_builders = {
        "opaque-user-id": types.SimpleNamespace(
            builder=old_builder,
            workflow=object(),
            ref_count=0,
        )
    }
    manager._per_user_builders_lock = asyncio.Lock()

    builder, _workflow = run(manager._get_or_create_per_user_builder("opaque-user-id"))

    assert builder is not old_builder
    assert cleanup_calls == [old_builder]
    assert original_calls == ["opaque-user-id"]
    assert builder._per_user_function_groups[
        "google_docs_mcp"
    ].instance.mcp_client.is_connected

    # Recovery must not tear down a workflow that still has an active request.
    active_info = manager._per_user_builders["opaque-user-id"]
    active_info.ref_count = 1
    active_info.builder._per_user_function_groups[
        "google_docs_mcp"
    ].instance.mcp_client.is_connected = False
    active_builder, _workflow = run(
        manager._get_or_create_per_user_builder("opaque-user-id")
    )
    assert active_builder is builder
    assert cleanup_calls == [old_builder]
    assert original_calls == ["opaque-user-id", "opaque-user-id"]


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
        monkeypatch.setattr(
            mcp_patches,
            "_validate_mcp_approval",
            lambda *_args, **_kwargs: (True, "read-only"),
        )

        mcp_patches._patch_tool_client()

        result = run(FakeMCPToolClient().acall({"thread_id": "123"}))

        assert result == (
            '{"error":"mcp_tool_failed","message":"The MCP call failed; do not '
            'retry it unchanged in this turn.","retryable":false,'
            '"server":"gmail_mcp_server","tool":"get_thread"}'
        )

    def test_google_tool_call_binds_current_oauth_callback(self, monkeypatch):
        """The tool wrapper must bridge the current callback to cached transport."""
        auth_adapter = types.SimpleNamespace()

        async def callback(_config, _method):
            return "current-request"

        class FakeContext:
            @staticmethod
            def get():
                return types.SimpleNamespace(user_auth_callback=callback)

        class FakeMCPToolClient:
            _tool_name = "list_events"

            def __init__(self):
                self._parent_client = types.SimpleNamespace(
                    server_name="calendar_mcp_server",
                    _httpx_auth=auth_adapter,
                    _tool_call_timeout=timedelta(seconds=1),
                    _auth_flow_timeout=timedelta(seconds=1),
                )

            async def acall(self, tool_args):
                assert (
                    await auth_adapter._daedalus_user_auth_callback(None, None)
                    == "current-request"
                )
                return "ok"

        context_module = types.ModuleType("nat.builder.context")
        context_module.Context = FakeContext
        client_module = types.ModuleType("nat.plugins.mcp.client.client_base")
        client_module.MCPToolClient = FakeMCPToolClient
        for module_name in (
            "nat",
            "nat.builder",
            "nat.plugins",
            "nat.plugins.mcp",
            "nat.plugins.mcp.client",
        ):
            module = types.ModuleType(module_name)
            module.__path__ = []
            monkeypatch.setitem(sys.modules, module_name, module)
        monkeypatch.setitem(sys.modules, "nat.builder.context", context_module)
        monkeypatch.setitem(
            sys.modules,
            "nat.plugins.mcp.client.client_base",
            client_module,
        )
        monkeypatch.setattr(mcp_patches, "_approval_gate_installed", False)
        monkeypatch.setattr(
            mcp_patches,
            "_PER_USER_MCP_OAUTH_SERVERS",
            frozenset({"calendar_mcp_server"}),
        )
        monkeypatch.setattr(
            mcp_patches,
            "_validate_mcp_approval",
            lambda *_args, **_kwargs: (True, "read-only"),
        )

        mcp_patches._patch_tool_client()

        assert run(FakeMCPToolClient().acall({})) == "ok"
        assert not hasattr(auth_adapter, "_daedalus_user_auth_callback")

    @pytest.mark.parametrize(
        "server_name,expected_error,auth_scope",
        [
            ("gmail_mcp_server", "mcp_user_authentication_required", "user"),
            ("calendar_mcp_server", "mcp_user_authentication_required", "user"),
            ("docs_mcp_server", "mcp_user_authentication_required", "user"),
            ("k8s_mcp_server", "mcp_shared_authentication_failed", "shared"),
            ("unifi_mcp_server", "mcp_shared_authentication_failed", "shared"),
        ],
    )
    def test_tool_client_auth_errors_identify_credential_owner(
        self,
        monkeypatch,
        server_name,
        expected_error,
        auth_scope,
    ):
        import json

        import mcp_patches

        class FakeMCPToolClient:
            _tool_name = "read_status"

            def __init__(self):
                self._parent_client = types.SimpleNamespace(server_name=server_name)

            async def acall(self, tool_args):
                raise httpx.HTTPStatusError(
                    "secret upstream response",
                    request=None,
                    response=types.SimpleNamespace(status_code=401),
                )

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
        monkeypatch.setattr(
            mcp_patches,
            "_PER_USER_MCP_OAUTH_SERVERS",
            frozenset(
                {
                    "gmail_mcp_server",
                    "calendar_mcp_server",
                    "docs_mcp_server",
                }
            ),
        )
        monkeypatch.setattr(
            mcp_patches,
            "_validate_mcp_approval",
            lambda *_args, **_kwargs: (True, "read-only"),
        )

        mcp_patches._patch_tool_client()
        payload = json.loads(run(FakeMCPToolClient().acall({})))

        assert payload["error"] == expected_error
        assert payload["auth_scope"] == auth_scope
        assert payload["retryable"] is False
        assert "secret upstream response" not in json.dumps(payload)
