"""
Patch NAT's MCP StreamableHTTP client to pass configurable timeouts
to the underlying MCP SDK's streamablehttp_client() and add diagnostic
logging for tool call failures.

Problem 1: NAT's MCPStreamableHTTPClient.connect_to_server() calls
streamablehttp_client(url, auth) without passing the `timeout` or
`sse_read_timeout` parameters. The MCP SDK defaults to timeout=30s,
which causes httpx.ReadTimeout during both tool calls and cleanup/shutdown
when the remote MCP server is slow.

Problem 2: NAT's MCPToolClient logs "tool call failed:" but often
swallows the actual exception details, making debugging impossible.

Problem 3: NAT's MCPBaseClient.get_tool() raises "not initialized"
when the session drops, but get_tool is called *before* call_tool
(which is wrapped in _with_reconnect). The reconnect logic never
fires because the error occurs one step earlier in the call chain.

Fix 1: Monkey-patch connect_to_server() to forward the configured
tool_call_timeout as the HTTP-level timeout.

Fix 2: Monkey-patch MCPToolClient to add verbose error logging with
full tracebacks around tool call execution.

Fix 3: Monkey-patch MCPBaseClient.get_tool() to catch the "not
initialized" RuntimeError and re-enter __aenter__() (which is safe
when _exit_stack is None) before retrying, so clients with
reconnect_enabled=true recover transparently.

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

Problem 11: NAT's ``JobStore.submit_job()`` is an async method called
from FastAPI handlers, but it executes synchronous Dask client
operations (``dask_client.submit()``, ``Variable()``, ``future.set()``)
directly on the asyncio event loop.  The ``dask_client`` property
lazily creates ``Client(address, asynchronous=False)``, a blocking TCP
connection.  If the local Dask scheduler becomes unresponsive (worker
exhaustion, memory pressure, GC pauses), these blocking calls freeze
the entire event loop — no health probes, no API responses, nothing.
The kubelet liveness probe eventually kills the pod.

Fix 11: Monkey-patch ``JobStore.submit_job()`` to return immediately
after creating the job in the database.  All synchronous Dask work is
launched in a fire-and-forget background ``asyncio.Task`` that offloads
to a thread via ``asyncio.to_thread()``, guarded by
``asyncio.wait_for()`` with a configurable timeout (default 30 s).
If Dask submission fails or times out, the background task marks the
job as FAILURE in the database — the frontend discovers this during
polling.  An in-flight set prevents duplicate submissions when the
frontend retries with the same job ID.  The ``sync_timeout > 0`` path
still awaits Dask inline to preserve the API contract.
"""

import asyncio
import logging
import traceback
from contextlib import asynccontextmanager

import httpx

logger = logging.getLogger("daedalus.mcp_patches")

_patched = False

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


