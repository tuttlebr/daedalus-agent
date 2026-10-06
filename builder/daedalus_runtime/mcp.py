"""Official MCP SDK transport, owned session lifetimes, and local approval policy."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import time
from datetime import timedelta
from weakref import WeakValueDictionary

import httpx
import jsonschema
from daedalus_runtime import approval
from daedalus_runtime.logging import log_event
from daedalus_runtime.oauth import GoogleOAuth
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from nat_helpers.identity import trusted_request_header_from_context


class Connection:
    """Enter and leave AnyIO transport scopes in the same owning task."""

    def __init__(self, url: str, headers: dict, timeout: float):
        self.ready = asyncio.get_running_loop().create_future()
        self.stop = asyncio.Event()
        self.last_used = time.monotonic()
        self.tools: dict = {}
        self.task = asyncio.create_task(self._own(url, headers, timeout))

    async def _own(self, url, headers, timeout):
        try:
            async with httpx.AsyncClient(
                headers=headers,
                timeout=httpx.Timeout(timeout, connect=10),
                follow_redirects=False,
            ) as http:
                async with streamable_http_client(url, http_client=http) as (
                    read,
                    write,
                    _,
                ):
                    async with ClientSession(
                        read, write, read_timeout_seconds=timedelta(seconds=timeout)
                    ) as session:
                        await session.initialize()
                        cursor = None
                        for _ in range(100):
                            page = await session.list_tools(cursor=cursor)
                            self.tools.update({tool.name: tool for tool in page.tools})
                            cursor = page.nextCursor
                            if not cursor:
                                break
                        else:
                            raise RuntimeError(
                                "MCP catalogue pagination exceeded limit"
                            )
                        self.ready.set_result(session)
                        await self.stop.wait()
        except BaseException:
            if not self.ready.done():
                self.ready.set_exception(RuntimeError("MCP connection is unavailable"))
            # Transport exceptions can embed URLs, headers, or remote content.
            # The caller receives a bounded application error instead.

    async def session(self):
        self.last_used = time.monotonic()
        if self.task.done():
            raise RuntimeError("MCP connection has closed")
        return await asyncio.wait_for(asyncio.shield(self.ready), timeout=15)

    async def close(self):
        self.stop.set()
        try:
            await asyncio.wait_for(asyncio.shield(self.task), timeout=5)
        except TimeoutError:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
        if self.ready.done() and not self.ready.cancelled():
            self.ready.exception()  # Retrieve a failed initialization's exception.


class MCPManager:
    def __init__(self, config: dict, oauth: GoogleOAuth):
        self.config = config
        self.groups = config.get("function_groups", {})
        self.oauth = oauth
        self.connections: dict[tuple[str, str], tuple[str, Connection]] = {}
        self.locks: WeakValueDictionary = WeakValueDictionary()

    def _auth(self, name: str) -> dict:
        server = self.groups[name]["server"]
        return self.config.get("authentication", {}).get(
            server.get("auth_provider"), {}
        )

    def _key(self, name: str, user: str) -> tuple[str, str]:
        # Even static services have isolated transports, so a session can never
        # retain another user's request-local state.
        return name, user

    async def _headers(self, name, user, emit=None):
        auth = self._auth(name)
        headers = dict(self.groups[name]["server"].get("custom_headers", {}))
        if auth.get("_type") == "mcp_oauth2":
            token = await self.oauth.access_token(user, auth, emit)
            return {**headers, "Authorization": "Bearer " + token} if token else None
        if auth.get("_type") == "api_key":
            key = auth.get("raw_key", "")
            if not key:
                raise RuntimeError("MCP credential is not configured")
            header = auth.get("custom_header_name", "Authorization")
            prefix = auth.get("custom_header_prefix", "Bearer")
            return {**headers, header: f"{prefix} {key}".strip()}
        if auth:
            raise ValueError("Unsupported MCP authentication provider")
        return headers

    async def _connection(self, name, user, headers):
        key = self._key(name, user)
        digest = hashlib.sha256(
            json.dumps(headers, sort_keys=True).encode()
        ).hexdigest()
        cached = self.connections.get(key)
        if cached and (cached[0] != digest or cached[1].task.done()):
            self.connections.pop(key)
            await cached[1].close()
            cached = None
        if cached is None:
            if len(self.connections) >= 256:
                raise RuntimeError("MCP connection capacity reached")
            group = self.groups[name]
            server = group["server"]
            if server.get("transport", "streamable-http") != "streamable-http":
                raise ValueError("Only MCP Streamable HTTP is supported")
            connection = Connection(
                server["url"], headers, float(group.get("tool_call_timeout", 120))
            )
            self.connections[key] = digest, connection
        else:
            connection = cached[1]
        try:
            await connection.session()
        except BaseException:
            self.connections.pop(key, None)
            await connection.close()
            raise
        return connection

    def _schemas(self, name, connection):
        group = self.groups[name]
        include = set(group.get("include", []))
        exclude = set(group.get("exclude", []))
        schemas = []
        for tool in connection.tools.values():
            if (include and tool.name not in include) or (
                not include and tool.name in exclude
            ):
                continue
            override = group.get("tool_overrides", {}).get(tool.name, {})
            schemas.append(
                {
                    "name": f"{name}__{tool.name}",
                    "description": override.get("description")
                    or tool.description
                    or tool.name,
                    "parameters": tool.inputSchema,
                }
            )
        return schemas

    def _connect_schema(self, name):
        names = ", ".join(self.groups[name].get("include", []))
        return {
            "name": f"{name}__connect",
            "description": f"Connect to {name} and discover its tools before using them. Complete browser authorization if requested. Available operations include: {names or 'the configured service operations'}.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        }

    async def catalogue(self, names: list[str], user: str) -> list[dict]:
        async def discover(name):
            started = time.monotonic()
            log_event("mcp_discovery_started", level=logging.DEBUG, group=name)
            try:
                async with self.locks.setdefault(self._key(name, user), asyncio.Lock()):
                    headers = await self._headers(name, user)
                    if headers is not None:
                        connection = await self._connection(name, user, headers)
                        schemas = self._schemas(name, connection)
                        log_event(
                            "mcp_discovery_finished",
                            level=logging.DEBUG,
                            group=name,
                            tool_count=len(schemas),
                            elapsed_ms=round((time.monotonic() - started) * 1000, 1),
                        )
                        return schemas
            except Exception as exc:
                log_event(
                    "mcp_catalogue_unavailable",
                    level=logging.WARNING,
                    group=name,
                    error_class=type(exc).__name__,
                )
            return [self._connect_schema(name)]

        return [
            schema
            for group in await asyncio.gather(*(discover(name) for name in names))
            for schema in group
        ]

    async def call(self, full_name: str, arguments: dict, user: str, emit):
        name, separator, tool_name = full_name.partition("__")
        if not separator or name not in self.groups:
            raise ValueError("Unknown MCP tool")
        async with self.locks.setdefault(self._key(name, user), asyncio.Lock()):
            headers = await self._headers(name, user, emit)
            connection = await self._connection(name, user, headers)
            schemas = self._schemas(name, connection)
            if tool_name == "connect":
                if arguments:
                    raise ValueError("Connect does not accept arguments")
                return {
                    "content": "Connected. The discovered tools are now available.",
                    "tools": schemas,
                }
            if full_name not in {schema["name"] for schema in schemas}:
                raise ValueError("MCP tool is not exposed by local configuration")
            tool = connection.tools[tool_name]
            jsonschema.validate(arguments, tool.inputSchema)
            token = (
                trusted_request_header_from_context("x-daedalus-approval-token") or ""
            )
            binding = {}
            allowed, reason = await asyncio.to_thread(
                approval._validate_mcp_approval,
                tool_name,
                arguments,
                annotations=tool.annotations,
                server_name=name,
                approval_token=token,
                validated_binding=binding,
            )
            if not allowed:
                from nat_helpers.approval_context import is_trusted_approval_marker

                return {
                    "content": reason,
                    "is_error": True,
                    "terminal": is_trusted_approval_marker(reason),
                    "terminal_reason": "mcp_approval_required",
                }
            session = await connection.session()
            try:
                # No retry of tools/call: a transport failure does not prove
                # that a remote mutation failed to execute.
                async with asyncio.timeout(
                    float(self.groups[name].get("tool_call_timeout", 120))
                ):
                    result = await session.call_tool(tool_name, arguments)
            except Exception as exc:
                log_event(
                    "mcp_call_unconfirmed",
                    level=logging.WARNING,
                    group=name,
                    tool=full_name,
                    error_class=type(exc).__name__,
                )
                self.connections.pop(self._key(name, user), None)
                await connection.close()
                # Force a refresh on the next operation without deleting the
                # offline grant. Never retry this operation automatically.
                auth = self._auth(name)
                if auth.get("_type") == "mcp_oauth2":
                    with contextlib.suppress(Exception):
                        await self.oauth.invalidate_access(
                            user, auth, headers["Authorization"][7:]
                        )
                return {
                    "content": "MCP call did not return a confirmed result. Its remote outcome may be unknown; check the current state before repeating a change.",
                    "is_error": True,
                }
            failed = approval._mcp_result_is_error(result)
            if not failed and binding:
                await asyncio.to_thread(
                    approval._record_approved_mcp_receipt,
                    approval_token=token,
                    validated_binding=binding,
                )
            return {
                "content": result.model_dump_json(exclude_none=True),
                "is_error": failed,
            }

    async def reset(self, service, user):
        names = [
            name
            for name in self.groups
            if self._auth(name).get("_type") == "mcp_oauth2"
            and self.oauth.service(self._auth(name)) == service
        ]
        async with contextlib.AsyncExitStack() as stack:
            for name in names:
                lock = self.locks.setdefault(self._key(name, user), asyncio.Lock())
                if lock.locked():
                    from fastapi import HTTPException

                    raise HTTPException(
                        409,
                        "Authorization is in use; wait for the current operation to finish",
                    )
                await stack.enter_async_context(lock)
            deleted = await self.oauth.reset(service, user)
            removed = 0
            for name in names:
                cached = self.connections.pop(self._key(name, user), None)
                if cached:
                    await cached[1].close()
                    removed += 1
        return {
            "service": service,
            "authorizationCleared": True,
            "savedTokenDeleted": deleted,
            "cachedWorkflowsInvalidated": removed,
        }

    def capability_status(self):
        required = {
            name.strip()
            for name in os.getenv("DAEDALUS_REQUIRED_MCP_GROUPS", "").split(",")
            if name.strip()
        }
        available = {
            name
            for (name, _), (_, connection) in self.connections.items()
            if connection.ready.done() and not connection.task.done()
        }
        missing = set(self.groups) - available
        return {
            "available": sorted(available),
            "missing_required": sorted(required - available),
            "unavailable_optional": sorted(missing - required),
        }

    async def reap(self):
        while True:
            await asyncio.sleep(60)
            for key, (_, connection) in list(self.connections.items()):
                lock = self.locks.setdefault(key, asyncio.Lock())
                if not lock.locked() and time.monotonic() - connection.last_used > 600:
                    async with lock:
                        if self.connections.get(key, (None, None))[1] is connection:
                            self.connections.pop(key)
                            await connection.close()
            static = [
                name
                for name in self.groups
                if self._auth(name).get("_type") != "mcp_oauth2"
            ]
            await self.catalogue(static, "runtime-readiness")

    async def close(self):
        await asyncio.gather(
            *(connection.close() for _, connection in self.connections.values())
        )
        self.connections.clear()
