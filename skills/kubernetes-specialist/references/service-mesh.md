# Existing service mesh

Use this reference when the target actually runs a mesh or the user requests
one. Do not install Istio/Linkerd as an incidental networking repair.

Inspect the mesh version, injection/ambient mode, control-plane health,
workload identity, proxy readiness and the affected traffic policy. Trace
Service routing separately from mesh routing and transport/authentication.

For a route, retry, timeout, circuit-breaker or mTLS change, verify its API
version and ownership, caller/destination identity, and interaction with
application retries, streaming responses, ingress and NetworkPolicy. A short
proxy timeout can break long agent/tool or inference streams.

For a canary or shadow route, preserve traffic accounting and avoid unintended
writes/private-data duplication. Fault injection is an active experiment that
needs an authorized target, impact bound and recovery verification.

Prepare a scoped source diff; validate with installed schemas and the mesh's
own tooling when available. Test the real application path after rollout.
Never pipe an unreviewed installer into a shell or disable mTLS/policy broadly
as diagnosis. Use `sre-engineer` for experiment criteria.
