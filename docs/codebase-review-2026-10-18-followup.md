# Follow-up codebase review and remediation, 18 October 2026

Starting revision: `9c900dad51e788304fb3344a0334806ae95264f4`, clean `main`. The
review covers bugs, dead code, conflicting contracts, latency, and test/hook
correctness across the browser, Next.js APIs, stream worker, WebSocket server,
Rust runtime and services, Python tools and autonomy, and delivery
configuration. It revisits the [earlier same-day review](codebase-review-2026-10-18.md)
as evidence, not as a list of current findings. Stored data formats, Redis key
names and API shapes are unchanged; no migration is required.

## Confirmed findings and remedies

Each regression test below failed on the original code (or a controlled
mutation of the fixed code) and passes with the remedy.

| Priority | Trigger and root cause                                                                                                                                                                                                                                                                                                                                                                                                                                             | Remedy and regression evidence                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | After any WebSocket reconnect the browser re-sent its job/chat subscriptions on `open`, but the server ignores application messages until it has authenticated the socket and sent `connected`. Live tokens stopped until polling noticed.                                                                                                                                                                                                                         | The browser treats `connected` as readiness (backoff reset and resubscription happen there). The server also holds a bounded, ordered pre-`connected` backlog for older clients. Real-bundle probe: original delivered only `connected`; fixed delivers status and tokens. |
| High     | An unauthenticated client could crash the WebSocket server by sending an invalid frame before the asynchronous session lookup attached an `error` listener.                                                                                                                                                                                                                                                                                                        | Listeners are attached before any await. Real-bundle probe: original process exited; fixed survives and keeps serving.                                                                                                                                                     |
| High     | Concurrent password guesses all passed the login lockout check, because counters were read before bcrypt and incremented after.                                                                                                                                                                                                                                                                                                                                    | One Lua script checks every limit and reserves the attempt; failures confirm it, success and infrastructure errors release it. Real Redis: original verified 20 guesses against a limit of 5.                                                                              |
| High     | The browser merged a stale selected conversation over a newer server copy, then saved it, erasing turns made on another device. Progress for an assistant message missing from the local copy was written into an earlier answer and saved.                                                                                                                                                                                                                        | Keep the local copy only when it is not older; adopt the server record when the target message is missing; save a finished turn only from a copy that contains it.                                                                                                         |
| High     | A lost token range (reconnect, reload, late subscription) froze the visible answer until completion because offset-gapped tokens were dropped and no repair arrived.                                                                                                                                                                                                                                                                                               | Gap tokens are held, an immediate status read repairs the text with bounded retries, and snapshots drain held tokens.                                                                                                                                                      |
| High     | A transient Redis error during one lease renewal aborted every running chat on that stream worker although the lease was still held.                                                                                                                                                                                                                                                                                                                               | Abort only on explicit ownership loss or once the conservative validity window has elapsed.                                                                                                                                                                                |
| High     | Milvus index waits never ended when progress stalled (the no-progress budget reset every 20 polls), holding the collection lock.                                                                                                                                                                                                                                                                                                                                   | Carry the budget across rounds.                                                                                                                                                                                                                                            |
| High     | A failure after Milvus acknowledged rows replayed the whole ingestion pipeline up to three times, duplicating chunks.                                                                                                                                                                                                                                                                                                                                              | Mark post-commit failures and stop retrying them.                                                                                                                                                                                                                          |
| High     | Image jobs that were stopped kept counting as active, blocking new Create submissions for up to an hour.                                                                                                                                                                                                                                                                                                                                                           | One in-progress predicate for admission, the active index and the active list.                                                                                                                                                                                             |
| High     | The default Helm install referenced the externally provisioned `exploration-grants` Secret, so pods failed to start even with the local workflow.                                                                                                                                                                                                                                                                                                                  | The reference is optional; a workflow that configures the exploration tool still refuses to start without the key.                                                                                                                                                         |
| High     | Checks that passed without checking: 21 rendered-chart tests skipped when Helm was absent (the CI builder job does not install it); the Bandit pipeline exited 0 with no files or a missing filter; filtered native `cargo test` gates passed with zero selected tests.                                                                                                                                                                                            | Helm is installed in the builder job and a `requires_helm` marker fails under `CI`; the Bandit step fails closed; the cargo runner requires at least one passing test.                                                                                                     |
| Medium   | Finalization persisted the browser's model-oriented copies of earlier messages (inline data omitted, attachment instructions appended) over the saved conversation.                                                                                                                                                                                                                                                                                                | Model input still uses the submitted copies; persisted history keeps saved turns and appends only new messages. Handler test fails on the original.                                                                                                                        |
| Medium   | Under the Helm Redis ACL, lease renewal for a job without a conversation declared an empty placeholder key and Redis rejected every heartbeat (`NOPERM`). Cross-device streaming state expired after ten minutes during longer runs.                                                                                                                                                                                                                               | Renewal declares only existing keys and passes their positions; it also renews streaming state while it still names the job. Real Redis with the Helm stream-worker ACL reproduces `NOPERM` on the original.                                                               |
| Medium   | Autonomy runs shared the Rust per-user limit of five with interactive chats, while frontend admission does not count them: an admitted fifth chat failed with a backend 429 (or a scheduled run failed).                                                                                                                                                                                                                                                           | Separate per-user pools for interactive and autonomy runs in Rust; the process-wide limit of 64 is unchanged. Backend 409/429 rejections now save an actionable message.                                                                                                   |
| Medium   | The autonomy scheduler wrote a stale config snapshot back after enqueueing, undoing concurrent dashboard edits (including disable) and allowing a duplicate enqueue if the write failed.                                                                                                                                                                                                                                                                           | Merge only the scheduler marker into the latest record and commit the queue entry in the same transaction. Real Redis tests in both storage formats.                                                                                                                       |
| Medium   | Dashboard Stop reached an open autonomy backend request only on the 20-second lease heartbeat.                                                                                                                                                                                                                                                                                                                                                                     | Poll cancellation every second; synthetic cancel-to-abort median 9.2 s → 0.56 s.                                                                                                                                                                                           |
| Medium   | Document uploads could be committed to object storage before the multipart trailer and exact length were validated; a lost PUT response orphaned the object.                                                                                                                                                                                                                                                                                                       | Withhold the last chunk until validation; clean up any possibly committed object.                                                                                                                                                                                          |
| Medium   | Agent loop: correction notices were inserted between tool results; a menu-hidden tool proposal consumed that tool's single argument correction; the configured briefing synthesis deadline was ignored.                                                                                                                                                                                                                                                            | Notices follow the batch; hidden proposals are not counted; the configured deadline is used. First unit coverage of the real loop.                                                                                                                                         |
| Medium   | The Rust proxy blocked `/runtime/*` by raw prefix only: percent-encoded and dot-segment paths (`/%72untime/...`, `/./runtime/...`) reached the internal tool service (which still requires its credential).                                                                                                                                                                                                                                                        | Check the decoded path of the URL actually forwarded.                                                                                                                                                                                                                      |
| Medium   | Local MCP argument/approval rejections tore down the user's MCP session; exploration HTTP errors were reported as successful results (Rust and Python).                                                                                                                                                                                                                                                                                                            | Create the cancel guard only around the remote call; return `Error:`-prefixed results for non-2xx responses.                                                                                                                                                               |
| Medium   | Milvus channels other than domain retrieval had no gRPC keepalive, so a silent Milvus hung the shared document-tool client.                                                                                                                                                                                                                                                                                                                                        | Apply the SDK keepalive defaults to every channel.                                                                                                                                                                                                                         |
| Medium   | Blocking DNS validation and tokenization ran on the Python event loop (source verification, visual media, scraping); legacy-encoded HTML lost non-ASCII text in claim verification.                                                                                                                                                                                                                                                                                | Move them off the loop; convert original bytes with the shared article converter.                                                                                                                                                                                          |
| Medium   | Compose sent the frontend and worker to `backend:$BACKEND_PORT` (the host port) and allowed `env_file` to move the backend listener; the stream queue key/group could differ between producer and consumer in Helm.                                                                                                                                                                                                                                                | Fixed container ports; queue keys delivered to both workloads; worker overrides honoured.                                                                                                                                                                                  |
| Low      | Assorted: memory route IDs with raw UTF-8 after an incomplete escape panicked the handler; non-ASCII credential headers produced 500 instead of 401 in Python; an unvalidated autonomy interval and zero poll interval; unread error bodies held sockets; rename during a run was lost at finalization; trace export missed running steps; image records could be stored without a TTL; the pod-security checker ignored privileged, host and capability settings. | Each fixed with a focused regression; see the commit diff.                                                                                                                                                                                                                 |

