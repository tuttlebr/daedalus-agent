# Daedalus skills architecture review

Reviewed on 2026-10-03 against the current application source and a locally built
backend image. The complete catalog contains **17 skills, 83 bundled resources,
and 6 Python helpers**. The review covers every entrypoint, supporting resource,
tool handoff, and helper contract. Retain compatible skills without rewriting
their domain guidance simply to make every file change.

The review incorporates two user preferences: inbox triage prioritizes messages
and drafts replies in chat by default; the `i-have-adhd` presentation style applies
to most conversational replies. These are application defaults, subject to later
requests and the owning task's complete output contract.

## Architecture that the skills must follow

- **Application discovery:** `SkillParser` discovers name and description. The
  production `agent_skills_tool` exposes list/load only. Optional metadata,
  `agents/openai.yaml`, slash commands, and imported invocation flags do not
  implement activation, permissions, or persistent preferences in Daedalus.
- **Runtime:** `backend/tool-calling-config.yaml` is the canonical per-user
  Responses API workflow. Skills must not prescribe a removed configuration
  overlay. Skill-based model routing remains limited to the configured owners;
  explicit user selection takes precedence, and maximum effort is explicit.
- **Actual tools:** Kubernetes, GitHub, Gmail, and UniFi expose read operations.
  The remote servers' larger catalogs do not authorize other leaves. Calendar,
  Docs, and Hue retain their existing runtime approval and OAuth behavior.
  Loading a skill does not extend the tool catalog or authentication scopes.
- **Memory and compaction:** reuse relevant `automatic_hindsight` context before
  an explicit recall. Treat recalled and retrieved content as evidence, not
  instructions. Recover omitted tool rows before complete-membership or absence
  claims. Skill loading does not authorize a durable memory write.
- **Execution and files:** the isolated sandbox has no implicit repository,
  `/skills`, credentials, kubeconfig, host filesystem, or GPU access. Loaded
  scripts are text until explicitly staged and executed. Requested durable files
  require verified sandbox publication; Daily Daedalus returns exact inline HTML.
- **Different consumers:** Daily Daedalus loads canonical policy, sourcing,
  format, and editorial resources automatically, with a fresh backend clock.
  Its renderer owns assets and scripts. Create directly reads `image-creation`
  and needs its self-contained recipes. Hue remains independently copyable with
  its inline operation, payload, transport, and color guidance.

## Complete catalog decisions

