"""
Patch NAT's MCP StreamableHTTP client to override the upstream 30 s
HTTP connect timeout with a faster fail-fast value, and add daedalus-
specific logging and approval-gate behavior around MCP tool calls.

Problem 1: NAT 1.7.0's MCPStreamableHTTPClient.connect_to_server()
uses MCP_DEFAULT_TIMEOUT=30 s as the httpx connect timeout.  With
startup-resilience retries (Fix 5) running each MCP server up to four
times, this multiplies into ~135 s per unreachable server before
giving up -- enough to extend pod startup by several minutes when
multiple MCP endpoints are offline.

Problem 2: NAT's MCPToolClient logs "tool call failed:" but often
swallows the actual exception details, making debugging impossible.

Fix 1: Monkey-patch connect_to_server() to build the httpx client via
the SDK's create_mcp_http_client() helper (matches upstream) but with
httpx.Timeout(connect=_MCP_CONNECT_TIMEOUT) so unreachable servers
fail in seconds instead of 30 s.  Read/write/pool timeouts inherit
upstream's max(MCP_DEFAULT_SSE_READ_TIMEOUT, tool_call_timeout,
auth_flow_timeout) so long-running tool calls are unaffected.

Fix 2: Monkey-patch MCPToolClient to add verbose error logging with
full tracebacks around tool call execution.

Problem 4: The MCP SDK's terminate_session() catches Exception but not
CancelledError (a BaseException).  During shutdown, the HTTP DELETE it
sends raises CancelledError which escapes through __aexit__, producing
a noisy traceback in the framework's lifespan handler.

Fix 4: Track whether the session yield has returned (teardown phase)
and suppress CancelledError / cancel-scope RuntimeError that occur
during cleanup, since the session was already used successfully.

Problem 5: NAT's WorkflowBuilder.populate_builder() treats any component
initialization failure as fatal.  One unreachable MCP server kills the
entire startup, blocking all remaining components (LLMs, retrievers,
memory, functions, workflow) from initializing.

Fix 5: Monkey-patch WorkflowBuilder.add_function_group() to catch
connection-related errors (including those wrapped in ExceptionGroup by
anyio's TaskGroup) and log a warning instead of raising.  Tools from the
unreachable server will be unavailable until the pod restarts, but the
rest of the system starts normally.

Problem 8: When a function group is skipped by Fix 5, downstream agent
configs still reference its tools by name in their tool_names list.
WorkflowBuilder.get_tools() raises ValueError for any tool whose function
group was never registered, crashing the entire startup.

Fix 8: Monkey-patch WorkflowBuilder.get_tools() to filter out tools
belonging to skipped function groups before resolution.  The agent starts
with a reduced tool set rather than failing entirely.

Problem 10: The get_tools() filter (Fix 8) only covers agents that
resolve tools via get_tools() (e.g. tool_calling_agent).  The
reasoning_agent plugin resolves tools individually by calling
builder.get_function(tool) for each tool name.  When a function group
was skipped, get_function() raises ValueError, crashing the entire
startup — even though all other components built successfully.

Fix 10: Monkey-patch WorkflowBuilder.get_function() to return None for
names in the skipped set instead of raising.  The reasoning_agent
receives None and skips the unavailable tool, starting with a reduced
tool set — identical degraded behaviour to Fix 8.

Problem 6: NAT's async_job.run_generation() places the
update_status(SUCCESS) call AFTER the ``async with load_workflow``
block.  When WorkflowBuilder cleanup raises (e.g. RuntimeError from
async generator teardown of MCP connections), the exception prevents
the SUCCESS update from executing.  The except handler then marks the
job as FAILURE even though the workflow produced a valid result.

Fix 6: Monkey-patch run_generation() to save the result INSIDE the
load_workflow context (after generate_single_response completes but
before cleanup starts).  If cleanup subsequently raises and the result
was already saved, the error is logged as a warning rather than
overwriting the SUCCESS status.

Problem 7: When an active cancel scope injects CancelledError into the
workflow (e.g. during MCP reconnect backoff), the error handler's own
``await job_store.update_status()`` is also cancelled by the same scope.
The job is left permanently in RUNNING status, causing the frontend to
poll indefinitely.  Additionally, ``except Exception`` in the inner
cleanup handler misses CancelledError in Python 3.9+ (it became a
BaseException), so cleanup cancellations bypass the result-saved check.

Fix 7: Schedule error-handler status updates via
``asyncio.ensure_future()`` (fire-and-forget) so they run as independent
tasks outside the cancel scope.  ``asyncio.shield()`` alone is
insufficient because the ``await`` itself is cancelled by the scope.
Catch CancelledError alongside Exception in the inner cleanup handler
so the result-saved check runs for all error types.

Problem 9: NAT's MCPBaseClient._with_reconnect() catches ALL exceptions
from MCP tool calls and attempts session reconnection.  McpError is an
*application-level* error (e.g. "pod not found", "missing parameter")
returned by the MCP server — the connection is healthy.  The spurious
reconnect fails ("generator didn't yield"), triggers cancel-scope
cascades, and crashes the entire async job instead of returning the
error to the LLM agent as a normal tool response.

Fix 9: Monkey-patch MCPBaseClient._with_reconnect() so that McpError
from the inner coro is wrapped in a BaseException sentinel that escapes
the ``except Exception`` reconnect handler.  The outer wrapper unwraps
it and re-raises the original McpError, which the LLM framework then
returns to the agent as a normal tool error response.

Problem 11: NAT's ``JobStore.submit_job()`` uses Dask for distributed
job execution, but the local Dask scheduler is prone to connection
timeouts and hangs that freeze the event loop and kill the pod.

Fix 11: Monkey-patch ``JobStore.submit_job()`` to bypass Dask entirely.
Async job functions run as ``asyncio.Task`` instances on the existing
event loop, while synchronous job functions are offloaded to a worker
thread.  The HTTP handler returns immediately after creating the job in
the database.  An in-flight set prevents duplicate submissions when the
frontend retries with the same job ID.
"""

import asyncio
import json
import logging
import os
import re
import traceback
from contextlib import asynccontextmanager

import httpx

logger = logging.getLogger("daedalus.mcp_patches")

_patched = False

# F-006: fail-closed tracking for the MCP approval gate. The gate is enforced by
# the wrapper installed in _patch_tool_client(); if NAT renames/moves its tool
# execution method the wrapper would silently not install, leaving destructive
# MCP calls ungated. These flags let patch() detect that and refuse to start.
_mcp_client_available = False
_approval_gate_installed = False

