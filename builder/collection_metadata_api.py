"""Authenticated collection metadata for frontend document workflows."""

from __future__ import annotations

import asyncio
import contextlib
import os
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException
from nat_helpers.internal_auth import require_trusted_user
from nat_nv_ingest.nat_nv_ingest import (
    SHARED_COLLECTION_NAMES,
    user_upload_collection_name,
)

router = APIRouter(prefix="/v1/metadata", tags=["metadata"])


def _milvus_kwargs() -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "uri": os.getenv(
            "MILVUS_URI", "http://milvus.milvus.svc.cluster.local:19530"
        )
    }
    token = (os.getenv("MILVUS_TOKEN") or "").strip()
    username = (os.getenv("MILVUS_USERNAME") or os.getenv("MILVUS_USER") or "").strip()
    password = (os.getenv("MILVUS_PASSWORD") or "").strip()
    if token:
        kwargs["token"] = token
    elif username or password:
        kwargs["user"] = username
        kwargs["password"] = password
    database = (os.getenv("MILVUS_DATABASE") or "default").strip()
    if database and database != "default":
        kwargs["db_name"] = database
    return kwargs


def _list_collections_sync() -> list[str]:
    from pymilvus import MilvusClient

    client = MilvusClient(**_milvus_kwargs())
    try:
        return [str(name) for name in client.list_collections()]
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            with contextlib.suppress(Exception):
                close()


async def _list_collections() -> list[str]:
    timeout = max(
        0.5,
        min(10.0, float(os.getenv("MILVUS_METADATA_TIMEOUT_SECONDS", "3"))),
    )
    return await asyncio.wait_for(
        asyncio.to_thread(_list_collections_sync),
        timeout=timeout,
    )


async def _collection_metadata(
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """Return only the caller's private target and allow-listed shared reads."""

    user_id = require_trusted_user(x_user_id, x_daedalus_internal_token)
    private_name = user_upload_collection_name(
        user_id,
        os.getenv("DOCUMENT_INGEST_DEFAULT_COLLECTION", "user_uploads"),
    )
    try:
        existing = set(await _list_collections())
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Collection metadata is temporarily unavailable",
        ) from exc

    database_name = (os.getenv("MILVUS_DATABASE") or "default").strip() or "default"
    user_collection = {
        "name": private_name,
        "displayName": "My documents",
        "scope": "user",
        "exists": private_name in existing,
        "readable": True,
        "writable": True,
    }
    shared_collections = [
        {
            "name": name,
            "displayName": name,
            "scope": "shared",
            "exists": name in existing,
            "readable": True,
            "writable": False,
        }
        for name in sorted(SHARED_COLLECTION_NAMES)
    ]
    return {
        "databaseName": database_name,
        "userCollection": user_collection,
        "sharedCollections": shared_collections,
        "writableCollections": [user_collection],
    }


@router.get("/collections")
async def collection_metadata(
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    return await _collection_metadata(x_user_id, x_daedalus_internal_token)
