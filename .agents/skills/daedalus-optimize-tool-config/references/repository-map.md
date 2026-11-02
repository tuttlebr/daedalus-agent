# Capability and prompt ownership

Paths are relative to the repository root. These are navigation aids, not a frozen
capability catalog. Verify ownership against current code and refresh this map
when it changes. Start with `docs/architecture.md` and the affected YAML sections.

| Surface                    | Current source and what to trace                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary workflow           | `backend/tool-calling-config.yaml`: functions, function groups, workflow tools, instructions, source registry, model profiles, and special-purpose tool subsets. This file is a home deployment with personal integrations.                                                      |
| Minimal workflow           | `backend/local-chat-config.yaml`: starting configuration. Keep shared behavioral contracts consistent where applicable, without copying home integrations into it.                                                                                                               |
| Configuration loading      | `builder/runtime/src/config.rs`, `builder/runtime/src/yaml.rs`: inheritance, environment expansion, validation, native ownership, and policy handling. Use the workflow's `instructions` field; inspect current support before adding any alternative key.                       |
| Model-visible preparation  | `builder/runtime/src/preparation.rs`, `builder/runtime/src/agent.rs`, `builder/runtime/src/provider.rs`: selected tools, instructions, request-specific menus, and actual provider payloads.                                                                                     |
| Added runtime instructions | `builder/runtime/src/tool_contracts.rs`, `builder/runtime/resources/tool-policy.json`: policy appended to workflow instructions and initial menu behavior. YAML size alone omits this context.                                                                                   |
| Native tool schemas        | `builder/runtime/src/` tool modules and `builder/runtime/resources/`: follow preparation into the actual schema/default description and dispatch implementation. A YAML description need not be the entire emitted definition.                                                   |
| Python tools and fallback  | `builder/daedalus_runtime/tools.py`, `builder/daedalus_runtime/service.py`, and the selected tool package: explicit factories, schemas, description overrides, and fallback preparation. Do not assume a similarly named Python implementation is unused.                        |
| MCP capabilities           | `builder/runtime/src/mcp.rs`, `builder/runtime/src/authorization.rs`: include/exclude filters, `initial_tools`, `defer_discovery`, connect descriptions, tool overrides, schemas, and authorization. MCP descriptions can be overridden per tool; verify the emitted definition. |
| Runtime skills             | `skills/AGENTS.md`, `builder/runtime/src/agent_skills.rs`, `builder/agent_skills/`: task routing and on-demand instructions. Runtime skills do not create tools or permissions. Follow their local guide before changing them.                                                   |
| Background work            | `builder/autonomous_agent/src/autonomous_agent/prompt.py`, `builder/autonomous_agent/src/autonomous_agent/backend_client.py`, `builder/autonomous_agent/src/autonomous_agent/worker.py`: prompt assembly, source policy, goals, handoffs, and non-interactive execution.         |
| Human-facing behavior      | `frontend/server/chat/`, `frontend/pages/api/chat/async.ts`, `frontend/types/sourcePolicy.ts`: request controls, source selection, receipts, and final responses. Follow the owning path when a prompt assumption depends on UI behavior.                                        |
| Configuration delivery     | `deploy.sh`, `docker-compose.yaml`, `helm/daedalus/templates/config-backend-default.yaml`, `helm/daedalus/values.yaml`: which file is mounted and how overrides reach the runtime. Editing YAML is not a rollout.                                                                |

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
families also map to frontend and autonomous policies. Preserve these consumers
when aligning a tool; `builder/tests/test_tool_skill_alignment.py` checks several
cross-surface contracts. A source-planning result does not prove its tools are
reachable, and a read-only label does not override the execution gate.

For recovery and evaluation identity, read `docs/research-workflows.md` and
`docs/tool-correctness.md`. `builder/runtime/src/harness.rs` fingerprints selected
configuration/catalog inputs. Inspect what a digest includes before using it as
evidence that two runs used identical conditions.
