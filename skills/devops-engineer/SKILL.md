---
name: devops-engineer
description: Build or review CI/CD, container images, release automation, and infrastructure delivery. Use kubernetes-specialist for cluster objects and sre-engineer for reliability analysis.
license: MIT
metadata:
  author: Jeff Allan <author@example.com>
  version: '2.0.0'
  source: https://github.com/Jeffallan
---

# DevOps engineer

Implement the requested delivery change in the application's existing
architecture. Do not introduce a new orchestrator, cloud, staging environment,
or release process just because a generic template uses one.

## Execution and ownership

Daedalus uses registered repository tools for source inspection,
`k8s_mcp_server` for cluster evidence, and `llm_sandbox_tool` for explicitly
requested isolated command/file work. GitHub's configured tools are read-only.
The sandbox does not inherit a checkout, Docker daemon, or cluster credentials.
Without an appropriate execution tool, produce the exact files/patch and report
unexecuted validation or release steps.

For this application, inspect `README.md`, `Makefile`, `deploy.sh`,
`docker-compose.yaml`, `builder/Dockerfile`, the selected backend YAML,
and `helm/daedalus` as relevant:

- The canonical interactive workflow is `backend/tool-calling-config.yaml`;
  its Responses overlay inherits it. The frontend's chat-completions route
  and the backend's outbound Responses model API are separate contracts.
- Compose supports local services; Kubernetes also supplies the autonomous
  worker and external integrations. Do not treat their footprints as identical.
- Backend images copy the separate `skills` build context into `/skills`.
  Compose mounts source skills read-only; Helm can use an optional skills
  volume. Check the effective deployment before choosing how to refresh them.
- Use the documented deploy wrapper and existing preflights for publication
  and deployment. Preserve image provenance, immutable references, Secret
  wiring, protected user identity, and existing data.

## Workflow

1. Identify the requested artifact and release stage, repository revision,
   environment, owner, and existing constraints. Reuse confirmed context.
2. Inspect relevant source/configuration and explain the concrete change.
   Keep source edits, build, image publication, deployment, and restart distinct.
3. Implement the smallest complete change in the owner source. Prefer existing
   templates and dependency locks over copied examples or version guesses.
4. Run the checks that cover the changed behavior, including runtime packaging
   where dependencies, registrations, or image contents change.
5. Publish/deploy only within the user's requested scope and runtime gates;
   existing authorization carries forward. Verify immutable artifacts and the
   actual endpoint/tool result after a rollout.
6. Report what changed, evidence, remaining risk, and any unexecuted stage.
   Do not call a source test a deployed fix.

Use [kubernetes-specialist](../kubernetes-specialist/SKILL.md) for manifests,
Helm resources, networking, and storage; [sre-engineer](../sre-engineer/SKILL.md)
for SLOs or incident policy. Preserve completed checks across handoffs.
Dynamo recipe bring-up belongs to
[dynamo-recipe-runner](../dynamo-recipe-runner/SKILL.md).

## Focused references

Load only the relevant resource with `agent_skills_tool(operation=load_skill,
skill_name=devops-engineer, resource=references/<file>.md)`.

| Task                       | Reference                                                    |
| -------------------------- | ------------------------------------------------------------ |
| CI workflow                | [github-actions](references/github-actions.md)               |
| Image/build context        | [docker-patterns](references/docker-patterns.md)             |
| Cluster delivery boundary  | [kubernetes](references/kubernetes.md)                       |
| Terraform/IaC              | [terraform-iac](references/terraform-iac.md)                 |
| Rollout and rollback       | [deployment-strategies](references/deployment-strategies.md) |
| Internal platform          | [platform-engineering](references/platform-engineering.md)   |
| Release/artifact lifecycle | [release-automation](references/release-automation.md)       |
| Delivery-related incident  | [incident-response](references/incident-response.md)         |

For requested downloads, verify and publish generated text through the sandbox
and return its exact link. Do not expose credentials, stage unrelated edits,
or replace persistent resources to make a rollout pass.
