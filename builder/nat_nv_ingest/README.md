# NvIngest Document Processing Tool

This package registers the Daedalus document tool that ingests, searches, and
lists user-uploaded documents. Redis stores bounded ownership metadata and an
object reference, while the document bytes are streamed through the dedicated
S3-compatible document store. Ingestion resolves that reference, sends the
bytes through NvIngest, and writes chunked results into Milvus. Search hands
queries to the [`smart_milvus`](../smart_milvus/) retriever scoped to the
requesting user.

## What It Does

- Registers a single `user_document_tool(operation, ...)` function with three operations:
  - `operation="ingest"` for `documentRef` (single document) or `documentRefs` (batch)
  - `operation="search"` for natural-language queries against the user's collection
  - `operation="list_collections"` to enumerate the caller's private collection
    and allow-listed shared collections without exposing other tenants
- Streams structured progress (`fetching`, `submitting`, `processing`, `indexing`, `postprocessing`, etc.) through an optional callback for the document ingest HTTP route
- Routes every user upload to a private per-user collection; shared collection writes are rejected
- Allows search reads from private or allow-listed shared collections
- Returns extracted markdown plus a structured summary footer that the frontend parses for the upload-progress UI

Despite the older PDF-centric naming in some workflows, the tool is broader
than PDF-only. It accepts any NvIngest-compatible format: PDFs, DOCX, PPTX,
images, audio, and plain text. It uses the appropriate extraction settings
based on the filename.

## Configuration

The backend pins `nv-ingest-client` and `nv-ingest-api` to 26.3.0 as a matched
pair. Deploy the external NV-Ingest service at the matching 26.3 release before
rolling out this backend image. Treat the service upgrade as a rollout gate,
because running a different client and service schema can reject extraction
jobs after the backend has started successfully.

The package-level smoke-test config lives in
[`src/nat_nv_ingest/configs/config.yml`](src/nat_nv_ingest/configs/config.yml).
It contains no fallback credentials or client-side `0.0.0.0` endpoints and
requires its connection settings from the environment. Production uses the
reviewed `backend/tool-calling-config.yaml` workflow.

```yaml
functions:
  user_document_tool:
    _type: nat_nv_ingest
    redis_url: ${REDIS_URL}
    nv_ingest_host: ${NV_INGEST_HOST}
    nv_ingest_port: ${NV_INGEST_PORT}
    milvus_uri: ${MILVUS_URI}
    minio_endpoint: ${MINIO_ENDPOINT}
    minio_access_key: ${MINIO_ACCESS_KEY}
    minio_secret_key: ${MINIO_SECRET_KEY}
    minio_bucket: ${MINIO_BUCKET}
    chunk_size: 1024
    chunk_overlap: 150
    embedder_dim: 2048
    recreate_collection: false
```

Important fields:

| Field                                                                  | Purpose                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `redis_url`                                                            | Source document metadata and object references                                            |
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

Object-backed uploads use the `DOCUMENT_OBJECT_ENDPOINT`,
`DOCUMENT_OBJECT_ACCESS_KEY`, `DOCUMENT_OBJECT_SECRET_KEY`, optional
`DOCUMENT_OBJECT_SESSION_TOKEN`, `DOCUMENT_OBJECT_BUCKET`,
`DOCUMENT_OBJECT_REGION`, and `DOCUMENT_OBJECT_PREFIX` environment variables.
`DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS` bounds connect and read operations from
100 through 900,000 milliseconds and defaults to 300,000. Invalid timeout
configuration fails closed before an object request is made. Give this
credential read access only to the configured document bucket and prefix.

## Function Signature

The registered function is:

```python
user_document_tool(
    operation: str = "search",
    query: str = "",
    collection_name: str | None = None,
    collection_scope: str | None = None,
    provenance: dict[str, Any] | None = None,
    documentRef: dict[str, Any] | None = None,
    documentRefs: list[dict[str, Any]] | None = None,
    top_k: int | None = None,
    filters: str | None = None,
    chunk_size: int | None = None,
    chunk_overlap: int | None = None,
) -> str
```

The backend derives identity from trusted NAT request metadata. Legacy direct
callers may still supply `username` or `input_message`, but `username` is only
an equality assertion against request identity and is not in the LLM schema.

## Daedalus Integration

1. The frontend streams document bytes into the S3-compatible document store and writes bounded ownership metadata plus the exact object reference to Redis under the `document:<sessionId>:<documentId>` key shape.
2. The frontend or agent calls the tool with `operation="ingest"` and `documentRef` (or `documentRefs` for batches); the backend supplies the authenticated identity.
3. The tool retrieves each document, runs NV-Ingest extraction in a worker thread, and writes the resulting chunks into Milvus.
4. The frontend or agent later calls the same tool with `operation="search"` to retrieve passages for the same user.
5. The assistant reports success, partial success, or failure back to the user, with footer metadata the upload UI surfaces in its progress badge.

## HTTP Routes (bypass the agent loop)

`document_ingest_api.py` injects a `/v1/documents/*` FastAPI router that reuses
this package's extraction code without routing through the LLM (the router
corrupts exact-args like `username`/`documentRef`):

