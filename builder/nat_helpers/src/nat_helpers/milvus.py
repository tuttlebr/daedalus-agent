"""Milvus connection ownership helpers."""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any


def owned_milvus_connection_args(
    owner: str,
    connection_args: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Return connection args with an alias owned by one client lifecycle.

    PyMilvus otherwise derives a process-global alias from the endpoint and
    identity. Separate ``MilvusClient`` objects then share one gRPC channel,
    and closing either client removes the channel while the other still uses
    it. Each independently closed Daedalus client therefore needs its own
    alias.
    """

    normalized_owner = "-".join(owner.strip().lower().split())
    if not normalized_owner:
        raise ValueError("Milvus connection owner must not be empty")

    args = dict(connection_args or {})
    args["alias"] = f"daedalus-{normalized_owner}-{uuid.uuid4().hex}"
    return args


def close_milvus_client(client: Any) -> None:
    """Best-effort close for an independently owned Milvus client."""

    if client is None:
        return
    close = getattr(client, "close", None)
    if not callable(close):
        return
    try:
        close()
    except Exception:
        # Cleanup must not mask the request or generator exception.
        return
