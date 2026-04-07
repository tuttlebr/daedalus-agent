# NvIngest Document Processing Tool

This package registers the Daedalus document-ingestion tool that reads uploaded document references from Redis, sends them through NvIngest, and writes chunked results into Milvus for later retrieval.

## Current Scope

Despite the older PDF-centric naming in some workflows, the implementation is broader than PDF-only. The function is written around NvIngest-compatible document inputs and accepts either:

- `documentRef` for a single uploaded document
- `documentRefs` for a batch of uploaded documents

It can also list current Milvus collections when no document reference is supplied.

## How Daedalus Uses It

1. The frontend uploads documents and stores them in Redis.
2. The frontend or agent passes `documentRef` or `documentRefs` into the backend workflow.
3. This tool retrieves the stored document bytes from Redis.
4. NvIngest extracts structured content.
5. The processed chunks are written into the target Milvus collection.
6. The assistant reports success, partial success, or failure back to the user.

## Configuration

Default config lives in [`src/nat_nv_ingest/configs/config.yml`](src/nat_nv_ingest/configs/config.yml).

```yaml
functions:
  list_collections:
    _type: nat_nv_ingest
    redis_url: "redis://daedalus-redis.daedalus.svc.cluster.local:6379"
    nv_ingest_host: "0.0.0.0"
    nv_ingest_port: 7670
    milvus_uri: "http://0.0.0.0:32073"
    recreate_collection: false

  nat_nv_ingest:
    _type: nat_nv_ingest
    redis_url: "redis://daedalus-redis.daedalus.svc.cluster.local:6379"
    nv_ingest_host: "0.0.0.0"
    nv_ingest_port: 7670
    milvus_uri: "http://0.0.0.0:32073"
    recreate_collection: false
```

Important fields:

| Field | Purpose |
|-------|---------|
| `redis_url` | Source document storage |
| `nv_ingest_host` / `nv_ingest_port` | NvIngest service |
| `milvus_uri` | Milvus destination |
| `chunk_size` / `chunk_overlap` | Chunking behavior |
| `recreate_collection` | Rebuild collection on ingestion |
| `default_collection_name` | Fallback collection when caller does not provide one |

## Runtime Behavior

- If `documentRef` is supplied, one document is processed.
- If `documentRefs` is supplied, the tool processes a batch.
- If neither is supplied, the tool lists available Milvus collections.
- If `collection_name` is omitted, the tool falls back to the username or configured default collection.

## Practical Limits

- Batch ingestion is capped at 5 documents per request in the tool implementation.
- The frontend can store large documents in Redis before this tool runs, but actual ingestion success still depends on document format, size, NvIngest capacity, and cluster resources.
- Uploaded documents are stored in Redis with a 7-day TTL before cleanup.

## Output

The tool returns human-readable status text, for example:

- successful single-document ingestion
- successful or partial batch ingestion summary
- collection listings
- actionable error messages when retrieval, ingestion, or storage fails

## Related Components

- [`../smart_milvus/README.md`](../smart_milvus/README.md) for retrieval after ingestion
- [`../../frontend/pages/api/milvus/README.md`](../../frontend/pages/api/milvus/README.md) for the current frontend-side collection helper
