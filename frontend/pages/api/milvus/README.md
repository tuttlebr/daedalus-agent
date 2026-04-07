# Milvus Collections API

## Current State

`/api/milvus/collections` is still a lightweight frontend-side helper, not a real Milvus control-plane API.

Today it:

- accepts only `GET`
- derives the current user from the session
- returns a small predefined collection list that includes the current username
- falls back to a minimal list if the handler errors

See [`collections.ts`](collections.ts) for the implementation.

## Why It Exists

The frontend needs a fast, predictable source for collection names when users prepare document-ingestion flows. A stubbed list keeps that UI path working without forcing collection discovery through the LLM or requiring a separate backend service endpoint.

## Limitations

- It does not query Milvus directly.
- It does not reflect the real set of collections in the cluster.
- It should be treated as a convenience API for the current UI, not as a source of truth.

## Recommended Future Direction

Replace this handler with a structured backend endpoint that:

1. Authenticates the caller.
2. Queries Milvus directly.
3. Returns real collection metadata as JSON.
4. Supports filtering by user namespace or collection ownership if needed.

Until then, keep the doc and the implementation explicit that this endpoint is intentionally a stub.
