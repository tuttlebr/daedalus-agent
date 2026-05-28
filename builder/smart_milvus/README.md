# Smart Milvus Retriever

This package provides a Milvus-backed retriever for NeMo Agent workflows used
by Daedalus and related builder configs. It registers a generic
`smart_milvus` retriever client and a higher-level `domain_retriever`
function that maps named domains to curated collections.

## What It Does

- Vector search against Milvus collections
- Optional non-default Milvus database prefixes
- Configurable content and vector field names
- Optional iterator-based retrieval for larger result sets
- Optional reranking through an external reranker endpoint
- Per-domain routing through `domain_retriever` (e.g. `nvidia`, `semianalysis`, `kubernetes`, `veterinarian`, `mentalhealth`)

## Key Behavior

The retriever requires a `query`. If `collection_name` is not bound in
configuration, the caller must also provide `collection_name` at runtime.

When `database_name` is set to something other than `default`, the retriever
automatically checks both plain collection names and `database.collection`
names.

## Configuration

Default example config lives in [`src/smart_milvus/configs/config.yml`](src/smart_milvus/configs/config.yml).

```yaml
retrievers:
  - _type: smart_milvus
    uri: 'http://localhost:19530'
    embedding_model: 'milvus_embedder'
    database_name: 'default'
    collection_name: null
    content_field: null
    top_k: 5
    vector_field_name: 'vector'
    use_reranker: false
```

Important fields:

| Field               | Purpose                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `uri`               | Milvus endpoint                                                                                                     |
| `connection_args`   | Optional Milvus connection or auth arguments; defaults from `MILVUS_USERNAME` / `MILVUS_PASSWORD` or `MILVUS_TOKEN` |
| `embedding_model`   | Query embedder used before search                                                                                   |
| `database_name`     | Optional Milvus database prefix                                                                                     |
| `collection_name`   | Bound default collection name, if any                                                                               |
| `content_field`     | Field containing returned text content                                                                              |
| `vector_field_name` | Vector column name in the collection                                                                                |
| `top_k`             | Number of retrieved candidates                                                                                      |
| `distance_cutoff`   | Optional distance threshold; hits above the cutoff are dropped before reranking                                     |
| `output_fields`     | Optional list of fields to return                                                                                   |
| `search_params`     | Vector search parameters (defaults to `{"metric_type": "L2"}`)                                                      |
| `use_reranker`      | Enables external reranking                                                                                          |
| `reranker_*`        | Endpoint, model, key, and result count for reranking                                                                |

The companion `domain_retriever` function adds a `domain_collections` map
that translates logical domain names into Milvus collections.

## Usage

Bound collection:

```python
results = await retriever.search(query="What is machine learning?")
```

Dynamic collection:

```python
results = await retriever.search(
    query="What changed in the architecture?",
    collection_name="engineering_docs",
)
```

Domain-routed tool call:

```python
output = await search_domain(
    query="What changed in the architecture?",
    domain="nvidia",
)
```

## Reranking

If reranking is enabled, the retriever:

1. performs the normal vector search
2. sends the candidate passages to the reranker endpoint
3. reorders the documents by rerank score
4. stores rerank metadata on each returned document

If reranking fails, the retriever falls back to the original Milvus order.

## Relationship To Daedalus

This retriever is the general Milvus search component. User-uploaded document
retrieval in Daedalus is paired with the ingestion flow from
[`../nat_nv_ingest/README.md`](../nat_nv_ingest/README.md), which writes
processed content into Milvus collections and reuses this retriever for the
`operation="search"` path.

## Requirements

- A reachable Milvus instance
- A configured embedding model
- Optional reranker endpoint plus `NVIDIA_API_KEY` or explicit reranker API key
