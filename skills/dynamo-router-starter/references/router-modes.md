# Router modes and evidence

<!-- SPDX-License-Identifier: CC-BY-4.0 -->

## Select against the deployed version

Inspect the pinned frontend CLI/config schema and effective container command
before editing. Mode names, environment bindings and defaults can change.
Do not assume every mode below exists in a particular image.

| Candidate mode          | Intended comparison                                                 |
| ----------------------- | ------------------------------------------------------------------- |
| `round-robin`           | Simple distribution baseline                                        |
| `kv`                    | KV overlap and load-aware placement                                 |
| `least-loaded`          | Load-aware placement without an overlap objective                   |
| `device-aware-weighted` | Capacity weighting where the version supports heterogeneous workers |
| `random`                | Randomized distribution baseline                                    |
| `direct`                | Explicit worker selection by the caller/orchestrator                |

Read the deployed version's help/docs for routing mode, KV event consumption,
cache block size, load weighting, temperature and queue policy. Use the exact
supported flag or environment variable; do not invent one from its description.

For example, when the pinned CLI supports these options:

```bash
python3 -m dynamo.frontend --router-mode kv --http-port 8000
python3 -m dynamo.frontend --router-mode least-loaded --http-port 8000
```

Approximate KV mode, where supported, trades event-derived cache knowledge for
an estimate. Make that tradeoff explicit. Match frontend/worker block sizes and
verify worker event publication and router consumption when events are enabled.

## Verify the claim being made

- Configuration: source diff plus effective frontend command/config and mode logs.
- Discovery: intended workers registered and requested model advertised.
- Serving: bounded request returns nonempty content and a successful finish state.
- Placement/reuse: per-request selected-worker rationale and KV-event/cache evidence.
- Performance: a separate frozen comparison with the same workload and topology.

Repeated-prefix traffic without errors establishes serving behavior only; it
cannot by itself establish KV reuse, placement quality or throughput improvement.

If models are absent, workers are unready, or requests fail, load
`dynamo-troubleshoot` by name. Use `dynamo-interconnect-check` for transport
questions after workers are running. Do not change routing modes repeatedly to
mask an unresolved platform, model-loading or registration failure.