# Function groups that were skipped during startup due to connection errors.
# Populated by _patch_startup_resilience, read by the get_tools filter.
_skipped_function_groups: set[str] = set()

# Retry settings for MCP server connections during startup.
_MCP_STARTUP_MAX_RETRIES = 3
_MCP_STARTUP_RETRY_DELAY = 5  # seconds between retries

# Connection error types that indicate an unreachable server (not a logic bug).
# Kept narrow to avoid masking real configuration or authentication errors.
_CONNECTION_ERROR_TYPES = (
    httpx.ConnectTimeout,
    httpx.ConnectError,
    httpx.ReadTimeout,  # server accepts TCP but never sends HTTP response
    ConnectionError,  # includes ConnectionRefusedError, ConnectionResetError
)

# Destructive/mutating verbs that gate an MCP tool call behind human approval.
#
# NOTE: this denylist is DEFENSE-IN-DEPTH only. The primary, robust control is
# restricting each MCP server to an explicit read-only `include:` allowlist in
# backend/tool-calling-config.yaml (every server there already does this EXCEPT
# k8s_mcp_server, which exposes its full tool surface) and/or honoring MCP tool
# annotations (readOnlyHint/destructiveHint). A denylist cannot enumerate every
# dangerous verb, so prefer the allowlist; this list is the backstop.
#
# Distinctive verbs — safe to match anywhere in the tool name (low risk of
# appearing inside a read-only tool name).
_MUTATING_TOOL_FRAGMENTS = (
    "apply",
    "create",
    "delete",
    "deletecollection",
    "patch",
    "replace",
    "rollback",
    "rollout",
    "scale",
    "autoscale",
    "uninstall",
    "update",
    "upgrade",
    "cordon",
    "drain",
    "evict",
    "taint",
    "terminate",
    "destroy",
    "revoke",
    "restart",
    "annotate",
    "remove",
    "disable",
)

# Short/ambiguous verbs matched as WHOLE tokens (the tool name is split on
# non-alphanumeric chars) to avoid false positives such as "asset"/"subset"/
# "reset"/"output"/"list_labels" that a substring match would wrongly gate.
_MUTATING_TOOL_TOKENS = frozenset(
    {
        "exec",
        "set",
        "put",
        "post",
        "cp",
        "edit",
        "kill",
        "drop",
        "debug",
        "expose",
        "attach",
        "label",
        "write",
        "send",
        "move",
        "rename",
    }
)

_WORD_SPLIT_RE = re.compile(r"[^a-z0-9]+")

_NON_DESTRUCTIVE_MCP_TOOLS = {
    # A Gmail draft is reversible and is not sent to a recipient. The remote
    # MCP schema does not expose Daedalus's approval_token field, so enforce
    # explicit confirmation in the agent instructions instead of this wrapper.
    "create_draft",
}


def _flatten_tool_payload(args, kwargs) -> dict:
    """Best-effort extraction of MCP tool arguments from wrapper inputs."""
    payload: dict = {}
    for candidate in list(args) + [kwargs]:
        if isinstance(candidate, dict):
            payload.update(candidate)
        elif isinstance(candidate, str):
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                payload.update(parsed)
    nested = payload.get("arguments") or payload.get("args") or payload.get("input")
    if isinstance(nested, dict):
        merged = dict(payload)
        merged.update(nested)
        payload = merged
    return payload


def _annotation_hint(annotations, name: str):
    """Read a boolean MCP tool annotation by *name* (e.g. destructiveHint).

    MCP annotations may arrive as a pydantic model (attribute access) or as a
    plain dict (key access).  Returns the bool value, or None when the hint is
    absent / not a bool.
    """
    if annotations is None:
        return None
    val = None
    if isinstance(annotations, dict):
        val = annotations.get(name)
    else:
        val = getattr(annotations, name, None)
    return val if isinstance(val, bool) else None


def _extract_tool_annotations(tool_client):
    """Best-effort read of MCP tool annotations from an MCPToolClient instance.

    The MCP SDK exposes per-tool annotations (readOnlyHint / destructiveHint /
    idempotentHint / openWorldHint) on the Tool definition. NAT's tool client
    stores that definition under a few possible attribute names depending on
    version. Returns the annotations object (pydantic model or dict), or None
    when the client/version does not expose them.
    """
    if tool_client is None:
        return None
    # Direct annotations attribute on the client (some NAT versions surface it).
    direct = getattr(tool_client, "annotations", None)
    if direct is not None:
        return direct
    # Otherwise look for the underlying MCP Tool definition.
    for attr in ("_tool", "tool", "_tool_def", "tool_def"):
        tool = getattr(tool_client, attr, None)
        if tool is not None:
            ann = getattr(tool, "annotations", None)
            if ann is not None:
                return ann
    return None


def _is_mutating_mcp_call(tool_name: str, payload: dict, annotations=None) -> bool:
    # F-009: honor MCP tool annotations when the server/client exposes them, in
    # ADDITION to the verb heuristic below. destructiveHint=True forces the call
    # to be treated as mutating even if its name carries no listed verb (closing
    # the denylist gap); readOnlyHint=True trusts the server's declaration that
    # the tool cannot mutate state. The robust, per-server read-only `include:`
    # allowlist still lives in backend/tool-calling-config.yaml and is the
    # primary control — see the _MUTATING_TOOL_FRAGMENTS note above.
    destructive_hint = _annotation_hint(annotations, "destructiveHint")
    if destructive_hint is True:
        return True
    read_only_hint = _annotation_hint(annotations, "readOnlyHint")
    if read_only_hint is True:
        return False

    normalized_tool_name = tool_name.lower().replace(".", "_").replace("-", "_")
    if (
        normalized_tool_name in _NON_DESTRUCTIVE_MCP_TOOLS
        or normalized_tool_name.endswith("_create_draft")
    ):
        return False

    text_parts = [tool_name]
    for key in ("operation", "command", "action", "method", "verb"):
        val = payload.get(key)
        if isinstance(val, str):
            text_parts.append(val)
    text = " ".join(text_parts).lower()

    if any(fragment in text for fragment in _MUTATING_TOOL_FRAGMENTS):
        return True

    tokens = set(_WORD_SPLIT_RE.split(text))
    return bool(tokens & _MUTATING_TOOL_TOKENS)


