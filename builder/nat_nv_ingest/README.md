# NvIngest Document Processing Tool

This package registers the Daedalus document tool that ingests, searches, and
lists user-uploaded documents. Ingestion reads uploaded document references
from Redis, sends them through NvIngest, and writes chunked results into
Milvus; search hands queries to the [`smart_milvus`](../smart_milvus/) retriever
scoped to the requesting user.

## What It Does

- Registers a single `user_document_tool(operation, ...)` function with three operations:
  - `operation="ingest"` for `documentRef` (single document) or `documentRefs` (batch)
  - `operation="search"` for natural-language queries against the user's collection
  - `operation="list_collections"` to enumerate available Milvus collections
- Streams structured progress (`fetching`, `submitting`, `processing`, `indexing`, `postprocessing`, etc.) through an optional callback for the document ingest HTTP route
- Routes shared and per-user uploads to the right collection automatically
- Validates `collection_scope` (`shared` or `user`) and logs `provenance` metadata for every ingest request
- Returns extracted markdown plus a structured summary footer that the frontend parses for the upload-progress UI

Despite the older PDF-centric naming in some workflows, the tool is broader
than PDF-only. It accepts any NvIngest-compatible format — PDFs, DOCX, PPTX,
images, audio, and plain text — and uses the appropriate extraction settings
based on the filename.

## Configuration

Default config lives in [`src/nat_nv_ingest/configs/config.yml`](src/nat_nv_ingest/configs/config.yml).

```yaml
functions:
  list_collections:
    _type: nat_nv_ingest
    redis_url: 'redis://daedalus-redis.daedalus.svc.cluster.local:6379'
    nv_ingest_host: '0.0.0.0'
    nv_ingest_port: 7670
    milvus_uri: 'http://0.0.0.0:32073'
    minio_endpoint: '0.0.0.0:9000'
    minio_access_key: 'minioadmin'
    minio_secret_key: 'minioadmin'
    chunk_size: 1024
    chunk_overlap: 150
    embedder_dim: 2048
    recreate_collection: false

  nat_nv_ingest:
    _type: nat_nv_ingest
    redis_url: 'redis://daedalus-redis.daedalus.svc.cluster.local:6379'
    nv_ingest_host: '0.0.0.0'
    nv_ingest_port: 7670
    milvus_uri: 'http://0.0.0.0:32073'
    minio_endpoint: '0.0.0.0:9000'
    minio_access_key: 'minioadmin'
    minio_secret_key: 'minioadmin'
    chunk_size: 1024
    chunk_overlap: 150
    embedder_dim: 2048
    recreate_collection: false
```

Important fields:

| Field                                                                  | Purpose                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `redis_url`                                                            | Source document storage                                                                   |
| `nv_ingest_host` / `nv_ingest_port`                                    | NvIngest service                                                                          |
| `milvus_uri`                                                           | Milvus destination                                                                        |
| `milvus_username` / `milvus_password`                                  | Optional Milvus auth for direct clients and NV-Ingest VDB upload                          |
| `milvus_token`                                                         | Optional Milvus token; `username:password` tokens are also split for NV-Ingest VDB upload |
| `minio_endpoint` / keys / `bucket`                                     | MinIO target for extracted assets                                                         |
| `chunk_size` / `chunk_overlap`                                         | Chunking behavior                                                                         |
| `embedder_dim` / `tokenizer`                                           | Embedding dimension and tokenizer used during chunking                                    |
| `recreate_collection`                                                  | Rebuild collection on ingestion                                                           |
| `default_collection_name`                                              | Fallback collection when caller does not provide one                                      |
| `database_name`                                                        | Milvus database name used by the user-document retriever                                  |
| `use_v2_api` / `pdf_pages_per_chunk`                                   | Enables NV-Ingest V2 server-side PDF chunking                                             |
| `enable_image_filter` / `enable_captioning`                            | Image pipeline toggles                                                                    |
| `caption_*`                                                            | VLM endpoint and credentials for image captioning                                         |
| `worker_pool_size`                                                     | NvIngestClient worker pool size                                                           |
| `batch_concurrency` / `max_documents_per_batch`                        | Concurrency limits for batch ingestion                                                    |
| `ingest_max_retries` / `ingest_retry_delay` / `ingest_timeout_seconds` | Robustness controls                                                                       |
| `embedder_name` / `content_field` / `vector_field`                     | Retrieval wiring for the `search` operation                                               |
| `top_k` / `distance_cutoff` / `output_fields` / `search_params`        | Search defaults                                                                           |
| `use_reranker` / `reranker_*`                                          | Optional reranking for search                                                             |

