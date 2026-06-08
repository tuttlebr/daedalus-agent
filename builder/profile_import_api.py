"""FastAPI router for deterministic profile-memory imports.

The chat memory tools intentionally derive user identity from the authenticated
request context. This route provides the same server-authoritative identity
property for bulk profile uploads while bypassing the agent loop entirely.
"""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime
from functools import lru_cache
from typing import Annotated, Any, Literal, Protocol

from fastapi import APIRouter, Header, HTTPException
from nat_helpers.internal_auth import require_trusted_user as _require_trusted_user
from nat_helpers.redis_url import redis_url_from_env
from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/profile", tags=["profile"])

MAX_PROFILE_IMPORT_ENTRIES = int(os.getenv("PROFILE_IMPORT_MAX_ENTRIES", "250"))
DEFAULT_MEMORY_KEY_PREFIX = os.getenv("MEMORY_KEY_PREFIX", "nat")


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

    Only append mode is currently supported. Replacement should be implemented
    with a scoped delete-by-profile-version path, not a broad user-memory wipe.
    """

    model_config = ConfigDict(extra="ignore")

    profile_version: str | None = None
    mode: Literal["append"] = "append"
    entries: list[ProfileEntry] = Field(..., min_length=1)

    @field_validator("entries")
    @classmethod
    def _limit_entries(cls, value: list[ProfileEntry]) -> list[ProfileEntry]:
        if len(value) > MAX_PROFILE_IMPORT_ENTRIES:
            raise ValueError(
                f"Too many profile entries: {len(value)} > {MAX_PROFILE_IMPORT_ENTRIES}"
            )
        return value


class ProfileImportResponse(BaseModel):
    status: Literal["success"]
    user_id: str
    imported: int
    profile_version: str | None = None


class _MemoryEditor(Protocol):
    async def add_items(self, items: list[Any]) -> None: ...


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _is_configured_value(value: str | None) -> bool:
    if not value:
        return False
    stripped = value.strip()
    if not stripped:
        return False
    return not (stripped.startswith("${") and stripped.endswith("}"))


def _resolve_env_value(value: str | None, *, max_depth: int = 5) -> str:
    """Resolve simple ${OTHER_ENV_VAR} indirection used by Helm env secrets."""
    resolved = (value or "").strip()
    for _ in range(max_depth):
        if not (resolved.startswith("${") and resolved.endswith("}")):
            return resolved
        env_name = resolved[2:-1].strip()
        if not env_name:
            return ""
        next_value = (os.getenv(env_name) or "").strip()
        if not next_value or next_value == resolved:
            return next_value
        resolved = next_value
    return resolved


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


def build_profile_memory_items(
    req: ProfileImportRequest,
    user_id: str,
    memory_item_cls: type[Any],
    *,
    imported_at: str | None = None,
) -> list[Any]:
    imported_at = imported_at or _now_iso()
    items: list[Any] = []
    for entry in req.entries:
        memory_text = entry.memory.strip()
        items.append(
            memory_item_cls(
                conversation=[{"role": "user", "content": memory_text}],
                user_id=user_id,
                memory=memory_text,
                tags=_memory_tags(entry),
                metadata=_merge_metadata(entry, req.profile_version, imported_at),
            )
        )
    return items


class OpenAICompatibleEmbeddings:
    """Minimal LangChain-compatible embeddings adapter for RedisEditor."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        truncate: str | None,
    ) -> None:
        from openai import AsyncOpenAI, OpenAI

        self._model = model
        self._truncate = truncate
        self._sync_client = OpenAI(api_key=api_key, base_url=base_url)
        self._async_client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    def _extra_body(self, input_type: Literal["passage", "query"]) -> dict[str, Any]:
        body: dict[str, Any] = {"input_type": input_type}
        if self._truncate:
            body["truncate"] = self._truncate
        return body

    @staticmethod
    def _extract_embeddings(response: Any) -> list[list[float]]:
        data = getattr(response, "data", None)
        if data is None and isinstance(response, dict):
            data = response.get("data")
        vectors: list[list[float]] = []
        for item in data or []:
            embedding = getattr(item, "embedding", None)
            if embedding is None and isinstance(item, dict):
                embedding = item.get("embedding")
            vectors.append(list(embedding or []))
        return vectors

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        kwargs: dict[str, Any] = {"model": self._model, "input": texts}
        kwargs["extra_body"] = self._extra_body("passage")
        response = self._sync_client.embeddings.create(**kwargs)
        return self._extract_embeddings(response)

    def embed_query(self, text: str) -> list[float]:
        kwargs: dict[str, Any] = {"model": self._model, "input": [text]}
        kwargs["extra_body"] = self._extra_body("query")
        response = self._sync_client.embeddings.create(**kwargs)
        return self._extract_embeddings(response)[0]

    async def aembed_documents(self, texts: list[str]) -> list[list[float]]:
        kwargs: dict[str, Any] = {"model": self._model, "input": texts}
        kwargs["extra_body"] = self._extra_body("passage")
        response = await self._async_client.embeddings.create(**kwargs)
        return self._extract_embeddings(response)

    async def aembed_query(self, text: str) -> list[float]:
        kwargs: dict[str, Any] = {"model": self._model, "input": [text]}
        kwargs["extra_body"] = self._extra_body("query")
        response = await self._async_client.embeddings.create(**kwargs)
        return self._extract_embeddings(response)[0]


