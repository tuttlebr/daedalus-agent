# Remaining integration acceptance

Use a disposable deployment, synthetic documents, two test identities and test
credentials. Do not use a production namespace, bucket, collection, memory bank,
OAuth grant or model account for these procedures. The implementation validation
report records the checks actually executed; this document is an acceptance
plan for boundaries unavailable in that environment.

## Complete document pipeline and cancellation

Provision the supported NV-Ingest server and extraction services, its configured
embedding model, authenticated Milvus, object store, Redis and backend/frontend
with loopback-only published test ports. Supply the actual serving images and
model artifacts before choosing their launch commands; the client repository
does not define that entire external deployment.

With the disposable frontend on port 15000 and backend on port 18880, the first
concrete checks are:

```sh
curl --fail-with-body --max-time 15 -c /tmp/daedalus-fixture.cookies \
  -H 'Content-Type: application/json' \
  -d '{"username":"fixture-alice","password":"fixture-password"}' \
  http://127.0.0.1:15000/api/auth/login

curl --fail-with-body --max-time 60 -b /tmp/daedalus-fixture.cookies \
  -F 'file=@/tmp/daedalus-fixture/source.pdf;type=application/pdf' \
  http://127.0.0.1:15000/api/session/documentStorage \
  -o /tmp/daedalus-fixture/upload.json

curl --fail-with-body --max-time 600 -N \
  -H 'x-user-id: fixture-alice' \
  -H 'x-daedalus-internal-token: fixture-internal-token' \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/daedalus-fixture/ingest.json \
  http://127.0.0.1:18880/v1/documents/ingest/stream
```

Create `source.pdf` containing a unique synthetic sentence. Build `ingest.json`
from the returned `documentId` and `sessionId` as
`{"documentRef":{"documentId":"...","sessionId":"..."}}`; omit any shared
collection target. Inspect the explicit complete event and the actual Milvus
database/schema/index. Verify the embedding model, vector dimension, field
names and metric against the effective workflow and query client. Search that
unique sentence through the real registered `user_document_tool`, with Alice's
trusted identity, then attempt the same private reference/collection as Bob.

Download the original through the authenticated document-storage API and compare
its hash. Delete it and verify both the object and metadata disappear while the
separately retained vector follows its documented deletion policy. Repeat with
injected upload, extraction and vector-write failures. Capture partial writes,
retry outcomes and orphan cleanup. Cancel a running extraction, then immediately
submit work for the same collection and inspect the _remote_ job/write timeline.
The implemented thread-owner lock proves local serialization; it does not prove
that a remote job stopped or rolled back its writes.

These commands remain blocked until the real disposable pipeline, model and
test fixture files exist. Mocked extraction, a synthetic vector in Milvus, or an
S3-only browser test does not satisfy this acceptance.

## External media fetcher

Supply the exact VLM serving image/model and a controlled resolver/media server
inside its disposable network. A representative first request is:

```sh
curl --fail-with-body --max-time 15 \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer disposable-test' \
  --data-binary @/tmp/daedalus-vlm-fixture/private-media-request.json \
  http://127.0.0.1:18888/v1/chat/completions
```

The body must use that fixture's model and a multimodal message referring to
its private canary. Repeat with redirects, changed DNS answers, mixed public
and private answers, IPv6/link-local addresses and valid public media. Inspect
canary access logs. The application's initial URL guard does not control a
remote server's subsequent DNS resolution or redirects; no remote weakness was
demonstrated and no speculative media-routing change was made.

## OAuth, IAM and durable external memory

Native NAT tests exercise refresh, adapters and reconstructed clients against
local OAuth fixtures. Completing environment acceptance additionally requires
disposable provider test accounts/scopes and the actual memory/object service
authorization policy. Authorize Alice, retain an offline refresh grant, restart
the worker/backend, expire the short-lived access token, and execute an allowed
read without browser interaction. Repeat as Bob and confirm no grant reuse.
Test revoked consent, a transient provider outage and a refresh error; ambiguous
writes must not be retried automatically. Record service-side identities and
scope checks without tokens. A new deployment's current grants cannot be
established from repository tests.

With a real isolated Hindsight instance, retain and recall distinct facts for
Alice/Bob, restart the service and clients, replace a profile, and clear memory.
Verify durable documents, knowledge pages and automatic context after each
operation. Test bucket IAM from each application identity, including denial of
foreign object reads/deletes. The repository's native HTTP fixtures validate
the client contract but not these remote service policies.

## Physical devices and sustained behavior

Use a physical supported iPhone/iPad to install the PWA and check keyboard
viewport changes, rotation, touch targets, VoiceOver focus, offline launch,
background/reconnect and retained conversations after app restart. Record
device/OS/browser versions, screenshots and observed failures. There is no CLI
command that substitutes for this hardware check; Linux WebKit is separate
evidence.

For model/source quality and sustained load, provision a disposable model and
the complete external tools with fixed synthetic datasets. Record prompt/model
versions, measured latency/RSS, request concurrency, tool calls and costs,
failure injection and citation/source outcomes. Existing bounded allocation
experiments justify the new file/HTTP/script limits; they do not measure real
model quality, pixel-decoder RSS or production throughput.
