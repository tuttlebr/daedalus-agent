# Capability and prompt ownership

Paths are relative to the repository root. These are navigation aids, not a frozen
capability catalog. Verify ownership against current code and refresh this map
when it changes. Start with `docs/architecture.md` and the affected YAML sections.

| Surface                    | Current source and what to trace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary workflow           | `backend/tool-calling-config.yaml`: functions, function groups, workflow tools, instructions, source registry, model profiles, and special-purpose tool subsets. This file is a home deployment with personal integrations.                                                                                                                                                                                                                                                                                                                                                   |
| Minimal workflow           | `backend/local-chat-config.yaml`: starting configuration. Keep shared behavioral contracts consistent where applicable, without copying home integrations into it.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Configuration loading      | `builder/runtime/src/config.rs`, `builder/runtime/src/yaml.rs`: inheritance, environment expansion, validation, native ownership, and policy handling. Use the workflow's `instructions` field; inspect current support before adding any alternative key.                                                                                                                                                                                                                                                                                                                    |
| Model-visible preparation  | `builder/runtime/src/preparation.rs`, `builder/runtime/src/agent.rs`, `builder/runtime/src/provider.rs`: selected tools, instructions, request-specific menus, and actual provider payloads.                                                                                                                                                                                                                                                                                                                                                                                  |
| Added runtime instructions | `builder/runtime/src/tool_contracts.rs`, `builder/runtime/resources/tool-policy.json`: policy appended to workflow instructions on every run, and initial menu behavior. `builder/runtime/src/agent.rs` attaches recovery guidance (invalid calls, repeated identical failures, autonomy completion) to tool results. YAML size omits both; do not duplicate them in the prompt.                                                                                                                                                                                              |
| Native tool schemas        | `builder/runtime/src/` tool modules and `builder/runtime/resources/`: follow preparation into the actual schema/default description and dispatch implementation. A YAML description need not be the entire emitted definition.                                                                                                                                                                                                                                                                                                                                                |
| Python tools and fallback  | `builder/daedalus_runtime/tools.py`, `builder/daedalus_runtime/service.py`, and the selected tool package: explicit factories, schemas, description overrides, and fallback preparation. Do not assume a similarly named Python implementation is unused.                                                                                                                                                                                                                                                                                                                     |
| MCP capabilities           | `builder/runtime/src/mcp.rs`, `builder/runtime/src/authorization.rs`: include/exclude filters, `initial_tools`, `defer_discovery`, connect descriptions, tool overrides, schemas, and authorization. MCP descriptions can be overridden per tool; verify the emitted definition.                                                                                                                                                                                                                                                                                              |
| Runtime skills             | `skills/AGENTS.md`, `builder/runtime/src/agent_skills.rs`, `builder/agent_skills/`: task routing and on-demand instructions. Runtime skills do not create tools or permissions. Follow their local guide before changing them.                                                                                                                                                                                                                                                                                                                                                |
| Background work            | `builder/autonomous_agent/src/autonomous_agent/prompt.py`, `builder/autonomous_agent/src/autonomous_agent/backend_client.py`, `builder/autonomous_agent/src/autonomous_agent/worker.py`: charter task prompts, user-scoped Google MCP, independent schedules, durable action records, and daily summaries. `builder/autonomous_agent/src/autonomous_agent/charter.py` owns strict configuration/results; `builder/autonomous_agent/src/autonomous_agent/scheduling.py` owns task identities and recovery; `builder/runtime/src/autonomy_policy.rs` enforces task tool limits. |
| Human-facing behavior      | `frontend/server/chat/`, `frontend/pages/api/chat/async.ts`, `frontend/server/compat/`, `frontend/types/sourcePolicy.ts`: request controls, source selection, receipts, and final responses. Compatibility agent runs add a subordinate `[CALLER_INSTRUCTIONS]` message and request `response_mode: final_only`; `daedalus-model` instead forwards caller tools/history through `builder/runtime/src/model_endpoint.rs`, without the agent catalog or prompt. Follow the owning path when a prompt assumption depends on UI behavior.                                         |
| Configuration delivery     | `deploy.sh`, `docker-compose.yaml`, `helm/daedalus/templates/config-backend-default.yaml`, `helm/daedalus/values.yaml`: which file is mounted and how overrides reach the runtime. Editing YAML is not a rollout.                                                                                                                                                                                                                                                                                                                                                             |

Search narrowly from the affected surface, for example:

```sh
rg -n 'instructions|description|discovery_description|tool_overrides|initial_tools' backend builder/runtime/src builder/daedalus_runtime
rg -n 'workflow|daily_summary_tools|daily_summary_final_tools|source_registry' backend/tool-calling-config.yaml builder/runtime/src/preparation.rs
```

For affected capabilities, record a small local comparison: source/schema,
workflow exposure, description owner, dependent consumers, availability evidence,
and required checks. Use current emitted tool names after discovery; group names
and remote operation names are not interchangeable.

