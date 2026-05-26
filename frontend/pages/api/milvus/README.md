# Milvus Collections API

## Current State

`/api/milvus/collections` is a lightweight frontend-side helper, not a real
Milvus control-plane API.

Today it:

- accepts only `GET`
- derives the current user from the session
- returns a small predefined collection list that includes the current
  username and the allow-listed shared upload targets
- labels each entry as either `shared` or `user` in `collectionOptions`
- exposes `collectionPolicy` describing the database name, the shared
  collection names, and the current user's collection
- falls back to a minimal list (current user plus `nvidia`) if the handler errors

See [`collections.ts`](collections.ts) for the implementation and
[`../../../utils/app/milvusCollections.ts`](../../../utils/app/milvusCollections.ts)
for the `SHARED_MILVUS_COLLECTIONS` constants the handler reuses.

## Why It Exists

The frontend needs a fast, predictable source for collection names when users
prepare document-ingestion flows. A stubbed list keeps that UI path working
without forcing collection discovery through the LLM or requiring a separate
backend service endpoint.

## Limitations

- It does not query Milvus directly.
- It does not reflect the real set of collections in the cluster.
- It only exposes the shared targets that `nat_nv_ingest` allows writes to:
  `kubernetes`, `mentalhealth`, `nvidia`, `semianalysis`, and `vetpartner`.
- Shared and user-scoped collections are intentionally separate collection
  classes in one Milvus database, not separate databases.
- It should be treated as a convenience API for the current UI, not as a
  source of truth.

## Recommended Future Direction

Replace this handler with a structured backend endpoint that:

1. Authenticates the caller.
2. Queries Milvus directly.
3. Returns real collection metadata as JSON.
4. Supports filtering by user namespace or collection ownership if needed.

Until then, the doc and implementation should remain explicit that this
endpoint is intentionally a stub.

## Related Components

- [`../../../../builder/nat_nv_ingest/README.md`](../../../../builder/nat_nv_ingest/README.md) for the backend ingest, search, and listing tool that owns the real collection lifecycle
- [`../../../../builder/smart_milvus/README.md`](../../../../builder/smart_milvus/README.md) for the underlying Milvus retriever
