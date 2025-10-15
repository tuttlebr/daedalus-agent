from nat.builder.builder import Builder, LLMFrameworkEnum
from nat.builder.retriever import RetrieverProviderInfo
from nat.cli.register_workflow import (
    register_retriever_client,
    register_retriever_provider,
)
from nat.data_models.retriever import RetrieverBaseConfig
from pydantic import Field, HttpUrl


class MilvusRetrieverConfig(RetrieverBaseConfig, name="smart_milvus"):
    """
    Configuration for a Retriever which pulls data from a Milvus service.
    """

    model_config = {"populate_by_name": True}

    uri: HttpUrl = Field(description="The uri of Milvus service")
    connection_args: dict = Field(
        description="Dictionary of arguments used to connect to and "
        "authenticate with the Milvus service",
        default={},
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
