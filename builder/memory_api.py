"""Authenticated Daedalus memory-management and lifecycle API."""

from __future__ import annotations

import datetime
import json
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
from nat_helpers.hindsight_memory_context import (
    clear_user_memory_caches,
    ensure_bank_initialized,
)
from nat_helpers.identity import authenticated_user_id_from_headers
from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger("daedalus.memory_api")
router = APIRouter(tags=["memory"])

_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
_MAX_TURN_CHARS = 12_000
_MAX_TURN_PART_CHARS = 5_500
_CLEAR_CONFIRMATION = "DELETE ALL MY MEMORIES"
_CONTROL_BLOCK = re.compile(
    r"\[(?:IDENTITY|MEMORY_CONTEXT|SOURCE_POLICY)\][\s\S]*?" r"(?=\n\[[A-Z_]+\]|\Z)",
    re.IGNORECASE,
)
_DATA_URL = re.compile(r"data:[^\s)\]]+", re.IGNORECASE)
_REDIS_REFERENCE = re.compile(r"redis(?:s)?://[^\s)\]]+", re.IGNORECASE)


class RetainTurnRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(min_length=1, max_length=256)
    conversation_id: str | None = Field(default=None, max_length=256)
    assistant_message_id: str | None = Field(default=None, max_length=256)
    user_content: str | None = Field(default=None, max_length=_MAX_TURN_CHARS)
    assistant_content: str | None = Field(default=None, max_length=_MAX_TURN_CHARS)
    # Rolling compatibility with the prior user-only finalizer contract.
    content: str | None = Field(default=None, max_length=_MAX_TURN_CHARS)

    @model_validator(mode="after")
    def require_turn_content(self) -> RetainTurnRequest:
        if not (self.user_content or self.content):
            raise ValueError("user_content or content is required")
        return self


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
    if mode != "hindsight":
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


def _sanitize_turn_part(value: str) -> str:
    cleaned = _CONTROL_BLOCK.sub("", value or "")
    cleaned = _DATA_URL.sub("[embedded data omitted]", cleaned)
    cleaned = _REDIS_REFERENCE.sub("[internal reference omitted]", cleaned)
    return cleaned.strip()[:_MAX_TURN_PART_CHARS]