## Dead code and contract decisions

Removed after reference, route, registration, entry-point and runner searches:
the unused `/api/images/generate` and `/api/images/edit` proxies (the browser
moved to image jobs) and their helper, the unreachable `/api/document/process`
ingest mode, the Python chat-route MCP approval middleware and the daily-summary
synthesis helpers (Rust owns both), synchronous fetch helpers, unrunnable Rust
probes and the rmcp `auth` feature, duplicated Milvus/reranker helpers, a
polling-only browser path that no caller enabled, unused store members, two
byte-identical check wrappers, the inert root `.dockerignore`, and environment
variables nothing reads. Compatibility readers, the Python preparation and
rollback profiles, and frozen fixtures were retained.

Decisions: socket readiness follows the server's `connected` message (and the
server tolerates older clients); the hook is the single authority for live text;
saved history wins for persistence while submitted copies feed the model;
autonomy and interactive runs use separate per-user pools; committed Milvus rows
are never replayed (deliberately stricter than NV-Ingest); memory clear uses one
shared lifecycle; the encoding used for token counting is baked into the image
instead of downloaded at request time.

## Latency evidence

End-to-end synthetic workload: real Next.js standalone server, WebSocket sidecar,
stream worker and Redis with a deterministic mock backend streaming three tokens
300 ms apart; Playwright Chromium measures DOM milestones, and Redis job records
give admission and durable completion. Baseline (`9c900dad`) and final builds
alternated in three blocks of 20 samples after two warm-ups (n=60 each), same
host and services.

