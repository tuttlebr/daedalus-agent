# Incidents and resilience experiments

For an incident, capture current user impact, affected scope, as-of time,
strongest evidence and a concise timeline. Separate facts, hypotheses,
mitigations, recovery and root cause. Use focused operational skills for reads
and requested repair; preserve successful checks across handoffs.

Do not restart, scale, fail over, delete pods or send notifications merely to
follow an incident template. Those are distinct actions under the user's task
scope and runtime gates. Draft communications only when requested and keep
credentials/private payloads out of reports.

A post-incident record should explain what failed, why detection/recovery took
as long as they did, what remains uncertain, and owned follow-ups. Keep its
length proportional to the incident; avoid a mandatory organizational ritual.

For an explicitly requested fault experiment, predeclare the hypothesis,
target, baseline, blast radius, duration, abort thresholds, observer,
restoration steps and application-level recovery proof. Verify capacity/data
protection and operator availability before injecting the fault. Run one
bounded experiment, stop on the abort condition, and verify restoration even
when the hypothesis fails. Do not add chaos traffic to a routine SLO audit.

Record RTO/RPO from the actual recovered service/data. A Ready replacement pod
is not evidence that users or data recovered.
