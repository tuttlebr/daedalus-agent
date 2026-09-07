---
name: dynamo-router-starter
description: Configure Dynamo router modes and smoke-test its OpenAI-compatible frontend. Use for router setup, not deployment or failure diagnosis.
license: Apache-2.0
metadata:
  author: Dan Gil <dagil@nvidia.com>
  version: 2.0.0
  tags:
    - dynamo
    - router
    - smoke-test
    - bring-up
---

# Dynamo router starter

Configure the requested routing mode on an existing NVIDIA Dynamo frontend and
verify a real model response. A router-mode task does not imply a full recipe
redeploy or a throughput campaign.

## Establish the contract

Use `k8s_mcp_server` for live resources, `github_mcp_server` for the owning
manifest, and `nvidia_docs_tool(product=dynamo)` for version-specific behavior.
Inspect the running image/version and CLI/config schema before choosing flags.
Local CLI examples require an actual operator environment; the sandbox does
not inherit workers, a checkout, or a port-forward.

Read [router-modes](references/router-modes.md) through
`agent_skills_tool(operation=load_skill, skill_name=dynamo-router-starter,
resource=references/router-modes.md)`. Mode/flag names are version-dependent.

## Configure and smoke-test

1. Resolve deployment owner, namespace/context, frontend address, desired mode,
   requested model, worker registration, and KV-event publication. Reuse known
   values and successful reads.
2. If workers/recipe are absent, use
   [dynamo-recipe-runner](../dynamo-recipe-runner/SKILL.md). If they failed,
   use [dynamo-troubleshoot](../dynamo-troubleshoot/SKILL.md).
3. Preserve the requested mode. For a comparison, freeze model, workers,
   prompts, sampling, concurrency, and warmup. Do not always switch to KV.
4. Patch the owner source, review the effective frontend change, then apply
   within the user's existing authorization and runtime gates.
   Approximate KV is an explicit tradeoff when events are unavailable, not an
   automatic fix for any hang. Verify the version's actual setting first.
5. Verify effective mode and worker registration. Read `/v1/models`, select
   the intended model, and send one bounded completion. Check the response
   schema, nonempty content, and finish/error state; HTTP 200 alone is not proof.
6. Report the configured mode, evidence it took effect, model/output, and any
   approximate-routing or untested-path limitation.

The optional operator helper
[check_router_health.py](scripts/check_router_health.py) checks models and a
completion. Inspect its `--help`, then run its resolved file path from an
environment that can reach the endpoint. It supports `--base-url`,
`--model`, `--timeout`, and bounded model-discovery retries.
`--skip-chat` is only a discovery check. Production skill execution is disabled.

A single completion cannot prove KV reuse, correct worker choice, transport,
or performance improvement. Use logs/events for selection/reuse evidence,
[dynamo-interconnect-check](../dynamo-interconnect-check/SKILL.md) for fabric,
and [dynamo-frontend-benchmark](../dynamo-frontend-benchmark/SKILL.md) only for
a requested mock-worker frontend benchmark. Real-GPU capacity measurement needs
a separately scoped workload and suitable execution capability.