| Measurement (ms)     | Baseline median / p95 | Final median / p95 |
| -------------------- | --------------------- | ------------------ |
| Admission            | 7.0 / 10.0            | 6.5 / 10.0         |
| User message visible | 4.0 / 4.6             | 4.0 / 4.7          |
| First token visible  | 450.4 / 455.4         | 328.4 / 340.1      |
| Answer complete      | 951.1 / 958.8         | 949.3 / 960.9      |
| Durable finalization | 933.0 / 938.0         | 932.0 / 943.0      |

The first-token gain comes from making the 120 ms render throttle leading-edge;
the parse bound of one flush per interval is unchanged. The healthy path was
otherwise unchanged (an earlier run before that change matched the baseline
within noise). Component measurements, all synthetic: WebSocket connect without
a keyspace `SCAN` (100k keys) 627 → 15.5 ms median; image-history ownership
checks 504.7 → 7.3 ms median; past-lookup memory context 315 → 214 ms median;
history listing without Lua decoding of every record roughly halves concurrent
Redis stalls for megabyte records. Provider latency, physical-device rendering
and recovery-path user experience were not measured end to end.

## Test and hook repairs

Tests that asserted only their own mocks, test-only copies of production
formatters, or configuration text were replaced with behaviour tests; tests that
depended on ambient credentials, live DNS or an absent environment variable were
made hermetic; a vacuous WebSocket subscription test and a 409 test that passed
for the wrong reason were repaired; real-Redis tests now cover the conversation
guard script, login reservation, streaming-state reads and ACL-restricted lease
renewal. Coverage includes every shipped Python module and every frontend server
module and store. The `skill-links` hook now runs when any skill file changes.
No floor was lowered, no exclusion widened and no failure converted into a skip.

## Decisions and residual risks

- `SESSION_SECRET` has had no reader since signed identity cookies were removed
  (May 2026); sessions are opaque Redis-backed IDs. Documentation and the chart
  still describe it as required. Removing it is left for an explicit decision.
- No browser code subscribes to push notifications, although the route, sender
  and chart support them.
- Identity and source-policy instructions are prepended to the history and can
  fall outside the backend's 50-message budget in long conversations; moving them
  needs a live-model check.
- Autonomy reclaim is at-least-once; remote MCP writes without execution-ID
  reservations can repeat after a crash.
- The model request deadline covers the whole streamed response (60 s shipped).
- Expired image-scan VEX statements no longer match any scanned image.

## Validation

Toolchains: Node 22.17.0, Python 3.12, Rust 1.95 (container), Docker 29, Helm 3.15.
Built-image checks run inside a Linux container on the Docker VM network,
because Docker Desktop for Mac cannot reach `--network host` containers.

| Gate                                    | Result                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline at `9c900dad`                  | Python 1 failed (an ambient-credential test), 1,976 passed; frontend 1,026 passed; Rust 113 passed; all other checks passed                                           |
| Python suite and coverage               | 2,066 passed, 9 skipped; 81.35% (floor 65%); also passes with a polluted synthetic environment and with `CI=true`                                                     |
| Python Redis integration                | 7 passed                                                                                                                                                              |
| Frontend lint, types, coverage          | Passed; 1,085 passed, 235 service-gated skips; 65.46% lines (baseline 62.41%)                                                                                         |
| Frontend persistence integration        | 19 files, 257 tests passed against the repository Redis image                                                                                                         |
| Rust fmt, clippy, tests, protocol drift | Passed; 134 passed, 20 service tests ignored (run by the image checks)                                                                                                |
| Built images                            | Backend and `rust-minimal` built; the token-counting encoding loads offline in the read-only image                                                                    |
| Runtime HTTP contracts                  | Rust and Python preparation, with real Redis approvals: passed                                                                                                        |
| Migration/image checks                  | Exploration (three profiles), leaf, response, public HTTP, document tools HTTP, document receipts, Milvus search, document search and document tool ingestion: passed |
| Browser workflows                       | 229 passed, 74 configured skips; four WebKit keyboard-focus checks fail identically on the baseline build on this macOS host                                          |
| Helm, pod security, Compose             | Lint, default/custom render, pod-security check and Compose config passed                                                                                             |
| Hooks (pre-commit 3.6.2)                | Changed-file and all-files passes, stable on rerun                                                                                                                    |

Not run here: the complete `make migration` matrix (checks that need the
`7dc4e1d` baseline image, including the differential, memory, profile, documents,
collections, ingestion and authorization suites), `make candidate-browser`,
`make rust-coverage`, the Kind Redis upgrade, image/filesystem vulnerability and
secret scans, and CodeQL. CI runs these; their results here are unknown.
