# Smart Milvus Retriever

This package provides Milvus-backed retrieval for NeMo Agent workflows used by
Daedalus. It registers a `domain_retriever` function that maps named domains to
curated collections and reuses the `MilvusRetriever` search implementation.

## What It Does

- Vector search against Milvus collections
- Optional non-default Milvus database prefixes
- Configurable content and vector field names
- Optional iterator-based retrieval for larger result sets
- Optional reranking through an external reranker endpoint
- Per-domain routing through `domain_retriever` (e.g. `nvidia`, `semianalysis`, `kubernetes`, `veterinarian`, `mentalhealth`)

## Key Behavior

The domain retriever requires a `query` and a configured logical `domain`.
It resolves the domain to its collection before calling `MilvusRetriever`.

When `database_name` is set to something other than `default`, the retriever
automatically checks both plain collection names and `database.collection`
names.

Synchronous PyMilvus construction and calls run in worker threads so retrieval
does not block the async server. Collection resolution and schema metadata use
a bounded 30-second cache that is cleared after any Milvus client error.

## Configuration

Default example config lives in [`src/smart_milvus/configs/config.yml`](src/smart_milvus/configs/config.yml).

```yaml
functions:
  domain_retriever:
    _type: domain_retriever
    uri: http://localhost:19530
    embedding_model: milvus_embedder
    content_field: text
    vector_field: vector
    top_k: 10
    domain_collections:
      nvidia: nvidia
      kubernetes: kubernetes
```

Important fields:

| Field                | Purpose                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `uri`                | Milvus endpoint                                                                                                     |
| `connection_args`    | Optional Milvus connection or auth arguments; defaults from `MILVUS_USERNAME` / `MILVUS_PASSWORD` or `MILVUS_TOKEN` |
| `embedding_model`    | Query embedder used before search                                                                                   |
| `database_name`      | Optional Milvus database prefix                                                                                     |
| `content_field`      | Field containing returned text content                                                                              |
| `vector_field_name`  | Vector column name in the collection                                                                                |
| `top_k`              | Number of retrieved candidates                                                                                      |
| `distance_cutoff`    | Optional distance threshold; hits above the cutoff are dropped before reranking                                     |
| `output_fields`      | Optional list of fields to return                                                                                   |
| `search_params`      | Vector search parameters (defaults to `{"metric_type": "L2"}`)                                                      |
| `domain_collections` | Logical domain-to-collection mapping                                                                                |
| `use_reranker`       | Enables external reranking                                                                                          |
| `reranker_*`         | Endpoint, model, key, and result count for reranking                                                                |

## Usage

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

`MilvusRetriever` remains the shared search implementation. User-uploaded
document retrieval in Daedalus is paired with the ingestion flow from
[`../nat_nv_ingest/README.md`](../nat_nv_ingest/README.md), which writes
processed content into Milvus collections and reuses this retriever for the
`operation="search"` path.

## Requirements

- A reachable Milvus instance
- A configured embedding model
- Optional reranker endpoint plus `NVIDIA_API_KEY` or explicit reranker API key
