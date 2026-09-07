# Monitoring and alerting

Monitor user-visible latency, traffic, errors and saturation using the existing
telemetry stack. Do not assume Prometheus or a specific metric exists because
Kubernetes tools are connected.

For a 99.9% availability SLO, a fast-burn example tests both 1-hour and 5-minute
error ratios above `14.4 * 0.001`. A medium-burn example tests both 6-hour and
30-minute error ratios above `6 * 0.001`. Use the actual target and window;
validate label matching, denominator, exclusions and low/no-traffic behavior.
Do not replace a short confirmation window with a second longer window.

For histogram latency, preserve the bucket label and intended service labels
while aggregating. Verify units. CPU throttled-period ratio uses throttled
periods divided by total periods; throttled seconds divided by periods is not
a dimensionless ratio. Inspect the actual exporter schema.

Each actionable alert needs impact, source/query, severity rationale, owner,
first checks and recovery criteria. Group related failures and route through
existing notification policy. Drafting an alert message does not authorize
sending it or paging someone.

Validate representative normal, burning, recovered and missing-data cases.
A dashboard rendering successfully is not proof that its queries observe the
service. See [error-budget-policy](error-budget-policy.md) for arithmetic and
[incident-chaos](incident-chaos.md) for incident/experiment handling.
