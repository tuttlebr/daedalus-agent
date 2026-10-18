"""Contract tests for the vLLM embedding and reranking adapters."""

import asyncio
import json

import httpx
import pytest
from nat_helpers.vllm_embeddings import DaedalusVLLMEmbeddings, _embeddings_endpoint
from nat_helpers.vllm_reranker import (
    VLLMRerankResult,
    build_vllm_rerank_payload,
    parse_vllm_rerank_response,
)


def _embedding_response(value: float) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "object": "list",
            "data": [{"object": "embedding", "index": 0, "embedding": [value]}],
        },
    )


def test_embeddings_endpoint_normalizes_supported_base_urls():
    assert _embeddings_endpoint("http://embedder:8000") == (
        "http://embedder:8000/v1/embeddings"
    )
    assert _embeddings_endpoint("http://embedder:8000/v1/") == (
        "http://embedder:8000/v1/embeddings"
    )
    assert _embeddings_endpoint("http://embedder:8000/v1/embeddings") == (
        "http://embedder:8000/v1/embeddings"
    )


def test_embedding_adapter_sends_query_and_document_message_roles():
    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return _embedding_response(float(len(requests)))

    transport = httpx.MockTransport(handler)
    sync_client = httpx.Client(transport=transport)
    async_client = httpx.AsyncClient(transport=transport)
    adapter = DaedalusVLLMEmbeddings(
        base_url="http://embedder:8000/v1",
        model="nvidia/embedder",
        truncate_prompt_tokens=10240,
        sync_client=sync_client,
        async_client=async_client,
    )

    assert adapter.embed_query("question") == [1.0]
    assert adapter.embed_documents(["first", "second"]) == [[2.0], [3.0]]

    assert requests == [
        {
            "model": "nvidia/embedder",
            "messages": [
                {
                    "role": "query",
                    "content": [{"type": "text", "text": "question"}],
                }
            ],
            "truncate_prompt_tokens": 10240,
        },
        {
            "model": "nvidia/embedder",
            "messages": [
                {
                    "role": "document",
                    "content": [{"type": "text", "text": "first"}],
                }
            ],
            "truncate_prompt_tokens": 10240,
        },
        {
            "model": "nvidia/embedder",
            "messages": [
                {
                    "role": "document",
                    "content": [{"type": "text", "text": "second"}],
                }
            ],
            "truncate_prompt_tokens": 10240,
        },
    ]
    assert all("input_type" not in payload for payload in requests)
    assert all("truncate" not in payload for payload in requests)
    asyncio.run(adapter.aclose())


def test_embedding_adapter_async_documents_preserve_input_order():
    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        text = payload["messages"][0]["content"][0]["text"]
        if text == "slow":
            await asyncio.sleep(0.01)
        return _embedding_response(float(len(text)))

    async def run_test():
        transport = httpx.MockTransport(handler)
        adapter = DaedalusVLLMEmbeddings(
            base_url="http://embedder:8000/v1",
            model="nvidia/embedder",
            sync_client=httpx.Client(transport=transport),
            async_client=httpx.AsyncClient(transport=transport),
        )
        try:
            return await adapter.aembed_documents(["slow", "x"])
        finally:
            await adapter.aclose()

    assert asyncio.run(run_test()) == [[4.0], [1.0]]


@pytest.mark.parametrize("cancel", [False, True])
def test_embedding_batch_settles_siblings_before_returning_failure(cancel):
    async def check():
        started = asyncio.Event()
        closed = asyncio.Event()

        async def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            text = payload["messages"][0]["content"][0]["text"]
            if text == "failure":
                await started.wait()
                return httpx.Response(503, text="unavailable")
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                # Transport cleanup yields while releasing sockets/pool slots.
                await asyncio.sleep(0)
                closed.set()

        transport = httpx.MockTransport(handler)
        adapter = DaedalusVLLMEmbeddings(
            base_url="http://embedder:8000/v1",
            model="nvidia/embedder",
            sync_client=httpx.Client(transport=transport),
            async_client=httpx.AsyncClient(transport=transport),
        )
        batch = asyncio.create_task(
            adapter.aembed_documents(["waiting"] if cancel else ["waiting", "failure"])
        )
        try:
            await asyncio.wait_for(started.wait(), 1)
            if cancel:
                batch.cancel()
            with pytest.raises(asyncio.CancelledError if cancel else RuntimeError):
                await asyncio.wait_for(batch, 1)
            assert closed.is_set(), "A failed batch left embedding requests running"
        finally:
            batch.cancel()
            await asyncio.gather(batch, return_exceptions=True)
            await adapter.aclose()

    asyncio.run(check())


def test_embedding_adapter_surfaces_bounded_http_error():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="invalid role")

    transport = httpx.MockTransport(handler)
    adapter = DaedalusVLLMEmbeddings(
        base_url="http://embedder:8000/v1",
        model="nvidia/embedder",
        sync_client=httpx.Client(transport=transport),
        async_client=httpx.AsyncClient(transport=transport),
    )

    with pytest.raises(RuntimeError, match="HTTP 400: invalid role"):
        adapter.embed_query("question")
    asyncio.run(adapter.aclose())


def test_vllm_reranker_contract_builds_and_parses_supported_fields():
    assert build_vllm_rerank_payload(
        model="nvidia/reranker",
        query="capital of France",
        documents=["Brasilia", "Paris"],
        top_n=2,
    ) == {
        "model": "nvidia/reranker",
        "query": "capital of France",
        "documents": ["Brasilia", "Paris"],
        "top_n": 2,
    }

    assert parse_vllm_rerank_response(
        {
            "results": [
                {"index": 0, "relevance_score": 0.1},
                {"index": 1, "relevance_score": 0.9},
            ]
        },
        document_count=2,
    ) == [
        VLLMRerankResult(index=1, relevance_score=0.9),
        VLLMRerankResult(index=0, relevance_score=0.1),
    ]


@pytest.mark.parametrize(
    "payload",
    [
        {"rankings": [{"index": 0, "logit": 1.0}]},
        {"results": [{"index": 2, "relevance_score": 1.0}]},
        {"results": [{"index": 0, "relevance_score": "high"}]},
    ],
)
def test_vllm_reranker_rejects_legacy_or_invalid_responses(payload):
    with pytest.raises(ValueError):
        parse_vllm_rerank_response(payload, document_count=1)