def _completed_turn_document(user_content: str, assistant_content: str) -> str:
    user_text = _sanitize_turn_part(user_content)
    assistant_text = _sanitize_turn_part(assistant_content)
    if not user_text:
        raise ValueError("user content is empty after sanitization")

    def serialize() -> str:
        messages = [{"role": "user", "content": user_text}]
        if assistant_text:
            messages.append({"role": "assistant", "content": assistant_text})
        return json.dumps(
            {
                "schema": "daedalus.completed-turn.v1",
                "status": "completed",
                "messages": messages,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )

    document = serialize()
    while len(document) > _MAX_TURN_CHARS:
        overflow = len(document) - _MAX_TURN_CHARS
        if assistant_text:
            assistant_text = assistant_text[
                : max(0, len(assistant_text) - overflow - 1)
            ]
        else:
            user_text = user_text[: max(1, len(user_text) - overflow - 1)]
        document = serialize()
    return document


def _normalized_operation(result: dict[str, Any]) -> dict[str, Any]:
    raw_status = str(result.get("status") or "not_found")
    metadata = result.get("result_metadata")
    outcome = metadata if isinstance(metadata, dict) else {}
    try:
        unit_ids_count = int(outcome.get("unit_ids_count") or 0)
    except (TypeError, ValueError):
        unit_ids_count = 0
    try:
        extraction_errors_count = int(outcome.get("extraction_errors_count") or 0)
    except (TypeError, ValueError):
        extraction_errors_count = 0
    normalized_status = raw_status
    if raw_status == "completed" and unit_ids_count == 0:
        normalized_status = "zero_fact"
    elif raw_status not in {
        "pending",
        "processing",
        "completed",
        "failed",
        "cancelled",
        "not_found",
    }:
        normalized_status = "not_found"
    return {
        "operation_id": str(result.get("operation_id") or ""),
        "status": normalized_status,
        "unit_ids_count": unit_ids_count,
        "extraction_errors_count": extraction_errors_count,
        "retry_count": int(result.get("retry_count") or 0),
        "created_at": result.get("created_at"),
        "updated_at": result.get("updated_at"),
        "completed_at": result.get("completed_at"),
    }


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
    try:
        content = _completed_turn_document(
            body.user_content or body.content or "",
            body.assistant_content or "",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    client = client_from_env()
    try:
        await ensure_bank_initialized(client, user_id)
    except Exception:
        logger.warning("Hindsight bank initialization failed", exc_info=True)

    document_id = deterministic_document_id(
        user_id=user_id,
        source="turn",
        request_id=request_id,
        content=content,
    )
    result = await _call(
        client.retain(
            user_id=user_id,
            content=content,
            document_id=document_id,
            context="Daedalus completed interactive turn",
            tags=["source:interactive-turn"],
            metadata={
                "source": "interactive-turn",
                "schema": "daedalus.completed-turn.v1",
                "status": "completed",
                "request_id": request_id,
                "conversation_id": body.conversation_id or "",
                "assistant_message_id": body.assistant_message_id or "",
            },
            timestamp=datetime.datetime.now(datetime.UTC).isoformat(),
            asynchronous=True,
        )
    )
    return {
        "status": "accepted",
        "operation_id": result.get("operation_id"),
        "document_id": document_id,
    }


@router.get("/v1/memory/operations/{operation_id}")
async def get_memory_operation(
    operation_id: str,
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _require_hindsight()
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    result = await _call(
        client_from_env().get_operation(
            user_id=user_id,
            operation_id=_validate_resource_id(operation_id, "operation ID"),
        )
    )
    return _normalized_operation(result)


@router.post("/v1/memory/operations/{operation_id}/retry")
async def retry_memory_operation(
    operation_id: str,
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _require_hindsight()
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    clean_operation_id = _validate_resource_id(operation_id, "operation ID")
    await _call(
        client_from_env().retry_operation(
            user_id=user_id,
            operation_id=clean_operation_id,
        )
    )
    return {"operation_id": clean_operation_id, "status": "pending"}


def _flatten_knowledge_pages(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    for node in nodes:
        if node.get("kind") == "page":
            pages.append(
                {
                    key: node.get(key)
                    for key in (
                        "id",
                        "name",
                        "description",
                        "tags",
                        "timestamp",
                        "is_stale",
                    )
                }
            )
        children = node.get("children")
        if isinstance(children, list):
            pages.extend(
                _flatten_knowledge_pages(
                    [child for child in children if isinstance(child, dict)]
                )
            )
    return pages


@router.get("/v1/memory-pages")
async def list_memory_pages(
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _require_hindsight()
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    client = client_from_env()
    try:
        await ensure_bank_initialized(client, user_id)
    except Exception:
        logger.warning("Hindsight bank initialization failed", exc_info=True)
    items = _flatten_knowledge_pages(
        await _call(client.knowledge_tree(user_id=user_id))
    )
    return {"items": items, "total": len(items)}


@router.get("/v1/memory-pages/{page_id}")
async def get_memory_page(
    page_id: str,
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _require_hindsight()
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    result = await _call(
        client_from_env().get_knowledge_page(
            user_id=user_id,
            page_id=_validate_resource_id(page_id, "page ID"),
        )
    )
    return {
        key: result.get(key)
        for key in (
            "id",
            "name",
            "type",
            "description",
            "tags",
            "timestamp",
            "body",
            "markdown",
        )
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
    return await _call(
        client_from_env().update_memory(
            user_id=user_id,
            memory_id=_validate_resource_id(memory_id, "memory ID"),
            text=body.text,
        )
    )


@router.post("/v1/memories/{memory_id}/invalidate")
async def invalidate_memory(
    memory_id: str,
    body: InvalidateMemoryRequest,
    x_user_id: Annotated[str | None, Header()] = None,
    x_daedalus_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    _require_hindsight()
    user_id = _authenticated_user(x_user_id, x_daedalus_internal_token)
    return await _call(
        client_from_env().invalidate_memory(
            user_id=user_id,
            memory_id=_validate_resource_id(memory_id, "memory ID"),
            reason=body.reason,
        )
    )


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
    return await _call(
        client_from_env().delete_document(
            user_id=user_id,
            document_id=_validate_resource_id(document_id, "document ID"),
        )
    )


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
    client = client_from_env()
    tree = await _call(client.knowledge_tree(user_id=user_id))
    result = await _call(client.clear_memories(user_id=user_id))
    for root in tree:
        if not isinstance(root, dict) or not str(root.get("id") or "").strip():
            continue
        await _call(
            client.delete_knowledge_node(
                user_id=user_id,
                node_id=str(root["id"]),
            )
        )
    try:
        await clear_user_memory_caches(user_id)
    except Exception as exc:
        logger.error("Cleared Hindsight but could not clear session memory cache")
        raise HTTPException(
            status_code=503,
            detail="durable memory was cleared but session cache cleanup must be retried",
        ) from exc
    await ensure_bank_initialized(client, user_id)
    return {"status": "cleared", "result": result}
