# Tool execution contracts

Daedalus exposes 17 native tools plus explicitly configured MCP capabilities.
Every retained tool has a distinct execution or retrieval purpose. Shared
execution guidance lives in `builder/runtime/resources/tool-policy.json`; both
preparation modes use it in the Rust loop. Python and Rust also share the clock
description from that file.

## Retained native capabilities

| Tool                         | Purpose and selection boundary                                       | Required evidence or inputs                                                                                               |
| ---------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `current_datetime_tool`      | Observe current date/time in the trusted request timezone            | `{}`; answer from its actual ISO timestamp                                                                                |
| `agent_skills_tool`          | Discover and load task procedures and resources                      | Explicit list/load operation; load requires `skill_name`; scripts are absent when disabled                                |
| `briefing_renderer_tool`     | Validate and render the canonical Daily Daedalus artifact            | Structured edition; renderer owns canonical HTML and delivery                                                             |
| `add_memory`                 | Persist explicitly requested, durable user information               | A declarative memory; identity comes from authenticated context                                                           |
| `get_memory`                 | Recall user-specific durable information                             | Semantic query; prefer already retrieved relevant context                                                                 |
| `visual_media_tool`          | Generate/edit images or analyze an image/video                       | Generate: prompt; edit: prompt and imageRef; analyze: question and exactly one media input                                |
| `domain_retriever_tool`      | Retrieve established reference passages from curated domains         | Query and advertised domain; recent news uses feeds or web discovery                                                      |
| `user_document_tool`         | Extract, ingest, or search uploaded documents                        | Ingest: one reference or a batch; extract: one documentRef; search: query; list: no document/search arguments             |
| `curated_feed_search_tool`   | Discover recent source-specific feed entries or retrieve one article | Query, or discovery query batch with per-query scope; no mixed single/batch inputs                                        |
| `tool_output_retriever_tool` | Recover original content behind a compacted result                   | Reference returned by compaction plus literal search or offset; required when omitted content could change an exact claim |
| `user_interaction_tool`      | Request and execute approved deletion of the caller's durable memory | Confirm: action and reason; delete: single-use approval token; no model-supplied identity or target                       |
| `perplexity_search_tool`     | Discover public web sources and candidate URLs                       | Standalone query or bounded related queries; snippets are discovery evidence                                              |
| `webscrape_tool`             | Fetch source content from one known public URL                       | URL; read the page before treating its content as evidence                                                                |
| `nws_weather_tool`           | Observe official US forecasts and active alerts                      | Coordinates and bounded days; unavailable data is not an all-clear                                                        |
| `llm_sandbox_tool`           | Run bounded isolated commands and manage/publish files               | Explicit operation; execute takes argv or command; write requires path and content; read/publish require path             |
| `nvidia_docs_tool`           | Search the official documentation supported by its configured routes | Documentation query and supported product; no implicit access to local hosts or GPUs                                      |
| `source_verifier_tool`       | Plan sources, check a public claim against a URL, or audit citations | Plan: research question; verify: claim and source_url; audit: answer_markdown; these operations have separate arguments   |

MCP names, schemas, discovery, read/write classification, and authorization remain
owned by the configured server group and execution gate. Loading a skill never
adds permissions. Unknown tools are not executed. Discovery may add definitions;
it cannot silently replace an existing definition with a conflicting schema or
description. Missing MCP descriptions require a configured override; duplicate
remote names fail discovery rather than silently overwriting an earlier tool.

## Enforcement

When a user names an available tool explicitly, the first model request exposes
that tool plus the skill and original-output helpers. A named deferred MCP
operation exposes its connector. This reduces schema distraction; it does not
force a call, interpret quoted text as authorization, or change permissions.
The full authorized catalog returns on the next iteration, including after a
rejected proposal for an initially hidden tool. Questions without tool names
retain the complete catalog. Explicit API tool-choice requirements take priority.
Steering also restores the complete catalog so a redirected request is not limited
by names in the original message.

For an automatic first response to a request naming an available tool, text is
held until tool selection completes. If the model proposes an answer without any
calls, it gets one evidence review before answering. The unverified draft is
discarded. The review keeps automatic selection and explicitly permits answering
without tools for discussion, quoted instructions, prohibitions, or clarification.
It neither infers authorization nor forces a call. This adds a model round for
such no-call responses; semantic correctness still requires evaluation.

`daedalus_runtime/tool_contracts.py` projects each native dispatcher's actual
parameter types into operation-specific constraints. The published schema and
Python invocation validator are the same contract. Disabled operations and their
unused fields disappear. Required values cannot be null, blank, or empty;
`write_file` intentionally permits empty content. Irrelevant fields and ambiguous
input alternatives are rejected before leaf I/O. The existing tool-specific
ownership, URL, capability, and service checks still apply.

The Rust loop compiles catalog validators once per run and validates every call
in a completed model batch before scheduling calls. Invalid calls receive
structured correction feedback and never execute; valid siblings execute under
the usual authorization and approval gates. Each invalid tool gets one correction;
a second invalid proposal disables that tool for the remainder of the run while
other tools and synthesis continue. A successful correction restores its allowance
before disabling, but a disabled tool stays disabled until the next run.
Unrelated successes cannot reset an invalid tool's allowance. Rejection logs
identify only advertised tools, schema constraints and JSON types, never argument
values. Missing facts must be resolved from supplied context, existing results or
available memory rather than guessed. Required-tool requests still fail if the
required capability cannot succeed.
Missing, duplicate, and reused provider call IDs end
the run immediately. IDs from rejected batches must not be reused. Interrupted
or undecodable model responses still never execute proposed calls.