The deployed workflow has separate general-chat and daily-summary menus. Source
families also map to frontend policies; charter tasks have a separate runtime capability boundary. Preserve these consumers
when aligning a tool; `builder/tests/test_tool_skill_alignment.py` checks several
cross-surface contracts. A source-planning result does not prove its tools are
reachable, and a read-only label does not override the execution gate.

Image generation and editing share `builder/nat_helpers/src/nat_helpers/image_brief.py`
(`ImageOptions`) and `builder/nat_helpers/src/nat_helpers/openai_images.py`.
Chat exposes them through `builder/visual_media/src/visual_media/visual_media_function.py`;
Create uses `builder/image_api.py` and
`frontend/utils/app/imageModelCapabilities.ts`. `.env.template` and standalone
tool defaults select `gpt-image-2.6-sunburst`; explicit deployment overrides
remain authoritative. Complexity is separate from quality and travels through
the pinned SDK's `extra_body`, as do GIF generation's `frame_count` and
`frame_duration_ms`, including multipart edits. Image-to-GIF accepts 2–16
frames and no masks. GIF output cannot stream; Create checks the prepared
format before selecting transport and rejects masks with GIF output. GIF previews/downloads
serve the signed animation, bypassing JPEG thumbnails. First-frame GIF inputs
in Create and chat share `builder/nat_helpers/src/nat_helpers/image_edit_source.py`.
Keep these contracts, automatic chat quality, Create controls, and
`skills/image-creation/SKILL.md` aligned.

Autonomous completion also has a runtime-owned tool: the worker sends the schema
from `builder/autonomous_agent/src/autonomous_agent/prompt.py` as
`autonomy_output_schema`. `builder/runtime/src/autonomy_output.rs` adds
`submit_autonomous_result` only for that scoped request, and
`builder/runtime/src/agent.rs` validates and serializes its terminal arguments.
This tool is not a YAML function or an external action. Preserve the worker's
completion instruction and strict publication validation; final formatting must
not replay research. Charter completions additionally call the authenticated
`/runtime/v1/autonomy/validate` endpoint in `builder/daedalus_runtime/service.py`,
which uses the worker's Pydantic model for semantic validation before terminal
publication. Errors enter the runtime's bounded argument-correction path;
diagnostics from `builder/autonomous_agent/src/autonomous_agent/prompt.py` expose
only safe schema locations and fixed guidance. The autonomous cases in `builder/runtime_http_check.py`
exercise this path against the built image for both preparation modes.
`builder/migration/autonomy_http_check.py` additionally verifies user-scoped
Google grants, background authorization failure, task write limits, partial
lighting results, mutation replay rejection, call budgets, cluster backup/read
binding before patches, and constrained application health probes.

The Autonomy dashboard (`frontend/components/autonomy/AutonomyDashboard.tsx`)
shows current work, latest outcomes and briefing, and bounded proposal pages;
`frontend/components/autonomy/AutonomyJson.tsx` imports/exports operator settings
using the generated contract validator. Worker history remains persisted even
though the UI no longer renders its log. In
`builder/autonomous_agent/src/autonomous_agent/prompt.py`, evolution samples up to
six actions per responsibility plus scoped settings and continuity notes; other
tasks retain their own context. Cluster checks revisit Daedalus diagnostics and
prior repairs, while evolution remains read-only apart from authorized memory.
Feedback is preference data, not permission for self-deployment or new actions.

The main chat prompt routes prose rewrites and reviews to
`skills/prose-editing/SKILL.md`. Keep its editing rules available on demand while
preserving the global chat/output contracts and word budgets in
`builder/tests/test_backend_config_contracts.py`.

The shipped Kubernetes group preauthorizes its explicit allowlist with
`approval_policy: auto_approve`, including mutation/command tools. Results stay
in the agent loop; exact-call approval would terminate that run. Task scope and
compatibility guidance for interactive work live in the workflow instructions and
`skills/kubernetes-specialist/SKILL.md`; server authentication/RBAC still apply.
Autonomous requests additionally require a charter task and pass the scoped
capability checks in `builder/runtime/src/autonomy_policy.rs`. Skill scripts,
generic shell/delegation, and software upgrades are unavailable to these tasks.
Do not restore per-call gating as a wording cleanup. The deployed-policy cases
in `builder/tests/test_mcp_approval_gate.py` and the Kubernetes sequences in
`builder/runtime_http_check.py` cover this contract; the latter exercises both
preparation paths against local model/MCP peers with the shipped group policy.

For recovery and evaluation identity, read `docs/research-workflows.md` and
`docs/tool-correctness.md`. `builder/runtime/src/harness.rs` fingerprints selected
configuration/catalog inputs. Inspect what a digest includes before using it as
evidence that two runs used identical conditions.
