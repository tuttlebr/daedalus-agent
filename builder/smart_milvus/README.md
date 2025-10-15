# Smart Milvus NeMo Agent Toolkit Workflow

This is a custom NeMo Agent Toolkit (NAT) workflow that integrates Milvus vector database as a retriever for building intelligent agents with vector search capabilities.

## Features

- **Milvus Integration**: Seamlessly connect to Milvus vector databases
- **Flexible Search**: Supports both standard search and iterator-based search for large result sets
- **Database Support**: Can switch between different Milvus databases using database_name parameter
- **Distance Cutoff**: Filter results based on similarity distance
- **Configurable Fields**: Customize content and vector field names (e.g., "vector", "embedding", etc.)
- **Reranking Support**: Optional integration with reranking models (e.g., NVIDIA NIM) for improved relevance

## Installation

```bash
# Install the workflow
cd builder/smart_milvus
pip install -e .
```

## Configuration

The workflow can be configured through the `config.yml` file. Key configuration options:

```yaml
workflow:
  _type: nat.workflows.react

  retrievers:
    - _type: smart_milvus
      uri: "http://localhost:19530"  # Your Milvus URI
      embedding_model: "text-embedding-ada-002"  # Embedding model to use
      database_name: "default"
      collection_name: null  # Can be set dynamically
      content_field: "text"
      top_k: 5
      vector_field_name: "vector"

      # Optional reranker configuration
      use_reranker: false  # Set to true to enable reranking
      reranker_endpoint: "https://ai.api.nvidia.com/v1/ranking"
      reranker_model: "nvidia/nv-rerankqa-mistral-4b-v3"
      reranker_top_n: 3  # Return top 3 results after reranking
      reranker_api_key: null  # Or set via NVIDIA_API_KEY env var
```

## Usage

### Basic Example

```python
from nat.builder.builder import Builder
from smart_milvus.register import MilvusRetrieverConfig

# Configure the retriever
config = MilvusRetrieverConfig(
    uri="http://localhost:19530",
    embedding_model="text-embedding-ada-002",
    collection_name="my_collection",  # Can be set here or provided at search time
    top_k=10
)

# Use with NAT workflow
builder = Builder()
retriever = await smart_milvus_client(config, builder)

# Search for documents
results = await retriever.search(
    query="What is machine learning?",
    collection_name="my_collection",
    top_k=5
)
```

### Dynamic Collection Selection

When you want the LLM to determine which collection to search, don't set `collection_name` in the config:

```python
# Configure without collection_name - LLM will need to provide it
config = MilvusRetrieverConfig(
    uri="http://localhost:19530",
    embedding_model="text-embedding-ada-002",
    collection_name=None,  # Or omit entirely
    top_k=10
)

# The LLM will need to provide both query AND collection_name
# when using the retriever:
results = await retriever.search(
    query="What is machine learning?",
    collection_name="ml_documents"  # Required parameter
)
```

**Important:** When `collection_name` is not set in the configuration, the LLM MUST provide both `query` and `collection_name` parameters when calling the search function. The tool description will indicate this requirement to the LLM.

### Advanced Features

#### Using Search Iterator for Large Results

```python
retriever = MilvusRetriever(
    client=milvus_client,
    embedder=embedder,
    use_iterator=True  # Enable iterator mode
)
```

#### Working with Different Databases

```python
# Configure retriever to use a specific database
config = MilvusRetrieverConfig(
    uri="http://localhost:19530",
    embedding_model="text-embedding-ada-002",
    database_name="my_database",  # Specify non-default database
    collection_name="my_collection",
    vector_field_name="embedding",  # Custom vector field name
    top_k=10
)

# The retriever will automatically handle database prefixing
# when searching collections
```

#### Setting Distance Cutoff

```python
results = await retriever.search(
    query="example query",
    collection_name="my_collection",
    top_k=100,
    distance_cutoff=0.8  # Only return results with distance <= 0.8
)
```

#### Using Reranking for Better Relevance

The workflow supports reranking to improve search relevance using external reranking models:

```python
# Configure with reranking enabled
config = MilvusRetrieverConfig(
    uri="http://localhost:19530",
    embedding_model="text-embedding-ada-002",
    collection_name="my_collection",
    top_k=20,  # Retrieve more candidates
    use_reranker=True,
    reranker_endpoint="https://ai.api.nvidia.com/v1/ranking",
    reranker_model="nvidia/nv-rerankqa-mistral-4b-v3",
    reranker_top_n=5,  # Return only top 5 after reranking
    reranker_api_key="your-api-key"  # Or set NVIDIA_API_KEY env var
)

# Results will be reranked and include metadata
results = await retriever.search(
    query="What is machine learning?",
    collection_name="my_collection"
)

# Each result includes reranking metadata
for doc in results.results:
    print(f"Content: {doc.page_content}")
    print(f"Rerank Score: {doc.metadata.get('rerank_score')}")
    print(f"Rerank Position: {doc.metadata.get('rerank_position')}")
```

**Reranking Process:**
1. Initial vector search retrieves `top_k` candidates
2. Reranker scores each candidate against the query
3. Results are reordered by reranker scores
4. Only `reranker_top_n` results are returned

## API Reference

### MilvusRetrieverConfig

Configuration class for the Milvus retriever:

- `uri`: The URI of the Milvus service
- `connection_args`: Additional connection arguments
- `embedding_model`: Name of the embedding model to use
- `database_name`: Milvus database name (default: "default"). When using a non-default database, the retriever automatically handles collection name prefixing
- `collection_name`: Collection to search (can be set dynamically)
- `content_field`: Field containing the main text (default: "content")
- `vector_field_name`: Field containing vectors (default: "vector"). This allows you to work with collections that use different vector field names
- `top_k`: Number of results to return
- `search_params`: Vector search parameters
- `output_fields`: Fields to return in results
- `use_reranker`: Enable reranking for better relevance (default: false)
- `reranker_endpoint`: URL of the reranker service
- `reranker_model`: Reranker model to use
- `reranker_top_n`: Number of results to return after reranking
- `reranker_api_key`: API key for reranker (or use NVIDIA_API_KEY env var)

### MilvusRetriever

Main retriever class with methods:

- `search()`: Perform vector search
- `bind()`: Bind default parameters
- `get_unbound_params()`: Get list of required parameters

## Development

To contribute or modify the workflow:

1. Make changes to the source files in `src/smart_milvus/`
2. Test your changes
3. Update the version in `pyproject.toml` if needed
4. Reinstall: `pip install -e .`

## Requirements

- Python 3.11-3.13
- nvidia-nat[all]@git+https://github.com/NVIDIA/NeMo-Agent-Toolkit.git@develop
- pymilvus~=2.4
- requests>=2.31.0
