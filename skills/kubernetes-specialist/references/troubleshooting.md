# Bounded Kubernetes triage

Start with the affected context, namespace, owner and current symptom. Use MCP
schemas for bounded list/detail/log/event reads; operator commands are examples
only when the corresponding CLI environment exists.

| Symptom             | Evidence to inspect                                                       |
| ------------------- | ------------------------------------------------------------------------- |
| Pending             | scheduler conditions, requests, affinities, taints, quota, PVC binding    |
| Image pull failure  | exact image/platform, registry reachability, pull-Secret references       |
| Container waiting   | init-container state, mounts, dependency/startup ordering                 |
| Crash loop          | exit reason/code, current and previous logs, OOM and probe history        |
| Stalled rollout     | current generation, ReplicaSet/Pod conditions, readiness and capacity     |
| Unreachable Service | DNS, ports, EndpointSlices, policy/flow verdicts, listener, caller path   |
| Storage error       | PVC/PV/CSI, node locality, mount options, permissions and actual I/O      |
| Forbidden           | caller identity, required verb/resource and namespace, safe RBAC metadata |

Use bounded recent events and logs. Old warning totals do not describe current
health. Never read or decode Secret values, disable policy, delete persistent
claims, bypass PDBs, or blanket-restart workloads to gather evidence.

An ephemeral debug pod/container, node exec, port-forward, or active probe may
require an additional capability or mutation. Prefer existing reads and respect
the user's scope/runtime gate. Do not claim an unstarted probe tested the app.

Return the strongest signal, likely layer, remaining ambiguity, and one useful
next action. If repair is requested, change its owner source and verify the
specific postcondition plus the user-visible request.
