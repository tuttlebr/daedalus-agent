---
name: nat-tools-and-functions
description: >-
  Use when authoring, registering, composing, or testing custom NeMo Agent
  Toolkit Python components such as tools, functions, function groups, custom
  agents, and custom evaluators. Covers register_function,
  FunctionInfo.from_fn, the Builder, Pydantic config classes, lazy optional
  imports, and advanced extension patterns. Use this for writing new component
  code. Use nat-agent-configuration to select and wire built-in agents without
  Python, and nat-evaluation to configure and run evaluations, since this
  skill covers only the code for a custom evaluator.
author: NVIDIA Corporation and Affiliates
license: Apache-2.0
---

# NeMo Agent Toolkit Tools and Functions

Use this skill when adding custom Python behavior to the toolkit.

## Workflow

1. Read `references/tools-and-functions.md` for the registration pattern.
2. Use `FunctionInfo.from_fn()` for simple async functions.
3. Use function groups when related tools share a resource.
4. Keep heavyweight optional imports lazy.
5. Add focused tests for new component behavior.

## References

- `references/tools-and-functions.md`
- `references/advanced-python.md`
