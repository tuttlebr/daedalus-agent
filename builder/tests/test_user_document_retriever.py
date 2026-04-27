"""Tests for user-uploaded document retrieval wiring."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch


def run(coro):
    return asyncio.run(coro)


class FakeRetriever:
    def __init__(self, *args, **kwargs):
        self.calls = []

    async def search(self, query, **kwargs):
        self.calls.append((query, kwargs))
        return {"query": query, "kwargs": kwargs}


def test_retriever_derives_same_per_user_collection_as_ingest():
    async def _run():
        import nat_nv_ingest.user_document_retriever as mod
        from nat_nv_ingest.user_document_retriever import (
            UserDocumentRetrieverConfig,
            user_document_retriever_function,
        )

        fake_retriever = FakeRetriever()
        builder = MagicMock()
        builder.get_embedder = AsyncMock(return_value=MagicMock())

        with (
            patch.object(mod, "MilvusRetriever", return_value=fake_retriever),
            patch.object(mod, "MilvusClient", return_value=MagicMock()),
        ):
            items = []
            async for item in user_document_retriever_function(
                UserDocumentRetrieverConfig(milvus_uri="http://milvus:19530"),
                builder,
            ):
                items.append(item)
            result = await items[0].fn(query="summarize", username="Brandon Smith")

        assert result.error is None
        assert fake_retriever.calls[0][1]["collection_name"] == (
            "user_uploads_brandon_smith"
        )

    run(_run())


def test_retriever_accepts_user_id_alias():
    async def _run():
        import nat_nv_ingest.user_document_retriever as mod
        from nat_nv_ingest.user_document_retriever import (
            UserDocumentRetrieverConfig,
            user_document_retriever_function,
        )

        fake_retriever = FakeRetriever()
        builder = MagicMock()
        builder.get_embedder = AsyncMock(return_value=MagicMock())

        with (
            patch.object(mod, "MilvusRetriever", return_value=fake_retriever),
            patch.object(mod, "MilvusClient", return_value=MagicMock()),
        ):
            items = []
            async for item in user_document_retriever_function(
                UserDocumentRetrieverConfig(milvus_uri="http://milvus:19530"),
                builder,
            ):
                items.append(item)
            await items[0].fn(query="summarize", user_id="brandon")

        assert fake_retriever.calls[0][1]["collection_name"] == "user_uploads_brandon"

    run(_run())
