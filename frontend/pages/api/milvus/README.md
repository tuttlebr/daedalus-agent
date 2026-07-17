# Milvus Collection Metadata API

## Current Contract

`GET /api/milvus/collections` is the session-protected browser endpoint for
collection metadata. It no longer invents a fixed collection name or returns a
fallback list.

The request path is:

1. `collections.ts` authenticates the browser session and derives the username
   from that trusted context.
2. `server/milvusMetadata.ts` calls the backend
   `GET /v1/metadata/collections` endpoint with the internal API token and the
   trusted user identity.
3. The backend queries Milvus with a bounded timeout and returns the caller's
   hashed private collection plus the allow-listed shared read targets.
4. The frontend validates every collection record and rejects any response that
   marks a shared collection writable.
5. The route returns the validated JSON with
   `Cache-Control: private, no-store`.

The response shape is:

```ts
{
  databaseName: string;
  userCollection: MilvusCollectionMetadata;
  sharedCollections: MilvusCollectionMetadata[];
  writableCollections: MilvusCollectionMetadata[];
}
```

Each collection includes `name`, `displayName`, `scope`, `exists`, `readable`,
and `writable`. `writableCollections` may contain only the authenticated user's
private collection. Shared collections are allow-listed, readable, and
read-only.

## Failure Behavior

- Non-`GET` requests return `405`.
- Missing or invalid browser authentication fails at the shared session
  boundary.
- A backend, Milvus, timeout, or schema-validation failure returns `503`.
- The route doesn't fall back to guessed names or a stale list.

Failing closed is intentional. Document ingestion must not silently target a
different collection when the authoritative metadata source is unavailable.

## Consumers

- `utils/app/queries/milvus.ts` exposes only `writableCollections` to the
  document-ingest selection UI.
- `pages/api/chat/async.ts` and `pages/api/document/process.ts` retrieve the
  same backend metadata before resolving a target collection.
- `utils/app/milvusCollections.ts` validates that an ingest target matches the
  authenticated user's authoritative private collection and records
  provenance. It isn't a discovery source.

## Related Components

- [`collections.ts`](collections.ts) for the browser-facing route
- [`../../../server/milvusMetadata.ts`](../../../server/milvusMetadata.ts) for
  backend transport and response validation
- [`../../../../builder/collection_metadata_api.py`](../../../../builder/collection_metadata_api.py)
  for the authenticated backend endpoint
- [`../../../../builder/nat_nv_ingest/README.md`](../../../../builder/nat_nv_ingest/README.md)
  for ingestion and collection ownership rules
