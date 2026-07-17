"""Unit tests for smart_milvus utility functions and data models."""

import asyncio
import threading
from unittest.mock import MagicMock

import pytest
from smart_milvus.smart_milvus_function import (
    CollectionNotFoundError,
    MilvusRetriever,
    _wrap_milvus_results,
    _wrap_milvus_single_results,
)

# ---------------------------------------------------------------------------
# _wrap_milvus_single_results
# ---------------------------------------------------------------------------


class TestWrapMilvusSingleResults:
    def test_dict_result_wrapped(self):
        result = {
            "entity": {"text": "Hello world", "source": "doc1"},
            "distance": 0.25,
        }
        doc = _wrap_milvus_single_results(result, content_field="text")
        assert doc.page_content == "Hello world"
        assert doc.metadata["source"] == "doc1"
        assert doc.metadata["distance"] == 0.25

    def test_content_field_excluded_from_metadata(self):
        result = {
            "entity": {"text": "Content here", "extra": "data"},
            "distance": 0.1,
        }
        doc = _wrap_milvus_single_results(result, content_field="text")
        assert "text" not in doc.metadata
        assert "extra" in doc.metadata

    def test_invalid_type_raises(self):
        with pytest.raises(ValueError, match="Expected 'Hit' or 'dict'"):
            _wrap_milvus_single_results("not a dict", content_field="text")

    def test_distance_included_in_metadata(self):
        result = {
            "entity": {"text": "Sample text"},
            "distance": 0.75,
        }
        doc = _wrap_milvus_single_results(result, content_field="text")
        assert doc.metadata["distance"] == 0.75


# ---------------------------------------------------------------------------
# _wrap_milvus_results
# ---------------------------------------------------------------------------


class TestWrapMilvusResults:
    def test_empty_list(self):
        output = _wrap_milvus_results([], content_field="text")
        assert output.results == []

    def test_multiple_results(self):
        results = [
            {"entity": {"text": f"Doc {i}"}, "distance": float(i) / 10}
            for i in range(3)
        ]
        output = _wrap_milvus_results(results, content_field="text")
        assert len(output.results) == 3

    def test_page_content_preserved(self):
        results = [{"entity": {"text": "Important content"}, "distance": 0.2}]
        output = _wrap_milvus_results(results, content_field="text")
        assert output.results[0].page_content == "Important content"


# ---------------------------------------------------------------------------
# MilvusRetriever — construction and bind
# ---------------------------------------------------------------------------


class TestMilvusRetrieverConstruction:
    def _make_retriever(self, use_iterator=False, database_name=None):
        mock_client = MagicMock()
        mock_client.list_collections.return_value = ["test_collection"]
        # For use_iterator check
        if use_iterator:
            mock_client.search_iterator = MagicMock()
        mock_embedder = MagicMock()
        return MilvusRetriever(
            client=mock_client,
            embedder=mock_embedder,
            content_field="text",
            use_iterator=use_iterator,
            database_name=database_name,
        )

    def test_basic_construction(self):
        retriever = self._make_retriever()
        assert retriever.content_field == "text"

    def test_use_iterator_false_uses_search(self):
        retriever = self._make_retriever(use_iterator=False)
        assert "_search" in retriever._search_func.__name__

    def test_use_iterator_true_uses_search_iterator(self):
        retriever = self._make_retriever(use_iterator=True)
        assert "iterator" in retriever._search_func.__name__

    def test_use_iterator_no_support_raises(self):
        mock_client = MagicMock(spec=[])  # No search_iterator attr
        with pytest.raises(ValueError, match="search iterator"):
            MilvusRetriever(
                client=mock_client,
                embedder=MagicMock(),
                use_iterator=True,
            )

    def test_database_name_stored(self):
        retriever = self._make_retriever(database_name="mydb")
        assert retriever._database_name == "mydb"


