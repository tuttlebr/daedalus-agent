"""Authenticated Daedalus memory-management and lifecycle API."""

from __future__ import annotations

import datetime
import logging
import re
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException, Query
from nat_helpers.hindsight_client import (
    HindsightError,
    client_from_env,
    deterministic_document_id,
    memory_mode,
)
from nat_helpers.identity import authenticated_user_id_from_headers
from nat_helpers.memory_ledger import (
    delete_owned_redis_memories,
    record_clear_epoch,
    record_tombstone,
)
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger("daedalus.memory_api")
router = APIRouter(tags=["memory"])

_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
_MAX_TURN_CHARS = 12_000
_CLEAR_CONFIRMATION = "DELETE ALL MY MEMORIES"


class RetainTurnRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(min_length=1, max_length=256)
    conversation_id: str | None = Field(default=None, max_length=256)
    content: str = Field(min_length=1, max_length=_MAX_TURN_CHARS)


class UpdateMemoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=_MAX_TURN_CHARS)


class InvalidateMemoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(default="user requested forget", max_length=500)


class ClearMemoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmation: str


def _headers(
    x_user_id: str | None,
    x_daedalus_internal_token: str | None,
) -> dict[str, str]:
    headers: dict[str, str] = {}
    if x_user_id:
        headers["x-user-id"] = x_user_id
    if x_daedalus_internal_token:
        headers["x-daedalus-internal-token"] = x_daedalus_internal_token
    return headers


def _authenticated_user(
    x_user_id: str | None,
    x_daedalus_internal_token: str | None,
) -> str:
    try:
        return authenticated_user_id_from_headers(
            _headers(x_user_id, x_daedalus_internal_token)
        )
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def _validate_resource_id(value: str, label: str) -> str:
    cleaned = (value or "").strip()
    if not _ID_PATTERN.fullmatch(cleaned):
        raise HTTPException(status_code=400, detail=f"invalid {label}")
    return cleaned


def _require_hindsight() -> None:
    try:
        mode = memory_mode()
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="memory is misconfigured") from exc
    if mode not in {"shadow", "hindsight"}:
        raise HTTPException(status_code=503, detail="Hindsight memory is not enabled")


async def _call(operation) -> Any:
    try:
        return await operation
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HindsightError as exc:
        logger.warning("Hindsight memory operation failed: %s", exc)
        raise HTTPException(
            status_code=502, detail="memory service unavailable"
        ) from exc


async def _record_forget(operation) -> None:
    try:
        await operation
    except Exception as exc:
        # The Hindsight mutation already completed. Report the partial result
        # honestly because a missing ledger entry could let migration restore
        # the Redis source later.
        logger.exception("Memory forget ledger update failed")
        raise HTTPException(
            status_code=500,
            detail=(
                "Memory was changed, but the forget ledger requires operator "
                "repair before another migration"
            ),
        ) from exc


