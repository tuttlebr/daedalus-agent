# Codebase review and remediation, 19 October 2026

Starting revision: `306f1970ebd2a67f11c66a087ec335d0492978d1`, clean `main`. The
review covers bugs, dead code, conflicting contracts, latency, and test/hook
correctness across the browser, Next.js APIs, stream worker, WebSocket server,
Rust runtime and native tools, Python tools and autonomy, shared protocol,
hooks, CI and delivery configuration. The [18 October review](codebase-review-2026-10-18.md)
and its [follow-up](codebase-review-2026-10-18-followup.md) were treated as
evidence, not as current findings. Stored data formats, Redis key names and API
shapes are unchanged except where noted; no data migration is required.

## Confirmed findings and remedies

Each regression test below failed on the original code (or a controlled
mutation of the fixed code) and passes with the remedy.

| Priority | Trigger and root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Remedy and regression evidence                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| High     | Upload routes used the `sid` login cookie as the attachment `sessionId`. The login token was returned in JSON, stored in conversation references, sent to the model in `documentRef`/`imageRef` hints, written into object keys and metadata, and forwarded to Python records.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Uploads use a one-way storage scope (`getStorageSessionId`). Access for records with an owner still uses the user ID. `storageSessionScope.test.ts` exercises the real cookie helpers. Invalidate existing `auth-session:*` keys when deploying. |
| High     | One malformed `<chart>` or `<searchresults>` payload threw during render and replaced the whole app with the root error page; the saved message repeated the crash on reload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Each rich block has its own error boundary and fallback. `RichContent.test.tsx`.                                                                                                                                                                 |
| High     | Search-result and autonomy-feed links rendered `javascript:`/`data:` URLs from tool or agent data, bypassing the sanitizer's protocol policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Shared `safeExternalUrl` (absolute http(s) only) for SearchResults, FeedItem and StepDetails.                                                                                                                                                    |
| High     | The Markdown sanitizer allowed any class on every element, so model or tool HTML could use the app's own utility classes (`fixed inset-0 z-50 opacity-0`) to draw an invisible full-screen link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Only renderer classes survive: the default code-language, task-list and footnote classes and the math wrappers that rehype-katex reads. Rendered test plus schema test.                                                                          |
| High     | A Markdown render failure after the NV-Ingest pipeline had written to Milvus was retried as a whole (up to three attempts), duplicating every chunk; the Python rollback path also replayed after its SDK write began.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Post-write failures are `CommittedWrite`/`UncertainVectorWriteError` and are not retried. The frozen `render-error` expectation is trimmed to its first attempt in test code.                                                                    |
| High     | `/_next/image` (no login) allowed `http://localhost` on any port, `*.nvidia.com` and SVG, so anonymous callers could probe loopback ports through the frontend.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | No remote image sources are used; the patterns and SVG allowance are removed. Test uses Next's own matcher.                                                                                                                                      |
| Medium   | A panic anywhere in a Rust run skipped `runs.remove`, leaking the user's run slot, leaving the conversation at 409 until restart and ending the stream without a terminal event.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The run supervisor contains panics and always emits the terminal error and releases the slot.                                                                                                                                                    |
| Medium   | A complete answer whose stream failed before `response.completed` was reported as "Agent execution failed" when the resumed attempt had nothing to add.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | An empty continuation completes an already streamed answer.                                                                                                                                                                                      |
| Medium   | Jobs awaiting OAuth were left live, with no owner, when the backend stream ended: the obsolete handoff branch released the slots and acknowledged the queue entry although Rust ends the run (and its OAuth wait) with the stream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The reader always finalizes; the handoff branch is removed. Older parked records can still be cancelled.                                                                                                                                         |
| Medium   | The WebSocket server answered a Redis failure while reading streaming state with an empty snapshot, which the browser applied, showing running answers as idle after reconnect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The error propagates; initialization closes with 1011 and the client reconnects.                                                                                                                                                                 |
| Medium   | Browser lifecycle: each finished turn was saved twice; the browser's save dropped the worker's `metadata.jobId` (approvals, traces and recovery correlate on it); a job finishing during a brief disconnect stayed "streaming" for about 30 s; deleting a streaming conversation left its job running and blocked list sync; Retry resent a steering direction; Stop could save without the last tokens; approval cards stuck on a failed first read.                                                                                                                                                                                                                                                                                                                                                         | Fixed in `ChatView`, `useAsyncChat` and `McpApprovalCard`, each with a hook or component regression.                                                                                                                                             |
| Medium   | Memory Center refreshed the view captured when an action started, overwriting a newer tab's results; an earlier save closed a newer edit and discarded its text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Latest refresh through a ref; edit sessions.                                                                                                                                                                                                     |
| Medium   | Concurrent memory bootstrap callers skipped an in-flight bootstrap because the failure backoff was written before the request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A drop guard records backoff on failure or cancellation; waiters see the result.                                                                                                                                                                 |
| Medium   | Autonomy: a dashboard Stop racing a returned response was recorded as a lost lease and re-run by the next owner; reclaim left the interrupted run "running" forever, so the dashboard showed a dead run as live.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Cancellation is classified first; reclaim closes interrupted records under the lease. Real-Redis lease tests now also cover the stale-token `complete`/`reclaim` fences, which were untested.                                                    |
| Medium   | Source verification truncated the fetched page to the token budget before selecting claim evidence, so mid-page and tail evidence never reached the critic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Select from the whole source, then bound tokens. Verified in the built image with real MarkItDown and tiktoken.                                                                                                                                  |
| Medium   | Object-store requests used a total timeout of five minutes, cutting off uploads and downloads slower than about 0.67 MB/s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Inactivity timeout.                                                                                                                                                                                                                              |
| Medium   | Every AVIF upload was rejected because sharp reports AVIF as HEIF and it was sent to the HEVC-only decoder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | AV1 HEIF is decoded by sharp and stored as `image/avif`.                                                                                                                                                                                         |
| Low      | Assorted: NV-Ingest Markdown sort panicked on incomparable keys (Rust 1.81+ total-order check); YAML scalars diverged from PyYAML (sexagesimal and exponent forms); tiktoken special-token text broke scrape/RSS token bounds; RSS parsed HTTPX's UTF-8 guess instead of the declared encoding; Hindsight protocol errors surfaced as 500; escaped lone surrogates made Python tool output unencodable; code blocks re-serialized JSON lossily; React element comparison overflowed the stack in development; image presets conflicted between desktop and mobile; Tailwind did not scan `hooks/`; MCP approval success was not audited; unowned `conversation-job` fallback; Helm PVCs created alongside `existingClaimName`; backend `replicas: 0` rendered as 2; malformed upload/PUT bodies returned 500. | Each fixed with a focused regression.                                                                                                                                                                                                            |