class TestMilvusRetrieverBind:
    def _make_retriever(self):
        mock_client = MagicMock()
        mock_client.list_collections.return_value = []
        return MilvusRetriever(
            client=mock_client,
            embedder=MagicMock(),
            content_field="text",
        )

    def test_bind_stores_params(self):
        retriever = self._make_retriever()
        retriever.bind(collection_name="mycol", top_k=5)
        assert "collection_name" in retriever._bound_params
        assert "top_k" in retriever._bound_params

    def test_bind_ignores_query_param(self):
        retriever = self._make_retriever()
        retriever.bind(query="should be ignored", top_k=10)
        assert "query" not in retriever._bound_params
        assert "top_k" in retriever._bound_params

    def test_get_unbound_params_excludes_bound(self):
        retriever = self._make_retriever()
        retriever.bind(collection_name="col", top_k=5)
        unbound = retriever.get_unbound_params()
        assert "collection_name" not in unbound
        assert "top_k" not in unbound
        assert "query" in unbound

    def test_get_unbound_params_default(self):
        retriever = self._make_retriever()
        unbound = retriever.get_unbound_params()
        assert "query" in unbound
        assert "collection_name" in unbound
        assert "top_k" in unbound


# ---------------------------------------------------------------------------
# MilvusRetriever — search validation
# ---------------------------------------------------------------------------


class TestMilvusRetrieverSearch:
    def _make_retriever(self):
        mock_client = MagicMock()
        mock_client.list_collections.return_value = ["testcol"]
        mock_client.describe_collection.return_value = {
            "fields": [
                {"name": "text"},
                {"name": "vector"},
                {"name": "source"},
            ]
        }
        mock_client.search.return_value = [[]]
        mock_embedder = MagicMock()
        mock_embedder.embed_query.return_value = [0.1] * 128
        return MilvusRetriever(
            client=mock_client,
            embedder=mock_embedder,
            content_field="text",
        )

    def test_empty_query_raises(self):
        retriever = self._make_retriever()
        with pytest.raises(ValueError, match="'query' parameter is required"):
            asyncio.run(retriever.search(""))

    def test_collection_not_found_raises(self):
        mock_client = MagicMock()
        mock_client.list_collections.return_value = []
        retriever = MilvusRetriever(
            client=mock_client,
            embedder=MagicMock(),
            content_field="text",
        )
        with pytest.raises(CollectionNotFoundError):
            asyncio.run(
                retriever._search(
                    query="test",
                    collection_name="nonexistent",
                    top_k=5,
                )
            )


# ---------------------------------------------------------------------------
# CollectionNotFoundError
# ---------------------------------------------------------------------------


class TestCollectionNotFoundError:
    def test_is_exception(self):
        err = CollectionNotFoundError("Collection 'foo' not found")
        assert isinstance(err, Exception)
        assert "foo" in str(err)


# ---------------------------------------------------------------------------
# F-008 — search timeouts
# ---------------------------------------------------------------------------


class TestSearchTimeout:
    def _retriever(self, search_timeout, embed=None):
        client = MagicMock()
        client.list_collections.return_value = ["col"]
        client.describe_collection.return_value = {
            "fields": [{"name": "text"}, {"name": "vector"}]
        }
        client.search.return_value = [[]]
        embedder = MagicMock()
        if embed is not None:
            embedder.embed_query = embed
        retriever = MilvusRetriever(
            client=client,
            embedder=embedder,
            content_field="text",
            search_timeout=search_timeout,
        )
        return retriever, client

    def test_timeout_passed_to_all_milvus_calls(self):
        retriever, client = self._retriever(7.0)
        asyncio.run(retriever.search(query="q", collection_name="col", top_k=3))
        assert client.search.call_args.kwargs["timeout"] == 7.0
        assert client.describe_collection.call_args.kwargs["timeout"] == 7.0
        assert client.list_collections.call_args.kwargs["timeout"] == 7.0

    def test_overall_search_is_time_bounded(self):
        import time

        def _slow_embed(_q):
            time.sleep(0.5)
            return [0.1, 0.2]

        retriever, _ = self._retriever(0.05, embed=_slow_embed)
        with pytest.raises(TimeoutError):
            asyncio.run(retriever.search(query="q", collection_name="col", top_k=3))


# ---------------------------------------------------------------------------
# F-004 — iterator search tolerates schema with no 'fields'
# ---------------------------------------------------------------------------


