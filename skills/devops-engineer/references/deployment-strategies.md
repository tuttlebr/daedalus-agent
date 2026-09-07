# Rollout and rollback

Use the application's existing strategy unless the user requests a change or
current evidence shows it cannot meet the requirement.

| Strategy   | Decide from                                                               |
| ---------- | ------------------------------------------------------------------------- |
| Rolling    | spare capacity, readiness/startup behavior, surge/unavailable budget      |
| Blue/green | parallel capacity, routing ownership, session/data compatibility          |
| Canary     | meaningful traffic split, stable baseline, explicit success/abort metrics |
| Shadow     | side effects, private data, duplicated load, response isolation           |

For each changed component, record the immutable artifact, effective config,
owner, startup deadline, acceptance probe, and rollback target. Include data
migration compatibility; reverting an image cannot reverse arbitrary writes.
Use existing feature flags only if they control the behavior being changed.

Preview the actual diff, run applicable preflights, then execute the authorized
rollout through its owner. Observe the same rollout while active. On failure,
collect evidence before choosing rollback, a source fix, or a bounded wait.
Do not automate repeated rollback/restart loops.

A canary's metrics must measure user-visible success and error/latency changes
against equivalent traffic. Missing or low-volume evidence is inconclusive.
Use `sre-engineer` for measurement/abort criteria and `kubernetes-specialist`
for the actual cluster resources. Report traffic verification separately from
reconciler or pod readiness.