## Dead code and contract decisions

Removed after reference, route, registration, entry-point and runner searches:
the unused Python loop guard (`LoopGuardSettings`, `AgentRun.observe` and
`outcome_metadata`; Rust owns the guard), the autonomy worker's unread
`nat-session` cookie, `nv_ingest_router` and unreachable identity parameters,
the smart_milvus iterator/bind helpers, dead webscrape token parameters and the
source verifier's unreachable HTTP status branch, two NAT-era sample configs
whose content was also wrong, `promptSafety.ts`, unused store fields and query
keys, an unreachable Rust error arm, `migration_spikes.rs` (its telemetry test
moved to `telemetry.rs`), and the Helm Redis init's `memory_idx` index creation
(no `FT.*` consumer in Rust, Python or TypeScript). Python counterparts of
Rust-owned tools remain: they serve the `DAEDALUS_PREPARATION=python` rollback,
startup validation and differential baselines.

Decisions:

- Finalization records idempotent cleanup receipts in the write that publishes
  completion; `conversationAppliedAt` stays a separate write before the guard
  release so recovery cannot overwrite a newer turn. Journal compare-and-set
  uses a SHA-1 digest instead of resending the journal.
- Chat submission skips rewriting a conversation that is already a member,
  bound to the user and persistent; new, legacy and expiring records keep the
  compare-and-set save.
- Step merging uses (UUID, event type), matching `normalizeSteps`.
- The protocol generator emits Prettier's layout, so the hook and `--check`
  cannot disagree.
- The Helm hook renders default and deployed values, because `helm lint` only
  logs template `fail` errors.

## Latency

Synthetic paired measurements; production network, model and phone rendering
were not measured.

- Finalization and submission: a paired ABBA harness (real stream worker,
  WebSocket sidecar and chat API, scripted backend with the Rust SSE framing,
  Redis Stack on Docker Desktop, n=40 pairs) measured the receipt-combining and
  reservation changes against the starting revision. With a 1.55 MB history,
  finish to visible completion fell from 351 to 212 ms median (paired difference
  -109 ms, 95% bootstrap [-143, -92]); submission from 83 to 58 ms; first visible
  token from 154 to 116 ms. With a 379 KB history completion fell from 78 to
  52 ms. A separate 15-sample-by-3-round run of the digest-based journal update
  measured 272-360 ms to 123-223 ms at 2 MB. These runs measured the reviewers'
  variants of the same design; the combined final tree was not re-measured.