@router.post("/v1/memory/retain-turn")
async def retain_turn(
    body: RetainTurnRequest,
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """Queue selective extraction from one successfully completed user turn."""

    _require_hindsight()
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    return await _retain_turn_for_user(body, user_id)


async def _retain_turn_for_user(
    body: RetainTurnRequest,
    user_id: str,
) -> dict[str, Any]:
    request_id = _validate_resource_id(body.request_id, "request ID")
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    if content.startswith(("[IDENTITY]", "[MEMORY_CONTEXT]", "[SOURCE_POLICY]")):
        raise HTTPException(
            status_code=400, detail="internal control text cannot be retained"
        )

    document_id = deterministic_document_id(
        user_id=user_id,
        source="turn",
        request_id=request_id,
        content=content,
    )
    result = await _call(
        client_from_env().retain(
            user_id=user_id,
            content=content,
            document_id=document_id,
            context="Daedalus successful interactive user turn",
            tags=["source:interactive-turn"],
            metadata={
                "source": "interactive-turn",
                "request_id": request_id,
                "conversation_id": body.conversation_id or "",
            },
            timestamp=datetime.datetime.now(datetime.UTC).isoformat(),
            asynchronous=True,
        )
    )
    return {
        "status": result.get("status", "accepted"),
        "operation_id": result.get("operation_id"),
        "document_id": document_id,
    }


@router.get("/v1/memories")
async def list_memories(
    q: str = "",
    memory_type: str = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _require_hindsight()
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    return await _list_memories_for_user(
        user_id=user_id,
        q=q,
        memory_type=memory_type,
        limit=limit,
        offset=offset,
    )


async def _list_memories_for_user(
    *,
    user_id: str,
    q: str,
    memory_type: str,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    return await _call(
        client_from_env().list_memories(
            user_id=user_id,
            query=q,
            memory_type=memory_type,
            limit=limit,
            offset=offset,
        )
    )


@router.patch("/v1/memories/{memory_id}")
async def update_memory(
    memory_id: str,
    body: UpdateMemoryRequest,
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _require_hindsight()
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    return await _update_memory_for_user(memory_id, body, user_id)


async def _update_memory_for_user(
    memory_id: str,
    body: UpdateMemoryRequest,
    user_id: str,
) -> dict[str, Any]:
    result = await _call(
        client_from_env().update_memory(
            user_id=user_id,
            memory_id=_validate_resource_id(memory_id, "memory ID"),
            text=body.text,
        )
    )
    # A later Redis migration must not replace a user-curated correction with
    # the original legacy source. Hindsight returns the owning document ID.
    document_id = str(result.get("document_id") or "").strip()
    if document_id:
        await _record_forget(
            record_tombstone(
                user_id=user_id,
                kind="source",
                resource_id=document_id,
                reason="source contains a user-curated memory",
            )
        )
    return result


@router.post("/v1/memories/{memory_id}/invalidate")
async def invalidate_memory(
    memory_id: str,
    body: InvalidateMemoryRequest,
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _require_hindsight()
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    result = await _call(
        client_from_env().invalidate_memory(
            user_id=user_id,
            memory_id=_validate_resource_id(memory_id, "memory ID"),
            reason=body.reason,
        )
    )
    await _record_forget(
        record_tombstone(
            user_id=user_id,
            kind="memory",
            resource_id=memory_id,
            reason=body.reason,
        )
    )
    document_id = str(result.get("document_id") or "").strip()
    if document_id:
        await _record_forget(
            record_tombstone(
                user_id=user_id,
                kind="source",
                resource_id=document_id,
                reason="source contains a user-invalidated memory",
            )
        )
    return result


@router.get("/v1/memory-sources")
async def list_memory_sources(
    q: str = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _require_hindsight()
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    return await _call(
        client_from_env().list_documents(
            user_id=user_id,
            query=q,
            limit=limit,
            offset=offset,
        )
    )


@router.get("/v1/memory-sources/{document_id}")
async def get_memory_source(
    document_id: str,
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _require_hindsight()
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    return await _call(
        client_from_env().get_document(
            user_id=user_id,
            document_id=_validate_resource_id(document_id, "document ID"),
        )
    )


@router.delete("/v1/memory-sources/{document_id}")
async def delete_memory_source(
    document_id: str,
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _require_hindsight()
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    result = await _call(
        client_from_env().delete_document(
            user_id=user_id,
            document_id=_validate_resource_id(document_id, "document ID"),
        )
    )
    await _record_forget(
        record_tombstone(
            user_id=user_id,
            kind="source",
            resource_id=document_id,
            reason="user deleted source",
        )
    )
    return result


@router.post("/v1/memories/clear")
async def clear_memories(
    body: ClearMemoryRequest,
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _require_hindsight()
    if body.confirmation != _CLEAR_CONFIRMATION:
        raise HTTPException(
            status_code=400, detail="confirmation phrase does not match"
        )
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    return await _clear_memories_for_user(body, user_id)


async def _clear_memories_for_user(
    body: ClearMemoryRequest,
    user_id: str,
) -> dict[str, Any]:
    if body.confirmation != _CLEAR_CONFIRMATION:
        raise HTTPException(
            status_code=400, detail="confirmation phrase does not match"
        )
    result = await _call(client_from_env().clear_memories(user_id=user_id))
    await _record_forget(record_clear_epoch(user_id))
    try:
        redis_deleted = await delete_owned_redis_memories(user_id)
    except Exception as exc:
        logger.exception(
            "Hindsight cleared but Redis rollback copy could not be cleared"
        )
        raise HTTPException(
            status_code=500,
            detail="Hindsight cleared, but the Redis rollback copy requires operator repair",
        ) from exc
    return {"status": "cleared", "redis_deleted": redis_deleted, "result": result}
