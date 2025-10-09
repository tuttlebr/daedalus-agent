import logging
import os
from functools import partial

import requests
from langchain_core.embeddings import Embeddings
from nat.retriever.interface import Retriever
from nat.retriever.models import Document, RetrieverError, RetrieverOutput
from pymilvus import MilvusClient
from pymilvus.client.abstract import Hit

logger = logging.getLogger(__name__)


class CollectionNotFoundError(RetrieverError):
    pass


class MilvusRetriever(Retriever):
    """
    Client for retrieving document chunks from a Milvus vectorstore.

    This retriever supports both standard search and iterator-based search for
    handling large result sets. It embeds queries using the provided embedder
    and searches against vector collections in Milvus.
    """

    def __init__(
        self,
        client: MilvusClient,
        embedder: Embeddings,
        content_field: str = "content",
        use_iterator: bool = False,
        database_name: str | None = None,
        vector_field_name: str = "vector",
        reranker_config: dict | None = None,
    ) -> None:
        """
        Initialize the Milvus Retriever using a preconfigured MilvusClient.

        Args:
            client (MilvusClient): Preinstantiated pymilvus.MilvusClient object.
            embedder (Embeddings): Langchain embeddings model for vectorizing
                queries.
            content_field (str): The field name containing the main text
                content. Defaults to "content".
            use_iterator (bool): Whether to use search iterator for large
                result sets. Defaults to False.
            database_name (str | None): The name of the Milvus database to
                use. If provided, switches to this database.
            vector_field_name (str): The field name containing vectors.
                Defaults to "vector".
            reranker_config (dict | None): Configuration for the reranker service.
                Should contain 'endpoint', 'model', 'top_n', and 'api_key'.
        """
        self._client = client
        self._embedder = embedder
        self._database_name = database_name
        self._vector_field_name = vector_field_name
        self._reranker_config = reranker_config
        self._session = None  # Lazy-loaded requests session

        # Note: For MilvusClient, database switching is handled by prefixing
        # collection names with database name (e.g., "db_name.collection_name")
        if database_name and database_name != "default":
            logger.info("Configured to use Milvus database: %s", database_name)

        if use_iterator and "search_iterator" not in dir(self._client):
            raise ValueError(
                "This version of the pymilvus.MilvusClient does not support "
                "the search iterator."
            )

        self._search_func = (
            self._search if not use_iterator else self._search_with_iterator
        )
        self._default_params = None
        self._bound_params = []
        self.content_field = content_field
        logger.info("Milvus Retriever using %s for search.", self._search_func.__name__)

    def bind(self, **kwargs) -> None:
        """
        Bind default values to the search method.
        Cannot bind the 'query' parameter.

        Args:
          kwargs (dict): Key value pairs corresponding to the default
                values of search parameters.
        """
        if "query" in kwargs:
            kwargs = {k: v for k, v in kwargs.items() if k != "query"}
        self._search_func = partial(self._search_func, **kwargs)
        self._bound_params = list(kwargs.keys())
        logger.info(
            "MilvusRetriever: Binding parameters for search function: %s", kwargs
        )
        logger.info(
            "MilvusRetriever: Instance vector_field_name: %s", self._vector_field_name
        )

    def get_unbound_params(self) -> list[str]:
        """
        Returns a list of unbound parameters which will need to be passed
        to the search function.
        """
        return [
            param
            for param in ["query", "collection_name", "top_k", "filters"]
            if param not in self._bound_params
        ]

    def _validate_collection(self, collection_name: str) -> bool:
        # If database is specified, check with database prefix
        if self._database_name and self._database_name != "default":
            full_name = f"{self._database_name}.{collection_name}"
            # Try both with and without database prefix
            return (
                full_name in self._client.list_collections()
                or collection_name in self._client.list_collections()
            )
        return collection_name in self._client.list_collections()

    def _get_collection_name(self, collection_name: str) -> str:
        """Get the full collection name with database prefix if needed."""
        if self._database_name and self._database_name != "default":
            # Check if collection exists with database prefix
            full_name = f"{self._database_name}.{collection_name}"
            if full_name in self._client.list_collections():
                return full_name
        return collection_name

    def _get_session(self) -> requests.Session:
        """Get or create a requests session for connection reuse."""
        if self._session is None:
            self._session = requests.Session()
        return self._session

    async def _rerank(self, query: str, documents: list[Document]) -> list[Document]:
        """
        Rerank documents using the configured reranker service.

        Args:
            query: The search query
            documents: List of documents to rerank

        Returns:
            Reranked list of documents
        """
        if not self._reranker_config or not documents:
            return documents

        try:
            # Prepare API key
            api_key = self._reranker_config.get("api_key") or os.getenv(
                "NVIDIA_API_KEY"
            )
            if not api_key:
                logger.warning("No API key provided for reranker. Skipping reranking.")
                return documents

            # Prepare request
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            }

            # Extract text passages from documents
            passages = [{"text": doc.page_content} for doc in documents]

            payload = {
                "model": self._reranker_config.get("model"),
                "query": {"text": query},
                "passages": passages,
            }

            # Make request
            session = self._get_session()
            response = session.post(
                self._reranker_config["endpoint"],
                headers=headers,
                json=payload,
                timeout=30,
            )
            response.raise_for_status()

            # Process response
            result = response.json()
            rankings = result.get("rankings", [])

            # Sort by logit score (higher is better)
            rankings.sort(key=lambda x: x["logit"], reverse=True)

            # Reorder documents based on rankings
            reranked_docs = []
            top_n = self._reranker_config.get("top_n") or len(documents)

            for i, ranking in enumerate(rankings[:top_n]):
                idx = ranking["index"]
                if 0 <= idx < len(documents):
                    # Add reranking score to metadata
                    doc = documents[idx]
                    doc.metadata["rerank_score"] = ranking["logit"]
                    doc.metadata["rerank_position"] = i + 1
                    reranked_docs.append(doc)

            logger.debug(
                "Reranked %d documents, returning top %d",
                len(documents),
                len(reranked_docs),
            )
            return reranked_docs

        except Exception as e:
            logger.warning(
                "Failed to rerank documents: %s. Returning original order.", str(e)
            )
            return documents

    async def search(self, query: str, **kwargs):
        return await self._search_func(query=query, **kwargs)

    async def _search_with_iterator(
        self,
        query: str,
        *,
        collection_name: str,
        top_k: int,
        filters: str | None = None,
        output_fields: list[str] | None = None,
        search_params: dict | None = None,
        timeout: float | None = None,
        vector_field_name: str | None = None,
        distance_cutoff: float | None = None,
        **kwargs,
    ):
        """
        Retrieve document chunks from a Milvus vectorstore using a search
        iterator, allowing for the retrieval of more results.
        """
        logger.debug(
            "MilvusRetriever searching query: %s, for collection: %s. "
            "Returning max %s results",
            query,
            collection_name,
            top_k,
        )

        # Use instance default if not provided
        if vector_field_name is None:
            vector_field_name = self._vector_field_name

        if not self._validate_collection(collection_name):
            raise CollectionNotFoundError(
                f"Collection: {collection_name} does not exist"
            )

        # Get the actual collection name (with database prefix if needed)
        actual_collection_name = self._get_collection_name(collection_name)

        # If no output fields are specified, return all of them
        if not output_fields:
            collection_schema = self._client.describe_collection(actual_collection_name)
            output_fields = [
                field["name"]
                for field in collection_schema.get("fields")
                if field["name"] != vector_field_name
            ]

        search_vector = self._embedder.embed_query(query)

        search_iterator = self._client.search_iterator(
            collection_name=actual_collection_name,
            data=[search_vector],
            batch_size=kwargs.get("batch_size", 1000),
            filter=filters,
            limit=top_k,
            output_fields=output_fields,
            search_params=(search_params if search_params else {"metric_type": "L2"}),
            timeout=timeout,
            anns_field=vector_field_name,
            round_decimal=kwargs.get("round_decimal", -1),
            partition_names=kwargs.get("partition_names", None),
        )

        results = []
        try:
            while True:
                _res = search_iterator.next()
                res = _res.get_res()
                if len(_res) == 0:
                    search_iterator.close()
                    break

                if distance_cutoff:
                    # Add only results within the distance cutoff
                    for hit in res[0]:
                        if hit.distance <= distance_cutoff:
                            results.append(hit)
                        else:
                            # Results are sorted by distance, so we can stop early
                            search_iterator.close()
                            wrapped = _wrap_milvus_results(
                                results, content_field=self.content_field
                            )
                            wrapped.results = await self._rerank(query, wrapped.results)
                            return wrapped
                else:
                    results.extend(res[0])

                # Check if we've collected enough results
                if len(results) >= top_k:
                    results = results[:top_k]
                    search_iterator.close()
                    break

            wrapped = _wrap_milvus_results(results, content_field=self.content_field)
            wrapped.results = await self._rerank(query, wrapped.results)
            return wrapped

        except Exception as e:
            logger.error(
                "Exception when retrieving results from milvus for query %s: %s",
                query,
                e,
            )
            raise RetrieverError(
                f"Error when retrieving documents from {collection_name} "
                f"for query '{query}'"
            ) from e

    async def _search(
        self,
        query: str,
        *,
        collection_name: str,
        top_k: int,
        filters: str | None = None,
        output_fields: list[str] | None = None,
        search_params: dict | None = None,
        timeout: float | None = None,
        vector_field_name: str | None = None,
        **kwargs,
    ):
        """
        Retrieve document chunks from a Milvus vectorstore
        """
        logger.debug(
            "MilvusRetriever searching query: %s, for collection: %s. "
            "Returning max %s results",
            query,
            collection_name,
            top_k,
        )

        # Use instance default if not provided
        if vector_field_name is None:
            vector_field_name = self._vector_field_name

        if not self._validate_collection(collection_name):
            raise CollectionNotFoundError(
                f"Collection: {collection_name} does not exist"
            )

        # Get the actual collection name (with database prefix if needed)
        actual_collection_name = self._get_collection_name(collection_name)

        available_fields = [
            v.get("name")
            for v in self._client.describe_collection(actual_collection_name).get(
                "fields", {}
            )
        ]

        if self.content_field not in available_fields:
            raise ValueError(
                f"The specified content field: {self.content_field} "
                "is not part of the schema."
            )

        if vector_field_name not in available_fields:
            raise ValueError(
                f"The specified vector field name: {vector_field_name} "
                "is not part of the schema."
            )

        # If no output fields are specified, return all of them
        if not output_fields:
            output_fields = [
                field for field in available_fields if field != vector_field_name
            ]

        if self.content_field not in output_fields:
            output_fields.append(self.content_field)

        search_vector = self._embedder.embed_query(query)
        res = self._client.search(
            collection_name=actual_collection_name,
            data=[search_vector],
            filter=filters,
            output_fields=output_fields,
            search_params=(search_params if search_params else {"metric_type": "L2"}),
            timeout=timeout,
            anns_field=vector_field_name,
            limit=top_k,
        )

        wrapped = _wrap_milvus_results(res[0], content_field=self.content_field)
        wrapped.results = await self._rerank(query, wrapped.results)
        return wrapped


def _wrap_milvus_results(res: list[Hit], content_field: str):
    return RetrieverOutput(
        results=[
            _wrap_milvus_single_results(r, content_field=content_field) for r in res
        ]
    )


def _wrap_milvus_single_results(res: Hit | dict, content_field: str) -> Document:
    if not isinstance(res, (Hit, dict)):
        raise ValueError(
            f"Milvus search returned object of type {type(res)}. Expected 'Hit' or 'dict'."
        )

    if isinstance(res, Hit):
        metadata = {k: v for k, v in res.fields.items() if k != content_field}
        metadata.update({"distance": res.distance})
        return Document(
            page_content=res.fields[content_field],
            metadata=metadata,
        )

    fields = res["entity"]
    metadata = {k: v for k, v in fields.items() if k != content_field}
    metadata.update({"distance": res.get("distance")})
    return Document(page_content=fields.get(content_field), metadata=metadata)