Tool errors reach the model as an explicit `status: error` envelope. Repeating an
identical failure reaches the configured loop limit even when other successful
calls intervene. Approval, cancellation, and uncertain-write protections are
unchanged; schema validation does not authorize an action or prove semantic
success.

An explicitly read-only MCP tool whose destructive metadata or arguments
conflict with that policy returns a nonterminal source error without executing.
It never creates an approval that the direct-execution endpoint would reject.
Other sources and synthesis can continue. Correct the connector metadata before
retrying the read; remote hints still cannot authorize a locally unapproved tool.
The approval UI retains backend rejection details rather than replacing them
with a generic failure. Exact-action credentials and mutation non-replay remain
required.

In daily briefings, exhausted renderer argument corrections get one text-only
synthesis attempt from completed evidence, capped at 75 seconds. All tools are
disabled for that attempt; invalid batches and their sibling calls never run.
The fallback discloses that HTML validation failed. Other schema failures and
explicit required-tool contracts retain their failure behavior.

The chat API accepts `tool_choice: "auto"`, `"none"`, `"required"`, or a named
function in Chat Completions or Responses form. Required/named choices require
one successful matching tool execution before accepting answer text; after that,
selection returns to auto. While pending, proposed answer text is withheld. A
provider that ignores the requirement gets one correction, then the run fails.
Errors and approval pauses do not satisfy this requirement. A pending approval
still terminates at the existing approval boundary. This is a caller contract,
not a natural-language parser or a permission grant. Ordinary chat continues to
stream normally and relies on guidance plus semantic evaluation for tool selection.

## Final-only answers

The backend chat API accepts `response_mode: "auto"` (default), `"streaming"`, or
`"final_only"`. Auto recognizes common English exact-output requests in the
current user message or subsequent steering, such as “return only” and “without
commentary.” It does not inspect tool results or older conversation messages.
Once selected, final-only presentation lasts for the rest of that run. Callers
can select an explicit mode to avoid natural-language inference.

Final-only presentation buffers each model round. Text accompanying tool calls
remains in model history but is excluded from the visible answer. Only a complete
answer with no tool calls, no pending steering and a successful completion fence
is emitted. Failed, interrupted and incomplete rounds never expose partial text.
Tool events and activity heartbeats still arrive during execution. Ordinary chat
continues to stream; explicit streaming also overrides auto detection. Existing
tool-choice withholding and approval boundaries still apply.

The buffer is capped at 1 MiB; exceeding it fails the run. Final-only presentation
delays the first answer text until completion. It does not validate JSON, remove
prose from the final answer, prove factual correctness or grant tool permissions.
If the final answer itself violates the requested format, semantic evaluation
still fails. `builder/migration/response_check.py` exercises the built image in
both preparation modes, including retries, cancellation, steering, heartbeat
delivery and incremental streaming.

## Removed surfaces and migration

`content_distiller_tool` and its package are removed. A second model summary
could lose exact evidence and duplicated the reversible output-compaction path.
Use the preview and `tool_output_retriever_tool`, then summarize supported prose
directly. Frozen historical migration fixtures retain their original catalog.

`clarify`, `present_options`, and `confirm_research_plan` are removed from
`user_interaction_tool`; they only formatted text and did not execute a UI
interaction. Ask necessary questions and present requested plans in chat. Source
policy that requires plan approval still stops research until the user responds.
The memory deletion operations retain their scoped, single-use credential check.
Legacy `max_options`, model identity/target, and MCP argument fields are rejected.

The operator removed `humanizer`, `i-have-adhd`, and `sre-engineer`. Their routing
and handoff references were removed. Existing infrastructure evaluation cases
now use `kubernetes-specialist`; their evidence and assertions are retained.
Deploy the image and workflow configuration together. Rolling back requires the
previous image **and** workflow, because the removed package/config is incompatible.
No data migration or new dependency is required.

## Validation and evaluation

- Python regression tests check invalid calls before I/O, disabled capabilities,
  timezone observations, authenticated ownership, and single-use memory deletion.
- `tool_catalog_contract_check.py` checks every active native factory, schema,
  configured description, and lifecycle; it also runs in the image build.
- `runtime_http_check.py --image ... --redis-image ...` exercises the actual
  runtime, native tools, deterministic model/MCP peers, approval, recovery,
  steering/cancellation, invalid batches, IDs, and required-tool omission.
- `evaluation/tool-correctness/run.py` freezes 20 synthetic cases and alternates
  baseline/candidate images through a real gateway. It retains every attempt,
  exact call arguments/results, ID binding, dependency, and answer assertions.
  The fixture exposes only synthetic MCP reads. No production memory or tool
  service is connected. Credentials come from an environment variable and are
  not included in the saved configuration.

All candidate correctness assertions must pass; faster failures cannot offset
incorrect tools or answers. Report latency separately for all attempts and pairs
where both arms succeed. A passing finite workload does not prove arbitrary
natural-language correctness. Production rollout also needs actual calls and
semantic output checks against the mounted configuration and deployed digest.
