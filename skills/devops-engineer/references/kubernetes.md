# Delivery to Kubernetes

Load `kubernetes-specialist` by skill name for object design, Helm, networking,
storage, and live diagnosis. Carry the release, context, namespace, image digest,
rendered diff, and completed checks into that handoff.

The delivery skill owns the pipeline from source to artifact to rollout. It
must not become a second writer for resources owned by Helm, GitOps, an operator,
or an autoscaler. For Daedalus, follow the documented deploy wrapper and its
MCP/RAG preflights; do not replace it with a generic `kubectl apply` sequence.

Before rollout, verify architecture support, chart/value compatibility, Secret
references, resources/probes, persistent storage, and rollback limitations.
Preserve exact Service ports and network-policy dependencies.

After rollout, compare desired and effective images/configuration and exercise
the intended application request. Keep build success, Helm success, pod
readiness, and tool/endpoint behavior as separate observations. A restart uses
the published artifact; it does not publish local source changes.
