"""FastAPI router for deterministic profile-memory imports.

The chat memory tools intentionally derive user identity from the authenticated
request context. This route provides the same server-authoritative identity
property for bulk profile uploads while bypassing the agent loop entirely.
"""

from __future__ import annotations

import hashlib
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Header, HTTPException, Response
from nat_helpers.internal_auth import require_trusted_user as _require_trusted_user
from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/profile", tags=["profile"])

MAX_PROFILE_IMPORT_ENTRIES = int(os.getenv("PROFILE_IMPORT_MAX_ENTRIES", "250"))


class ProfileEntry(BaseModel):
    """Single profile memory supplied by a trusted frontend upload."""

    model_config = ConfigDict(extra="ignore")

    label: str = Field(..., min_length=1, max_length=200)
    memory: str = Field(..., min_length=1, max_length=4000)
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    key_value_pairs: dict[str, Any] | None = None

    @field_validator("label", "memory")
    @classmethod
    def _strip_required_strings(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("value must not be blank")
        return stripped

    @field_validator("tags")
    @classmethod
    def _normalize_tags(cls, value: list[str]) -> list[str]:
        seen: set[str] = set()
        tags: list[str] = []
        for raw_tag in value:
            tag = str(raw_tag).strip()
            if not tag or tag in seen:
                continue
            tags.append(tag)
            seen.add(tag)
        return tags


class ProfileImportRequest(BaseModel):
    """Bulk profile import payload.

    Replace mode removes only trusted profile-seed memories for the
    authenticated user before adding the supplied entries. It does not wipe
    normal conversational memories.
    """

    model_config = ConfigDict(extra="ignore")

    profile_version: str | None = None
    mode: Literal["append", "replace"] = "append"
    entries: list[ProfileEntry] = Field(..., min_length=1)

    @field_validator("entries")
    @classmethod
    def _limit_entries(cls, value: list[ProfileEntry]) -> list[ProfileEntry]:
        if len(value) > MAX_PROFILE_IMPORT_ENTRIES:
            raise ValueError(
                f"Too many profile entries: {len(value)} > {MAX_PROFILE_IMPORT_ENTRIES}"
            )
        labels = [entry.label for entry in value]
        if len(labels) != len(set(labels)):
            raise ValueError("Profile entry labels must be unique")
        return value


class ProfileImportResponse(BaseModel):
    status: Literal["success", "accepted"]
    user_id: str
    imported: int
    replaced: int = 0
    queued: int = 0
    operation_id: str | None = None
    profile_version: str | None = None


@dataclass(frozen=True)
class ProfileImportResult:
    imported: int
    replaced: int = 0
    queued: int = 0
    operation_id: str | None = None


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _merge_metadata(
    entry: ProfileEntry,
    profile_version: str | None,
    imported_at: str,
) -> dict[str, Any]:
    metadata = dict(entry.metadata or {})
    metadata.setdefault("source", "profile_import")
    metadata["label"] = entry.label
    metadata["imported_at"] = imported_at
    if profile_version:
        metadata.setdefault("profile_version", profile_version)

    if entry.key_value_pairs:
        existing = metadata.get("key_value_pairs")
        if isinstance(existing, dict):
            metadata["key_value_pairs"] = {**existing, **entry.key_value_pairs}
        else:
            metadata["key_value_pairs"] = dict(entry.key_value_pairs)

    return metadata


def _memory_tags(entry: ProfileEntry) -> list[str]:
    tags = list(entry.tags)
    if "user_profile" not in tags:
        tags.insert(0, "user_profile")
    category = (
        entry.metadata.get("category") if isinstance(entry.metadata, dict) else None
    )
    if isinstance(category, str) and category and category not in tags:
        tags.append(category)
    return tags


async def import_profile_memories(
    req: ProfileImportRequest,
    user_id: str,
) -> ProfileImportResult:
    from nat_helpers.hindsight_client import (
        client_from_env,
        deterministic_document_id,
        memory_mode,
    )

    mode = memory_mode()
    if mode == "disabled":
        raise RuntimeError("Durable memory is disabled by the operator")

    client = client_from_env()
    replaced = 0
    if req.mode == "replace":
        replaced = await client.delete_documents_with_tag(
            user_id=user_id,
            tag="source:profile-import",
        )

    imported_at = _now_iso()
    hindsight_items: list[dict[str, Any]] = []
    for entry in req.entries:
        label_hash = hashlib.sha256(entry.label.encode("utf-8")).hexdigest()
        document_id = deterministic_document_id(
            user_id=user_id,
            source="profile",
            request_id=label_hash,
            content=label_hash,
        )
        hindsight_items.append(
            {
                "content": entry.memory,
                "document_id": document_id,
                "context": "Daedalus authenticated profile import",
                "tags": ["source:profile-import", *_memory_tags(entry)],
                "metadata": _merge_metadata(
                    entry,
                    req.profile_version,
                    imported_at,
                ),
                "timestamp": "unset",
            }
        )

    # Each request gets a fresh durable operation. This is required for replace
    # mode: replaying a completed operation after deleting its old documents
    # would acknowledge the replay without restoring them.
    requested_operation_id = str(uuid.uuid4())
    accepted = await client.retain_batch(
        user_id=user_id,
        items=hindsight_items,
        operation_id=requested_operation_id,
    )
    operation_id = str(accepted.get("operation_id") or "").strip()
    if not operation_id:
        raise RuntimeError("Hindsight did not accept the profile import operation")

    return ProfileImportResult(
        imported=len(req.entries),
        replaced=replaced,
        queued=len(req.entries),
        operation_id=operation_id,
    )


def build_profile_import_response(
    *,
    req: ProfileImportRequest,
    user_id: str,
    result: ProfileImportResult,
    response: Response,
) -> ProfileImportResponse:
    status: Literal["success", "accepted"] = (
        "accepted" if result.operation_id else "success"
    )
    response.status_code = 202 if status == "accepted" else 200
    logger.info(
        "Profile import %s for authenticated user %s; submitted %s, queued %s, replaced %s",
        status,
        user_id,
        result.imported,
        result.queued,
        result.replaced,
    )
    return ProfileImportResponse(
        status=status,
        user_id=user_id,
        imported=result.imported,
        replaced=result.replaced,
        queued=result.queued,
        operation_id=result.operation_id,
        profile_version=req.profile_version,
    )


@router.post("/import", response_model=ProfileImportResponse, status_code=202)
async def import_profile(
    req: ProfileImportRequest,
    response: Response,
    x_user_id: Annotated[str | None, Header(alias="x-user-id")] = None,
    x_daedalus_internal_token: Annotated[
        str | None, Header(alias="x-daedalus-internal-token")
    ] = None,
) -> ProfileImportResponse:
    user_id = _require_trusted_user(x_user_id, x_daedalus_internal_token)

    try:
        result = await import_profile_memories(req, user_id)
    except Exception as exc:
        logger.exception("profile.import failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return build_profile_import_response(
        req=req,
        user_id=user_id,
        result=result,
        response=response,
    )
