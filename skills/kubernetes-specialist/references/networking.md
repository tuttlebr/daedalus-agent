# Network path diagnosis

Trace one real caller to the destination: DNS → route/firewall → Service port
and targetPort → EndpointSlice address/readiness → pod listener → application
protocol/authentication. Include return traffic and egress as well as ingress.

- Preserve requested NodePorts and distinguish cluster-internal from external
  reachability. A successful port-forward bypasses parts of the normal path.
- Inspect actual CNI policy and flow verdicts. Cilium FQDN/CIDR policy can apply
  after Service translation; compare the destination port the pod receives.
- Check namespace and pod selectors, DNS egress, source NAT, external traffic
  policy, VLAN routing and TLS/Host handling where relevant.
- Host-header allowlists validate Host values, not client-source reachability.
- A configured Ingress/Gateway/LoadBalancer does not prove a ready controller,
  assigned address, or backend route.

Prepare a narrow declarative policy/Service fix from evidence. Never remove all
network policies as a diagnostic step or open unrelated egress. Validate with
an allowed and, where needed, a denied path after the requested change.
Use `network-health-check` for UniFi-side evidence without conflating a healthy
controller with healthy Kubernetes networking.
