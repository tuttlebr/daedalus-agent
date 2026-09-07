---
name: dynamo-troubleshoot
description: Diagnose unhealthy Dynamo Kubernetes deployments across pods, jobs, PVCs, workers, routers, and endpoints. Not for normal recipe bring-up.
license: Apache-2.0
metadata:
  author: Dan Gil <dagil@nvidia.com>
  version: 2.0.0
  tags:
    - dynamo
    - kubernetes
    - troubleshooting
    - day-2
---

# Dynamo troubleshoot

Diagnose unhealthy NVIDIA Dynamo workloads using current, bounded evidence.
Diagnosis is read-only; execute a repair only when the user requested it and
the runtime permits it. Do not turn a debugging request into a redeployment.

## Collect and classify

Use registered `k8s_mcp_server` reads. Resolve context, namespace, DGD/workload,
container, endpoint and owner before collecting details. Carry prior evidence
and completed reads into this skill instead of repeating a full preflight.

Load [failure-decision-tree](references/failure-decision-tree.md) using
`agent_skills_tool(operation=load_skill, skill_name=dynamo-troubleshoot,
resource=references/failure-decision-tree.md)`.

Check the layer implicated by the symptom, then trace dependencies:

- cluster/node and namespace;
- model-access references, cache job, PVC and mount;
- image/backend/architecture and GPU scheduling;
- operator reconciliation and replica/scaling ownership;
- frontend/worker registration, Service/EndpointSlices and network policy;
- requested API/model response;
- benchmark client only after the endpoint works.

Use recent conditions, last termination, owner chain, and bounded current or
previous-container logs. An old event is not an active incident.
`ErrImagePull`, `ImagePullBackOff`, and a container that has not started
are unexecuted application checks. Preserve secrets and private request data.

## Optional operator bundle

[collect_dynamo_debug_bundle.py](scripts/collect_dynamo_debug_bundle.py) needs
an actual operator environment with Python and read-only kubectl access.
Load it as a resource to inspect; Daedalus does not execute bundled scripts.
Its arguments include `--namespace`, `--deployment-name`, `--selector`,
`--outdir`, `--tail`, and `--timeout`.

Use an explicit verified `--selector` to scope pod logs. A deployment name
adds its DGD description but does not automatically scope all pod reads.
The helper records failed collection commands and applies best-effort
redaction; inspect collection errors and sanitize before sharing. An empty
bundle is not evidence of a healthy deployment.

## Resolve and verify

Report the primary failure class, strongest signal, observed impact, plausible
cause, ruled-out layers, and the exact next read or source patch.

When repair is requested, choose one evidenced change in the owner source.
Use [dynamo-recipe-runner](../dynamo-recipe-runner/SKILL.md) for recipe repair,
[dynamo-router-starter](../dynamo-router-starter/SKILL.md) for routing, or
[kubernetes-specialist](../kubernetes-specialist/SKILL.md) for platform objects.
Do not recreate populated PVCs, dump Secrets, change GPU counts without
revalidating the model topology, or bypass PDBs to make readiness green.

Verify the changed layer and requested endpoint behavior afterward.
For running workers with suspected cross-worker transport failures, use
[dynamo-interconnect-check](../dynamo-interconnect-check/SKILL.md).
Keep source validation, rollout recovery, and real serving evidence distinct.
