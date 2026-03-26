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
"""

import asyncio
import logging
import traceback
from contextlib import asynccontextmanager

logger = logging.getLogger("daedalus.mcp_patches")

_patched = False


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

        @asynccontextmanager
        async def patched_connect_to_server(self):
            """
            Patched connect_to_server that passes the configured tool_call_timeout
            as both the HTTP timeout and SSE read timeout to streamablehttp_client.
            """
            timeout_seconds = self._tool_call_timeout.total_seconds()
            url = self._url

            logger.info(
                "MCP connect_to_server: url=%s timeout=%.0fs", url, timeout_seconds
            )

            try:
                async with streamablehttp_client(
                    url=url,
                    auth=self._httpx_auth,
                    timeout=timeout_seconds,
                    sse_read_timeout=max(timeout_seconds, 300),
                ) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        logger.info("MCP session initialized: url=%s", url)
                        yield session
            except asyncio.CancelledError:
                logger.warning(
                    "MCP session cancelled: CancelledError (url=%s). "
                    "Propagating for framework retry.",
                    url,
                )
                raise
            except RuntimeError as exc:
                if "cancel scope" in str(exc):
                    # anyio cancel-scope mismatch during teardown.  Convert to
                    # CancelledError so the NAT framework's reconnect logic
                    # handles it as a clean cancellation rather than an opaque
                    # RuntimeError (which wastes one reconnect attempt).
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
