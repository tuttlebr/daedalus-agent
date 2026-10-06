# Runtime architecture

The browser connects to the Next.js application and its authenticated WebSocket
server. Redis owns queued jobs, streamed output, conversation history, and
approval records. The stream worker calls the Rust backend's
`POST /v1/chat/completions` endpoint.

`builder/runtime` uses Rig for OpenAI Responses or Chat Completions, Tokio for
concurrency, and Axum for HTTP. Its application-owned loop controls model calls,
bounded tool batches, steering, cancellation, and terminal events. It never
executes a partial model tool call. Each run has a bounded, authenticated inbox;
duplicate command IDs are idempotent, and conflicting reuse is rejected.

Responses streams from compatible gateways may omit envelope metadata. The
runtime supplies missing sequence numbers and an unknown timestamp, and reuses
message IDs previously observed at the same output index. Content, tool call
identities, output indices, and completion status still pass Rig's validation.
Provider failure logs include the error category and HTTP status without
recording request bodies, response bodies, or credentials.

`builder/daedalus_runtime` runs Python tools on loopback port 8001. The Rust
process is the public backend on port 8000. The supervisor starts both, waits
for Python startup, forwards termination signals, and exits if either fails.
Python owns the typed native tool registry, official MCP client sessions,
Google OAuth, exact-call approvals, retrieval, images, and other existing APIs.
Internal tool endpoints require the shared internal credential and are blocked
at the public Rust proxy. Tool identities come from authenticated request
context, never model arguments.

Steering uses `steer_job` over the existing WebSocket connection. The server
revalidates the login and stored job owner, then forwards a UUID command to
`POST /v1/runs/{run_id}/control`. During model generation, steering closes that
generation and discards incomplete tool calls. During tool execution, it keeps
started calls and their results, skips calls still queued, and adds the user's
direction before the next model round. A direction cannot undo a remote change
that has already started. Stop uses the existing job cancellation path.

No NeMo Agent Toolkit distribution, plugin discovery, workflow builder, runner,
or monkeypatch is installed. Existing `nat_helpers` package names, frontend
`natBaseUrl` fields, and OAuth Redis key prefixes remain data compatibility
names. Python leaf tools still use LangChain model clients where needed; the
agent loop does not use LangChain or LangGraph.

Google refresh grants remain at their existing per-user Redis keys. The new
reader accepts the previous stored format and writes versioned grants without
losing refresh tokens. Model or user instructions cannot bypass approval:
the MCP gate binds a one-use credential to the user, server, operation, and
canonical arguments. Uncertain remote mutations are never automatically retried.

Optional Phoenix export records content-free run counters and tool phase spans.
It omits prompts, tool arguments, results, identities, and credentials. The run
records how many responses actually reported usage so missing usage is not
mistaken for a measured zero. Steering and completion remain independent of
telemetry availability.
