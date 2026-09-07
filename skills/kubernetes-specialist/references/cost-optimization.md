# Resource and capacity decisions

Use representative workload demand, latency/errors, CPU/memory/GPU utilization,
saturation, storage I/O and scheduling evidence. Identify the observation window
and source; an idle snapshot cannot justify shrinking production capacity.

Check requests versus actual use, throttling/OOM, queueing, topology and spare
capacity. For GPU workloads, preserve model fit and TP/PP/EP placement.
Coordinate with HPA, VPA, cluster autoscaling and custom scaling adapters rather
than giving multiple controllers ownership of replicas/resources.

Use recommendation/advisory modes before a requested sizing change when
available. Compare one variable with the workload/topology fixed and retain
baseline artifacts. Include startup time, headroom, disruption, recovery and
persistent-storage costs in the decision.

Spot/preemptible placement, scheduled scale-to-zero, quota/LimitRange and
priority changes need workload tolerance and recovery proof; do not evict or
suspend workloads to make an estimate look better. Validate after a scoped
change using the same service objectives. Use `sre-engineer` for capacity/SLO
analysis and the owner skill for implementation.