def _validate_mcp_approval(
    tool_name: str, payload: dict, annotations=None
) -> tuple[bool, str]:
    if not _is_mutating_mcp_call(tool_name, payload, annotations):
        return True, "read-only"

    token = str(payload.get("approval_token") or "").strip()
    user_id = str(
        payload.get("user_id")
        or payload.get("username")
        or payload.get("user")
        or "anonymous"
    ).strip()
    target = str(
        payload.get("target")
        or payload.get("namespace")
        or payload.get("repo")
        or payload.get("name")
        or tool_name
    ).strip()

    if not token:
        return False, (
            f"MCP tool '{tool_name}' appears to mutate external state and "
            "requires approval_token."
        )

    try:
        from user_interaction.approval_tokens import (
            make_redis_client,
            validate_approval_token,
        )

        ok, reason = validate_approval_token(
            make_redis_client(os.getenv("APPROVAL_REDIS_URL")),
            user_id=user_id,
            token=token,
            action_type="mcp_mutation",
            target=target or tool_name,
            consume=True,
        )
    except Exception as exc:
        return False, f"approval validation failed: {exc}"

    if not ok:
        return False, reason
    return True, "approved"


def _strip_approval_token(args, kwargs) -> None:
    for candidate in list(args) + [kwargs]:
        if not isinstance(candidate, dict):
            continue
        candidate.pop("approval_token", None)
        for key in ("arguments", "args", "input"):
            nested = candidate.get(key)
            if isinstance(nested, dict):
                nested.pop("approval_token", None)


def _is_transient_http_error(exc) -> bool:
    """Return True for httpx.HTTPStatusError with a 5xx status code.

    5xx responses from upstream MCP servers are server-side and typically
    transient — treat them like connection errors so startup retries / skips
    instead of crashing the pod.
    """
    if not isinstance(exc, httpx.HTTPStatusError):
        return False
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None) if response is not None else None
    return isinstance(status, int) and 500 <= status < 600


def _is_connection_error(exc):
    """Return True if *exc* (possibly wrapped in ExceptionGroup) is a connection error."""
    if isinstance(exc, _CONNECTION_ERROR_TYPES) or _is_transient_http_error(exc):
        return True
    # anyio TaskGroup wraps exceptions in ExceptionGroup
    if isinstance(exc, ExceptionGroup):  # noqa: F821 (builtin in 3.11+)
        return any(_is_connection_error(e) for e in exc.exceptions)
    # Check the __cause__ chain (e.g. framework re-raises wrapping the original)
    if exc.__cause__ is not None:
        return _is_connection_error(exc.__cause__)
    return False


def _extract_root_connection_error(exc):
    """Return the innermost connection error from *exc* for concise logging."""
    if isinstance(exc, _CONNECTION_ERROR_TYPES) or _is_transient_http_error(exc):
        return exc
    if isinstance(exc, ExceptionGroup):  # noqa: F821 (builtin in 3.11+)
        for e in exc.exceptions:
            root = _extract_root_connection_error(e)
            if root is not None:
                return root
    if exc.__cause__ is not None:
        return _extract_root_connection_error(exc.__cause__)
    return exc