@lru_cache(maxsize=1)
def _embedding_adapter() -> OpenAICompatibleEmbeddings:
    api_key = _resolve_env_value(os.getenv("EMBEDDING_API_KEY"))
    base_url = _resolve_env_value(os.getenv("EMBEDDING_BASE_URL"))
    model = _resolve_env_value(os.getenv("EMBEDDING_MODEL"))
    truncate = _resolve_env_value(os.getenv("EMBEDDING_TRUNCATE", "END")) or None

    missing = [
        name
        for name, value in (
            ("EMBEDDING_API_KEY", api_key),
            ("EMBEDDING_BASE_URL", base_url),
            ("EMBEDDING_MODEL", model),
        )
        if not _is_configured_value(value)
    ]
    if missing:
        raise RuntimeError(
            "Profile memory import requires embedding configuration: "
            + ", ".join(missing)
        )

    return OpenAICompatibleEmbeddings(
        api_key=api_key,
        base_url=base_url,
        model=model,
        truncate=truncate,
    )


@lru_cache(maxsize=1)
def _redis_editor() -> _MemoryEditor:
    from nat.plugins.redis.redis_editor import RedisEditor
    from redis import asyncio as redis_async

    redis_client = redis_async.from_url(redis_url_from_env(), decode_responses=True)
    return RedisEditor(
        redis_client=redis_client,
        key_prefix=DEFAULT_MEMORY_KEY_PREFIX,
        embedder=_embedding_adapter(),
    )


async def import_profile_memories(
    req: ProfileImportRequest,
    user_id: str,
    editor: _MemoryEditor | None = None,
) -> int:
    from nat.memory.models import MemoryItem

    memory_editor = editor or _redis_editor()
    items = build_profile_memory_items(req, user_id, MemoryItem)
    await memory_editor.add_items(items)
    return len(items)


@router.post("/import", response_model=ProfileImportResponse)
async def import_profile(
    req: ProfileImportRequest,
    x_user_id: Annotated[str | None, Header(alias="x-user-id")] = None,
    x_daedalus_internal_token: Annotated[
        str | None, Header(alias="x-daedalus-internal-token")
    ] = None,
) -> ProfileImportResponse:
    user_id = _require_trusted_user(x_user_id, x_daedalus_internal_token)

    try:
        imported = await import_profile_memories(req, user_id)
    except Exception as exc:
        logger.exception("profile.import failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    logger.info(
        "Imported %s profile memories for authenticated user %s",
        imported,
        user_id,
    )
    return ProfileImportResponse(
        status="success",
        user_id=user_id,
        imported=imported,
        profile_version=req.profile_version,
    )
