---
name: nat-agent-configuration
description: >-
  Use when selecting, configuring, composing, or troubleshooting NeMo Agent
  Toolkit built-in agents and control-flow components, including ReAct
  (react_agent), tool-calling (tool_calling_agent), ReWOO (rewoo_agent),
  reasoning (reasoning_agent), router (router_agent), sequential and parallel
  executors, sub-agents as tools, and multi-agent orchestration. Use this to
  pick and wire the agent type in workflow YAML. Use nat-tools-and-functions
  to write a custom agent or tool in Python, and nat-workflow-creation for
  general workflow YAML, running, and validation.
author: NVIDIA Corporation and Affiliates
license: Apache-2.0
---

# NeMo Agent Toolkit Agent Configuration

Use this skill when the task is about choosing or wiring agent components.

## Workflow

1. Classify the workflow shape before choosing an agent.
2. Prefer built-in agents and control-flow components before custom Python.
3. Use sub-agents as tools when composing larger systems.
4. Validate agent behavior with a small `nat run` request before broad tests.

## References

- `references/agents.md`
- `references/additional-agent-types.md`
- `references/subagents.md`
- `references/subagent-patterns.md`