@asynccontextmanager
async def _connect_with_graceful_teardown(
    streamable_ctx, session_cls, url, read_timeout_seconds=None
):
    """Connect to an MCP server with graceful teardown error handling.

    Wraps the streamablehttp_client -> ClientSession lifecycle and tracks
    whether the session ``yield`` has returned.  Cancellation errors that
    arrive *after* the yield (during ``__aexit__`` of the transport or
    session) are logged and suppressed instead of propagating, because:

    * The MCP SDK's ``terminate_session()`` catches ``Exception`` but not
      ``CancelledError`` (a ``BaseException``).  During shutdown the HTTP
      DELETE it sends raises ``CancelledError`` which escapes the SDK.
    * anyio cancel-scope ``RuntimeError`` variants behave the same way.

    Errors during the *operational* phase (before the yield returns) are
    still propagated so that the NAT framework's retry logic can act on
    them.

    Args:
        read_timeout_seconds: Timeout for individual MCP request-response
            pairs (ClientSession read_timeout).  Defaults to the MCP SDK
            default (60s) when None.  Set this to the configured
            tool_call_timeout so that slow operations like helm install
            are not killed prematurely.
    """
    from datetime import timedelta

    _in_teardown = False
    _DEFAULT_SDK_TIMEOUT = timedelta(seconds=60)

    def _build_session(session_cls, read, write, timeout_seconds):
        """Create a ClientSession context manager, injecting the timeout.

        Strategy:
          1. Try known constructor kwarg names (varies by SDK version).
          2. If no kwarg works, construct without and override attributes.

        Returns (context_manager, timeout_set_via_kwargs: bool).
        """
        if timeout_seconds is None:
            return session_cls(read, write), False

        td = timedelta(seconds=timeout_seconds)
        # Try every known kwarg name + type combination.
        for kwargs in (
            {"read_timeout_seconds": td},
            {"read_timeout_seconds": timeout_seconds},
            {"read_timeout": td},
            {"read_timeout": timeout_seconds},
        ):
            try:
                cm = session_cls(read, write, **kwargs)
                logger.info(
                    "ClientSession accepts %s (url=%s)",
                    list(kwargs.keys())[0],
                    url,
                )
                return cm, True
            except TypeError:
                continue

        logger.info(
            "ClientSession constructor rejects timeout kwargs; "
            "will override instance attributes after construction (url=%s)",
            url,
        )
        return session_cls(read, write), False

    def _force_session_timeout(session, seconds):
        """Scan the session's instance attributes for the 60 s SDK default
        and replace it with the configured timeout.

        The MCP SDK's BaseSession stores the timeout as a private
        attribute (typically ``_read_timeout_seconds``) whose name and
        type (``timedelta`` vs ``float``) vary across releases.  Rather
        than guessing names, we scan ``vars(session)`` for any value
        that equals the well-known 60 s default.
        """
        td = timedelta(seconds=seconds)
        overridden = False

        # Pass 1 -- instance attributes set by __init__
        for attr_name in list(vars(session)):
            val = getattr(session, attr_name, None)
            if isinstance(val, timedelta) and val == _DEFAULT_SDK_TIMEOUT:
                setattr(session, attr_name, td)
                logger.info(
                    "MCP session timeout: %s = %s -> %s (url=%s)",
                    attr_name,
                    val,
                    td,
                    url,
                )
                overridden = True
            elif isinstance(val, (int, float)) and abs(val - 60.0) < 0.1:
                setattr(session, attr_name, float(seconds))
                logger.info(
                    "MCP session timeout: %s = %s -> %s (url=%s)",
                    attr_name,
                    val,
                    seconds,
                    url,
                )
                overridden = True

        if overridden:
            return

        # Pass 2 -- inherited / class-level attributes with "timeout" in name
        for attr_name in dir(session):
            if attr_name.startswith("__") or "timeout" not in attr_name.lower():
                continue
            try:
                val = getattr(session, attr_name)
            except Exception:  # nosec B112 - intentional: skip inaccessible attrs
                continue
            if callable(val):
                continue
            if isinstance(val, timedelta) and val == _DEFAULT_SDK_TIMEOUT:
                setattr(session, attr_name, td)
                logger.info(
                    "MCP session timeout (class): %s = %s -> %s (url=%s)",
                    attr_name,
                    val,
                    td,
                    url,
                )
                overridden = True
            elif isinstance(val, (int, float)) and abs(val - 60.0) < 0.1:
                setattr(session, attr_name, float(seconds))
                logger.info(
                    "MCP session timeout (class): %s = %s -> %s (url=%s)",
                    attr_name,
                    val,
                    seconds,
                    url,
                )
                overridden = True

        if not overridden:
            # Dump everything for debugging so the next deploy shows
            # exactly what the SDK stores.
            timeout_attrs = {}
            for a in dir(session):
                if a.startswith("__"):
                    continue
                try:
                    v = getattr(session, a)
                except Exception:  # nosec B112 - intentional: skip inaccessible attrs
                    continue
                if callable(v):
                    continue
                if isinstance(v, (int, float, timedelta)):
                    timeout_attrs[a] = repr(v)
            logger.warning(
                "Could not locate 60 s default to override. "
                "All numeric/timedelta attrs: %s (url=%s)",
                timeout_attrs,
                url,
            )

    try:
        async with streamable_ctx as (read, write, _):
            session_cm, timeout_set = _build_session(
                session_cls, read, write, read_timeout_seconds
            )
            async with session_cm as session:
                if read_timeout_seconds is not None and not timeout_set:
                    _force_session_timeout(session, read_timeout_seconds)
                await session.initialize()
                logger.info("MCP session initialized: url=%s", url)
                yield session
                # If we reach here the yield returned normally -- we are now
                # in the teardown phase.  Any CancelledError from this point
                # is a cleanup artifact (e.g. terminate_session's HTTP DELETE),
                # not an operational failure.
                _in_teardown = True
    except asyncio.CancelledError:
        if _in_teardown:
            logger.info("MCP session teardown cancelled (url=%s) -- suppressed.", url)
        else:
            logger.warning(
                "MCP session cancelled: CancelledError (url=%s). "
                "Propagating for framework retry.",
                url,
            )
            raise
    except RuntimeError as exc:
        if "cancel scope" in str(exc):
            if _in_teardown:
                logger.info(
                    "MCP cancel-scope teardown error suppressed (url=%s).",
                    url,
                )
            else:
                # anyio cancel-scope mismatch during operation.  Convert to
                # CancelledError so the NAT framework's reconnect logic
                # handles it cleanly.
                logger.warning(
                    "MCP cancel scope teardown error (url=%s). "
                    "Converting to CancelledError for cleaner retry.",
                    url,
                )
                raise asyncio.CancelledError(str(exc)) from exc
        else:
            logger.error(
                "MCP connect_to_server failed: url=%s error=%r\n%s",
                url,
                exc,
                traceback.format_exc(),
            )
            raise
    except Exception as exc:
        if _in_teardown and _is_connection_error(exc):
            logger.info(
                "MCP transport cleanup error suppressed during teardown "
                "(url=%s): %s",
                url,
                type(_extract_root_connection_error(exc)).__name__,
            )
        elif _is_connection_error(exc):
            # Connection errors are handled gracefully by startup
            # resilience (the function group is skipped).  Log at
            # WARNING with a concise message instead of ERROR with a
            # full traceback to avoid alarming noise for a handled
            # condition.
            logger.warning(
                "MCP connect_to_server failed (connection error, "
                "handled by startup resilience): url=%s error=%s",
                url,
                type(_extract_root_connection_error(exc)).__name__,
            )
            raise
        else:
            logger.error(
                "MCP connect_to_server failed: url=%s error=%r\n%s",
                url,
                exc,
                traceback.format_exc(),
            )
            raise


def patch():
    """Apply MCP StreamableHTTP timeout and diagnostic patches. Safe to call multiple times."""
    global _patched
    if _patched:
        return

    try:
        try:
            from nat.plugins.mcp.client.client_base import MCPStreamableHTTPClient
        except ImportError:
            from nat.plugins.mcp.client_base import MCPStreamableHTTPClient
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client
        from mcp.shared._httpx_utils import (
            MCP_DEFAULT_SSE_READ_TIMEOUT,
            create_mcp_http_client,
        )

        # Override upstream's 30 s connect timeout for fast-fail on unreachable
        # MCP servers; read/write/pool inherit upstream's long-read values.
        _MCP_CONNECT_TIMEOUT = 10.0

        @asynccontextmanager
        async def patched_connect_to_server(self):
            """
            Patched connect_to_server that builds the httpx client the same
            way upstream does (create_mcp_http_client + streamable_http_client)
            but with a fast-fail connect timeout, and adds the daedalus
            graceful-teardown wrapper (Fix 4) that swallows CancelledError /
            cancel-scope RuntimeError raised after the session yield returns.
            """
            url = self._url
            tool_call_timeout_s = self._tool_call_timeout.total_seconds()
            sse_read_timeout_s = max(
                MCP_DEFAULT_SSE_READ_TIMEOUT,
                tool_call_timeout_s,
                self._auth_flow_timeout.total_seconds(),
            )
            timeout = httpx.Timeout(_MCP_CONNECT_TIMEOUT, read=sse_read_timeout_s)

            logger.info("MCP connect_to_server: url=%s timeout=%s", url, timeout)

            http_client = create_mcp_http_client(
                headers=self._custom_headers if self._custom_headers else None,
                timeout=timeout,
                auth=self._httpx_auth,
            )

            @asynccontextmanager
            async def _ctx():
                async with http_client:
                    async with streamable_http_client(
                        url=url, http_client=http_client
                    ) as (read, write, get_session_id):
                        self._get_mcp_session_id = get_session_id
                        yield read, write, get_session_id

            try:
                async with _connect_with_graceful_teardown(
                    _ctx(),
                    ClientSession,
                    url,
                    read_timeout_seconds=tool_call_timeout_s,
                ) as session:
                    yield session
            finally:
                self._get_mcp_session_id = None

        MCPStreamableHTTPClient.connect_to_server = patched_connect_to_server
        logger.info(
            "MCP StreamableHTTP connect-timeout patch applied -- "
            "httpx connect=%ss (upstream default 30s)",
            _MCP_CONNECT_TIMEOUT,
        )

    except ImportError as exc:
        logger.warning("Could not patch MCP StreamableHTTP client: %s", exc)
    except Exception as exc:
        logger.warning("Unexpected error patching MCP client: %s", exc)

    # Patch MCPToolClient to add the approval gate + diagnostic logging, then
    # fail closed if the security gate did not attach to an available MCP client.
    _patch_tool_client()
    _verify_approval_gate_installed()

    # Prevent McpError (application errors) from triggering reconnection
    _patch_mcp_error_no_reconnect()

    # Suppress cascade noise from MCP transport cleanup errors
    _install_mcp_log_filters()

    # Make MCP connection failures non-fatal during startup
    _patch_startup_resilience()

    # Fix async job result loss when workflow cleanup raises
    _patch_async_job_result_saving()

    # Bypass Dask for job submission — run jobs as asyncio tasks
    _patch_async_job_submit()

    _patched = True


