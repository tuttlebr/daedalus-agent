---
name: kubernetes-specialist
description: Author, review, or diagnose Kubernetes workloads, Helm resources, networking, policy, storage, and controllers. Daedalus's cluster tools provide read-only evidence; prepare requested changes for an authorized execution environment.
license: MIT
metadata:
  author: Jeff Allan <author@example.com>
  version: '2.0.0'
  source: https://github.com/Jeffallan
---

# Kubernetes specialist

Work from the intended cluster, namespace, resource, and controller owner.
Preserve application behavior and persistent state while diagnosing or changing
the requested surface.

## Use the available execution surface

Use registered `k8s_mcp_server` schemas for live reads and supported actions.
Daedalus currently exposes reads only: prepare an exact source patch and
validation commands for a requested repair when no write capability exists.
A tool name or Kubernetes verb does not itself grant permission.
Use an operator CLI only when the environment actually supplies it; the
isolated sandbox does not inherit kubeconfig or host/cluster access.

Read the matching reference using `agent_skills_tool(operation=load_skill,
skill_name=kubernetes-specialist, resource=references/<file>.md)`.
Cross-skill handoffs use the target skill's name and retain the same scope and
already collected evidence.

## Diagnose or implement

1. Resolve the context, namespace, workload and owner from the request/current
   inventory. Prefer bounded summaries, specific objects, recent logs and
   events over full-cluster dumps.
2. Follow the owner chain: source values/manifests → rendered resource →
   reconciler status → pod specification/mounted configuration → Service and
   EndpointSlices → the real caller's endpoint behavior.
3. Distinguish current failures from old events. An image-pull failure or a
   container waiting to start does not prove the application ran and failed.
   A Running/Ready pod does not prove a protected tool or application request.
4. Fix the diagnosed layer in its declarative source when repair is requested.
   Respect Helm, GitOps, operators, and autoscalers as owners; do not fight
   reconciliation with a lasting live patch. An emergency live change needs a
   scoped source follow-up and verification.
5. Review rendered diffs and use applicable lint/schema/dry-run checks before
   the authorized apply. Secret manifests and Helm output can contain values:
   avoid printing them. Runtime gates handle required approvals.
6. Verify the requested behavior from the caller path after a change. Preserve
   the previous working state when possible; rollback is a separate mutation
   with data/schema implications, not an automatic generic remedy.

## Application constraints

For Daedalus, Helm owns the deployed stack; Compose has a smaller footprint.
Trace backend config, external MCP/RAG dependencies, and per-user
authentication through the actual mounted/runtime configuration.

Preserve requested NodePorts, PVCs, PVs, Secret contents, PDBs, and unrelated
workloads. Do not delete network policies, bypass PDBs, dump Secrets, or recycle
all pods as diagnosis. Adapt probes, resource requests, permissions, and
security contexts to the workload: a model worker, migration Job, and web
server need different startup and health contracts.

Match node architecture, GPU SKU/count, image support, taints/tolerations,
storage locality, and controller-owned replicas before scheduling changes.
For Dynamo-specific schemas and recipes, inspect the installed CRDs and use
`nvidia_docs_tool(product=dynamo, query=...)` when available. Dynamo operator
skills are not part of this application's catalog.
Do not infer that a NodePort accepts a remote client because a Host header is
allowed; inspect routing, firewall/Cilium verdicts, and source/destination paths.

## References and handoffs

| Surface                        | Reference                                            |
| ------------------------------ | ---------------------------------------------------- |
| Workload lifecycle/probes      | [workloads](references/workloads.md)                 |
| DNS, Service, network policy   | [networking](references/networking.md)               |
| Config and Secret references   | [configuration](references/configuration.md)         |
| PVC, CSI, data lifecycle       | [storage](references/storage.md)                     |
| Chart and rendered contracts   | [helm-charts](references/helm-charts.md)             |
| Current failure triage         | [troubleshooting](references/troubleshooting.md)     |
| Custom controller ownership    | [custom-operators](references/custom-operators.md)   |
| Existing service mesh          | [service-mesh](references/service-mesh.md)           |
| GitOps revision/reconciliation | [gitops](references/gitops.md)                       |
| Evidence-based resource sizing | [cost-optimization](references/cost-optimization.md) |
| Multi-cluster scope/failover   | [multi-cluster](references/multi-cluster.md)         |

Use [devops-engineer](../devops-engineer/SKILL.md) for build/release pipelines
and [sre-engineer](../sre-engineer/SKILL.md) for SLOs and incident analysis.
Use [network-health-check](../network-health-check/SKILL.md) when external
UniFi evidence is needed. Lead with the supported conclusion and its effect on
operations or users, then explain the exact proposed/applied change and its
verification. Distinguish an observed failure from a suspected cause; explain
how remaining uncertainty affects the conclusion and which check would resolve
it. Preserve the workload, environment, and baseline behind performance claims.
Keep proposed owners, dates, and priorities distinct from confirmed commitments.
