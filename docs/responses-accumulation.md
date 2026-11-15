# Responses accumulation

The Rust runtime accumulates OpenAI Responses items by `output_index`, with
content and reasoning parts ordered by their respective indexes. Text/refusal
and function-argument deltas extend a part; `.done` events and nonempty terminal
output snapshots replace it. Text-only terminal replies and whole-response SSE
payloads follow the same path. Empty terminal output retains previously received
items for compatible gateways that omit the repeated output.

Visible message parts concatenate within an item; separate message items and
model/tool rounds have paragraph boundaries. Final function calls are validated
before execution, and original call IDs and encrypted reasoning remain available
for continuation. Reasoning and incomplete tool arguments do not enter the chat
text. Missing terminal events, provider failures, incomplete responses and invalid
completed function calls cannot produce a successful UI completion.

## Worker and browser contract

Ordinary backend deltas remain Chat-shaped SSE. A correction emits
`event: response_snapshot` with `{ "content": "the complete run text" }`, including
an empty string when earlier text is withdrawn. The worker replaces the Redis
response and increments its revision in one atomic operation, then publishes a
`chat_token` with `replace: true` and `responseRevision`. Later deltas carry that
revision and UTF-16 `responseStart` offsets; Redis append offsets remain UTF-8
bytes. Revision and text are read atomically for status polling.

The browser ignores older revisions, repairs a missed replacement from status,
and accepts shorter or empty authoritative text. Conversation finalization and
reload use the corrected text. The public compatibility Responses API uses the
same completed job record; its SDK stream remains completion-buffered as described
in [the compatibility API](compatibility-api.md).

Deploy the worker/frontend support before enabling runtime snapshot events, or
roll out the matching application image together. Old workers ignore the new SSE
event and cannot apply corrections. New clients continue to accept old workers'
append-only events at revision zero. No Redis data migration is needed.

Native Responses routes also need Switchyard's `responses-native-snapshots` patch:
its append-only translation projection must not terminate native snapshot replay.
Chat/Anthropic translation still rejects a conflicting snapshot because those
outbound delta formats cannot retract text already delivered.

## Regression coverage

The shared synthetic corpus is
[`responses-accumulation.json`](../builder/runtime/tests/fixtures/responses-accumulation.json).
Runtime tests cover multiple items/parts, interleaved output, Unicode, every text
snapshot boundary, replacement/empty replacement, refusal, terminal-only output,
whole responses, function calls, reasoning continuation and terminal failures.
Frontend tests cover Redis byte offsets, atomic replacements, stale polls,
missed-correction repair, finalization and render batching.

The [Responses browser suite](../frontend/e2e/README.md#responses-accumulation)
runs the built runtime and gateway, real worker/Redis/WebSocket/Next stack, browser
rendering and reload, and the official OpenAI JavaScript SDK against a synthetic
provider. This does not certify a deployed image or a live OpenAI model. It covers
the agent's text, refusal and function-tool workflow; it does not add UI renderers
or execution support for every hosted tool, audio, image or custom output type.

The event boundaries follow the
[OpenAI streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses).
