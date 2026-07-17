---
name: nat-user-rules
description: >-
  Use first and as the entry point for any NVIDIA NeMo Agent Toolkit (NAT)
  coding-agent task. This is the router that dispatches work to the focused
  nat-* skills. Covers cross-skill task routing, naming conventions (nat
  identifier vs NeMo Agent Toolkit prose), the mandatory nat info components
  discovery rule, and repo-wide conventions. Start here when the request is
  general, the toolkit repo is in scope, or the correct specific skill is not
  yet obvious, then load it for the details. Routes to nat-installation,
  nat-workflow-creation, nat-agent-configuration, nat-tools-and-functions,
  nat-evaluation, nat-optimization, nat-telemetry, nat-mcp-and-serving, and
  nat-path-checks.
author: NVIDIA Corporation and Affiliates
license: Apache-2.0
---

# NeMo Agent Toolkit User Rules

Use this skill first when working in the NeMo Agent Toolkit repository. It routes tasks to focused skills and states rules that apply across all toolkit work.

## Mandatory Rules

- Discover registered component `_type` values with `nat info components` before writing workflow, evaluation, optimizer, logging, or tracing YAML.
- Do not invent `_type` names or configuration keys from memory.
- Use `nat` only for technical identifiers such as the CLI, package name, Python namespace, paths, and environment variables.
- In prose, use "NVIDIA NeMo Agent Toolkit" on first use, then "NeMo Agent Toolkit" or "the toolkit".
- Prefer existing examples and docs before creating new patterns.
- Keep generated examples runnable from the repository root unless the surrounding example uses another convention.

## Task Routing

| Task                                                       | Skill                                     |
| ---------------------------------------------------------- | ----------------------------------------- |
| Installing or configuring the toolkit                      | `skills/nat-installation/SKILL.md`        |
| Creating, editing, validating, or running workflow YAML    | `skills/nat-workflow-creation/SKILL.md`   |
| Choosing or composing agents                               | `skills/nat-agent-configuration/SKILL.md` |
| Writing custom tools, functions, or function groups        | `skills/nat-tools-and-functions/SKILL.md` |
| Designing or running evaluation                            | `skills/nat-evaluation/SKILL.md`          |
| Running optimizer workflows                                | `skills/nat-optimization/SKILL.md`        |
| Adding tracing, logging, profiling, or telemetry exporters | `skills/nat-telemetry/SKILL.md`           |
| Serving workflows or wiring MCP                            | `skills/nat-mcp-and-serving/SKILL.md`     |
| Fixing documentation path-check failures                   | `skills/nat-path-checks/SKILL.md`         |
| Creating or improving skills                               | `skills/skill-evolution/SKILL.md`         |

## Discovery Commands

```bash
uv run nat info components -t function
uv run nat info components -t llm_provider
uv run nat info components -t evaluator
uv run nat info components -t logging
uv run nat info components -t tracing
```

## Skill Evolution

If a user corrects the skill routing, a command fails and the recovery is reusable, or a reference is stale, finish the user task first. Then read `skills/skill-evolution/SKILL.md` and update the relevant focused skill if the lesson should generalize.
