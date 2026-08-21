"""Identity-bound Hindsight client used by Daedalus memory surfaces.

The model and browser never receive or choose a Hindsight bank ID. Every call
derives the bank from the trusted authenticated user and applies the shared
service credential inside the backend process.
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from typing import Any, Literal
from urllib.parse import quote

import httpx

MemoryMode = Literal["disabled", "hindsight"]

_BANK_NAMESPACE = uuid.UUID("21b4c9b7-39a3-4c5e-8e31-66e2223e5040")
_VALID_MODES: set[str] = {"disabled", "hindsight"}
_MAX_RETAIN_CHARS = 12_000


class HindsightError(RuntimeError):
    """Credential-safe Hindsight client error."""


def memory_mode() -> MemoryMode:
    """Return the configured Hindsight availability mode."""

    mode = (os.getenv("DAEDALUS_MEMORY_MODE") or "hindsight").strip().lower()
    if mode not in _VALID_MODES:
        raise ValueError("DAEDALUS_MEMORY_MODE must be disabled or hindsight")
    return mode  # type: ignore[return-value]


def hindsight_enabled() -> bool:
    return memory_mode() == "hindsight"


def derive_bank_id(user_id: str) -> str:
    """Derive a stable opaque bank ID from a trusted authenticated user ID."""

    normalized = (user_id or "").strip()
    if not normalized:
        raise ValueError("authenticated user identity is required")
    return f"du-{uuid.uuid5(_BANK_NAMESPACE, normalized)}"


def deterministic_document_id(
    *,
    user_id: str,
    source: str,
    request_id: str,
    content: str,
) -> str:
    """Build an idempotent, non-identifying Hindsight document ID."""

    digest = hashlib.sha256()
    for value in (derive_bank_id(user_id), source, request_id, content):
        digest.update(value.encode("utf-8"))
        digest.update(b"\0")
    return f"daedalus-{source}-{digest.hexdigest()}"


def deterministic_operation_id(document_id: str) -> str:
    return str(uuid.uuid5(_BANK_NAMESPACE, document_id))


def _metadata_strings(metadata: dict[str, Any] | None) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for key, value in (metadata or {}).items():
        key_text = str(key).strip()
        if not key_text:
            continue
        if isinstance(value, str):
            normalized[key_text] = value
        else:
            normalized[key_text] = json.dumps(
                value,
                sort_keys=True,
                separators=(",", ":"),
                default=str,
            )
    return normalized


def _without_bank_fields(value: Any) -> Any:
    """Remove storage-routing details before returning data to Daedalus callers."""

    if isinstance(value, list):
        return [_without_bank_fields(item) for item in value]
    if isinstance(value, dict):
        return {
            key: _without_bank_fields(item)
            for key, item in value.items()
            if key not in {"bank_id", "tenant_id"}
        }
    return value


class HindsightClient:
    """Small async REST client for the pinned Hindsight contract."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout_seconds: float | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = (
            (
                base_url
                or os.getenv("HINDSIGHT_API_URL")
                or "http://hindsight-api.daedalus-hindsight.svc.cluster.local:8888"
            )
            .strip()
            .rstrip("/")
        )
        self._api_key = (api_key or os.getenv("HINDSIGHT_API_KEY") or "").strip()
        self._timeout = timeout_seconds or float(
            os.getenv("HINDSIGHT_API_TIMEOUT_SECONDS") or "20"
        )
        self._transport = transport
        if not self._base_url.startswith(("http://", "https://")):
            raise ValueError("HINDSIGHT_API_URL must use http:// or https://")
        if not self._api_key:
            raise ValueError("HINDSIGHT_API_KEY is required")

    def _bank_path(self, user_id: str, suffix: str) -> str:
        bank_id = quote(derive_bank_id(user_id), safe="")
        return f"/v1/default/banks/{bank_id}/{suffix.lstrip('/')}"

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
        }
        if json_body is not None:
            headers["Content-Type"] = "application/json"
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                headers=headers,
                timeout=httpx.Timeout(timeout_seconds or self._timeout),
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                response = await client.request(
                    method,
                    path,
                    json=json_body,
                    params=params,
                )
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise HindsightError("Hindsight is unavailable") from exc
        if response.status_code >= 400:
            raise HindsightError(
                f"Hindsight request failed with status {response.status_code}"
            )
        if response.status_code == 204 or not response.content:
            return {}
        try:
            parsed = response.json()
        except ValueError as exc:
            raise HindsightError("Hindsight returned an invalid response") from exc
        if not isinstance(parsed, dict):
            raise HindsightError("Hindsight returned an invalid response")
        return _without_bank_fields(parsed)

    async def health(self) -> dict[str, Any]:
        return await self._request("GET", "/health", timeout_seconds=3.0)

    async def retain(
        self,
        *,
        user_id: str,
        content: str,
        document_id: str,
        context: str,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        timestamp: str | None = None,
        asynchronous: bool,
    ) -> dict[str, Any]:
        clean_content = (content or "").strip()
        if not clean_content:
            raise ValueError("memory content is required")
        if len(clean_content) > _MAX_RETAIN_CHARS:
            raise ValueError(f"memory content exceeds {_MAX_RETAIN_CHARS} characters")
        item: dict[str, Any] = {
            "content": clean_content,
            "document_id": document_id,
            "context": context,
            "metadata": _metadata_strings(metadata),
            "tags": list(dict.fromkeys(tags or [])),
            "observation_scopes": "shared",
            "update_mode": "replace",
        }
        if timestamp:
            item["timestamp"] = timestamp
        body: dict[str, Any] = {"items": [item], "async": asynchronous}
        if asynchronous:
            body["operation_id"] = deterministic_operation_id(document_id)
        return await self._submit_retain(
            user_id=user_id,
            body=body,
            asynchronous=asynchronous,
        )

    async def retain_batch(
        self,
        *,
        user_id: str,
        items: list[dict[str, Any]],
        operation_id: str,
    ) -> dict[str, Any]:
        """Durably enqueue one idempotent batch for background extraction."""

        if not items:
            raise ValueError("at least one memory item is required")
        normalized_items: list[dict[str, Any]] = []
        document_ids: set[str] = set()
        for raw_item in items:
            content = str(raw_item.get("content") or "").strip()
            if not content:
                raise ValueError("memory content is required")
            if len(content) > _MAX_RETAIN_CHARS:
                raise ValueError(
                    f"memory content exceeds {_MAX_RETAIN_CHARS} characters"
                )
            document_id = str(raw_item.get("document_id") or "").strip()
            if not document_id:
                raise ValueError("document ID is required")
            if document_id in document_ids:
                raise ValueError("batch memory document IDs must be unique")
            document_ids.add(document_id)

            item: dict[str, Any] = {
                "content": content,
                "document_id": document_id,
                "context": str(raw_item.get("context") or ""),
                "metadata": _metadata_strings(raw_item.get("metadata")),
                "tags": list(dict.fromkeys(raw_item.get("tags") or [])),
                "observation_scopes": "shared",
                "update_mode": "replace",
            }
            timestamp = raw_item.get("timestamp")
            if timestamp:
                item["timestamp"] = str(timestamp)
            normalized_items.append(item)

        return await self._submit_retain(
            user_id=user_id,
            body={
                "items": normalized_items,
                "async": True,
                "operation_id": operation_id,
            },
            asynchronous=True,
        )

    async def _submit_retain(
        self,
        *,
        user_id: str,
        body: dict[str, Any],
        asynchronous: bool,
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            self._bank_path(user_id, "memories"),
            json_body=body,
            timeout_seconds=15.0 if asynchronous else 120.0,
        )

    async def retain_explicit(
        self,
        *,
        user_id: str,
        content: str,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        request_id: str = "explicit",
    ) -> dict[str, Any]:
        document_id = deterministic_document_id(
            user_id=user_id,
            source="explicit",
            request_id=request_id,
            content=content,
        )
        return await self.retain(
            user_id=user_id,
            content=content,
            document_id=document_id,
            context="Daedalus verified explicit memory",
            tags=["source:explicit", *(tags or [])],
            metadata={"source": "explicit", **(metadata or {})},
            asynchronous=False,
        )

    async def recall(
        self,
        *,
        user_id: str,
        query: str,
        budget: Literal["low", "mid", "high"] = "low",
        max_tokens: int = 800,
    ) -> list[dict[str, Any]]:
        clean_query = (query or "").strip()
        if not clean_query:
            return []
        response = await self._request(
            "POST",
            self._bank_path(user_id, "memories/recall"),
            json_body={
                "query": clean_query,
                "budget": budget,
                "max_tokens": max(128, min(max_tokens, 4096)),
                "types": ["world", "experience", "observation"],
                "prefer_observations": True,
                "include": {"entities": None, "chunks": None, "source_facts": None},
                "trace": False,
            },
            timeout_seconds=12.0,
        )
        results = response.get("results", [])
        return [item for item in results if isinstance(item, dict)]

    async def list_memories(
        self,
        *,
        user_id: str,
        query: str = "",
        memory_type: str = "",
        limit: int = 25,
        offset: int = 0,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "limit": max(1, min(limit, 100)),
            "offset": max(0, offset),
        }
        if query.strip():
            params["q"] = query.strip()
        if memory_type in {"world", "experience", "observation"}:
            params["type"] = memory_type
        return await self._request(
            "GET",
            self._bank_path(user_id, "memories/list"),
            params=params,
        )

    async def update_memory(
        self,
        *,
        user_id: str,
        memory_id: str,
        text: str,
    ) -> dict[str, Any]:
        clean_text = text.strip()
        if not clean_text:
            raise ValueError("memory text is required")
        return await self._request(
            "PATCH",
            self._bank_path(user_id, f"memories/{quote(memory_id, safe='')}"),
            json_body={"text": clean_text},
        )

    async def invalidate_memory(
        self,
        *,
        user_id: str,
        memory_id: str,
        reason: str,
    ) -> dict[str, Any]:
        return await self._request(
            "PATCH",
            self._bank_path(user_id, f"memories/{quote(memory_id, safe='')}"),
            json_body={
                "state": "invalidated",
                "reason": (reason or "user requested forget").strip()[:500],
            },
        )

    async def list_documents(
        self,
        *,
        user_id: str,
        query: str = "",
        limit: int = 25,
        offset: int = 0,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "limit": max(1, min(limit, 100)),
            "offset": max(0, offset),
        }
        if query.strip():
            params["q"] = query.strip()
        if tags:
            params["tags"] = tags
            params["tags_match"] = "all_strict"
        return await self._request(
            "GET",
            self._bank_path(user_id, "documents"),
            params=params,
        )

    async def delete_documents_with_tag(self, *, user_id: str, tag: str) -> int:
        deleted = 0
        while True:
            page = await self.list_documents(
                user_id=user_id,
                limit=100,
                offset=0,
                tags=[tag],
            )
            items = page.get("items", [])
            document_ids = [
                str(item.get("id", ""))
                for item in items
                if isinstance(item, dict) and str(item.get("id", "")).strip()
            ]
            if not document_ids:
                return deleted
            for document_id in document_ids:
                await self.delete_document(user_id=user_id, document_id=document_id)
                deleted += 1

    async def get_document(
        self,
        *,
        user_id: str,
        document_id: str,
    ) -> dict[str, Any]:
        return await self._request(
            "GET",
            self._bank_path(user_id, f"documents/{quote(document_id, safe='')}"),
        )

    async def delete_document(
        self,
        *,
        user_id: str,
        document_id: str,
    ) -> dict[str, Any]:
        return await self._request(
            "DELETE",
            self._bank_path(user_id, f"documents/{quote(document_id, safe='')}"),
        )

    async def clear_memories(self, *, user_id: str) -> dict[str, Any]:
        return await self._request(
            "DELETE",
            self._bank_path(user_id, "memories"),
            timeout_seconds=60.0,
        )


def client_from_env() -> HindsightClient:
    return HindsightClient()
