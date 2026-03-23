"""Unit tests for smart_milvus utility functions and data models."""

import asyncio
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
