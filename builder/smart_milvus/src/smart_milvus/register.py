import asyncio
import json
import logging
import os
from typing import Annotated

from nat.builder.builder import Builder, LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.milvus import owned_milvus_connection_args
from pydantic import Field, HttpUrl

logger = logging.getLogger(__name__)

_MAX_DOMAIN_TOP_K = 50
_MAX_DOMAIN_OUTPUT_RESULTS = 20
_MAX_DOMAIN_CONTENT_CHARS = 12000
DomainTopK = Annotated[int, Field(ge=1, le=_MAX_DOMAIN_TOP_K)]


def _close_milvus_client(client) -> None:
    """Best-effort close of a MilvusClient connection pool (F-013a).

    Tolerates clients that predate the ``close`` method and never raises so it
    is safe to call from generator-cleanup ``finally`` blocks.
    """
    if client is None:
        return
    close = getattr(client, "close", None)
    if not callable(close):
        return
    try:
        close()
    except Exception as exc:  # pragma: no cover - defensive cleanup
        logger.debug("Error closing MilvusClient: %s", exc)


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


class DomainRetrieverConfig(FunctionBaseConfig, name="domain_retriever"):
    """Configuration for one routed Milvus retriever over curated domains."""

    uri: HttpUrl = Field(description="Milvus service URI")
    connection_args: dict = Field(
        default_factory=_milvus_connection_args_from_env,
        description="Milvus connection/auth arguments.",
    )
    embedding_model: str = Field(
        description="Embedder name used to vectorize the query"
    )
    database_name: str = Field(default="default", description="Milvus database name")
    domain_collections: dict[str, str] = Field(
        default_factory=lambda: {
            "nvidia": "nvidia",
            "semianalysis": "semianalysis",
            "kubernetes": "kubernetes",
            "veterinarian": "vetpartner",
            "mentalhealth": "mentalhealth",
        },
        description="Map of logical domain names to Milvus collection names.",
    )
    content_field: str = Field(default="text", description="Content field name")
    vector_field_name: str = Field(
        default="vector",
        alias="vector_field",
        description="Vector field name used for similarity search",
    )
    top_k: int = Field(
        default=10,
        gt=0,
        le=_MAX_DOMAIN_TOP_K,
        description="Number of chunks to retrieve",
    )
    distance_cutoff: float | None = Field(
        default=None,
        description="Optional distance cutoff before reranking",
    )
    output_fields: list[str] | None = Field(
        default=None,
        description="Optional output fields returned from Milvus",
    )
    search_params: dict = Field(
        default_factory=lambda: {"metric_type": "L2"},
        description="Milvus search params",
    )
    search_timeout: float | None = Field(
        default=30.0,
        description="Per-request timeout (seconds) applied to every Milvus call "
        "and bounding the overall search. None disables the timeout.",
    )
    use_reranker: bool = Field(
        default=True,
        description="Whether to rerank retrieved chunks",
    )
    reranker_endpoint: HttpUrl | None = Field(
        default=None, description="Reranker endpoint URL"
    )
    reranker_model: str | None = Field(default=None, description="Reranker model")
    reranker_top_n: int | None = Field(
        default=None,
        ge=1,
        le=_MAX_DOMAIN_OUTPUT_RESULTS,
        description="Number of reranked chunks to keep",
    )
    reranker_min_score: float | None = Field(
        default=None,
        ge=0.0,
        description="Optional minimum reranker relevance score",
    )
    reranker_api_key: str | None = Field(default=None, description="Reranker API key")


