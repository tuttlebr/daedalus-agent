"""User document retriever tool backed by Milvus."""

import logging
import os
from typing import Any

from nat.builder.builder import Builder, LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_nv_ingest.nat_nv_ingest import resolve_user_collection_name
from pydantic import BaseModel, Field
from pymilvus import MilvusClient
from smart_milvus.smart_milvus_function import MilvusRetriever

logger = logging.getLogger(__name__)


def _milvus_connection_args_from_env() -> dict[str, str]:
    token = (os.getenv("MILVUS_TOKEN") or "").strip()
    if token:
        return {"token": token}

    username = (os.getenv("MILVUS_USERNAME") or os.getenv("MILVUS_USER") or "").strip()
    password = (os.getenv("MILVUS_PASSWORD") or "").strip()
    connection_args: dict[str, str] = {}
    if username:
        connection_args["user"] = username
    if password:
        connection_args["password"] = password
    return connection_args


class UserDocumentRetrieverConfig(FunctionBaseConfig, name="user_document_retriever"):
    """Configuration for retrieving content from user-uploaded documents."""

    milvus_uri: str = Field(description="Milvus connection URI.")
    connection_args: dict[str, str] = Field(
        default_factory=_milvus_connection_args_from_env,
        description="Milvus connection/auth arguments.",
    )
    embedder_name: str = Field(
        default="milvus_embedder",
        description="Embedder name used to vectorize queries.",
    )
    database_name: str = Field(
        default="default",
        description="Milvus database name.",
    )
    default_collection_name: str = Field(
        default="user_uploads",
        description="Base collection prefix used when deriving per-user collections.",
    )
    content_field: str = Field(
        default="text",
        description="Field containing the text content.",
    )
    vector_field: str = Field(
        default="vector",
        description="Vector field name used for similarity search.",
    )
    top_k: int = Field(
        default=25,
        gt=0,
        description="Number of chunks to return.",
    )
    distance_cutoff: float | None = Field(
        default=None,
        description="Optional distance cutoff for retrieved chunks.",
    )
    output_fields: list[str] | None = Field(
        default=None,
        description="Optional list of output fields to return from Milvus.",
    )
    search_params: dict[str, Any] = Field(
        default_factory=lambda: {"metric_type": "L2"},
        description="Search parameters passed to Milvus.",
    )
    search_timeout: float | None = Field(
        default=30.0,
        description="Per-request timeout (seconds) applied to every Milvus call "
        "and bounding the overall search. None disables the timeout.",
    )
    use_reranker: bool = Field(
        default=True,
        description="Whether to rerank retrieved chunks.",
    )
    reranker_endpoint: str | None = Field(
        default=None,
        description="Reranker service endpoint.",
    )
    reranker_model: str | None = Field(
        default=None,
        description="Reranker model identifier.",
    )
    reranker_top_n: int | None = Field(
        default=None,
        description="Number of top results to keep after reranking.",
    )
    reranker_api_key: str | None = Field(
        default=None,
        description="API key for the reranker service.",
    )
    verbose: bool = Field(
        default=True,
        description="Enable verbose logging.",
    )


class UserDocumentRetrieverOutput(BaseModel):
    """Response payload for user document retrieval."""

    result: dict[str, Any] | None = None
    error: str | None = None


def _serialize_output(output: object) -> UserDocumentRetrieverOutput:
    if hasattr(output, "model_dump"):
        return UserDocumentRetrieverOutput(result=output.model_dump())
    if hasattr(output, "dict"):
        return UserDocumentRetrieverOutput(result=output.dict())
    if hasattr(output, "__dict__"):
        return UserDocumentRetrieverOutput(result=dict(vars(output)))
    return UserDocumentRetrieverOutput(result={"value": output})


@register_function(config_type=UserDocumentRetrieverConfig)
async def user_document_retriever_function(
    config: UserDocumentRetrieverConfig,
    builder: Builder,
):
    """Register a retriever tool for user-uploaded document content."""

    # Lazy initialization - embedder and retriever are created on first use
    # This avoids dependency ordering issues with the workflow builder
    _retriever_cache: dict[str, MilvusRetriever] = {}

    async def _get_retriever() -> MilvusRetriever:
        """Get or create the retriever instance lazily."""
        if "instance" not in _retriever_cache:
            embedder = await builder.get_embedder(
                embedder_name=config.embedder_name,
                wrapper_type=LLMFrameworkEnum.LANGCHAIN,
            )
            milvus_client = MilvusClient(
                uri=str(config.milvus_uri), **config.connection_args
            )

            reranker_config = None
            if config.use_reranker and config.reranker_endpoint:
                reranker_config = {
                    "endpoint": config.reranker_endpoint,
                    "model": config.reranker_model,
                    "top_n": config.reranker_top_n,
                    "api_key": config.reranker_api_key,
                }

            _retriever_cache["instance"] = MilvusRetriever(
                client=milvus_client,
                embedder=embedder,
                content_field=config.content_field,
                database_name=(
                    config.database_name if config.database_name != "default" else None
                ),
                vector_field_name=config.vector_field,
                reranker_config=reranker_config,
                search_timeout=config.search_timeout,
            )
        return _retriever_cache["instance"]

    async def _retrieve(
        query: str,
        collection_name: str | None = None,
        username: str | None = None,
        user_id: str | None = None,
        top_k: int | None = None,
        filters: str | None = None,
    ) -> UserDocumentRetrieverOutput:
        """
        Retrieve chunks from a user's document collection.

        Args:
            query: Search query for the document content.
            collection_name: Milvus collection name to search.
            username: Optional authenticated username to derive the collection.
            user_id: Backward-compatible alias for username.
            top_k: Optional override for number of chunks to return.
            filters: Optional Milvus filter expression.

        Returns:
            Serialized retriever output or an error message.
        """
        resolved_collection = resolve_user_collection_name(
            collection_name,
            username or user_id,
            config.default_collection_name,
        )

        resolved_query = query.strip() if isinstance(query, str) else ""
        if not resolved_query:
            resolved_query = "summary of the document"

        search_kwargs: dict[str, Any] = {
            "collection_name": resolved_collection,
            "top_k": top_k or config.top_k,
            "filters": filters,
            "output_fields": config.output_fields,
            "search_params": config.search_params,
        }
        if config.distance_cutoff is not None:
            search_kwargs["distance_cutoff"] = config.distance_cutoff

        logger.info(
            "Searching user document collection '%s' with query '%s'",
            resolved_collection,
            resolved_query,
        )
        retriever = await _get_retriever()
        output = await retriever.search(query=resolved_query, **search_kwargs)
        return _serialize_output(output)

    yield FunctionInfo.from_fn(
        _retrieve,
        description=(
            "Retrieve relevant chunks from user-uploaded documents stored in Milvus. "
            "Provide query plus collection_name (or username) to target the user collection."
        ),
    )
