# Maintaining Daedalus skills

These are application skills loaded by the NVIDIA NeMo Agent Toolkit backend,
not a collection of installed CLI plugins. Keep all skills compatible with
`backend/tool-calling-config.yaml`, the parser and dispatcher in
`builder/agent_skills`, and the actual leaf-tool schemas.

- Keep `name` identical to the directory. Discovery sees only name and
  description; metadata, `allowed-tools`, and `agents/openai.yaml` do not grant
  capabilities or implement routing in Daedalus.
- Use `agent_skills_tool(operation=load_skill, skill_name=..., resource=...)`
  for on-demand references. Sibling handoffs use the sibling's name, never
  `resource=../...`. The production dispatcher enables list/load only.
- Put shared execution rules in the dispatcher description. Keep domain
  decisions in the owning skill; references must agree with its boundaries.
- Tool descriptions must survive configuration and runtime registration. An
  individual NAT function factory yields exactly one callable; dispatch related
  operations through its typed schema. Test all enabled operations together.
- Keep source IDs aligned across the verifier registry, chat source policy,
  and autonomous worker. Planning, public claim verification, numbered Markdown
  auditing, and briefing HTML validation have distinct contracts.
- Use connected MCP tools for live systems and `llm_sandbox_tool` for bounded
  isolated work. A loaded script is text, not an executed program. The sandbox
  does not inherit `/skills`, repositories, kubeconfig, credentials, or GPUs.
- Keep explicit user scope and existing authorization across handoffs. The
  runtime owns approval/OAuth; skills must not demand duplicate confirmation,
  bypass gates, or turn an autonomous run into an interactive one.
- Preserve source-only, read-only, validated inline HTML for Daily Daedalus.
  `briefing_renderer_tool` stages canonical resources in the sandbox and owns
  validation, bounded correction, and exact inline delivery.
  Ordinary file delivery uses sandbox publication. Image creation uses the
  shared `ImageBrief`/`ImageOptions` contract, also consumed directly by Create.
- Keep diagnostics distinct from repair, artifact preparation from publication,
  and deployment readiness from successful end-to-end behavior.
- Preserve licenses and attribution. Imported evaluation reports and signatures
  cannot certify edited copies; identify provenance clearly.

## Ownership and handoffs

| Task                                 | Owner                     | Load next only when needed                                                              |
| ------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------- |
| Personalized briefing                | daily-summary             | network-health-check, kubernetes-specialist, espn-fantasy-football for a requested desk |
| Ideation                             | creative-ideation         | requested implementation or image skill                                                 |
| Image generation/edit                | image-creation            | creative-ideation only for open concept exploration                                     |
| Sandbox commands/files               | bubblewrap-agent-workflow | devops-engineer for adapter/deployment changes                                          |
| CI/CD, images, delivery              | devops-engineer           | kubernetes-specialist for cluster objects; sre-engineer for reliability                 |
| Kubernetes objects and diagnosis     | kubernetes-specialist     | focused Dynamo skills; network-health-check for external network evidence               |
| SLOs, incidents, capacity            | sre-engineer              | devops-engineer or kubernetes-specialist for implementation                             |
| Dynamo existing recipe deployment    | dynamo-recipe-runner      | dynamo-router-starter, dynamo-interconnect-check, dynamo-troubleshoot                   |
| Dynamo router mode or endpoint smoke | dynamo-router-starter     | dynamo-troubleshoot on failure                                                          |
| Unhealthy Dynamo deployment          | dynamo-troubleshoot       | dynamo-interconnect-check when workers run and transport is suspect                     |
| Dynamo fabric evidence               | dynamo-interconnect-check | dynamo-troubleshoot for pod/platform blockers                                           |
| Dynamo mock frontend measurement     | dynamo-frontend-benchmark | dynamo-router-starter for smoke; no real-GPU capacity claim                             |
| Dynamo offline replay parity         | dynamo-kv-replay-parity   | its frozen campaign references                                                          |
| Dynamo documentation authoring       | dynamo-docs               | dynamo-recipe-runner only for requested deployment validation                           |
| UniFi operations                     | unifi-network             | network-health-check or unifi-network-setup                                             |
| UniFi connector configuration        | unifi-network-setup       | unifi-network after authenticated discovery/read                                        |
| Read-only UniFi health               | network-health-check      | unifi-network for a separately requested change                                         |
| ESPN fantasy decisions               | espn-fantasy-football     | current research tools; no transaction execution                                        |

## Validation

Validate all 18 entries through the real parser/dispatcher, load every bundled
text resource, and check local links and cross-skill targets. Run the focused
builder tests for any changed scripts/contracts and pre-commit on changed files.
Do not use syntax checks as proof of model behavior, a deployment, or benchmark
quality. Keep a per-skill review record in `docs/skills-review.md`.