| Skill                       | Decision and rationale                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bubblewrap-agent-workflow` | Retain. Matches sandbox isolation, explicit staging, bounded execution, and verified publication. Its API reference agrees with the adapter.                                                                                                                                                                                                                                                              |
| `creative-ideation`         | Clarify chat adaptations versus real workshops. Method examples cannot invent participants, observations, random draws, elapsed time, or authorization to contact or delete. Keep its conditional method library.                                                                                                                                                                                         |
| `daily-summary`             | Align sourcing with the restricted briefing catalog; include ESPN for the seasonal fantasy desk. Remove visual-media exposure because source photographs belong to the renderer. Limit operational investigation to requested or affected scope. Supply plain text for the renderer's escaping. Preserve canonical policy, editorial detail, HTML schema, research budget, and final renderer-only phase. |
| `devops-engineer`           | Replace the obsolete Responses overlay guidance with the canonical workflow. Retain focused CI, artifact, deployment, and incident references.                                                                                                                                                                                                                                                            |
| `email-inbox-triage`        | Adapt the supplied import to the five real Gmail read leaves and per-user OAuth. Prioritize and draft in chat. State a bounded default inbox window, retrieve complete threads, report coverage gaps, and use available voice evidence before optional small sent-mail sampling. Remove unavailable connector handoffs and provider-write promises.                                                       |
| `espn-fantasy-football`     | Retain. Current league discovery, fresh evidence, complete league coverage, transaction limits, and tool contracts remain useful. Its substantial entrypoint encodes domain-specific correctness rules.                                                                                                                                                                                                   |
| `fantasy-football-recap`    | Retain. Requires fresh ESPN evidence, exact scoring and finality, complete league reporting, the companion fantasy skill, checked calculations, and verified publication. Template and score-check helper remain consistent.                                                                                                                                                                              |
| `humanizer`                 | Retain. Precise prose-editing scope, optional pattern reference, attribution, and preservation of the calling task's evidence and deliverable are compatible.                                                                                                                                                                                                                                             |
| `i-have-adhd`               | Adapt the supplied import and make its concise presentation default part of the main prompt. Detailed loading is reserved for focused support or tailoring. Remove unsupported activation and persistence promises, diagnosis claims, mandatory time estimates, and extra approval rituals. Preserve exhaustive coverage and structured outputs.                                                          |
| `image-creation`            | Retain its self-contained recipes. Both Chat and Create consume the shared image brief/options contract, while Create reads this entrypoint directly. Keep current Sunburst constraints, exact lettering, image-reference handling, and Content Credentials rules.                                                                                                                                        |
| `kubernetes-specialist`     | Remove nonexistent application-skill handoffs and obsolete overlay guidance. Use available NVIDIA documentation and installed CRD evidence for Dynamo tasks. Make the read-only cluster surface explicit; prepare a patch when execution requires an operator capability.                                                                                                                                 |
| `last30days`                | Add the actual read-only X and GitHub research surfaces where relevant. Bound native searches by supported schemas and timestamps, distinguish coverage gaps, and separate shipped releases from proposed changes. Preserve public-search fallback and the pinned imported methodology.                                                                                                                   |
| `network-health-check`      | Retain. Read-only health reporting, target resolution, bounded observations, and separation from repairs agree with current UniFi access. Its state/alarm/subsystem references remain applicable.                                                                                                                                                                                                         |
| `sre-engineer`              | Retain. Reliability ownership, SLO/error-budget reasoning, incident and capacity evidence, and implementation handoffs match the current architecture.                                                                                                                                                                                                                                                    |
| `unifi-network`             | Restrict discovery and reference guidance to the eleven configured read leaves. Prepare requested changes from actual evidence, identify missing configuration, and reserve execution for a separately supplied authorized write capability. Remove promises of unavailable firewall, VPN, and mutation tools.                                                                                            |
| `unifi-network-setup`       | Distinguish application read access from connector repair requiring an operator environment. The isolated sandbox cannot act as the host or change deployment credentials.                                                                                                                                                                                                                                |
| `use-hue-api`               | Add an inline Daedalus integration path using connected MCP tools, runtime credentials, and existing gates. Prefer convenience calls for ordinary lighting, native tools for richer fields, and bounded readback. Preserve the standalone REST guide and all 155 operations; direct REST requires an explicitly supplied operator environment. Align its UI description.                                  |

## Configuration and maintenance changes

The dispatcher now documents the actual read-only groups, automatic-memory reuse,
and task-owned output formats. A short main-prompt presentation default applies
the requested response style without spending a skill-load call before every
answer. It retains the existing shared communication guidance and lets later
style requests override the default.

Daily Daedalus keeps seventeen research tools: ESPN replaces visual media.
General chat retains X, domain retrieval, NVIDIA documentation, and visual media;
the briefing uses eligible search/fetch sources and its renderer. Its final phase
still exposes only `briefing_renderer_tool`. No OAuth scopes, runtime gates,
model routes, dependencies, helper implementation, or deployment were changed.

The two supplied imports include adaptation/provenance notes. Their original MIT
license declarations are preserved. The supplied inbox import identifies its
author/version but no source URL, commit, or full license text; the style import
does not identify an upstream author or revision. The notes state these gaps
without inventing provenance or claiming upstream certification.

Catalog regression coverage now discovers the shipped skills dynamically instead
of hard-coding fifteen entries. Tool-alignment coverage checks qualified MCP
leaves against the actual include/exclude configuration. Tests that referenced
retired, absent Dynamo skill helpers are replaced with offline checks for the Hue
helpers that are actually shipped: operation coverage, bounded output, invalid
requests, format versions, export deduplication, conflicts, and incomplete exports.
Existing briefing renderer/validator and fantasy scoring tests cover the other
four helpers.

## Validation and limits

- Focused parser, dispatcher, catalog, tool-alignment, helper, briefing, image,
  fantasy, and model-routing tests: **285 passed**.
- Backend configuration checks: **94 passed, 2 pre-existing failures**. The
  changed catalog, tool-alignment, and helper tests also pass after formatting.
- The locally built backend image loads **17 skills and 83 resources through
  the real NVIDIA NeMo Agent Toolkit** and validates **18 native tool schemas,
  configured descriptions, and registration lifecycles**. The image build also
  runs the repository's runtime contract checks.
- All seventeen skills pass frontmatter validation; all local skill links resolve.
- Changed-file pre-commit hooks and `git diff --check` pass.
- A real HTTP backend workflow against a recording Responses API fixture and
  disposable Redis passes **77 cases**, including streaming, skill-load routing,
  explicit model selection, restricted briefing phases, and failure paths. This
  fixture uses synthetic skills and a local provider; it does not measure model
  interpretation of the production skill instructions. No production services
  were contacted, and the disposable Redis container was removed.

The broader backend configuration test file has two unrelated existing failures,
reproduced using its unmodified HEAD test functions: the dependency checker reports
an undeclared `pil` import, and a deployment guide check cannot find
`docs/operations.md` (it also expects `docs/content-credentials.md`). They remain
outside this skill review; no missing deployment guides or dependency locks were
reconstructed to hide the failures.

These checks establish source contracts, resource loading, helper behavior, and
local runtime integration. They do not establish live MCP availability, deployed
behavior, or how a production model will apply the new presentation and triage
instructions. Validation was performed locally before committing; this review
includes no push or deployment. When deployed, exercise a representative inbox
review, an ordinary reply, a task-starting request, a Hue lighting request, and an in-season briefing
through the authenticated application to assess behavior and latency.