- `POST /v1/documents/ingest` and `/ingest/stream`: bulk ingest into Milvus.
- `POST /v1/documents/extract`: single document to markdown JSON, **truncated**
  to `char_limit` (default 50K) for inline LLM consumption.
- `POST /v1/documents/markdown`: **doc-to-markdown download.** Returns the
  _entire_ document as a `text/markdown` attachment (`Content-Disposition:
attachment; filename="<name>.md"`). Untruncated, bounded only by
  `DOCUMENT_MARKDOWN_MAX_CHARS` (default 20,000,000). The download filename is
  derived from the stored filename, sanitized (path components and unsafe
  characters stripped) and given a `.md` extension. Ownership is enforced via
  the stored document's `userId`; failures map to 403/404/413/422/504.

## Collection Scoping

Private collections use a short readable subject prefix plus the full SHA-256
of the immutable authenticated subject. Runtime reads and writes don't fall
back to legacy normalized-only names because two users can share one legacy
name. Legacy collections are migrated with the operator-only
[`milvus_collection_migration.py`](../milvus_collection_migration.py) command.
It isn't registered as a NAT function or exposed to the model.

### Private collection migration runbook

Before a migration, drain ingestion and retrieval for the selected user. Take
a Milvus backup, then create a JSON file containing the complete inventory of
immutable authenticated subjects. The executor refuses the migration if any
two inventory entries normalize to the same legacy collection, if the selected
subject isn't present exactly once, or if either collection can't provide a
stable primary field. NV-Ingest collections use AutoID, so the executor
temporarily enables Milvus `allow_insert_auto_id` on the target to preserve
the legacy IDs during retry-safe upserts, then restores the target's prior
setting before verification.

Set authenticated `MILVUS_URI` plus `MILVUS_TOKEN`, or both
`MILVUS_USERNAME` and `MILVUS_PASSWORD`. Set a separate, randomly generated
`MILVUS_MIGRATION_OPERATOR_TOKEN` of at least 32 characters. Put the same
operator token in a mode-0600 file mounted only into the maintenance process.
The token isn't accepted on the command line and isn't written to the audit
log.

Run one subject at a time from the backend image or the `builder/` directory:

```bash
python /workspace/milvus_collection_migration.py migrate \
  --subject alice@example.com \
  --subject-inventory /run/migration/authenticated-subjects.json \
  --operator-id operator@example.com \
  --operator-token-file /run/secrets/milvus-migration-operator-token \
  --audit-log /var/lib/daedalus-migrations/milvus-private-collections.jsonl
```

The hashed target must be missing or empty when the first attempt starts. The
executor clones the source schema and indexes when needed, copies rows in
bounded batches with primary-key upserts, and returns `verified` only after all
of these checks pass:

- a strong-consistency row count is identical in source and target;
- canonical field schemas are identical;
- index names, fields, types, metrics, and parameters are identical; and
- every source and target index reports a finished state with no pending rows.

The mode-0600 JSONL audit is append-only and hash-chained. It records the named
operator, exact subject and collections, count and schema/index fingerprints,
failure details, and the verified migration ID. A retry of a completed
migration rechecks the marker evidence without copying again. An interrupted
attempt can resume only with the same subject-inventory fingerprint and while
the legacy source still matches its recorded snapshot. A nonblocking audit
lock refuses concurrent operators. Index and count convergence is bounded to
120 seconds by default and can be adjusted with
`--verification-timeout-seconds`. The command never calls a Milvus drop,
truncate, rename, delete, or alias operation.

To mark a verified migration for rollback:

```bash
python /workspace/milvus_collection_migration.py rollback \
  --subject alice@example.com \
  --subject-inventory /run/migration/authenticated-subjects.json \
  --operator-id operator@example.com \
  --operator-token-file /run/secrets/milvus-migration-operator-token \
  --audit-log /var/lib/daedalus-migrations/milvus-private-collections.jsonl \
  --reason "Application smoke test failed after cutover"
```

Rollback is deliberately logical and non-destructive. It revalidates both
collections, appends a `migration_rolled_back` marker, and leaves both
collections and every row intact. Use that marker as the gate for the
deployment rollback while the user remains drained. The runtime never falls
back to a legacy collection on its own. A migration that has been rolled back
can't be restarted against the same audit log without a new operator review.

Unit tests use a stateful Milvus double. Before production cutover, run the
command against the deployed Milvus version and prove schema reconstruction,
index completion, restart from an interrupted batch, application reads from
the hashed collection, and deployment rollback from the retained legacy
collection.

- Shared and user-scoped collections intentionally live in the same Milvus database.
- Search may read the allow-listed shared collections `kubernetes`, `mentalhealth`, `nvidia`, `semianalysis`, and `vetpartner`.
- User-facing ingestion rejects those shared targets. Every accepted write is scoped to the authenticated user's private collection.
- `collection_scope` mismatches are rejected and optional `provenance` remains available for private-ingest audit context.

## Practical Limits

- Large `documentRefs` requests are processed in internal batches controlled by `max_documents_per_batch` and `batch_concurrency`.
- The frontend can stream large documents to object storage before this tool runs, but actual ingestion success still depends on document format, size, NvIngest capacity, and cluster resources.
- Uploaded object references and their objects default to a 7-day lifetime before cleanup.
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
