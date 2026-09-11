# Tool and skill alignment, 2026-09-11

The reported `plan_sources` fallback came from an actual runtime contract
defect. The briefing instructed the model to call an operation that the
deployed verifier did not expose. This was reproduced in the running backend;
it was not necessary to infer a model regression.

## Root cause

`source_verifier_function` yielded three separate `FunctionInfo` objects from
one individual-function registration. NVIDIA NeMo Agent Toolkit consumes that
factory as an async context manager, with exactly one yielded callable. With
the production allowlist, the first yield exposed only `claim`, `source_url`,
and `context` for `verify_claim`. Neither `operation` nor `research_question`
appeared in the generated schema. Exiting the registration raised
`RuntimeError: generator didn't stop` when it reached the second yield.

The earlier tests enabled one operation at a time and iterated a stubbed
generator. They could prove each implementation worked in isolation but could
not detect the broken combined registration.

Read-only reproduction used backend pod
`daedalus-backend-default-66f5947577-8cv55`, image digest
`sha256:214c12cde61bcb4394771e9827b7f3fac2829c2f16c555b05fc7c7df7e66d9ac`.
No provider request or source fetch was needed for the reproduction.

## Corrections

| Finding                                                                        | Resulting behavior                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verifier exposed only its first operation                                      | One typed dispatcher accepts `operation=plan_sources`, `verify_claim`, or `audit_citations`; disabled operations and missing fields return explicit errors. Unknown operations/fields fail schema validation.                                                    |
| Seven other tools discarded YAML descriptions                                  | RSS, web search, web scraping, curated retrieval, uploaded documents, distillation, and sandbox now preserve configured routing descriptions, with their existing defaults for standalone use. The verifier also preserves its description.                      |
| Source IDs differed across callers                                             | The default verifier registry, production registry, frontend policy, and autonomous policy now agree. The autonomous worker's retired `google_search` entry becomes `perplexity_search`; X and requested operational/fantasy sources are represented everywhere. |
| Briefing source plan omitted live operational sources                          | Explicit source selection can include Kubernetes, UniFi, GitHub, Workspace, and requested ESPN evidence. The briefing uses quick planning, reuses its personal preflight results, and treats the plan as a relevant source menu.                                 |
| Planning, verification, auditing, and rendering could be confused              | Shared guidance distinguishes source recommendations, public factual verification, numbered Markdown auditing, and briefing HTML validation. A plan or citation audit does not establish factual support.                                                        |
| Image skill permitted an unsupported URL edit input                            | Edits require actual uploaded `imageRef` values; public `image_url` is analysis-only. The schema also uses the current `image-creation` skill name.                                                                                                              |
| Backend queried absent Flux resources                                          | The briefing discovers installed resource kinds before optional Flux reads. An absent CRD is unavailable evidence, not an outage or a reason for repeated identical calls.                                                                                       |
| Connector argument conventions could be confused                               | Gmail reads use `threadId`; Calendar uses `eventId`, `startTime`, `endTime`, and `timeZone`. These were checked against live schemas.                                                                                                                            |
| Native clock description claimed no arguments                                  | Removed the ignored configuration description; the pinned upstream tool requires `unused=""` and supplies its own description.                                                                                                                                   |
| Memory description promised a memory ID and automatic verification enforcement | It now describes the actual write-status response and distinguishes the workflow's public-claim verification requirement from the storage tool's identity, availability, and idempotency checks. Private observations stay with authenticated evidence.          |

The shared dispatcher keeps the original skill responsible for the final
deliverable. Specialists contribute scoped evidence and retain completed calls,
identifiers, source restrictions, authorization, and output requirements.
Independent reads can run together once their inputs are known. Loading another
skill does not grant tools or create a new execution environment.

The connected Kubernetes and GitHub tools currently expose reads. Skills can
prepare patches and commands for requested changes; actual application needs an
available authorized write capability. The existing runtime approval and OAuth
boundaries remain authoritative. Ordinary briefing requests do not acquire a
second approval requirement from the source planner's broad-topic cost hint.

