"""Canonical REDIS_URL resolution for Daedalus backend HTTP routers (F-019).

Resolves the Redis connection URL from ``REDIS_URL``, appending ``REDIS_PORT``
when the URL has a scheme and host but no explicit port. Consolidates the
construction previously duplicated across the image and document-ingest routers.
"""

from __future__ import annotations

import os
from urllib.parse import urlparse

DEFAULT_REDIS_URL = "redis://daedalus-redis.daedalus.svc.cluster.local"


def redis_url_from_env(default: str = DEFAULT_REDIS_URL) -> str:
    """Return the configured Redis URL, folding in REDIS_PORT when applicable."""
    raw = os.getenv("REDIS_URL", default).strip()
    port = os.getenv("REDIS_PORT", "").strip()
    parsed = urlparse(raw)
    if port and parsed.scheme and parsed.hostname and parsed.port is None:
        return f"{raw.rstrip('/')}:{port}"
    return raw
