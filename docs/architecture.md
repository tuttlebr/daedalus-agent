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

Transient model stream failures use the configured bounded retry budget,
including Switchyard's in-stream upstream transport errors. Recovery retains
completed tool results and any answer text already streamed, asks the model to
continue without repeating that text, and discards tool proposals from the
failed response. A tool only runs after the whole model response completes.
Invalid requests, malformed responses, and explicit incomplete responses keep
their failure status. Exhausted retries return an explicit stream interruption.

Backend application logs are JSON lines on stdout. They record run start/end,
preparation, model attempts and retries, time to the first model event, tool
execution, steering, cancellation, approval waits, and process lifecycle. A final
run summary includes elapsed time, model/tool call counts, and reported token
usage. Failures include their stage, category, and HTTP status when available.
Prompts, answers, tool arguments/results, user identities, credentials, raw
provider errors, and OAuth URLs are excluded from these application logs.

`LOG_LEVEL=INFO` is the default for both processes; `DEBUG` also logs MCP
discovery timings, and `WARN`/`ERROR` reduce progress output. Rust additionally
honors `RUST_LOG` when set. Use `daedalus_runtime=debug` to scope Rust diagnostics
to application events. Uvicorn and other dependencies retain their own log
formats. No Phoenix collector is needed to see application logs.

Follow the backend with:

```bash
kubectl -n daedalus logs -f deployment/daedalus-backend-default -c backend
```

The Rust `span.run_id` and Python `fields.run_id` identify the same frontend job.
To inspect one run, filtering out non-JSON server messages:

```bash
kubectl -n daedalus logs deployment/daedalus-backend-default -c backend --since=30m |
  jq -R 'fromjson? | select((.span.run_id // .fields.run_id) == "RUN_ID")'
```

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
