"""Shared request and response contract for vLLM reranking endpoints."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class VLLMRerankResult:
    index: int
    relevance_score: float


def build_vllm_rerank_payload(
    *,
    model: str,
    query: str,
    documents: list[str],
    top_n: int | None = None,
) -> dict[str, Any]:
    """Build the Cohere-compatible rerank request accepted by vLLM."""
    payload: dict[str, Any] = {
        "model": model,
        "query": query,
        "documents": documents,
    }
    if top_n is not None:
        if top_n < 1:
            raise ValueError("top_n must be positive when set")
        payload["top_n"] = top_n
    return payload


def parse_vllm_rerank_response(
    payload: Any,
    *,
    document_count: int,
) -> list[VLLMRerankResult]:
    """Validate and normalize `results[].relevance_score` from vLLM."""
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise ValueError("vLLM reranker response is missing results")

    parsed: list[VLLMRerankResult] = []
    seen_indexes: set[int] = set()
    for item in payload["results"]:
        if not isinstance(item, dict):
            raise ValueError("vLLM reranker result must be an object")
        index = item.get("index")
        score = item.get("relevance_score")
        if isinstance(index, bool) or not isinstance(index, int):
            raise ValueError("vLLM reranker result has an invalid index")
        if not 0 <= index < document_count:
            raise ValueError("vLLM reranker result index is out of range")
        if index in seen_indexes:
            raise ValueError("vLLM reranker returned a duplicate index")
        if isinstance(score, bool) or not isinstance(score, (int, float)):
            raise ValueError("vLLM reranker result has an invalid relevance score")
        seen_indexes.add(index)
        parsed.append(VLLMRerankResult(index=index, relevance_score=float(score)))

    parsed.sort(key=lambda item: item.relevance_score, reverse=True)
    return parsed