def _format_domain_results(output: object, domain: str) -> str:
    results = getattr(output, "results", None) or []
    formatted = []
    for doc in results[:_MAX_DOMAIN_OUTPUT_RESULTS]:
        content = getattr(doc, "page_content", "") or str(doc)
        metadata = getattr(doc, "metadata", {}) or {}
        source = metadata.get("source") or metadata.get("url") or metadata.get("title")
        item = {
            "content": str(content)[:_MAX_DOMAIN_CONTENT_CHARS],
            "source": str(source)[:2048] if source else None,
            "distance": (
                float(metadata["distance"])
                if metadata.get("distance") is not None
                else None
            ),
            "rerank_score": (
                float(metadata["rerank_score"])
                if metadata.get("rerank_score") is not None
                else None
            ),
        }
        formatted.append(
            {key: value for key, value in item.items() if value is not None}
        )
    ranking_status = "no_results"
    if formatted:
        ranking_status = (
            "reranked"
            if any("rerank_score" in item for item in formatted)
            else "vector_only"
        )
    return json.dumps(
        {
            "domain": domain,
            "ranking_status": ranking_status,
            "retrieved_count": len(results),
            "results_truncated": len(results) > len(formatted),
            "results": formatted,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


@register_function(config_type=DomainRetrieverConfig)
async def domain_retriever_function(config: DomainRetrieverConfig, builder: Builder):
    """Register one routed tool for all curated Milvus knowledge domains."""

    from pymilvus import MilvusClient
    from smart_milvus.smart_milvus_function import MilvusRetriever

    _retriever_cache: dict[str, MilvusRetriever] = {}
    _client_cache: dict[str, MilvusClient] = {}
    _retriever_lock = asyncio.Lock()

    async def _get_retriever() -> MilvusRetriever:
        retriever = _retriever_cache.get("instance")
        if retriever is not None:
            return retriever

        async with _retriever_lock:
            retriever = _retriever_cache.get("instance")
            if retriever is not None:
                return retriever

            embedder = await builder.get_embedder(
                embedder_name=config.embedding_model,
                wrapper_type=LLMFrameworkEnum.LANGCHAIN,
            )
            # pymilvus constructs channels and may perform connection setup in
            # its synchronous constructor. Keep that work off the event loop.
            milvus_client = await asyncio.to_thread(
                MilvusClient,
                uri=str(config.uri),
                **owned_milvus_connection_args(
                    "domain-retriever", config.connection_args
                ),
            )
            _client_cache["instance"] = milvus_client
            reranker_config = None
            if config.use_reranker and config.reranker_endpoint:
                reranker_config = {
                    "endpoint": str(config.reranker_endpoint),
                    "model": config.reranker_model,
                    "top_n": config.reranker_top_n,
                    "min_score": config.reranker_min_score,
                    "api_key": config.reranker_api_key,
                }
            try:
                retriever = MilvusRetriever(
                    client=milvus_client,
                    embedder=embedder,
                    content_field=config.content_field,
                    database_name=(
                        config.database_name
                        if config.database_name != "default"
                        else None
                    ),
                    vector_field_name=config.vector_field_name,
                    reranker_config=reranker_config,
                    search_timeout=config.search_timeout,
                )
            except Exception:
                _client_cache.pop("instance", None)
                await asyncio.to_thread(_close_milvus_client, milvus_client)
                raise
            _retriever_cache["instance"] = retriever
            return retriever

    async def search_domain(
        query: str,
        domain: str,
        top_k: DomainTopK | None = None,
        filters: str | None = None,
    ) -> str:
        """Search one configured knowledge domain.

        Args:
            query: Search query.
            domain: One of the configured domains, e.g. nvidia, semianalysis,
                kubernetes, veterinarian, or mentalhealth.
            top_k: Optional result count override.
            filters: Optional Milvus filter expression.
        """
        normalized_domain = (domain or "").strip().lower()
        collection = config.domain_collections.get(normalized_domain)
        if not collection:
            return (
                f"Error: unknown domain '{domain}'. Available domains: "
                f"{', '.join(sorted(config.domain_collections))}"
            )

        retriever = await _get_retriever()
        requested_top_k = (
            config.top_k
            if top_k is None
            else min(_MAX_DOMAIN_TOP_K, max(1, int(top_k)))
        )
        output = await retriever.search(
            query=query,
            collection_name=collection,
            top_k=requested_top_k,
            filters=filters,
            output_fields=config.output_fields,
            search_params=config.search_params,
            distance_cutoff=config.distance_cutoff,
        )
        return _format_domain_results(output, normalized_domain)

    try:
        yield FunctionInfo.from_fn(
            search_domain,
            description=(
                "Search one curated Milvus knowledge domain. Args: query, domain "
                "(nvidia, semianalysis, kubernetes, veterinarian, mentalhealth), "
                "optional top_k and filters. Returns reranked passages with metadata."
            ),
        )
    finally:
        # F-013a: release the reranker HTTP session and Milvus connection pool
        # so long-running processes don't leak sockets on reconfiguration.
        retriever = _retriever_cache.get("instance")
        if retriever is not None:
            await asyncio.to_thread(retriever.close)
        milvus_client = _client_cache.get("instance")
        if milvus_client is not None:
            await asyncio.to_thread(_close_milvus_client, milvus_client)
