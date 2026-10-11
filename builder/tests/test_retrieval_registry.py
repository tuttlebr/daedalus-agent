"""Real tool/registry/retriever contracts with only external transports replaced."""

import asyncio
import json

import httpx
import nat_nv_ingest.nat_nv_ingest as documents
import pymilvus
import smart_milvus.register  # noqa: F401 - registers the real domain tool
from daedalus_runtime.tools import ToolRegistry
from nat_helpers import vllm_embeddings
from nat_helpers.identity import authenticated_request_headers_scope


def test_registered_retrievers_embed_search_isolate_users_and_close(monkeypatch):
    requests, searches, clients, embeddings = [], [], [], []
    collections = {
        documents.user_upload_collection_name(user): f"Evidence for {user}"
        for user in ("synthetic-alice", "synthetic-bob")
    } | {"nvidia": "Curated evidence"}

    def embed(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"data": [{"embedding": [0.1, 0.2]}]})

    def create(config):
        client = vllm_embeddings.DaedalusVLLMEmbeddings(
            base_url=config.base_url,
            model=config.model_name,
            sync_client=httpx.Client(transport=httpx.MockTransport(embed)),
            async_client=httpx.AsyncClient(transport=httpx.MockTransport(embed)),
        )
        embeddings.append(client)
        return client

    class Milvus:
        def __init__(self, **kwargs):
            self.closed = False
            clients.append(self)

        def list_collections(self, **kwargs):
            return list(collections)

        def describe_collection(self, collection_name, **kwargs):
            return {"fields": [{"name": n} for n in ("text", "vector", "source")]}

        def search(self, **kwargs):
            searches.append(kwargs)
            return [
                [
                    {
                        "entity": {
                            "text": collections[kwargs["collection_name"]],
                            "source": "synthetic-source",
                        },
                        "distance": 0.1,
                    }
                ]
            ]

        def close(self):
            self.closed = True

    monkeypatch.setattr(vllm_embeddings, "create_embeddings", create)
    monkeypatch.setattr(documents, "MilvusClient", Milvus)
    monkeypatch.setattr(pymilvus, "MilvusClient", Milvus)
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "synthetic-token")

    async def exercise():
        registry = ToolRegistry(
            {
                "embedders": {
                    "shared": {
                        "base_url": "http://embedding.test/v1",
                        "model_name": "fixture",
                    }
                },
                "functions": {
                    "documents": {
                        "_type": "nat_nv_ingest",
                        "embedder_name": "shared",
                        "use_reranker": False,
                    },
                    "domain": {
                        "_type": "domain_retriever",
                        "uri": "http://milvus.test:19530",
                        "embedding_model": "shared",
                        "use_reranker": False,
                    },
                },
            }
        )
        try:
            tool = await registry.get_function("documents")
            for user in ("synthetic-alice", "synthetic-bob"):
                with authenticated_request_headers_scope(
                    {"x-user-id": user, "x-daedalus-internal-token": "synthetic-token"}
                ):
                    result = await tool.ainvoke(
                        {"operation": "search", "query": f"question {user}", "top_k": 2}
                    )
                    assert f"Evidence for {user}" in result
                    other = (
                        "synthetic-bob" if user.endswith("alice") else "synthetic-alice"
                    )
                    assert f"Evidence for {other}" not in result
            domain = await registry.get_function("domain")
            result = json.loads(
                await domain.ainvoke(
                    {"domain": "nvidia", "query": "curated question", "top_k": 2}
                )
            )
            assert result["results"][0]["content"] == "Curated evidence"
            assert result["results"][0]["source"] == "synthetic-source"
        finally:
            await registry.close()

    asyncio.run(exercise())
    assert len(embeddings) == 1, "the registry owns one shared embedder"
    assert len(clients) == 2 and all(client.closed for client in clients)
    assert embeddings[0]._sync_client.is_closed
    assert embeddings[0]._async_client.is_closed
    assert [r["messages"][0]["content"][0]["text"] for r in requests] == [
        "question synthetic-alice",
        "question synthetic-bob",
        "curated question",
    ]
    assert all(r["messages"][0]["role"] == "query" for r in requests)
    assert [r["collection_name"] for r in searches] == list(collections)
    assert all(r["data"] == [[0.1, 0.2]] and r["limit"] == 2 for r in searches)
