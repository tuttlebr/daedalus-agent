import os

from nat.builder.builder import Builder, LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.builder.retriever import RetrieverProviderInfo
from nat.cli.register_workflow import (
    register_function,
    register_retriever_client,
    register_retriever_provider,
)
from nat.data_models.function import FunctionBaseConfig
from nat.data_models.retriever import RetrieverBaseConfig
from pydantic import Field, HttpUrl


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


class MilvusRetrieverConfig(RetrieverBaseConfig, name="smart_milvus"):
    """
    Configuration for a Retriever which pulls data from a Milvus service.
    """

    model_config = {"populate_by_name": True}

    uri: HttpUrl = Field(description="The uri of Milvus service")
    connection_args: dict = Field(
        description="Dictionary of arguments used to connect to and "
        "authenticate with the Milvus service",
        default_factory=_milvus_connection_args_from_env,
    )
    embedding_model: str = Field(
        description="The name of the embedding model to use for vectorizing "
        "the query"
    )
    database_name: str = Field(
        description="The name of the Milvus database to use", default="default"
    )
    collection_name: str | None = Field(
        description="The name of the milvus collection to search", default=None
    )
    content_field: str = Field(
        description="Name of the primary field to store/retrieve",
        default="content",
        alias="primary_field",
    )
    top_k: int | None = Field(
        gt=0, description="The number of results to return", default=None
    )
    distance_cutoff: float | None = Field(
        default=None,
        description="Optional distance threshold; hits with distance above this value are dropped before reranking",
    )
    output_fields: list[str] | None = Field(
        default=None,
        description="A list of fields to return from the datastore. "
        "If 'None', all fields but the vector are returned.",
    )
    search_params: dict = Field(
        default={"metric_type": "L2"},
        description="Search parameters to use when performing vector search",
    )
    vector_field_name: str = Field(
        default="vector",
        description="Name of the field to compare with the vectorized query",
        alias="vector_field",
    )
    description: str | None = Field(
        default="Search for relevant documents in Milvus vector database. "
        "REQUIRED PARAMETERS: query (search text) and collection_name "
        "(Milvus collection to search in, unless pre-configured).",
        description="If present it will be used as the tool description",
        alias="collection_description",
    )

    # Reranker configuration
    use_reranker: bool = Field(
        default=False,
        description="Whether to use a reranker to improve result relevance",
    )
    reranker_endpoint: HttpUrl | None = Field(
        default=None, description="The endpoint URL for the reranker service"
    )
    reranker_model: str | None = Field(
        default=None,
        description="The reranker model to use "
        "(e.g., 'nvidia/nv-rerankqa-mistral-4b-v3')",
    )
    reranker_top_n: int | None = Field(
        default=None,
        description="Number of top results to return after reranking. "
        "If None, returns all reranked results up to top_k",
    )
    reranker_api_key: str | None = Field(
        default=None,
        description="API key for the reranker service. Can also be set via "
        "NVIDIA_API_KEY environment variable",
    )


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


@register_retriever_provider(config_type=MilvusRetrieverConfig)
async def smart_milvus(retriever_config: MilvusRetrieverConfig, builder: Builder):
    yield RetrieverProviderInfo(
        config=retriever_config,
        description="An adapter for a Milvus data store to use with a "
        "Retriever Client",
    )


@register_retriever_client(config_type=MilvusRetrieverConfig, wrapper_type=None)
async def smart_milvus_client(config: MilvusRetrieverConfig, builder: Builder):
    from pymilvus import MilvusClient
    from smart_milvus.smart_milvus_function import MilvusRetriever

    embedder = await builder.get_embedder(
        embedder_name=config.embedding_model, wrapper_type=LLMFrameworkEnum.LANGCHAIN
    )

    milvus_client = MilvusClient(uri=str(config.uri), **config.connection_args)

    # Prepare reranker configuration
    reranker_config = None
    if config.use_reranker and config.reranker_endpoint:
        reranker_config = {
            "endpoint": str(config.reranker_endpoint),
            "model": config.reranker_model,
            "top_n": config.reranker_top_n,
            "api_key": config.reranker_api_key,
        }

    retriever = MilvusRetriever(
        client=milvus_client,
        embedder=embedder,
        content_field=config.content_field,
        database_name=(
            config.database_name if config.database_name != "default" else None
        ),
        vector_field_name=config.vector_field_name,
        reranker_config=reranker_config,
    )

    # Using parameters in the config to set default values which can be
    # overridden during the function call.
    optional_fields = [
        "collection_name",
        "top_k",
        "distance_cutoff",
        "output_fields",
        "search_params",
        # "vector_field_name" is already set in constructor, don't bind it again
    ]
    model_dict = config.model_dump()
    optional_args = {
        field: model_dict[field]
        for field in optional_fields
        if model_dict[field] is not None
    }

    retriever.bind(**optional_args)

    yield retriever


@register_function(config_type=DomainRetrieverConfig)
async def domain_retriever_function(config: DomainRetrieverConfig, builder: Builder):
    """Register one routed tool for all curated Milvus knowledge domains."""

    from pymilvus import MilvusClient
    from smart_milvus.smart_milvus_function import MilvusRetriever

    _retriever_cache: dict[str, MilvusRetriever] = {}

    async def _get_retriever() -> MilvusRetriever:
        if "instance" not in _retriever_cache:
            embedder = await builder.get_embedder(
                embedder_name=config.embedding_model,
                wrapper_type=LLMFrameworkEnum.LANGCHAIN,
            )
            milvus_client = MilvusClient(uri=str(config.uri), **config.connection_args)
            reranker_config = None
            if config.use_reranker and config.reranker_endpoint:
                reranker_config = {
                    "endpoint": str(config.reranker_endpoint),
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
                vector_field_name=config.vector_field_name,
                reranker_config=reranker_config,
            )
        return _retriever_cache["instance"]

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

    yield FunctionInfo.from_fn(
        search_domain,
        description=(
            "Search one curated Milvus knowledge domain. Args: query, domain "
            "(nvidia, semianalysis, kubernetes, veterinarian, mentalhealth), "
            "optional top_k and filters. Returns reranked passages with metadata."
        ),
    )
