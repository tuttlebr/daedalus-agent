# Browser test environment

`npm run e2e` requires Docker Compose, OpenSSL, Node 22 and the pinned Playwright
browsers. The runner builds the production application and creates disposable
Redis and object-store services with test credentials.

The browser opens `https://127.0.0.1:15000`. A loopback TLS proxy forwards HTTP
requests to the standalone Next server on 15002 and real WebSocket upgrades to
the sidecar on 15001. The build uses `wss://127.0.0.1:15000`; restart/outage tests
still stop and start the actual sidecar. A one-day synthetic certificate is
created in an OS temporary directory and removed during harness shutdown. Only
the Playwright context and readiness probe ignore this test certificate's trust
error. Chromium service-worker requests additionally trust only this run's
certificate public-key fingerprint. Production Secure cookies and application
TLS settings are unchanged.

Real login helpers check `/api/auth/me` from the browser after navigation; cached
UI identity alone cannot satisfy session acceptance. The browser suite also
checks service-worker control and observes actual WebSocket chat frames. Design
fixtures that explicitly mock authentication remain isolated UI tests.

Use `E2E_SKIP_BUILD=1` only with artifacts built using the same secure WebSocket
URL and current source. The default runner removes its Compose services and
volumes afterward; `E2E_KEEP_SERVICES=1` retains them for local diagnosis. Tests
never require production credentials or deployment access.

`make candidate-browser` selects the built `rust-minimal` backend. It shares the
frontend Redis and S3 fixtures for real document uploads; the separate image
contract suite retains TLS/ACL Redis coverage. The runner requires `E2E_CANDIDATE_REDIS_IMAGE`
and `E2E_MILVUS_PEER_IMAGE` (the retained SDK image for a scripted gRPC peer), verifies
that readiness identifies Rust, and never starts the mock backend in this mode.
The candidate spec exercises real login, stream worker chat, native tool output,
exact cached Unicode output recovery, native memory save/recall, completed-turn
retention/polling, Memory Center editing/clearing, profile JSON append/replacement
uploads through the Workspace drawer, conversation persistence,
steering and Stop. It also uploads a UTF-8 document to S3, verifies inline
truncation, and downloads the complete Markdown attachment through the UI. It checks
the native collection metadata API and the "My documents" selector, including the
hashed private namespace and exclusion of shared collections from write targets.
The ingestion workflow uploads another document to S3 and sends it through the
real stream worker and native SSE endpoint. A paused Milvus insert makes the
progress display observable before the fixture releases the write. The test
checks the complete retained RPC sequence, one document insert, NV-Ingest job
content and the completed answer after reloading. It then searches through the
native document tool, verifies the private collection and acknowledged write
timestamp in the Milvus request, and checks that the retrieved answer survives
another reload. It also retrieves a curated-domain passage, checks the shared
collection and independent read timestamp, and verifies persistence after reload.
The Perplexity workflow sends two related queries to a local provider, renders
the returned rich search cards, checks source URLs and snippets, and reloads the
conversation to verify those cards persist.
The user-interaction workflow renders the native memory-deletion confirmation,
checks that it reports no executable credential, and verifies persistence after
reload before continuing the memory save/recall and Memory Center workflows.
The skill workflow loads native instructions and resources, checks the promoted
model at the fixture provider, and verifies rendered Unicode instructions survive
a conversation reload.
The sandbox workflow writes and reads a conversation file through the native
tool, then publishes its bytes through the actual internal Next.js endpoint to
Redis and S3. It checks download-link repair, exact Unicode download bytes,
persistence after reload, private-marker removal, unauthenticated rejection and
denial of another owner's published artifact.
The weather workflow calls the native NWS tool through real DNS and TLS in a
disposable network namespace. It checks complete and partial results, preserved
units and Unicode location names, forecast links, reload persistence, and Stop
disconnecting an outstanding alerts request. Byte relays connect the backend to
the existing loopback model, Redis, S3, publisher and Milvus peers; no host public
address or route changes and no production network-check bypasses are used.
The loopback fixture control
uses the candidate backend port plus one; it is not an application endpoint.
The default mock suite remains a
separate check; passing it does not establish backend integration.
