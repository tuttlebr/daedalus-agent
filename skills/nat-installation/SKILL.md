---
name: nat-installation
description: >-
  Use when installing, setting up, or upgrading the NVIDIA NeMo Agent Toolkit
  (NAT). Covers the nvidia-nat package, uv add and pip install commands,
  choosing package extras such as langchain, all, eval, ragas, and
  config-optimizer, Python dependencies and virtual-environment setup,
  verifying the nat CLI with nat --version, and adapting the first runnable
  hello-world workflow. Use nat-workflow-creation for building, editing,
  validating, or running workflow YAML beyond the initial hello-world, and
  nat-user-rules if you are unsure which nat-* skill applies.
author: NVIDIA Corporation and Affiliates
license: Apache-2.0
---

# NeMo Agent Toolkit Installation

Use this skill when the task is about setup, dependencies, package extras, environment variables, or a first runnable workflow.

## Workflow

1. Read `references/installation.md`.
2. Prefer the smallest package extra that supports the requested workflow.
3. Verify the CLI with `uv run nat --version` or `uv run nat --help`.
4. For a first workflow, adapt `references/hello_world.yaml`.

## Key Commands

```bash
uv run nat --help
uv run nat --version
uv run nat info components
```

## References

- `references/installation.md`
- `references/hello_world.yaml`
