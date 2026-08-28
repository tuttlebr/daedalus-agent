"""User-scoped Google Workspace OAuth reset support.

The durable token and NAT's in-process per-user workflow are one logical cache.
Resetting only Redis can leave a live MCP transport attached to stale OAuth
state, while evicting only the workflow immediately reloads the same token.
This module clears both under the SessionManager locks used to create cached
per-user workflows.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
from collections.abc import Sequence

from fastapi import HTTPException, Request
from nat_helpers.redis_url import close_redis_client, redis_url_from_env

logger = logging.getLogger("daedalus.google_workspace_auth")

_TOKEN_BUCKETS = {
    "gmail": "gmail-mcp-oauth-ro",
    "calendar": "calendar-mcp-oauth-rw",
    "docs": "docs-mcp-oauth-drive",
}
_WORKFLOW_CLEANUP_TIMEOUT_SECONDS = 5.0


def google_workspace_token_key(service_id: str, user_id: str) -> str:
    """Return the exact Redis key used by NAT's ObjectStoreTokenStorage."""
    bucket = _TOKEN_BUCKETS.get(service_id)
    if bucket is None:
        raise ValueError("Unknown Google Workspace service")
    user_hash = hashlib.sha256(user_id.encode("utf-8")).hexdigest()
    return f"nat/object_store/{bucket}/tokens/{user_hash}"


def _request_user_id(request: Request) -> str:
    from nat.runtime.user_manager import UserManager

    user_info = UserManager.extract_user_from_connection(request)
    user_id = user_info.get_user_id() if user_info is not None else ""
    if not user_id:
        raise HTTPException(
            status_code=401,
            detail="Google Workspace authorization identity is required",
        )
    return user_id


async def _cleanup_detached_builders(builder_infos: Sequence[object]) -> None:
    for builder_info in builder_infos:
        builder = getattr(builder_info, "builder", None)
        if builder is None:
            continue
        try:
            await asyncio.wait_for(
                builder.__aexit__(None, None, None),
                timeout=_WORKFLOW_CLEANUP_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            # The builder was already removed from every SessionManager, so a
            # cleanup failure cannot make stale OAuth state reachable again.
            logger.warning(
                "Google Workspace cached workflow cleanup failed: %s",
                type(exc).__name__,
            )


async def reset_google_workspace_authorization(
    service_id: str,
    request: Request,
    session_managers: Sequence[object],
) -> dict[str, object]:
    """Clear one durable grant and evict this user's cached MCP workflows."""
    if service_id not in _TOKEN_BUCKETS:
        raise HTTPException(
            status_code=404,
            detail="Unknown Google Workspace service",
        )

    user_id = _request_user_id(request)
    managers = [
        manager
        for manager in session_managers
        if getattr(manager, "_is_workflow_per_user", False)
        and getattr(manager, "_per_user_builders_lock", None) is not None
        and isinstance(getattr(manager, "_per_user_builders", None), dict)
    ]
    detached: list[object] = []
    client = None

    # Prevent a request from recreating the workflow between token deletion and
    # cache eviction. SessionManager takes the same locks during builder lookup.
    async with contextlib.AsyncExitStack() as stack:
        for manager in managers:
            await stack.enter_async_context(manager._per_user_builders_lock)

        active = [
            info
            for manager in managers
            if (info := manager._per_user_builders.get(user_id)) is not None
            and getattr(info, "ref_count", 0) > 0
        ]
        if active:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Google Workspace authorization is in use. Wait for the "
                    "current chat request to finish, then reconnect."
                ),
            )

        try:
            from redis.asyncio import Redis

            client = Redis.from_url(
                redis_url_from_env(),
                socket_connect_timeout=2.0,
                socket_timeout=5.0,
            )
            deleted = await client.delete(
                google_workspace_token_key(service_id, user_id)
            )
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning(
                "Google Workspace authorization reset could not reach Redis: %s",
                type(exc).__name__,
            )
            raise HTTPException(
                status_code=503,
                detail="Google Workspace authorization reset is temporarily unavailable",
            ) from exc
        finally:
            if client is not None:
                with contextlib.suppress(Exception):
                    await close_redis_client(client)

        for manager in managers:
            info = manager._per_user_builders.pop(user_id, None)
            if info is not None:
                detached.append(info)

    await _cleanup_detached_builders(detached)
    logger.info(
        "Reset Google Workspace authorization: service=%s token_deleted=%s "
        "cached_workflows=%d",
        service_id,
        bool(deleted),
        len(detached),
    )
    return {
        "service": service_id,
        "authorizationCleared": True,
        "savedTokenDeleted": bool(deleted),
        "cachedWorkflowsInvalidated": len(detached),
    }
