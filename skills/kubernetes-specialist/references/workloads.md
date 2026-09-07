# Workload lifecycle

Select the existing controller appropriate to the task: Deployment for
replaceable replicas, StatefulSet for stable identity/storage, DaemonSet for
per-node agents, Job for finite work, CronJob for scheduled finite work.
Do not replace a custom operator with a generic controller.

Inspect selectors, owner references, revision/generation, replicas, affinity,
taints, architecture, resources, init/sidecar containers and mounted paths.
Match GPU topology and per-node capacity explicitly. Use service accounts/RBAC
only for required API access; avoid automatic token mounting when unnecessary.

Set startup/readiness/liveness according to real behavior. Long model loading
needs a startup budget; liveness must not repeatedly kill a healthy slow start.
Jobs prove completion through exit/conditions and output, not service probes.
Bound deadlines, retries, log collection and CronJob concurrency as appropriate.

For rollout changes, inspect surge/unavailable limits and PDBs against actual
capacity. Preserve stateful identity and volume retention. Verify reconciler,
pod/container, and caller-path behavior after the authorized change.

Use current [Kubernetes workload concepts](https://kubernetes.io/docs/concepts/workloads/)
and installed API schemas for detailed fields.
