# Multi-cluster scope and recovery

Keep cluster context, account/project, namespace, source revision and resource
identity explicit per operation. Use per-command context selection in operator
workflows; avoid changing a shared default context for concurrent work.

Inspect each cluster's API/schema, node architecture, network CIDRs, storage,
identity and ownership before sharing manifests. Same resource names do not
imply the same data or credentials. Never expose kubeconfig or Secret values.

For connectivity, trace service discovery, routes, policy, TLS/identity and the
actual caller path across both clusters. Do not install Cluster API, a mesh,
VPN or federation layer unless it is the requested architecture change.

For disaster recovery, freeze RPO/RTO, data replication/checkpoint, promotion
ownership, traffic cutover and split-brain prevention. Test restoration on a
separate target where possible. Failover, backup restoration and DNS/routing
changes are state-changing actions requiring the existing task authorization
and runtime gate. Verify application data and requests after a requested cutover;
control-plane health alone cannot prove recovery.