def _is_connection_error(exc):
    """Return True if *exc* (possibly wrapped in ExceptionGroup) is a connection error."""
    if isinstance(exc, _CONNECTION_ERROR_TYPES):
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
    if isinstance(exc, _CONNECTION_ERROR_TYPES):
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

        # Import both streamable_http_client variants:
        #   streamable_http_client  -- NAT's version, accepts http_client= kwarg
        #   streamablehttp_client   -- MCP SDK's version, accepts timeout/sse_read_timeout
        # Prefer NAT's version to preserve custom_headers and session ID tracking.
        try:
            from mcp.client.streamable_http import (
                streamable_http_client as _nat_http_client,
            )

            _use_nat_client = True
        except ImportError:
            _use_nat_client = False

        try:
            from mcp.client.streamable_http import (
                streamablehttp_client as _sdk_http_client,
            )
        except ImportError:
            _sdk_http_client = None

        # Split timeouts: short connect to fail fast on unreachable servers,
        # long read for slow tool responses.
        _MCP_CONNECT_TIMEOUT = 10.0
        _MCP_WRITE_TIMEOUT = 30.0
        _MCP_POOL_TIMEOUT = 10.0

        def _make_split_timeout(read_seconds: float) -> httpx.Timeout:
            return httpx.Timeout(
                connect=_MCP_CONNECT_TIMEOUT,
                read=read_seconds,
                write=_MCP_WRITE_TIMEOUT,
                pool=_MCP_POOL_TIMEOUT,
            )

        @asynccontextmanager
        async def patched_connect_to_server(self):
            """
            Patched connect_to_server that passes the configured tool_call_timeout
            as both the HTTP timeout and MCP session read timeout, with graceful
            teardown error handling.

            Uses NAT's streamable_http_client (with pre-built httpx.AsyncClient)
            to preserve custom_headers and session ID tracking.  Falls back to
            the MCP SDK's streamablehttp_client if the NAT variant is unavailable.

            Uses split httpx.Timeout (short connect, long read) so that
            ConnectTimeout fires quickly when a server is unreachable,
            rather than waiting the full tool_call_timeout.
            """
            timeout_seconds = self._tool_call_timeout.total_seconds()
            url = self._url
            split_timeout = _make_split_timeout(timeout_seconds)

            logger.info("MCP connect_to_server: url=%s timeout=%s", url, split_timeout)

            if _use_nat_client:
                # NAT's streamable_http_client accepts a pre-built httpx client.
                # Build one with custom headers, auth, and our split timeout.
                http_client = httpx.AsyncClient(
                    headers=self._custom_headers if self._custom_headers else None,
                    auth=self._httpx_auth,
                    timeout=split_timeout,
                )

                @asynccontextmanager
                async def _ctx():
                    async with http_client:
                        async with _nat_http_client(
                            url=url,
                            http_client=http_client,
                        ) as (read, write, get_session_id):
                            self._get_mcp_session_id = get_session_id
                            yield read, write, get_session_id

                ctx = _ctx()
            elif _sdk_http_client is not None:
                ctx = _sdk_http_client(
                    url=url,
                    auth=self._httpx_auth,
                    timeout=timeout_seconds,
                    sse_read_timeout=max(timeout_seconds, 300),
                )
            else:
                raise ImportError(
                    "Neither streamable_http_client nor streamablehttp_client available"
                )

            try:
                async with _connect_with_graceful_teardown(
                    ctx,
                    ClientSession,
                    url,
                    read_timeout_seconds=timeout_seconds,
                ) as session:
                    yield session
            finally:
                if _use_nat_client:
                    self._get_mcp_session_id = None

        MCPStreamableHTTPClient.connect_to_server = patched_connect_to_server
        logger.info(
            "MCP StreamableHTTP timeout patch applied -- "
            "HTTP timeout now follows tool_call_timeout from YAML config"
        )

    except ImportError as exc:
        logger.warning("Could not patch MCP StreamableHTTP client: %s", exc)
    except Exception as exc:
        logger.warning("Unexpected error patching MCP client: %s", exc)

    # Patch MCPBaseClient.get_tool to reconnect on session drop
    _patch_get_tool_reconnect()

    # Patch MCPToolClient to add diagnostic logging around tool calls
    _patch_tool_client()

    # Prevent McpError (application errors) from triggering reconnection
    _patch_mcp_error_no_reconnect()

    # Suppress cascade noise from MCP transport cleanup errors
    _install_mcp_log_filters()

    # Make MCP connection failures non-fatal during startup
    _patch_startup_resilience()

    # Fix async job result loss when workflow cleanup raises
    _patch_async_job_result_saving()

    # Prevent Dask operations from blocking the event loop
    _patch_async_job_submit()

    _patched = True