class TestIteratorSchemaWithoutFields:
    def _make_iterator_retriever(self, describe_return):
        client = MagicMock()
        client.list_collections.return_value = ["col"]
        client.describe_collection.return_value = describe_return
        client.search_iterator = MagicMock()
        # Iterator immediately returns an empty batch so the search completes.
        empty_batch = MagicMock()
        empty_batch.get_res.return_value = [[]]
        empty_batch.__len__.return_value = 0
        client.search_iterator.return_value.next.return_value = empty_batch
        embedder = MagicMock()
        embedder.embed_query.return_value = [0.1, 0.2]
        retriever = MilvusRetriever(
            client=client,
            embedder=embedder,
            content_field="text",
            use_iterator=True,
        )
        return retriever, client

    def test_schema_missing_fields_does_not_crash(self):
        # describe_collection returns a schema with NO 'fields' key.
        retriever, client = self._make_iterator_retriever({})
        result = asyncio.run(
            retriever.search(query="q", collection_name="col", top_k=3)
        )
        assert result.results == []
        # output_fields ended up empty because schema had no fields
        assert client.search_iterator.call_args.kwargs["output_fields"] == []

    def test_schema_fields_none_does_not_crash(self):
        # describe_collection returns {"fields": None}.
        retriever, _ = self._make_iterator_retriever({"fields": None})
        result = asyncio.run(
            retriever.search(query="q", collection_name="col", top_k=3)
        )
        assert result.results == []


# ---------------------------------------------------------------------------
# F-012 — single list_collections() round-trip per search
# ---------------------------------------------------------------------------


class TestSingleListCollectionsRoundTrip:
    def _make_retriever(self, database_name=None):
        client = MagicMock()
        client.list_collections.return_value = ["col"]
        client.describe_collection.return_value = {
            "fields": [{"name": "text"}, {"name": "vector"}]
        }
        client.search.return_value = [[]]
        embedder = MagicMock()
        embedder.embed_query.return_value = [0.1, 0.2]
        retriever = MilvusRetriever(
            client=client,
            embedder=embedder,
            content_field="text",
            database_name=database_name,
        )
        return retriever, client

    def test_default_db_calls_list_collections_once(self):
        retriever, client = self._make_retriever()
        asyncio.run(retriever.search(query="q", collection_name="col", top_k=3))
        assert client.list_collections.call_count == 1

    def test_non_default_db_calls_list_collections_once(self):
        retriever, client = self._make_retriever(database_name="mydb")
        # Collection exists under the database prefix.
        client.list_collections.return_value = ["mydb.col"]
        asyncio.run(retriever.search(query="q", collection_name="col", top_k=3))
        assert client.list_collections.call_count == 1
        # Resolved name carries the database prefix.
        assert client.search.call_args.kwargs["collection_name"] == "mydb.col"

    def test_resolve_collection_returns_exists_and_name(self):
        retriever, _ = self._make_retriever()
        exists, name = asyncio.run(retriever._resolve_collection("col"))
        assert exists is True
        assert name == "col"

    def test_resolve_collection_missing(self):
        retriever, client = self._make_retriever()
        client.list_collections.return_value = []
        exists, name = asyncio.run(retriever._resolve_collection("nope"))
        assert exists is False
        assert name == "nope"

    def test_resolve_collection_prefixed_db(self):
        retriever, client = self._make_retriever(database_name="mydb")
        client.list_collections.return_value = ["mydb.col"]
        exists, name = asyncio.run(retriever._resolve_collection("col"))
        assert exists is True
        assert name == "mydb.col"

    def test_resolve_collection_unprefixed_in_db(self):
        retriever, client = self._make_retriever(database_name="mydb")
        # Only the unprefixed form exists.
        client.list_collections.return_value = ["col"]
        exists, name = asyncio.run(retriever._resolve_collection("col"))
        assert exists is True
        assert name == "col"


# ---------------------------------------------------------------------------
# F-022 — synchronous Milvus calls stay off the event loop and metadata caches
# ---------------------------------------------------------------------------