def _patch_tool_client():
    """Wrap MCPToolClient tool execution with the approval gate + error logging."""
    global _mcp_client_available, _approval_gate_installed
    try:
        try:
            from nat.plugins.mcp.client.tool_client import MCPToolClient
        except ImportError:
            try:
                from nat.plugins.mcp.client.client_base import MCPToolClient
            except ImportError:
                from nat.plugins.mcp.tool_client import MCPToolClient

        # MCP client class imported successfully: the approval gate is now
        # REQUIRED to attach. If it does not, patch() fails closed (F-006).
        _mcp_client_available = True

        # Find the method that executes tool calls -- try common names
        original_fn = None
        method_name = None
        for name in (
            "_call_tool",
            "_execute_tool",
            "call_tool",
            "_run_tool",
            "_invoke",
        ):
            fn = getattr(MCPToolClient, name, None)
            if fn is not None and callable(fn):
                original_fn = fn
                method_name = name
                break

        if original_fn is None:
            # Fallback: wrap __call__ or run
            for name in ("__call__", "run", "_run", "execute"):
                fn = getattr(MCPToolClient, name, None)
                if fn is not None and callable(fn):
                    original_fn = fn
                    method_name = name
                    break

        if original_fn is None:
            logger.warning(
                "MCPToolClient: could not find tool execution method to patch. "
                "Available methods: %s",
                [m for m in dir(MCPToolClient) if not m.startswith("__")],
            )
            return

        import functools

        @functools.wraps(original_fn)
        async def wrapped(self, *args, **kwargs):
            tool_name = getattr(self, "_tool_name", getattr(self, "name", "unknown"))
            url = getattr(self, "_url", getattr(self, "url", "unknown"))
            payload = _flatten_tool_payload(args, kwargs)
            annotations = _extract_tool_annotations(self)
            approved, approval_reason = _validate_mcp_approval(
                tool_name, payload, annotations
            )
            if not approved:
                logger.warning(
                    "MCP tool call blocked by approval gate: tool=%s reason=%s",
                    tool_name,
                    approval_reason,
                )
                raise PermissionError(approval_reason)
            _strip_approval_token(args, kwargs)
            logger.info(
                "MCP tool call start: tool=%s url=%s args=%s kwargs=%s",
                tool_name,
                url,
                args[:2] if args else "()",
                {k: v for k, v in kwargs.items() if k != "self"},
            )
            try:
                result = await original_fn(self, *args, **kwargs)
                logger.info("MCP tool call success: tool=%s", tool_name)
                return result
            except Exception as exc:
                logger.error(
                    "MCP tool call FAILED: tool=%s url=%s error=%s(%s)\n%s",
                    tool_name,
                    url,
                    type(exc).__name__,
                    exc,
                    traceback.format_exc(),
                )
                raise

        wrapped._daedalus_approval_gate = True
        setattr(MCPToolClient, method_name, wrapped)
        _approval_gate_installed = True
        logger.info(
            "MCPToolClient approval-gate + diagnostic patch applied on %s.%s",
            MCPToolClient.__name__,
            method_name,
        )

    except ImportError as exc:
        # MCP client not importable: MCP is not in use, nothing to gate.
        logger.warning("Could not patch MCPToolClient: %s", exc)
    except Exception as exc:
        # Leave _approval_gate_installed False so patch() can fail closed.
        logger.warning("Unexpected error patching MCPToolClient: %s", exc)


def _verify_approval_gate_installed():
    """Fail closed if the MCP approval gate did not attach (F-006).

    The gate is the only thing forcing destructive MCP tool calls through human
    approval. If the MCP client class is importable but the gate failed to wrap
    its tool-execution method (e.g. a NAT upgrade renamed it), continuing would
    silently leave destructive MCP calls ungated. Refuse to start instead, unless
    an operator explicitly opts out (MCP_APPROVAL_GATE_OPTIONAL=1) for a
    deployment that intentionally exposes no mutating MCP tools.
    """
    if _approval_gate_installed or not _mcp_client_available:
        return
    if (os.getenv("MCP_APPROVAL_GATE_OPTIONAL") or "").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        logger.warning(
            "MCP approval gate did NOT install, but MCP_APPROVAL_GATE_OPTIONAL is "
            "set; continuing with destructive MCP calls UNGATED."
        )
        return
    logger.critical(
        "MCP approval gate failed to install on the MCP tool client. Refusing to "
        "start so destructive MCP tool calls cannot run without approval. Set "
        "MCP_APPROVAL_GATE_OPTIONAL=1 only if no mutating MCP tools are exposed."
    )
    raise RuntimeError("MCP approval gate failed to install (fail-closed)")