def _patch_get_tool_reconnect():
    """Wrap MCPBaseClient.get_tool with reconnection on 'not initialized' errors.

    NAT's reconnect logic (_with_reconnect) only wraps call_tool, but
    get_tool is called first and raises RuntimeError when _exit_stack is
    None after a session drop.  This patch catches that error and
    re-enters __aenter__() (safe when _exit_stack is None) so the
    session is re-established before retrying.
    """
    try:
        try:
            from nat.plugins.mcp.client.client_base import MCPBaseClient
        except ImportError:
            from nat.plugins.mcp.client_base import MCPBaseClient

        import functools

        original_get_tool = MCPBaseClient.get_tool

        @functools.wraps(original_get_tool)
        async def patched_get_tool(self, *args, **kwargs):
            try:
                return await original_get_tool(self, *args, **kwargs)
            except RuntimeError as exc:
                if "not initialized" not in str(exc):
                    raise
                if not getattr(self, "_reconnect_enabled", False):
                    raise

                url = getattr(self, "_url", "unknown")
                logger.warning(
                    "MCP client not initialized during get_tool (url=%s), "
                    "attempting reconnect",
                    url,
                )

                try:
                    # _exit_stack is None here, so __aenter__ is safe to call
                    # (it only raises when _exit_stack is already set).
                    await self.__aenter__()
                except RuntimeError as init_err:
                    if "already initialized" in str(init_err):
                        # Another concurrent coroutine already reconnected
                        logger.info(
                            "MCP client already reconnected by concurrent call: url=%s",
                            url,
                        )
                    else:
                        logger.error(
                            "MCP reconnect failed in get_tool: url=%s error=%s(%s)\n%s",
                            url,
                            type(init_err).__name__,
                            init_err,
                            traceback.format_exc(),
                        )
                        raise exc from init_err
                except Exception as reconnect_err:
                    logger.error(
                        "MCP reconnect failed in get_tool: url=%s error=%s(%s)\n%s",
                        url,
                        type(reconnect_err).__name__,
                        reconnect_err,
                        traceback.format_exc(),
                    )
                    raise exc from reconnect_err

                logger.info("MCP reconnect succeeded in get_tool: url=%s", url)
                return await original_get_tool(self, *args, **kwargs)

        MCPBaseClient.get_tool = patched_get_tool
        logger.info("MCPBaseClient.get_tool reconnect patch applied")

    except ImportError as exc:
        logger.warning("Could not patch MCPBaseClient.get_tool: %s", exc)
    except Exception as exc:
        logger.warning("Unexpected error patching MCPBaseClient.get_tool: %s", exc)


def _patch_tool_client():
    """Wrap MCPToolClient tool execution with verbose error logging."""
    try:
        try:
            from nat.plugins.mcp.client.tool_client import MCPToolClient
        except ImportError:
            try:
                from nat.plugins.mcp.client.client_base import MCPToolClient
            except ImportError:
                from nat.plugins.mcp.tool_client import MCPToolClient

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

        setattr(MCPToolClient, method_name, wrapped)
        logger.info(
            "MCPToolClient diagnostic patch applied on %s.%s",
            MCPToolClient.__name__,
            method_name,
        )

    except ImportError as exc:
        logger.warning("Could not patch MCPToolClient: %s", exc)
    except Exception as exc:
        logger.warning("Unexpected error patching MCPToolClient: %s", exc)


class _McpAppError(BaseException):
    """Sentinel wrapper to smuggle McpError past _with_reconnect.

    _with_reconnect catches ``Exception`` and triggers reconnection.
    We wrap McpError (an application-level error, NOT a connection issue)
    in this BaseException subclass so it escapes the ``except Exception``
    block.  The outer wrapper unwraps it immediately.
    """

    def __init__(self, original):
        self.original = original
        super().__init__(str(original))


