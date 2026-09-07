---
name: sre-engineer
description: Define or review service SLIs, SLOs, error budgets, alerting, capacity, incident response, and bounded toil automation. Use focused delivery skills for implementation.
license: MIT
metadata:
  author: Jeff Allan <author@example.com>
  version: '2.0.0'
  source: https://github.com/Jeffallan
---

# SRE engineer

Tie reliability claims to user-visible behavior and measured evidence.
Choose the requested reliability task; an alert review does not require a
chaos campaign, new monitoring stack, or deployment.

## Application boundaries

Use connected tools and existing telemetry. Daedalus's registered Kubernetes
tools can establish workload state, but are not an implicit Prometheus query
service. Read logs/metrics through an available capability or supplied data;
report missing observation instead of inventing a metric.

For this application, distinguish frontend request acceptance, provider
response completion, successful tool actions, durable memory, retrieval, image
delivery, and autonomous goal runs. A successful HTTP status or Ready pod is
not a complete service SLI. Per-user OAuth/approval waits should be classified
according to the agreed user journey, not automatically counted as server
failure or silently removed from the denominator.

## Workflow

1. Identify the service boundary, affected users, measurement period, and
   requested decision. Reuse current scope and evidence from the calling skill.
2. For an SLO, specify good events, valid total events, source query, exclusions,
   window, and target. Separate an observed baseline from a proposed target.
   Missing telemetry is unknown, not zero errors.
3. For an incident, lead with current impact, timeline, strongest evidence,
   owner, and a bounded next action. Distinguish recovery from root-cause proof.
4. For capacity, use representative traffic, service latency and saturation;
   freeze the workload/topology before comparison. A mock frontend benchmark
   cannot establish real GPU serving capacity.
5. For automation, begin with a read-only decision/dry run, exact targets,
   concurrency/timeout bounds, stop conditions, and verifiable postconditions.
   A restart on a threshold alone is not a diagnosis.
6. Validate queries, calculations, proposed configuration, and recovery behavior
   appropriate to the requested scope. Execute a fault experiment, restart,
   failover, or external notification only when that action is authorized and
   the runtime permits it.

Do not impose an invented organization-wide release freeze, approval hierarchy,
mandatory postmortem, or toil percentage. Propose policies based on impact,
actual ownership, and the user's constraints.

## References

Load only the relevant reference with `agent_skills_tool(operation=load_skill,
skill_name=sre-engineer, resource=references/<file>.md)`.

- [slo-sli-management](references/slo-sli-management.md): event definitions,
  latency and availability targets, missing data.
- [error-budget-policy](references/error-budget-policy.md): burn rates,
  budget arithmetic, decision policy.
- [monitoring-alerting](references/monitoring-alerting.md): paired windows,
  label consistency, notification/runbook design.
- [automation-toil](references/automation-toil.md): bounded automation and
  capacity evidence.
- [incident-chaos](references/incident-chaos.md): incident record and
  explicitly requested resilience experiments.

Hand off cluster objects to
[kubernetes-specialist](../kubernetes-specialist/SKILL.md), delivery changes to
[devops-engineer](../devops-engineer/SKILL.md), and Dynamo failures to
[dynamo-troubleshoot](../dynamo-troubleshoot/SKILL.md). Keep evidence and
execution status together. Return the requested analysis or artifact, its
measurement assumptions, validation, and unverified limits.
