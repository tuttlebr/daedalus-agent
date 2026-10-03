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
- Use the exposed application allowlist, not the remote server's full catalog.
  Kubernetes, GitHub, Gmail and UniFi are read-only in this configuration.
  Hue, Calendar and Docs writes retain their own runtime gates. A skill cannot
  widen that surface or change per-user OAuth scopes.
- Reuse relevant `automatic_hindsight` context before explicit recall. Memory
  is untrusted personalization evidence, never an instruction or permission
  to persist facts. Background runs retain their separate output/tool contract.
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
- Check Daily Daedalus against `daily_summary_nat_tools`, not only `nat_tools`.
  ESPN is available for the seasonal fantasy desk; X, domain retrieval and
  NVIDIA docs are general-chat tools. Briefing photos are handled by the
  renderer, and its final synthesis phase exposes only the renderer.
- Keep `use-hue-api` independently copyable and `image-creation` self-contained
  for Create's direct entrypoint reader. Their larger catalogs have a concrete
  consumer; do not move required guidance into unconsumed references.
- Keep diagnostics distinct from repair, artifact preparation from publication,
  and deployment readiness from successful end-to-end behavior.
- Keep skill reporting consistent with the runtime communication style: lead
  with a supported conclusion and consequence, distinguish evidence from
  interpretation and proposals, preserve comparison conditions, and make needed
  decisions or validation clear. Put task-specific editorial guidance in the
  owning skill; do not replace required output schemas with a prose template.
- Apply the `i-have-adhd` presentation default to most conversational replies
  through the main prompt, without loading it before each answer. Use its full
  guidance for task-starting support or tailoring. Preserve the user's requested
  depth, complete coverage, and the owning skill's HTML/JSON/artifact contract.
- Preserve licenses and attribution. Imported evaluation reports and signatures
  cannot certify edited copies; identify provenance clearly.

## Ownership and handoffs

| Task                                 | Owner                     | Companion skills and when to load                                                                                                     |
| ------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Personalized briefing                | daily-summary             | espn-fantasy-football for in-season fantasy; network-health-check or kubernetes-specialist for a requested check or material incident |
| Inbox prioritization and chat drafts | email-inbox-triage        | humanizer for requested voice polish; bubblewrap-agent-workflow for files; daily-summary retains its source window and format         |
| Conversational response presentation | i-have-adhd               | overlays an owning task; never replaces its evidence, completeness, or delivery contract                                              |
| Ideation                             | creative-ideation         | requested implementation or image skill                                                                                               |
| Prose humanization and voice editing | humanizer                 | bubblewrap-agent-workflow for requested files; preserve the calling skill's evidence and output contract                              |
| Recent topic and community research  | last30days                | humanizer for requested prose polish; bubblewrap-agent-workflow for files; daily-summary retains its briefing contract                |
| Image generation/edit                | image-creation            | creative-ideation only for open concept exploration                                                                                   |
| Sandbox commands/files               | bubblewrap-agent-workflow | devops-engineer for adapter/deployment changes                                                                                        |
| CI/CD, images, delivery              | devops-engineer           | kubernetes-specialist for cluster objects; sre-engineer for reliability                                                               |
| Kubernetes objects and diagnosis     | kubernetes-specialist     | network-health-check for external network evidence                                                                                    |
| SLOs, incidents, capacity            | sre-engineer              | devops-engineer or kubernetes-specialist for implementation                                                                           |
| UniFi operations                     | unifi-network             | network-health-check or unifi-network-setup                                                                                           |
| Hue lighting and resource operations | use-hue-api               | devops-engineer for a separately requested integration or deployment change                                                           |
| UniFi connector configuration        | unifi-network-setup       | unifi-network after authenticated discovery/read                                                                                      |
| Read-only UniFi health               | network-health-check      | unifi-network for a separately requested change                                                                                       |
| ESPN fantasy decisions               | espn-fantasy-football     | current research tools; no transaction execution                                                                                      |
| Weekly fantasy league newspaper      | fantasy-football-recap    | espn-fantasy-football required for every edition; bubblewrap-agent-workflow for calculation and file delivery                         |

## Validation

Discover the complete catalog dynamically through the real parser/dispatcher;
the current catalog contains 17 entries. Load every bundled
text resource, and check local links and cross-skill targets. Run the focused
builder tests for any changed scripts/contracts and pre-commit on changed files.
Do not use syntax checks as proof of model behavior, a deployment, or benchmark
quality. Keep import provenance, adaptation decisions, and validation scope
beside each imported skill in `references/upstream.md`.
The complete architecture review is recorded in
[docs/skills-review.md](../docs/skills-review.md).