## Complete catalog coverage

The native runtime check covers every configured individual tool:

| Native tool                                | Contract checked                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `agent_skills_tool`                        | List/load routing, explicit input, real catalog/resource loading        |
| `briefing_renderer_tool`                   | Structured edition object and sandbox dependency registration           |
| `add_memory`, `get_memory`                 | Trusted-identity input schemas and configured descriptions              |
| `current_datetime_tool`                    | Pinned upstream input schema                                            |
| `visual_media_tool`                        | Generate, edit, analyze argument shapes and shared routing              |
| `domain_retriever_tool`                    | Domain and query inputs                                                 |
| `user_document_tool`                       | Ingest, extract, search, list collections                               |
| `curated_feed_search_tool`                 | Feed scope and query                                                    |
| `content_distiller_tool`                   | Content, focus, and word budget                                         |
| `tool_output_retriever_tool`               | Opaque reference and exact-output retrieval query                       |
| `user_interaction_tool`                    | Production clarification, research-plan, and memory-deletion operations |
| `perplexity_search_tool`, `webscrape_tool` | Discovery versus known-URL retrieval                                    |
| `llm_sandbox_tool`                         | Discovery, execution, write, read, and publication inputs               |
| `nvidia_docs_tool`                         | Closed product routing and query                                        |
| `source_verifier_tool`                     | All three operations invoked through one real registration              |

All eight configured MCP servers returned complete `tools/list` catalogs.
Every configured allowlisted leaf exists. No business-data tool or mutation was
invoked during this discovery:

| MCP group  | Exposed leaves after configured filtering |
| ---------- | ----------------------------------------: |
| ESPN       |                                        10 |
| X          |                                        17 |
| GitHub     |                                        10 |
| Gmail      |                                         5 |
| Calendar   |                                         9 |
| Docs       |                                         2 |
| Kubernetes |                                        30 |
| UniFi      |                                        73 |
| **Total**  |                                   **156** |

The check also resolves qualified MCP references in bundled Markdown against
the filtered live catalog. Catalog discovery does not prove per-user OAuth
refresh, a successful downstream read/write, or the quality of a model's tool
choice. Those remain separate operational checks.

All 18 skills and 102 visible bundled resources round-trip through the real
NAT parser/dispatcher. [The per-skill review](skills-review.md) and
[ownership matrix](../skills/AGENTS.md) cover the full catalog. Existing domain
boundaries were retained; focused changes affect shared routing, briefing
sourcing, sandbox-to-renderer handoff, and image inputs.

## Regression gates

[tool_catalog_contract_check.py](../builder/tool_catalog_contract_check.py)
checks native schemas, configured descriptions, operation visibility, fixture
arguments, registration cleanup, and combined verifier execution. Its offline
core now runs in the backend image build. With mounted source configuration and
skills, run it in the pinned backend environment:

```bash
python builder/tool_catalog_contract_check.py \
  --config backend/tool-calling-config.yaml --skills skills
```

An optional `--mcp-catalog PATH` validates a read-only `tools/list` capture keyed
by configured group, with `status: "ok"` and `tools` entries containing `name`
and `inputSchema`. Incomplete/unavailable captures or missing leaves fail the
check. `--output PATH` writes native schemas/descriptions for inspection.
Connection and provider settings use offline defaults; the core never invokes
remote tools or providers. The verifier execution uses deterministic fetch and
critic fixtures, and real citation auditing against a public literal URL.

The builder suite additionally checks source-ID parity, configured workflow
exposure, every bundled Markdown tool reference, and one-yield registration for
all repository-owned individual functions. Combined-operation, invalid-input,
disabled-operation, and missing-argument cases supplement existing verifier
tests. Frontend tests preserve operational/social source restrictions through
policy sanitization and use the actual planning dispatcher name.

These are source changes and local/pinned-runtime validation. Applying them to
the running service requires a backend image/config and frontend release. This
audit does not deploy them or claim a full live briefing completed afterward.