class _McpAppError(BaseException):
    """Sentinel wrapper to smuggle application errors past _with_reconnect.

    _with_reconnect catches ``Exception`` and triggers reconnection.
    We wrap application-level errors (McpError, or the approval gate's
    PermissionError) — which are NOT connection issues — in this
    BaseException subclass so they escape the ``except Exception`` block.
    The outer wrapper unwraps them immediately.
    """

    def __init__(self, original):
        self.original = original
        super().__init__(str(original))


def _patch_mcp_error_no_reconnect():
    """Prevent application-level errors from triggering MCP reconnection.

    NAT's MCPBaseClient._with_reconnect() catches ALL exceptions and
    attempts reconnection.  McpError is an application-level error from
    the MCP server (e.g. "resource not found", "missing parameter") —
    the connection is healthy.  The spurious reconnect fails, triggers
    cancel-scope cascades, and crashes the job.

    The approval gate's PermissionError (F-018) is the same shape: a
    denied mutating call is an application/policy decision, not a
    connection fault.  Left unwrapped it would be caught by
    ``except Exception`` and trigger a spurious reconnect/cancel-scope
    cascade instead of returning cleanly to the agent.

    Fix: Patch MCPBaseClient._with_reconnect() so the inner coro wraps
    McpError and PermissionError in a BaseException sentinel that escapes
    the ``except Exception`` reconnect handler.  The outer wrapper
    unwraps it and re-raises the original.
    """
    try:
        import functools

        from mcp.shared.exceptions import McpError
        from nat.plugins.mcp.client.client_base import MCPBaseClient

        original_with_reconnect = MCPBaseClient._with_reconnect

        @functools.wraps(original_with_reconnect)
        async def patched_with_reconnect(self, coro, *args, **kwargs):
            # Wrap the coro so application-level errors escape
            # _with_reconnect's ``except Exception`` block.
            async def coro_with_mcp_bypass():
                try:
                    return await coro()
                except (McpError, PermissionError) as e:
                    raise _McpAppError(e) from e

            try:
                return await original_with_reconnect(
                    self, coro_with_mcp_bypass, *args, **kwargs
                )
            except _McpAppError as wrapper:
                raise wrapper.original from wrapper.__cause__

        MCPBaseClient._with_reconnect = patched_with_reconnect
        logger.info("MCPBaseClient._with_reconnect McpError bypass patch applied")

    except ImportError as exc:
        logger.warning("Could not patch MCPBaseClient._with_reconnect: %s", exc)
    except Exception as exc:
        logger.warning(
            "Unexpected error patching MCPBaseClient._with_reconnect: %s", exc
        )


def _patch_startup_resilience():
    """Patch WorkflowBuilder to survive MCP connection failures at startup.

    Part 1 — add_function_group resilience:
    NAT's WorkflowBuilder treats any component initialization failure as fatal,
    so one unreachable MCP server kills the entire startup — blocking all
    remaining components (LLMs, retrievers, memory, functions, workflow) from
    initializing.  This catches connection-related errors in add_function_group
    and logs a warning instead of raising.

    Part 2 — get_tools filter:
    When a function group is skipped, downstream agent configs still reference
    its tools by name.  WorkflowBuilder.get_tools() raises ValueError for any
    tool whose function group was never registered.  This patch filters out
    skipped groups from the tool_names list before resolution, so the agent
    starts with a reduced (but functional) tool set instead of crashing.

    Part 3 — get_function filter:
    Some plugins resolve tools individually via builder.get_function(tool)
    instead of get_tools(). Without this patch, a skipped function group
    causes ValueError here too. Returns None for skipped groups so the
    agent can skip the tool.
    """
    try:
        import functools

        from nat.builder.workflow_builder import WorkflowBuilder

        # --- Part 1: add_function_group resilience ---

        original_add_fg = WorkflowBuilder.add_function_group

        @functools.wraps(original_add_fg)
        async def resilient_add_function_group(self, name, *args, **kwargs):
            last_exc = None
            for attempt in range(_MCP_STARTUP_MAX_RETRIES + 1):
                try:
                    return await original_add_fg(self, name, *args, **kwargs)
                except Exception as exc:
                    if not _is_connection_error(exc):
                        raise
                    last_exc = exc
                    if attempt < _MCP_STARTUP_MAX_RETRIES:
                        root = _extract_root_connection_error(exc)
                        logger.warning(
                            "Startup resilience: function_group '%s' "
                            "unreachable (attempt %d/%d) — %s(%s). "
                            "Retrying in %ds...",
                            name,
                            attempt + 1,
                            _MCP_STARTUP_MAX_RETRIES + 1,
                            type(root).__name__,
                            root,
                            _MCP_STARTUP_RETRY_DELAY,
                        )
                        await asyncio.sleep(_MCP_STARTUP_RETRY_DELAY)
            # All retries exhausted
            root = _extract_root_connection_error(last_exc)
            _skipped_function_groups.add(name)
            logger.warning(
                "Startup resilience: function_group '%s' skipped after "
                "%d attempts — %s(%s). Tools from this server will be "
                "unavailable until restart.",
                name,
                _MCP_STARTUP_MAX_RETRIES + 1,
                type(root).__name__,
                root,
            )
            return None

        WorkflowBuilder.add_function_group = resilient_add_function_group

        # --- Part 2: get_tools filter for skipped groups ---

        original_get_tools = WorkflowBuilder.get_tools

        @functools.wraps(original_get_tools)
        async def resilient_get_tools(self, tool_names=None, *args, **kwargs):
            if tool_names and _skipped_function_groups:
                skipped = [n for n in tool_names if n in _skipped_function_groups]
                if skipped:
                    tool_names = [
                        n for n in tool_names if n not in _skipped_function_groups
                    ]
                    logger.warning(
                        "Startup resilience: omitting tools %s from agent — "
                        "their function groups were unreachable at startup.",
                        skipped,
                    )
            result = await original_get_tools(self, tool_names, *args, **kwargs)
            resolved_names = (
                [t.name if hasattr(t, "name") else str(t) for t in result]
                if result
                else []
            )
            logger.info(
                "Agent resolved %d tools: %s", len(resolved_names), resolved_names
            )
            if _skipped_function_groups:
                logger.warning(
                    "Skipped function groups (unavailable until restart): %s",
                    sorted(_skipped_function_groups),
                )
            return result

        WorkflowBuilder.get_tools = resilient_get_tools

        # --- Part 3: get_function filter for skipped groups ---
        #
        # The reasoning_agent plugin resolves tools by calling
        # builder.get_function(tool) for each tool name individually,
        # unlike tool_calling_agent which calls get_tools(tool_names).
        # Without this patch, a skipped function group raises ValueError
        # here and crashes the entire startup.
        #
        # Returning None lets the reasoning_agent's builder skip the
        # tool rather than abort.  The agent starts with a reduced tool
        # set — identical behaviour to the get_tools filter.

        original_get_function = WorkflowBuilder.get_function

        @functools.wraps(original_get_function)
        async def resilient_get_function(self, name, *args, **kwargs):
            if name in _skipped_function_groups:
                logger.warning(
                    "Startup resilience: get_function('%s') skipped — "
                    "function group was unreachable at startup.",
                    name,
                )
                return None
            return await original_get_function(self, name, *args, **kwargs)

        WorkflowBuilder.get_function = resilient_get_function

        logger.info("WorkflowBuilder startup resilience patch applied")

    except ImportError as exc:
        logger.warning(
            "Could not patch WorkflowBuilder for startup resilience: %s", exc
        )
    except Exception as exc:
        logger.warning("Unexpected error patching startup resilience: %s", exc)