## Function Signature

The registered function is:

```python
user_document_tool(
    operation: str = "search",
    query: str = "",
    username: str = "",
    collection_name: str | None = None,
    collection_scope: str | None = None,
    provenance: dict[str, Any] | None = None,
    documentRef: dict[str, Any] | None = None,
    documentRefs: list[dict[str, Any]] | None = None,
    top_k: int | None = None,
    filters: str | None = None,
    chunk_size: int | None = None,
    chunk_overlap: int | None = None,
    input_message: dict[str, Any] | None = None,
) -> str
```

`input_message` is kept for backwards compatibility with raw request payloads.

## Daedalus Integration

1. The frontend uploads documents and stores them in Redis with the shared `document:<sessionId>:<documentId>` key shape.
2. The frontend or agent calls the tool with `operation="ingest"` and `documentRef` (or `documentRefs` for batches), plus the authenticated `username` and an optional `collection_name`.
3. The tool retrieves each document, runs NV-Ingest extraction in a worker thread, and writes the resulting chunks into Milvus.
4. The frontend or agent later calls the same tool with `operation="search"` to retrieve passages for the same user.
5. The assistant reports success, partial success, or failure back to the user, with footer metadata the upload UI surfaces in its progress badge.

## HTTP Routes (bypass the agent loop)

`document_ingest_api.py` injects a `/v1/documents/*` FastAPI router that reuses
this package's extraction code without routing through the LLM (the router
corrupts exact-args like `username`/`documentRef`):

- `POST /v1/documents/ingest` and `/ingest/stream` — bulk ingest into Milvus.
- `POST /v1/documents/extract` — single document → markdown JSON, **truncated**
  to `char_limit` (default 50K) for inline LLM consumption.
- `POST /v1/documents/markdown` — **doc-to-markdown download.** Returns the
  _entire_ document as a `text/markdown` attachment (`Content-Disposition:
attachment; filename="<name>.md"`). Untruncated, bounded only by
  `DOCUMENT_MARKDOWN_MAX_CHARS` (default 20,000,000). The download filename is
  derived from the stored filename, sanitized (path components and unsafe
  characters stripped) and given a `.md` extension. Ownership is enforced via
  the stored document's `userId`; failures map to 403/404/413/422/504.

## Collection Scoping

- Shared and user-scoped collections intentionally live in the same Milvus database.
- The allow-listed shared collection names are `kubernetes`, `mentalhealth`, `nvidia`, `semianalysis`, and `vetpartner`; they are used exactly as supplied.
- Any other arbitrary name is scoped to the authenticated user before it reaches Milvus.
- Callers can pass `collection_scope` (`shared` or `user`) and `provenance` metadata. Scope mismatches are rejected, and provenance is logged so shared-corpus writes carry uploader, source, and target context.

## Practical Limits

- Large `documentRefs` requests are processed in internal batches controlled by `max_documents_per_batch` and `batch_concurrency`.
- The frontend can store large documents in Redis before this tool runs, but actual ingestion success still depends on document format, size, NvIngest capacity, and cluster resources.
- Uploaded documents are stored in Redis with a 7-day TTL before cleanup.
- A single document ingest is bounded by `ingest_timeout_seconds`; on timeout, any remaining batch items are marked as skipped so the user gets actionable feedback fast.

## Output

The tool returns human-readable status text, for example:

- successful single-document ingestion (markdown body plus chunk and page counts)
- successful or partial batch ingestion summary
- collection listings
- formatted user-document search passages
- actionable error messages when retrieval, ingestion, or storage fails

## Related Components

- [`../smart_milvus/README.md`](../smart_milvus/README.md) for retrieval after ingestion and the underlying `MilvusRetriever`
- [`../../frontend/pages/api/milvus/README.md`](../../frontend/pages/api/milvus/README.md) for the frontend-side collection helper
