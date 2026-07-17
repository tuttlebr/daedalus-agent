import asyncio
import logging
import os

from nat.builder.builder import Builder, LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field, HttpUrl

logger = logging.getLogger(__name__)


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
    top_k: int = Field(default=10, gt=0, description="Number of chunks to retrieve")
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
        default=None, description="Number of reranked chunks to keep"
    )
    reranker_api_key: str | None = Field(default=None, description="Reranker API key")


def _format_domain_results(output: object, domain: str) -> str:
    results = getattr(output, "results", None) or []
    if not results:
        return f"No {domain} results found."

    parts = [f"Domain: {domain}", f"Results: {len(results)}"]
    for idx, doc in enumerate(results, start=1):
        content = getattr(doc, "page_content", "") or str(doc)
        metadata = getattr(doc, "metadata", {}) or {}
        source = metadata.get("source") or metadata.get("url") or metadata.get("title")
        header = f"{idx}. {source}" if source else f"{idx}."
        parts.append(f"\n{header}\n{content}")
    return "\n".join(parts)


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
                MilvusClient, uri=str(config.uri), **config.connection_args
            )
            _client_cache["instance"] = milvus_client
            reranker_config = None
            if config.use_reranker and config.reranker_endpoint:
                reranker_config = {
                    "endpoint": str(config.reranker_endpoint),
                    "model": config.reranker_model,
                    "top_n": config.reranker_top_n,
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
        top_k: int | None = None,
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
        output = await retriever.search(
            query=query,
            collection_name=collection,
            top_k=top_k or config.top_k,
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
