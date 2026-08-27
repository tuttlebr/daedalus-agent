"""Reversible, low-latency compaction for large structured tool results.

The model does not need repeated JSON keys or every routine row to decide its
next step.  This module keeps a representative, query-aware preview in the
prompt and stores the exact original in user-isolated Redis for bounded
retrieval.  Content that is small, unstructured, unsafe to parse, or cannot be
cached passes through unchanged.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import math
import re
import time
import zlib
from dataclasses import dataclass
from typing import Any

from nat_helpers.redis_url import close_redis_client, redis_url_from_env

logger = logging.getLogger(__name__)

COMPACTION_MARKER = "_daedalus_compacted_tool_output"
REFERENCE_PREFIX = "tor_"
REFERENCE_PATTERN = re.compile(r"^tor_[0-9a-f]{32}$")

_CACHE_VERSION = b"z1"
_ERROR_SIGNAL = re.compile(
    r"\b(?:critical|denied|error|exception|failed|failure|fatal|invalid|"
    r"missing|not[ -]?ready|timeout|unavailable|unhealthy|warning)\b",
    re.IGNORECASE,
)
_COMPLETE_OUTPUT_INTENT = re.compile(
    r"\b(?:all|complete|count|each|entire|every|exact|exhaustive|full|raw|"
    r"verbatim)\b|\bhow many\b|\bare there (?:any|no)\b|\blist (?:all|every)\b",
    re.IGNORECASE,
)
_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{2,}")
_STOP_WORDS = {
    "about",
    "after",
    "also",
    "and",
    "are",
    "can",
    "could",
    "does",
    "for",
    "from",
    "have",
    "into",
    "latest",
    "list",
    "more",
    "please",
    "show",
    "that",
    "the",
    "their",
    "this",
    "tool",
    "what",
    "when",
    "where",
    "which",
    "with",
    "would",
}
_TAGGED_JSON = re.compile(
    r"^(\s*<([A-Za-z][A-Za-z0-9_:-]*)>\s*)(.*)(\s*</\2>\s*)$",
    re.DOTALL,
)
_FENCED_JSON = re.compile(
    r"^(\s*```(?:json)?\s*)(.*?)(\s*```\s*)$",
    re.IGNORECASE | re.DOTALL,
)


class _UnsafeJSON(ValueError):
    """Raised when normalizing JSON could change its meaning."""


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise _UnsafeJSON(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def _reject_non_finite(value: str) -> None:
    raise _UnsafeJSON(f"non-finite JSON number: {value}")


def _json_loads(value: str) -> Any:
    return json.loads(
        value,
        object_pairs_hook=_reject_duplicate_keys,
        parse_constant=_reject_non_finite,
    )


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class CompactionSettings:
    """Prompt-budget policy for structured tool results."""

    enabled: bool = True
    min_chars: int = 8_000
    max_items: int = 16
    min_savings_chars: int = 1_500
    max_compacted_ratio: float = 0.70
    max_original_chars: int = 4_000_000
    cache_ttl_seconds: int = 7_200


@dataclass(frozen=True)
class OptimizedToolContent:
    """One tool result after a lossless or reversible optimization decision."""

    content: str
    mode: str
    original_chars: int
    optimized_chars: int
    reference: str | None = None


@dataclass(frozen=True)
class _ParsedJSON:
    value: Any
    prefix: str = ""
    suffix: str = ""

    def render(self, value: Any) -> str:
        return f"{self.prefix}{_json_dumps(value)}{self.suffix}"


def _parse_structured_json(content: str) -> _ParsedJSON | None:
    """Parse plain JSON plus the two wrappers emitted by repository tools."""

    stripped = content.strip()
    candidates: list[tuple[str, str, str]] = [("", stripped, "")]
    tagged = _TAGGED_JSON.fullmatch(content)
    if tagged:
        candidates.append((tagged.group(1), tagged.group(3), tagged.group(4)))
    fenced = _FENCED_JSON.fullmatch(content)
    if fenced:
        candidates.append((fenced.group(1), fenced.group(2), fenced.group(3)))

    for prefix, candidate, suffix in candidates:
        try:
            value = _json_loads(candidate.strip())
        except (json.JSONDecodeError, _UnsafeJSON, TypeError, ValueError):
            continue
        return _ParsedJSON(value=value, prefix=prefix, suffix=suffix)
    return None


def tool_output_reference(content: str) -> str:
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()[:32]
    return f"{REFERENCE_PREFIX}{digest}"


def _user_cache_key(user_id: str, reference: str) -> str:
    user_hash = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:24]
    return f"daedalus:tool-output:v1:{user_hash}:{reference}"


class ToolOutputStore:
    """Short-lived Redis storage for exact, user-isolated tool output."""

    def __init__(
        self,
        *,
        redis_url: str | None = None,
        ttl_seconds: int = 7_200,
        retry_after_seconds: float = 30.0,
    ) -> None:
        self._redis_url = (
            redis_url.strip() if redis_url is not None else redis_url_from_env()
        )
        self._ttl_seconds = max(1, int(ttl_seconds))
        self._retry_after_seconds = max(1.0, float(retry_after_seconds))
        self._client = None
        self._disabled_until = 0.0

    def _get_client(self):
        if self._client is None:
            from redis.asyncio import Redis

            self._client = Redis.from_url(
                self._redis_url,
                decode_responses=False,
                socket_timeout=2.0,
                socket_connect_timeout=1.0,
            )
        return self._client

    async def put(self, user_id: str, content: str, reference: str) -> bool:
        if not user_id or not REFERENCE_PATTERN.fullmatch(reference):
            return False
        if time.monotonic() < self._disabled_until:
            return False
        payload = _CACHE_VERSION + zlib.compress(content.encode("utf-8"), level=3)
        try:
            await self._get_client().set(
                _user_cache_key(user_id, reference),
                payload,
                ex=self._ttl_seconds,
            )
        except Exception as exc:
            self._disabled_until = time.monotonic() + self._retry_after_seconds
            logger.warning(
                "Tool-output cache unavailable; preserving original result: "
                "error_class=%s",
                type(exc).__name__,
            )
            return False
        return True

    async def get(self, user_id: str, reference: str) -> str | None:
        if not user_id or not REFERENCE_PATTERN.fullmatch(reference):
            return None
        if time.monotonic() < self._disabled_until:
            return None
        try:
            payload = await self._get_client().get(_user_cache_key(user_id, reference))
            if not payload:
                return None
            if isinstance(payload, str):
                payload = payload.encode("utf-8")
            if not payload.startswith(_CACHE_VERSION):
                return None
            content = zlib.decompress(payload[len(_CACHE_VERSION) :]).decode("utf-8")
            if tool_output_reference(content) != reference:
                logger.warning("Tool-output cache integrity check failed")
                return None
            return content
        except Exception as exc:
            self._disabled_until = time.monotonic() + self._retry_after_seconds
            logger.warning(
                "Tool-output retrieval cache unavailable: error_class=%s",
                type(exc).__name__,
            )
            return None

    async def close(self) -> None:
        if self._client is not None:
            await close_redis_client(self._client)
            self._client = None


def _estimate_tokens(content: str) -> int:
    """Return a cheap provider-neutral estimate for telemetry and thresholds."""

    return max(1, math.ceil(len(content) / 4))


def _query_terms(query: str) -> set[str]:
    return {
        word.casefold()
        for word in _WORD.findall(query)
        if word.casefold() not in _STOP_WORDS
    }


def _item_text(item: Any) -> str:
    try:
        return _json_dumps(item)
    except (TypeError, ValueError):
        return str(item)


def _select_indices(items: list[Any], *, max_items: int, query: str) -> list[int]:
    """Keep boundaries, failures, query-relevant rows, then an even sample."""

    count = len(items)
    budget = min(max(1, max_items), count)
    selected: set[int] = set(range(min(3, count)))
    selected.update(range(max(0, count - 2), count))

    rendered = [_item_text(item) for item in items]
    signal_indices = [
        index for index, text in enumerate(rendered) if _ERROR_SIGNAL.search(text)
    ]
    remaining_budget = max(0, budget - len(selected))
    signal_quota = max(1, remaining_budget // 2) if remaining_budget else 0
    for index in signal_indices[:signal_quota]:
        if len(selected) >= budget:
            break
        selected.add(index)

    terms = _query_terms(query)
    if terms and len(selected) < budget:
        scored: list[tuple[int, int]] = []
        for index, text in enumerate(rendered):
            lowered = text.casefold()
            score = sum(lowered.count(term) for term in terms)
            if score:
                scored.append((-score, index))
        query_quota = max(1, budget - len(selected))
        for _negative_score, index in sorted(scored)[:query_quota]:
            if len(selected) >= budget:
                break
            selected.add(index)

    if len(selected) < budget:
        for index in signal_indices[signal_quota:]:
            if len(selected) >= budget:
                break
            selected.add(index)

    if len(selected) < budget:
        remaining = budget - len(selected)
        step = count / (remaining + 1)
        for ordinal in range(1, remaining + 1):
            selected.add(min(count - 1, int(round(ordinal * step))))

    if len(selected) < budget:
        for index in range(count):
            if len(selected) >= budget:
                break
            selected.add(index)
    return sorted(selected)[:budget]


def _array_target(value: Any) -> tuple[str, list[Any]] | None:
    if isinstance(value, list):
        return "$", value
    if not isinstance(value, dict):
        return None

    candidates = [
        (key, item) for key, item in value.items() if isinstance(item, list) and item
    ]
    if not candidates:
        return None
    key, items = max(candidates, key=lambda candidate: len(_json_dumps(candidate[1])))
    return f"$.{key}", items


def _preview_value(
    parsed_value: Any,
    *,
    array_path: str,
    items: list[Any],
    selected_indices: list[int],
) -> Any:
    selected_items = [
        {"index": index, "value": items[index]} for index in selected_indices
    ]
    array_preview = {
        "total_items": len(items),
        "shown_items": len(selected_items),
        "omitted_items": len(items) - len(selected_items),
        "selection": "first,last,errors,query_relevance,even_sample",
        "items": selected_items,
    }
    if array_path == "$":
        return array_preview
    preview = dict(parsed_value)
    preview[array_path[2:]] = array_preview
    return preview


def _reversible_preview(
    content: str,
    parsed: _ParsedJSON,
    *,
    query: str,
    settings: CompactionSettings,
) -> tuple[str, str] | None:
    target = _array_target(parsed.value)
    if target is None:
        return None
    array_path, items = target
    if len(items) <= settings.max_items:
        return None

    selected_indices = _select_indices(
        items,
        max_items=settings.max_items,
        query=query,
    )
    reference = tool_output_reference(content)
    preview = _preview_value(
        parsed.value,
        array_path=array_path,
        items=items,
        selected_indices=selected_indices,
    )
    envelope = {
        COMPACTION_MARKER: {
            "reference": reference,
            "array_path": array_path,
            "original_chars": len(content),
            "estimated_original_tokens": _estimate_tokens(content),
            "total_items": len(items),
            "shown_items": len(selected_indices),
            "omitted_items": len(items) - len(selected_indices),
            "retrieval": (
                "Use tool_output_retriever_tool with this reference when omitted "
                "rows could affect the answer. Search by query first; page exact "
                "content when completeness matters."
            ),
        },
        "preview": preview,
    }
    optimized = parsed.render(envelope)
    savings = len(content) - len(optimized)
    if savings < settings.min_savings_chars:
        return None
    if len(optimized) / max(1, len(content)) > settings.max_compacted_ratio:
        return None
    return optimized, reference


async def optimize_tool_content(
    content: str,
    *,
    tool_name: str,
    query: str,
    user_id: str,
    store: ToolOutputStore,
    settings: CompactionSettings,
) -> OptimizedToolContent:
    """Optimize one result, failing open whenever exact recovery is unavailable."""

    original_chars = len(content)
    unchanged = OptimizedToolContent(
        content=content,
        mode="unchanged",
        original_chars=original_chars,
        optimized_chars=original_chars,
    )
    if (
        not settings.enabled
        or not isinstance(content, str)
        or not content
        or COMPACTION_MARKER in content
        or original_chars > settings.max_original_chars
    ):
        return unchanged

    parsed = _parse_structured_json(content)
    if parsed is None:
        return unchanged
    minified = parsed.render(parsed.value)
    lossless = unchanged
    if len(content) - len(minified) >= 256:
        lossless = OptimizedToolContent(
            content=minified,
            mode="lossless_json",
            original_chars=original_chars,
            optimized_chars=len(minified),
        )

    if original_chars < settings.min_chars:
        return lossless
    if _COMPLETE_OUTPUT_INTENT.search(query):
        # Exact counts, exhaustive lists, and absence claims should not depend
        # on the model noticing a retrieval marker. Preserve the whole result.
        return lossless
    reversible = _reversible_preview(
        content,
        parsed,
        query=query,
        settings=settings,
    )
    if reversible is None:
        return lossless
    optimized, reference = reversible
    if not await store.put(user_id, content, reference):
        return lossless

    logger.info(
        "Tool output compacted: tool=%s original_chars=%d compacted_chars=%d "
        "estimated_tokens_saved=%d",
        tool_name or "unknown",
        original_chars,
        len(optimized),
        max(0, _estimate_tokens(content) - _estimate_tokens(optimized)),
    )
    return OptimizedToolContent(
        content=optimized,
        mode="reversible_preview",
        original_chars=original_chars,
        optimized_chars=len(optimized),
        reference=reference,
    )


def latest_user_query(messages: list[Any]) -> str:
    for message in reversed(messages):
        if getattr(message, "type", "") not in {"human", "user"}:
            continue
        content = getattr(message, "content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict) and block.get("type") in {
                    "text",
                    "input_text",
                }:
                    text = block.get("text")
                    if isinstance(text, str):
                        parts.append(text)
            return "".join(parts)
    return ""


def _copy_message_with_content(message: Any, content: str) -> Any:
    model_copy = getattr(message, "model_copy", None)
    if callable(model_copy):
        return model_copy(update={"content": content})
    copied = copy.copy(message)
    copied.content = content
    return copied


async def optimize_tool_messages(
    messages: list[Any],
    *,
    user_id: str,
    store: ToolOutputStore,
    settings: CompactionSettings,
    exempt_tools: frozenset[str] = frozenset({"tool_output_retriever_tool"}),
) -> list[Any]:
    """Return model-facing copies with eligible ToolMessage content optimized."""

    query = latest_user_query(messages)
    task_by_index: dict[int, asyncio.Task[OptimizedToolContent]] = {}
    for index, message in enumerate(messages):
        if getattr(message, "type", "") != "tool":
            continue
        tool_name = str(getattr(message, "name", "") or "")
        if tool_name in exempt_tools:
            continue
        content = getattr(message, "content", None)
        if not isinstance(content, str):
            continue
        task_by_index[index] = asyncio.create_task(
            optimize_tool_content(
                content,
                tool_name=tool_name,
                query=query,
                user_id=user_id,
                store=store,
                settings=settings,
            )
        )

    if not task_by_index:
        return messages
    optimized_messages = list(messages)
    results = await asyncio.gather(
        *task_by_index.values(),
        return_exceptions=True,
    )
    for index, result in zip(task_by_index, results, strict=True):
        if isinstance(result, BaseException):
            if isinstance(result, asyncio.CancelledError):
                raise result
            logger.warning(
                "Tool-output optimization failed open: error_class=%s",
                type(result).__name__,
            )
            continue
        if result.content != getattr(messages[index], "content", None):
            optimized_messages[index] = _copy_message_with_content(
                messages[index], result.content
            )
    return optimized_messages
