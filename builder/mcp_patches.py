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
"""

import asyncio
import logging
import traceback
from contextlib import asynccontextmanager

import httpx

logger = logging.getLogger("daedalus.mcp_patches")

_patched = False

# Connection error types that indicate an unreachable server (not a logic bug).
# Kept narrow to avoid masking real configuration or authentication errors.
_CONNECTION_ERROR_TYPES = (
    httpx.ConnectTimeout,
    httpx.ConnectError,
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
async def _connect_with_graceful_teardown(streamable_ctx, session_cls, url):
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
    """
    _in_teardown = False
    try:
        async with streamable_ctx as (read, write, _):
            async with session_cls(read, write) as session:
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
        from mcp.client.streamable_http import streamablehttp_client

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
            as both the HTTP timeout and SSE read timeout to streamablehttp_client,
            with graceful teardown error handling.

            Uses split httpx.Timeout (short connect, long read) so that
            ConnectTimeout fires quickly when a server is unreachable,
            rather than waiting the full tool_call_timeout.
            """
            timeout_seconds = self._tool_call_timeout.total_seconds()
            url = self._url
            split_timeout = _make_split_timeout(timeout_seconds)

            logger.info("MCP connect_to_server: url=%s timeout=%s", url, split_timeout)

            # Try httpx_client_factory for split timeouts (MCP SDK >=1.3);
            # fall back to uniform timeout for older versions.
            import inspect

            sig = inspect.signature(streamablehttp_client)
            if "httpx_client_factory" in sig.parameters:

                def _client_factory(**kwargs):
                    kwargs["timeout"] = split_timeout
                    return httpx.AsyncClient(**kwargs)

                ctx = streamablehttp_client(
                    url=url,
                    auth=self._httpx_auth,
                    timeout=timeout_seconds,
                    sse_read_timeout=max(timeout_seconds, 300),
                    httpx_client_factory=_client_factory,
                )
            else:
                ctx = streamablehttp_client(
                    url=url,
                    auth=self._httpx_auth,
                    timeout=timeout_seconds,
                    sse_read_timeout=max(timeout_seconds, 300),
                )

            async with _connect_with_graceful_teardown(
                ctx, ClientSession, url
            ) as session:
                yield session

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

    # Suppress cascade noise from MCP transport cleanup errors
    _install_mcp_log_filters()

    # Make MCP connection failures non-fatal during startup
    _patch_startup_resilience()

    # Fix async job result loss when workflow cleanup raises
    _patch_async_job_result_saving()

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


def _patch_startup_resilience():
    """Patch WorkflowBuilder.add_function_group to survive MCP connection failures.

    NAT's WorkflowBuilder treats any component initialization failure as fatal,
    so one unreachable MCP server kills the entire startup — blocking all
    remaining components (LLMs, retrievers, memory, functions, workflow) from
    initializing.

    This patch catches connection-related errors in add_function_group and logs
    a warning instead of raising, allowing the rest of the system to start.
    Tools from the unreachable MCP server will be unavailable until pod restart.
    """
    try:
        import functools

        from nat.builder.workflow_builder import WorkflowBuilder

        original_add_fg = WorkflowBuilder.add_function_group

        @functools.wraps(original_add_fg)
        async def resilient_add_function_group(self, name, *args, **kwargs):
            try:
                return await original_add_fg(self, name, *args, **kwargs)
            except Exception as exc:
                if _is_connection_error(exc):
                    root = _extract_root_connection_error(exc)
                    logger.warning(
                        "Startup resilience: function_group '%s' skipped — "
                        "%s(%s). Tools from this server will be unavailable "
                        "until restart.",
                        name,
                        type(root).__name__,
                        root,
                    )
                    return None
                raise

        WorkflowBuilder.add_function_group = resilient_add_function_group
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

    Problem: NAT's run_generation() in async_job.py places
    update_status(SUCCESS) AFTER the ``async with load_workflow`` block.
    When the WorkflowBuilder cleanup raises (e.g. RuntimeError from async
    generator teardown of MCP connections), the exception skips the
    SUCCESS update and the except handler marks the job as FAILURE — even
    though the workflow produced a valid result.

    Fix: Monkey-patch run_generation() to save the result INSIDE the
    load_workflow context, before cleanup runs.  Cleanup errors are then
    logged as warnings but do not affect job status.
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
                except Exception as cleanup_err:
                    # Check if we already saved the result before the error
                    if result is not None:
                        try:
                            job = await job_store.get_job(job_id)
                            if job and job.status == JobStatus.SUCCESS:
                                _logger.warning(
                                    "Async job %s completed but cleanup failed "
                                    "(result already saved): %s",
                                    job_id,
                                    cleanup_err,
                                )
                                return
                        except Exception:  # nosec B110
                            pass
                    raise

            except asyncio.CancelledError:
                _logger.info("Async job %s cancelled", job_id)
                if job_store is not None:
                    await job_store.update_status(
                        job_id, JobStatus.INTERRUPTED, error="cancelled"
                    )
            except Exception as e:
                _logger.exception("Error in async job %s", job_id)
                if job_store is not None:
                    await job_store.update_status(
                        job_id, JobStatus.FAILURE, error=str(e)
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


def _install_mcp_log_filters():
    """Attach cascade noise filter to MCP SDK loggers."""
    cascade_filter = _MCPCascadeFilter()
    for name in ("mcp", "mcp.client.streamable_http", "root"):
        logging.getLogger(name).addFilter(cascade_filter)
    logger.info("MCP cascade log filter installed")
