"""Canonical REDIS_URL resolution for Daedalus backend HTTP routers (F-019).

Resolves the Redis connection URL from ``REDIS_URL``, appending ``REDIS_PORT``
when the URL has a scheme and host but no explicit port. Consolidates the
construction previously duplicated across the image and document-ingest routers.
"""

from __future__ import annotations

import inspect
import os
from urllib.parse import urlparse

DEFAULT_REDIS_URL = "redis://daedalus-redis.daedalus.svc.cluster.local"


def redis_client(*, timeout_seconds: float = 5.0):
    """Return an async Redis client for the configured URL.

    Callers differ only in how long they are willing to block, so that is the
    single parameter. Previously each module carried its own copy of this
    four-line constructor, which is how two of them ended up with different
    ``decode_responses`` expectations waiting to happen.
    """

    from redis.asyncio import Redis

    return Redis.from_url(
        redis_url_from_env(),
        decode_responses=True,
        socket_connect_timeout=timeout_seconds,
        socket_timeout=timeout_seconds,
    )


async def close_redis_client(client) -> None:
    """Close Redis clients across the pinned 4.x and newer async APIs."""

    close = getattr(client, "aclose", None) or getattr(client, "close", None)
    if close is None:
        return
    result = close()
    if inspect.isawaitable(result):
        await result


def redis_url_from_env(default: str = DEFAULT_REDIS_URL) -> str:
    """Return the configured Redis URL, folding in REDIS_PORT when applicable."""
    raw = os.getenv("REDIS_URL", default).strip()
    port = os.getenv("REDIS_PORT", "").strip()
    parsed = urlparse(raw)
    if port and parsed.scheme and parsed.hostname and parsed.port is None:
        return f"{raw.rstrip('/')}:{port}"
    return raw
