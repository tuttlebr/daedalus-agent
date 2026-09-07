# SLIs and SLOs

Define an event-based SLI as `good / valid_total` over an explicit window.
Specify the telemetry source, label scope, aggregation, exclusions and freshness.
For a latency SLI, count valid requests meeting a latency threshold; an average
or p99 is not that event ratio. Match histogram units/buckets to the threshold.

For Daedalus, identify which journey is measured: chat completion, tool action,
image delivery, retrieval, memory or autonomous run. HTTP acceptance and token
arrival do not necessarily establish successful completion. Define how retries,
client cancellations, OAuth waits, approval pauses and upstream failures count.

Missing series, stale samples and no traffic produce unknown/no-observation
states unless the agreed SLI explicitly defines otherwise. Never fabricate a
perfect SLI by substituting zero errors for missing telemetry.

Record a measured baseline and proposed target separately. Choose targets from
user impact, achievable behavior and the observation window, not a stock 99.9%.
For availability target S and N valid requests, allowed bad events are
`(1 - S) * N`. Time-based and request-based budgets use different denominators;
do not convert between them without an explicit assumption.

Validate calculations on known good/bad/missing fixtures and representative
real telemetry. Return the query, assumptions and coverage limits with the SLO.