class _MCPCascadeFilter(logging.Filter):
    """Demote cascade errors that follow MCP ConnectTimeout to DEBUG.

    When an MCP server is temporarily unreachable, the transport logs a
    ConnectTimeout followed by BrokenResourceError, GeneratorExit
    RuntimeError, and cancel-scope errors during cleanup.  These are
    expected consequences of the disconnect, not independent failures.
    Keeping them at ERROR/WARNING clutters logs and obscures the root cause.
    """

    _CASCADE_FRAGMENTS = (
        "BrokenResourceError",
        "async generator ignored GeneratorExit",
        "Attempted to exit cancel scope",
        "Error parsing SSE message",
    )

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno < logging.WARNING:
            return True
        msg = record.getMessage()
        if any(frag in msg for frag in self._CASCADE_FRAGMENTS):
            record.levelno = logging.DEBUG
            record.levelname = "DEBUG"
        return True


def _patch_async_job_result_saving():
    """Fix NAT async job result loss caused by workflow cleanup errors.

    Problem A: NAT's run_generation() in async_job.py places
    update_status(SUCCESS) AFTER the ``async with load_workflow`` block.
    When the WorkflowBuilder cleanup raises (e.g. RuntimeError from async
    generator teardown of MCP connections), the exception skips the
    SUCCESS update and the except handler marks the job as FAILURE — even
    though the workflow produced a valid result.

    Fix A: Monkey-patch run_generation() to save the result INSIDE the
    load_workflow context, before cleanup runs.  Cleanup errors are then
    logged as warnings but do not affect job status.

    Problem B: When an active cancel scope injects CancelledError into the
    workflow, the error handler's own ``await job_store.update_status()``
    is also cancelled by the same scope, leaving the job permanently stuck
    in RUNNING status.  Additionally, ``except Exception`` misses
    CancelledError in Python 3.9+ (it became a BaseException), so cleanup
    cancellations bypass the result-already-saved check entirely.

    Fix B: Schedule error-handler status updates via
    ``asyncio.ensure_future()`` (fire-and-forget) so they run as
    independent tasks outside the cancel scope.  ``asyncio.shield()``
    alone is insufficient because the ``await`` itself is cancelled.
    Catch CancelledError alongside Exception in the inner cleanup
    handler.
    """
    try:
        import nat.front_ends.fastapi.async_jobs.async_job as async_job_mod

        async def patched_run_generation(
            configure_logging,
            log_level,
            scheduler_address,
            db_url,
            config_file_path,
            job_id,
            payload,
            serialized_request=None,
        ):
            from nat.front_ends.fastapi.async_jobs.job_store import JobStatus, JobStore
            from nat.front_ends.fastapi.response_helpers import generate_single_response
            from nat.runtime.loader import load_workflow

            _logger = async_job_mod._configure_logging(configure_logging, log_level)

            job_store = None
            try:
                job_store = JobStore(scheduler_address=scheduler_address, db_url=db_url)
                await job_store.update_status(job_id, JobStatus.RUNNING)

                http_connection = None
                if serialized_request is not None:
                    from fastapi import Request

                    http_connection = Request(scope=serialized_request)

                result = None
                try:
                    async with load_workflow(config_file_path) as local_session_manager:
                        async with local_session_manager.session(
                            http_connection=http_connection
                        ) as session:
                            result = await generate_single_response(
                                payload,
                                session,
                                result_type=session.workflow.single_output_schema,
                            )
                        # Save result INSIDE the context, before cleanup
                        await job_store.update_status(
                            job_id, JobStatus.SUCCESS, output=result
                        )
                        _logger.info("Async job %s result saved successfully", job_id)
                except (Exception, asyncio.CancelledError) as cleanup_err:
                    # Check if we already saved the result before the error.
                    # Catch CancelledError too: in Python 3.9+ it is a
                    # BaseException and would bypass ``except Exception``,
                    # skipping the result-already-saved check and letting the
                    # outer handler overwrite a SUCCESS status.
                    if result is not None:
                        try:
                            job = await asyncio.shield(job_store.get_job(job_id))
                            if job and job.status == JobStatus.SUCCESS:
                                _logger.warning(
                                    "Async job %s completed but cleanup failed "
                                    "(result already saved): %s",
                                    job_id,
                                    cleanup_err,
                                )
                                return
                            # Result exists in memory but was not persisted
                            # (e.g. update_status(SUCCESS) itself was
                            # cancelled).  Retry the save.
                            await asyncio.shield(
                                job_store.update_status(
                                    job_id, JobStatus.SUCCESS, output=result
                                )
                            )
                            _logger.info(
                                "Async job %s result saved on retry "
                                "after cleanup error",
                                job_id,
                            )
                            return
                        except (asyncio.CancelledError, Exception):
                            pass
                    raise

            except asyncio.CancelledError:
                _logger.info("Async job %s cancelled", job_id)
                if job_store is not None:
                    # Don't ``await`` — the active cancel scope cancels every
                    # await point, even through asyncio.shield().  Fire-and-
                    # forget as an independent task on the event loop instead.
                    _bg = asyncio.ensure_future(
                        job_store.update_status(
                            job_id, JobStatus.INTERRUPTED, error="cancelled"
                        )
                    )
                    _bg.add_done_callback(
                        lambda t: t.exception() if not t.cancelled() else None
                    )
            except Exception as e:
                _logger.exception("Error in async job %s", job_id)
                if job_store is not None:
                    _bg = asyncio.ensure_future(
                        job_store.update_status(job_id, JobStatus.FAILURE, error=str(e))
                    )
                    _bg.add_done_callback(
                        lambda t: t.exception() if not t.cancelled() else None
                    )

        async_job_mod.run_generation = patched_run_generation
        logger.info(
            "Async job run_generation patch applied — "
            "result saved before workflow cleanup"
        )

    except ImportError as exc:
        logger.warning("Could not patch async job run_generation: %s", exc)
    except Exception as exc:
        logger.warning("Unexpected error patching async job run_generation: %s", exc)