- Image thumbnail reads: 55.9 ms → 1.15 ms median (p95 75.2 → 2.57 ms, n=30,
  12 MP record) by reading only the needed JSON paths.
- Render work: the chat view no longer re-renders per token; the input and the
  app shell no longer re-render per flush (render-count tests).

Remaining opportunities with attribution are listed in the follow-up section.

## Validation

Run on the final tree on macOS with Docker Desktop (Rust and the built-image
checks ran in a Linux checker container with a private cargo target directory):

- Rust: `cargo fmt --check`, Clippy with `-D warnings`, and `cargo test --locked`
  (150 passed, 20 opt-in ignored; 139 at the start), protocol drift check.
- Python: `pytest --cov --cov-fail-under=65`, 2205 passed, 24 skipped, 82.59% of
  12,192 statements (81.89% of 12,208 at the start); `pytest -m integration`
  against Redis Stack, 22 passed.
- Frontend: lint, `tsc`, `npm run coverage` (1269 passed, 269 Redis-gated
  skipped; statements 69.1%, branches 61.4%), `npm run test:integration` against
  Redis Stack (291 passed), production build.
- `pre-commit run --all-files` with the pinned 3.6.2 (all hooks passed, no
  autofixes) and `make helm`.
- Built backend image: `builder/runtime_http_check.py` with the Redis image
  (all contracts including exact approvals and non-replay),
  `builder/migration/leaf_check.py`, `response_check.py` and
  `research_check.py` passed in both preparation modes.

Not run before this record was committed: the Playwright browser suite
(`make frontend-e2e`), `document_tool_ingestion_check.py` (its Milvus peer
mount needs host-shared paths that the containerized checker cannot supply on
Docker Desktop) and the other `make migration` checks against the `7dc4e1d`
baseline, the security scans that need gitleaks and Trivy, the Kind Redis
upgrade test, and a latency re-measurement of the combined tree. The
finalization change in particular should be exercised by `make frontend-e2e`
before deployment.

## Decisions and follow-up

Owner decisions needed:

- `delete_memory_guarded` can never succeed: nothing mints its approval token,
  and the token is a model-visible argument. Remove the operation (the Memory
  Center clear flow remains) or build a pending-approval flow like MCP's with
  the token in a backend header.
- Helm nginx sets `X-Forwarded-For` to `$remote_addr` without `real_ip`
  configuration, so behind an ingress every per-IP limit and the login lockout
  key on the ingress pod. This needs a trusted-proxy CIDR value.
- Coverage floors sit far below measured coverage (frontend global statements
  34 against 69.1; Rust 40 against roughly 60). Raising them is a policy choice.
- Document attachments that are not inline always go to ingestion, because the
  intent check runs on text that already contains the server's ingest hint.
  Either make that explicit or evaluate intent on the user's own text.
- Routes with no caller: `GET /api/conversations`, `POST /api/images/history`,
  `PATCH /api/autonomy/goals`, the `sync/notify` deletion/list branches,
  `session/conversationHistory` PUT/DELETE and `push/subscribe`.
- Test dependencies: two tests need markitdown and fastfeedparser and never run
  in CI; `daedalus_runtime/service.py` has no unit coverage because FastAPI is
  mocked; the integration Redis client is unpinned (the image pins 5.3.1).

Remaining confirmed defects and opportunities (lower priority):

- A server-side conversation delete does not cancel its job when no browser tab
  is open (open tabs now cancel it).
- A negative "collection does not exist" cache lasts 30 s after a user's first
  ingest (Rust and Python, pinned by a differential fixture).
- NV-Ingest client calls have no read timeout or overall worker deadline.
- The sandbox POST error message claims a transport retry that never happens
  (Rust and Python, compared byte for byte).
- Preflight probe pods join workload Services; Redis passwords are substituted
  raw into URLs; the chart's backend env allowlist and `deploy.sh` disagree.
- `test-fixtures/independent-contracts/reference.json` has about 31 behaviour
  cases that no test reads.
- Finalization still copies the full conversation through the journal and the
  `conversation_updated` event; ownership checks read whole documents; the
  browser uploads the full history several times per turn.
