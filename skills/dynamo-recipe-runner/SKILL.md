---
name: dynamo-recipe-runner
description: Deploy and validate existing NVIDIA Dynamo Kubernetes recipes for a selected model, backend, GPU, and mode. Not for authoring new recipes.
license: Apache-2.0
metadata:
  author: Dan Gil <dagil@nvidia.com>
  version: 2.0.0
  tags:
    - dynamo
    - kubernetes
    - recipes
    - bring-up
---

# Dynamo recipe runner

Select and adapt an existing NVIDIA Dynamo Kubernetes recipe, then deploy and
verify it when requested and supported by the available tools. New recipe
authoring is a separate task; do not substitute a different model or topology
to make the request appear complete.

## Execution and references

Use registered `k8s_mcp_server` tools for live evidence and supported actions,
`github_mcp_server` for source inspection, and `nvidia_docs_tool` with
`product=dynamo` for current documented behavior. A local Dynamo checkout and
`kubectl` are operator-environment prerequisites, not Daedalus defaults.
The sandbox has no implicit checkout, kubeconfig, or GPU access.

Load [k8s-recipe-workflow](references/k8s-recipe-workflow.md) using
`agent_skills_tool(operation=load_skill, skill_name=dynamo-recipe-runner,
resource=references/k8s-recipe-workflow.md)` before deployment.
Bundled [recipe_tool.py](scripts/recipe_tool.py) is an optional operator helper.
Production skill loading does not execute scripts.

## Bring-up

1. Resolve the model, backend, GPU SKU/count, node architecture, aggregation
   mode, context, namespace, image revision, storage class and model-access
   Secret reference. Infer from confirmed source/state; ask only for an
   ambiguous requirement that changes selection.
2. Inspect the target revision's `recipes/README.md` and candidate README,
   model-cache manifests, deployment, and optional performance configuration.
   Prefer an exact recipe; show incompatible requirements before proposing a
   different one.
3. Check live allocatable GPUs/topology, image architecture/backend support,
   CRDs/operator version, storage access mode/capacity/locality, and Secret
   existence/reference names without reading values.
4. Validate and patch only required values. The scanner's GPU count is a
   textual hint; verify replicas, roles, TP/PP/EP, and per-node fit explicitly.
   Record scaling ownership, including a DGD scaling adapter when present.
5. Prepare the full diff, apply/wait sequence, rollback limits, and smoke
   request. Use the owning repository's deploy flow within existing user
   authorization and runtime gates. Model-cache job names and resource order
   come from that recipe, never an assumed `model-download` name.
6. Check cache completion, bound storage, reconciled DGD, ready frontend and
   workers, model registration, then a real completion for the requested model.
   Use bounded polls and retain the same operation/job while it is running.

Load [dynamo-router-starter](../dynamo-router-starter/SKILL.md) for router
configuration or smoke mechanics. On failure, use
[dynamo-troubleshoot](../dynamo-troubleshoot/SKILL.md) with completed checks.
For disaggregated transport evidence, use
[dynamo-interconnect-check](../dynamo-interconnect-check/SKILL.md).
Do not launch a performance job as an incidental smoke test.

## Operator helper

From an actual Dynamo checkout, use the resolved path to this skill's helper:

```bash
python3 /path/to/skills/dynamo-recipe-runner/scripts/recipe_tool.py --help
```

Its `list --framework vllm --format table` and
`validate recipes/<model>/<backend>/<mode>` subcommands perform discovery and
lightweight text validation. They do not prove cluster/API compatibility.

Report selected revision/path, fit evidence, exact patch, executed stages,
endpoint/completion result, and remaining blockers. If execution is unavailable,
deliver the reviewable patch and commands without claiming a deployment.