# Tracks job IDs whose background submission is still in flight.
# Prevents duplicate submissions when the frontend retries with the same ID.
_inflight_submissions: set[str] = set()

# Strong references to background tasks so they aren't garbage-collected.
_background_tasks: set[asyncio.Task] = set()


def _max_concurrent_jobs() -> int:
    """Bound on concurrently-executing background workflow runs (F-010).

    Configurable via MCP_MAX_CONCURRENT_JOBS; defaults to 8. A burst of job
    submissions must not spawn unbounded concurrent workflow runs (each one
    loads a workflow + holds MCP/LLM connections), which can exhaust memory
    and connection pools. Values <= 0 fall back to the default.
    """
    raw = (os.getenv("MCP_MAX_CONCURRENT_JOBS") or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return 8
    return value if value > 0 else 8


# Bounds concurrent background job execution. Lazily created on the running
# event loop inside the submit patch so it binds to the correct loop.
_job_semaphore: asyncio.Semaphore | None = None


def _get_job_semaphore() -> asyncio.Semaphore:
    """Return the process-wide job concurrency semaphore (lazy init)."""
    global _job_semaphore
    if _job_semaphore is None:
        _job_semaphore = asyncio.Semaphore(_max_concurrent_jobs())
    return _job_semaphore


def _patch_async_job_submit():
    """Bypass Dask for job submission — run jobs as asyncio tasks.

    NAT's ``JobStore.submit_job()`` uses Dask's distributed scheduler
    to execute job functions.  The Dask scheduler is prone to connection
    timeouts that freeze the event loop and kill the pod.

    This patch replaces the Dask-based submission with direct asyncio task
    execution.  Job functions run on the existing event loop (or in a thread
    for sync functions), eliminating the Dask dependency entirely.
    """
    try:
        from nat.front_ends.fastapi.async_jobs.job_store import JobStore

        if getattr(JobStore.submit_job, "_daedalus_dask_bypass", False):
            logger.info("JobStore.submit_job patch already applied")
            return

        _original_submit_job = JobStore.submit_job

        async def patched_submit_job(
            self,
            *,
            job_id=None,
            config_file=None,
            expiry_seconds=JobStore.DEFAULT_EXPIRY,
            sync_timeout=0,
            job_fn=None,
            job_args=None,
            **job_kwargs,
        ):
            from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

            job_args = job_args or []

            # Async DB work — safe on the event loop
            job_id = await self._create_job(
                job_id=job_id,
                config_file=config_file,
                expiry_seconds=expiry_seconds,
            )

            # ── Deduplication guard ──────────────────────────────────────
            if job_id in _inflight_submissions:
                logger.warning(
                    "Job submission already in flight for job %s, "
                    "skipping duplicate",
                    job_id,
                )
                return (job_id, None)

            _inflight_submissions.add(job_id)

            # Bound concurrent workflow runs (F-010). Acquired INSIDE the
            # background task so submit_job still returns immediately; a burst
            # of submissions queues here rather than spawning unbounded
            # concurrent runs. NOTE (residual): this bound is per-process and
            # in-memory only — it does not survive a pod restart, and durable
            # resume of queued/in-flight jobs across restarts is broader work
            # tracked separately (see Fix 11 / async-job durability).
            semaphore = _get_job_semaphore()

            async def _run_job():
                """Execute the job function directly, bypassing Dask."""
                try:
                    async with semaphore:
                        if asyncio.iscoroutinefunction(job_fn):
                            result = await job_fn(*job_args, **job_kwargs)
                        else:
                            result = await asyncio.to_thread(
                                job_fn, *job_args, **job_kwargs
                            )
                        if asyncio.iscoroutine(result):
                            result = await result
                        return result
                except Exception as exc:
                    _msg = f"Job {job_id} failed: {exc}"
                    logger.error(_msg)
                    try:
                        await self.update_status(job_id, JobStatus.FAILURE, error=_msg)
                    except Exception:
                        logger.exception("Failed to mark job %s as FAILURE", job_id)
                    raise
                finally:
                    _inflight_submissions.discard(job_id)

            # Fire-and-forget background execution.  sync_timeout only waits
            # for an early result; it must not cancel the real job on timeout.
            task = asyncio.create_task(_run_job())
            _background_tasks.add(task)

            def _finalize_task(done_task):
                _background_tasks.discard(done_task)
                if not done_task.cancelled():
                    done_task.exception()

            task.add_done_callback(_finalize_task)

            # ── sync_timeout > 0: caller wants to wait for result ────────
            if sync_timeout > 0:
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout=sync_timeout)
                    job = await self.get_job(job_id)
                    return (job_id, job)
                except TimeoutError:
                    logger.warning(
                        "Job %s did not complete within sync_timeout=%ds, "
                        "continuing in background",
                        job_id,
                        sync_timeout,
                    )
                except Exception as exc:
                    _msg = f"Job {job_id} failed: {exc}"
                    logger.error(_msg)
                    raise RuntimeError(_msg) from exc

            return (job_id, None)

        patched_submit_job._daedalus_dask_bypass = True
        patched_submit_job._daedalus_original_submit_job = _original_submit_job
        JobStore.submit_job = patched_submit_job
        logger.info(
            "JobStore.submit_job patch applied — "
            "jobs run as asyncio tasks (Dask bypassed)"
        )

    except ImportError as exc:
        logger.warning("Could not patch JobStore.submit_job: %s", exc)
    except Exception as exc:
        logger.warning("Unexpected error patching JobStore.submit_job: %s", exc)


def _install_mcp_log_filters():
    """Attach cascade noise filter to MCP SDK loggers."""
    cascade_filter = _MCPCascadeFilter()
    for name in ("mcp", "mcp.client.streamable_http", "root"):
        logging.getLogger(name).addFilter(cascade_filter)
    logger.info("MCP cascade log filter installed")