def _patch_mcp_error_no_reconnect():
    """Prevent McpError from triggering MCP session reconnection.

    NAT's MCPBaseClient._with_reconnect() catches ALL exceptions and
    attempts reconnection.  McpError is an application-level error from
    the MCP server (e.g. "resource not found", "missing parameter") —
    the connection is healthy.  The spurious reconnect fails, triggers
    cancel-scope cascades, and crashes the job.

    Fix: Patch MCPBaseClient._with_reconnect() so the inner coro wraps
    McpError in a BaseException sentinel that escapes the ``except
    Exception`` reconnect handler.  The outer wrapper unwraps it.
    """
    try:
        import functools

        from mcp.shared.exceptions import McpError
        from nat.plugins.mcp.client.client_base import MCPBaseClient

        original_with_reconnect = MCPBaseClient._with_reconnect

        @functools.wraps(original_with_reconnect)
        async def patched_with_reconnect(self, coro, *args, **kwargs):
            # Wrap the coro so McpError escapes _with_reconnect's
            # ``except Exception`` block.
            async def coro_with_mcp_bypass():
                try:
                    return await coro()
                except McpError as e:
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
    The reasoning_agent plugin (used by the deep-thinker workflow) resolves
    tools individually via builder.get_function(tool) instead of get_tools().
    Without this patch, a skipped function group causes ValueError here too.
    Returns None for skipped groups so the reasoning_agent can skip the tool.
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
        ):
            from nat.front_ends.fastapi.async_jobs.job_store import JobStatus, JobStore
            from nat.front_ends.fastapi.response_helpers import generate_single_response
            from nat.runtime.loader import load_workflow

            _logger = async_job_mod._configure_logging(configure_logging, log_level)

            job_store = None
            try:
                job_store = JobStore(scheduler_address=scheduler_address, db_url=db_url)
                await job_store.update_status(job_id, JobStatus.RUNNING)

                result = None
                try:
                    async with load_workflow(config_file_path) as local_session_manager:
                        async with local_session_manager.session() as session:
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


# Default timeout for Dask submission.  Keeps the event loop free even when
# the local Dask scheduler is unresponsive.
_DASK_SUBMIT_TIMEOUT = 30  # seconds

# Number of retry attempts for Dask submission in the background path.
# The scheduler often recovers from transient stalls (GC, memory pressure),
# so retrying avoids marking jobs as FAILURE on single hiccups.
_DASK_SUBMIT_RETRIES = 3

# Base delay (seconds) between retry attempts; doubles each retry.
_DASK_SUBMIT_RETRY_DELAY = 2

# Tracks job IDs whose background Dask submission is still in flight.
# Prevents duplicate submissions when the frontend retries with the same ID.
_inflight_submissions: set[str] = set()

# Strong references to background tasks so they aren't garbage-collected.
_background_tasks: set[asyncio.Task] = set()