class TestAsyncMilvusCalls:
    def test_domain_retriever_offloads_constructor_metadata_search_and_close(
        self, monkeypatch
    ):
        import pymilvus
        from smart_milvus.register import (
            DomainRetrieverConfig,
            domain_retriever_function,
        )

        event_loop_thread = threading.get_ident()
        call_threads: dict[str, int] = {}

        class RecordingClient:
            def __init__(self, **_kwargs):
                call_threads["construct"] = threading.get_ident()

            def list_collections(self, **_kwargs):
                call_threads["list"] = threading.get_ident()
                return ["nvidia"]

            def describe_collection(self, *_args, **_kwargs):
                call_threads["describe"] = threading.get_ident()
                return {"fields": [{"name": "text"}, {"name": "vector"}]}

            def search(self, **_kwargs):
                call_threads["search"] = threading.get_ident()
                return [[]]

            def close(self):
                call_threads["close"] = threading.get_ident()

        class RecordingEmbedder:
            def embed_query(self, _query):
                call_threads["embed"] = threading.get_ident()
                return [0.1, 0.2]

        class FakeBuilder:
            async def get_embedder(self, **_kwargs):
                return RecordingEmbedder()

        monkeypatch.setattr(pymilvus, "MilvusClient", RecordingClient, raising=False)
        config = DomainRetrieverConfig(
            uri="http://milvus:19530",
            embedding_model="embedder",
            use_reranker=False,
        )

        async def run_search():
            registration = domain_retriever_function(config, FakeBuilder())
            function_info = await registration.__anext__()
            try:
                result = await function_info.fn("query", "nvidia")
                assert result == "No nvidia results found."
            finally:
                await registration.aclose()

        asyncio.run(run_search())

        expected_calls = {"construct", "list", "describe", "search", "embed", "close"}
        assert expected_calls <= call_threads.keys()
        assert all(call_threads[name] != event_loop_thread for name in expected_calls)

    def test_metadata_is_cached_with_a_bounded_size(self):
        client = MagicMock()
        client.list_collections.return_value = ["a", "b"]
        client.describe_collection.return_value = {
            "fields": [{"name": "text"}, {"name": "vector"}]
        }
        client.search.return_value = [[]]
        embedder = MagicMock()
        embedder.embed_query.return_value = [0.1, 0.2]
        retriever = MilvusRetriever(
            client=client,
            embedder=embedder,
            content_field="text",
            metadata_cache_ttl=30.0,
            metadata_cache_max_entries=1,
        )

        async def run_searches():
            await retriever.search(query="q", collection_name="a", top_k=3)
            await retriever.search(query="q", collection_name="b", top_k=3)

        asyncio.run(run_searches())

        assert len(retriever._collection_cache) == 1
        assert len(retriever._schema_cache) == 1
        assert list(retriever._collection_cache) == ["b"]
        assert list(retriever._schema_cache) == ["b"]

    def test_client_error_invalidates_collection_and_schema_cache(self):
        client = MagicMock()
        client.list_collections.return_value = ["col"]
        client.describe_collection.return_value = {
            "fields": [{"name": "text"}, {"name": "vector"}]
        }
        client.search.side_effect = [RuntimeError("connection reset"), [[]]]
        embedder = MagicMock()
        embedder.embed_query.return_value = [0.1, 0.2]
        retriever = MilvusRetriever(
            client=client,
            embedder=embedder,
            content_field="text",
        )

        async def run_searches():
            with pytest.raises(RuntimeError, match="connection reset"):
                await retriever.search(query="q", collection_name="col", top_k=3)
            assert not retriever._collection_cache
            assert not retriever._schema_cache
            await retriever.search(query="q", collection_name="col", top_k=3)

        asyncio.run(run_searches())

        assert client.list_collections.call_count == 2
        assert client.describe_collection.call_count == 2


# ---------------------------------------------------------------------------
# F-013a — connection-pool cleanup
# ---------------------------------------------------------------------------


class TestRetrieverClose:
    def _make_retriever(self):
        client = MagicMock()
        client.list_collections.return_value = []
        return MilvusRetriever(
            client=client,
            embedder=MagicMock(),
            content_field="text",
        )

    def test_close_with_no_session_is_noop(self):
        retriever = self._make_retriever()
        # Should not raise even though no session was created.
        retriever.close()
        assert retriever._session is None

    def test_close_closes_existing_session(self):
        retriever = self._make_retriever()
        session = MagicMock()
        retriever._session = session
        retriever.close()
        session.close.assert_called_once()
        assert retriever._session is None


class TestCloseMilvusClient:
    def test_close_none_is_noop(self):
        from smart_milvus.register import _close_milvus_client

        # Should not raise.
        _close_milvus_client(None)

    def test_close_calls_client_close(self):
        from smart_milvus.register import _close_milvus_client

        client = MagicMock()
        _close_milvus_client(client)
        client.close.assert_called_once()

    def test_close_swallows_errors(self):
        from smart_milvus.register import _close_milvus_client

        client = MagicMock()
        client.close.side_effect = RuntimeError("boom")
        # Must not propagate from cleanup.
        _close_milvus_client(client)

    def test_close_tolerates_client_without_close(self):
        from smart_milvus.register import _close_milvus_client

        client = object()  # no close attribute
        _close_milvus_client(client)
