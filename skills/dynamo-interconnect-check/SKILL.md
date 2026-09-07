---
name: dynamo-interconnect-check
description: Validate NIXL, UCX, NCCL, RDMA, GPUDirect, and NVLink for Dynamo disaggregated serving. Use after deploy, not for failed pods.
license: Apache-2.0
metadata:
  author: Dan Gil <dagil@nvidia.com>
  version: 2.0.0
  tags:
    - dynamo
    - nixl
    - rdma
    - disagg
    - validation
---

# Dynamo interconnect check

Inspect the transport used by running disaggregated NVIDIA Dynamo workers.
Separate configuration, device capability, and actual transfer proof.
A successful frontend completion does not prove RDMA or NVLink was used.

## Execution and evidence

Use registered `k8s_mcp_server` reads or an available, authorized in-pod exec
capability. Do not presume the isolated sandbox can reach pods or GPUs.
Use `nvidia_docs_tool(product=dynamo)` and the deployed NIXL/UCX/NCCL
version's documentation for settings; no fixed environment list proves health.

Load [interconnect-env-vars](references/interconnect-env-vars.md) through
`agent_skills_tool(operation=load_skill, skill_name=dynamo-interconnect-check,
resource=references/interconnect-env-vars.md)`.
The optional [check_interconnect.py](scripts/check_interconnect.py) needs an
operator environment; loading it does not execute it.

## Checks

1. Resolve context, namespace, worker roles/containers, node placement, image,
   transport plugin and expected path. For crashing or unschedulable pods,
   use [dynamo-troubleshoot](../dynamo-troubleshoot/SKILL.md) first.
2. Compare recipe settings with effective worker configuration and transport
   logs. Inspect only transport-related fields, never a full credential-bearing
   environment dump. Unset UCX/NCCL selectors may mean valid auto-selection.
3. Inspect GPU/NIC topology, exposed RDMA devices, link state, and applicable
   peer-memory or DMA-BUF support. Missing probe tools are inconclusive.
   GDRCopy, NVLink, and `nvidia_peermem` are not universal prerequisites.
4. Identify the actual selected NIXL backend/UCX transport and NCCL path when
   collectives are relevant. A discovered test binary proves availability only.
5. To claim transfer correctness/performance, run an explicitly scoped pairwise
   test in the actual prefill/decode placement with compatible shipped tooling.
   Record peers, payload, selected transport, integrity, bytes transferred,
   timing, and completion. This is active test traffic, not a passive read.
   If the capability/budget is absent, return `not validated`.

Helper subcommands:

- `env <manifest-or-directory>`: text inventory, not effective config proof.
- `node --namespace <ns> --pod <pod> --container <container>`: capability probes.
- `nixl --namespace <ns> --pod <pod>`: tooling discovery only, no transfer.

Report each layer as verified, failed, or inconclusive, with evidence.
Never turn `skipped`, an exit code of zero, or a present module into a fabric
pass. A multi-node RDMA test and same-node GPU peer transfer test cover
different paths.

Use [kubernetes-specialist](../kubernetes-specialist/SKILL.md) for device
exposure/policy repairs, [dynamo-recipe-runner](../dynamo-recipe-runner/SKILL.md)
for recipe changes, and [dynamo-troubleshoot](../dynamo-troubleshoot/SKILL.md)
for worker failures. Keep repairs within the user's scope and runtime gates.