def _patch_async_job_submit():
    """Prevent synchronous Dask calls in submit_job() from blocking the event loop.

    NAT's ``JobStore.submit_job()`` is an ``async def`` called from FastAPI
    handlers, but it invokes ``self.dask_client.submit()``, ``Variable()``,
    and ``future_var.set()`` — all synchronous, potentially blocking Dask
    RPCs.  If the local Dask scheduler stalls, the entire event loop
    freezes and the pod fails its liveness probe.

    The patch offloads all synchronous Dask work to a background task so
    the HTTP handler returns immediately after creating the job in the DB.
    If Dask submission fails or times out, the background task marks the
    job as FAILURE — the frontend discovers this during polling.

    For ``sync_timeout > 0`` (caller wants to wait for the result), the
    Dask submission is still awaited inline to preserve the API contract.
    """
    try:
        from nat.front_ends.fastapi.async_jobs.job_store import JobStore

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
            from dask.distributed import Variable, fire_and_forget
            from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

            # Async DB work — safe on the event loop
            job_id = await self._create_job(
                job_id=job_id,
                config_file=config_file,
                expiry_seconds=expiry_seconds,
            )

            def _dask_submit():
                """All synchronous Dask interaction, run in a thread."""
                future = self.dask_client.submit(
                    job_fn, *job_args, key=f"{job_id}-job", **job_kwargs
                )
                future_var = Variable(name=job_id, client=self.dask_client)
                future_var.set(future, timeout="5 s")
                return future

            # ── sync_timeout > 0: caller wants to wait for result ────────
            if sync_timeout > 0:
                try:
                    future = await asyncio.wait_for(
                        asyncio.to_thread(_dask_submit),
                        timeout=_DASK_SUBMIT_TIMEOUT,
                    )
                except (TimeoutError, Exception) as exc:
                    _msg = (
                        f"Dask submission timed out for job {job_id} "
                        f"after {_DASK_SUBMIT_TIMEOUT}s"
                        if isinstance(exc, asyncio.TimeoutError)
                        else f"Dask submission failed for job {job_id}: {exc}"
                    )
                    logger.error(_msg)
                    try:
                        await self.update_status(job_id, JobStatus.FAILURE, error=_msg)
                    except Exception:
                        logger.exception(
                            "Failed to mark job %s as FAILURE after Dask error",
                            job_id,
                        )
                    raise RuntimeError(_msg) from exc

                def _dask_result():
                    return future.result(timeout=sync_timeout)

                try:
                    await asyncio.to_thread(_dask_result)
                    job = await self.get_job(job_id)
                    assert job is not None, "Job should exist after future result"  # nosec B101
                    return (job_id, job)
                except Exception:
                    pass  # nosec B110 — fall through to fire-and-forget

                await asyncio.to_thread(fire_and_forget, future)
                return (job_id, None)

            # ── sync_timeout == 0: fire-and-forget background submission ─
            async def _background_dask_submit():
                if job_id in _inflight_submissions:
                    logger.warning(
                        "Dask submission already in flight for job %s, "
                        "skipping duplicate",
                        job_id,
                    )
                    return
                _inflight_submissions.add(job_id)
                try:
                    for attempt in range(1, _DASK_SUBMIT_RETRIES + 1):
                        try:
                            future = await asyncio.wait_for(
                                asyncio.to_thread(_dask_submit),
                                timeout=_DASK_SUBMIT_TIMEOUT,
                            )
                            break  # success
                        except (TimeoutError, Exception) as exc:
                            _kind = (
                                "timed out"
                                if isinstance(exc, asyncio.TimeoutError)
                                else f"failed ({exc})"
                            )
                            if attempt < _DASK_SUBMIT_RETRIES:
                                _delay = _DASK_SUBMIT_RETRY_DELAY * (2 ** (attempt - 1))
                                logger.warning(
                                    "Dask submission %s for job %s "
                                    "(attempt %d/%d), retrying in %ds",
                                    _kind,
                                    job_id,
                                    attempt,
                                    _DASK_SUBMIT_RETRIES,
                                    _delay,
                                )
                                await asyncio.sleep(_delay)
                            else:
                                _msg = (
                                    f"Dask submission {_kind} for job "
                                    f"{job_id} after "
                                    f"{_DASK_SUBMIT_RETRIES} attempts"
                                )
                                logger.error(_msg)
                                try:
                                    await self.update_status(
                                        job_id,
                                        JobStatus.FAILURE,
                                        error=_msg,
                                    )
                                except Exception:
                                    logger.exception(
                                        "Failed to mark job %s as "
                                        "FAILURE after Dask error",
                                        job_id,
                                    )
                                return
                    else:
                        # _DASK_SUBMIT_RETRIES == 0 edge case
                        return

                    await asyncio.to_thread(fire_and_forget, future)
                finally:
                    _inflight_submissions.discard(job_id)

            task = asyncio.create_task(_background_dask_submit())
            _background_tasks.add(task)
            task.add_done_callback(_background_tasks.discard)

            return (job_id, None)

        JobStore.submit_job = patched_submit_job
        logger.info(
            "JobStore.submit_job patch applied — "
            "Dask submission runs in background task with %ds timeout "
            "(%d retries)",
            _DASK_SUBMIT_TIMEOUT,
            _DASK_SUBMIT_RETRIES,
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
