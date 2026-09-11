# Application skills review

Reviewed all 18 application skills and their bundled resources against the
Daedalus source tree on 2026-09-07. The changes define task ownership and
handoffs, remove unsupported tool assumptions, and distinguish preparation,
execution, publication, deployment, and evidence of successful behavior.
NVIDIA copyright notices have been removed as requested. License identifiers
and source attribution remain.

## Architecture used for the review

- [Shared backend configuration](../backend/tool-calling-config.yaml) defines
  the direct tool-calling workflow, connected MCP groups, and skill dispatcher.
  The Responses configuration inherits this shared configuration. Skills use
  these registered tools rather than inventing nested agents or extra execution
  capabilities. GitHub MCP access is read-only.
- [Skill parser](../builder/agent_skills/src/agent_skills/skill_parser.py) and
  [dispatcher](../builder/agent_skills/src/agent_skills/agent_skills_function.py)
  implement progressive discovery/loading. Production enables list/load only;
  script files are inspectable resources. Sibling skills load by name because
  resource paths cannot escape the selected skill directory. Metadata does not
  grant tools or implement routing.
- The sandbox tool owns authentication, workspace identity, readiness,
  discovery, file staging and publication. It does not inherit the operator's
  checkout, `/skills`, kubeconfig, GPU, credentials, or localhost services.
  Operator CLI examples require an actual execution environment.
- [ImageBrief/ImageOptions](../builder/nat_helpers/src/nat_helpers/image_brief.py),
  [visual media](../builder/visual_media/src/visual_media/visual_media_function.py)
  and [Create API](../builder/image_api.py) share image preparation. Create reads
  the image skill directly, so that entrypoint stays self-contained.
- [Autonomous worker](../builder/autonomous_agent/src/autonomous_agent/worker.py)
  and [prompt](../builder/autonomous_agent/src/autonomous_agent/prompt.py)
  impose a noninteractive task/output contract. Skill handoffs preserve it;
  an autonomous task does not silently become an interactive Daily edition.
- UniFi instructions were checked against the sibling daedalus-context
  repository's `unifi-network-mcp/README.md`, `src/pkg/unifi/endpoints.go`,
  `src/pkg/unifi/network_v10.4.57_openapi.json`, and `src/tools/unifi.go`.
  The integration API has 73 operations, camelCase leaf names, site UUIDs,
  paginated inventory and string device states. The older desktop plugin's
  dispatcher, numeric states, alarm feed and health dashboard do not describe
  this application's connector. Future changes should recheck the deployed
  server's schema against these pinned contracts.

The shared dispatcher description now records the execution and handoff rules.
[skills/AGENTS.md](../skills/AGENTS.md) supplies the complete ownership matrix
and future maintenance checks. Resource discovery and image packaging omit
local caches and imported signatures. Old imported evaluation reports/cards
are labeled historical; they do not certify these edited copies.

## Per-skill review

The 2026-09-11 daily-summary update replaces model-transcribed rendering files
with `briefing_renderer_tool`. The tool serializes the edition object and stages
the canonical resources in the isolated sandbox. It runs both quality gates,
permits one corrected submission, and delivers exact HTML or a terminal error
edition. Shared request-scoped loop guards also bound repeated tool results,
recurring errors, and unresolved repairs in other workflows. The regression
checks cover successful inspection commands during failed repairs, parallel
submissions, exact delivery, truncation, and the real streaming agent graph.

Every row received an entrypoint and resource review, parser/dispatcher loading,
frontmatter validation, and local-link validation. The scenarios below are
manual instruction/contract checks; they are not model-driven evaluations.

| Skill                                                                     | Problem addressed and resulting behavior                                                                                                                                             | Scenario or additional evidence                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [bubblewrap-agent-workflow](../skills/bubblewrap-agent-workflow/SKILL.md) | Uses the application's sandbox schema and publication path; separates ordinary file work from adapter implementation.                                                                | Downloadable file requires successful publication; a Daily edition stays inline. Existing sandbox tests cover tool behavior.                                                                                                                                                                                                                                         |
| [creative-ideation](../skills/creative-ideation/SKILL.md)                 | Narrows method loading, removes forced novelty/discard quotas, honors requested methods/counts, and hands implementation to the requested domain.                                    | A practical three-option request retains three useful options; method-catalog links resolve to their actual resources.                                                                                                                                                                                                                                               |
| [daily-summary](../skills/daily-summary/SKILL.md)                         | Preserves OAuth-first personal reads, one memory read, exact rendering resources and source-only imagery; operational specialists return evidence to the edition owner.              | Pending personal-source authorization precedes public research; network health cannot trigger a repair or change the final HTML contract. Renderer/validator and backend contract tests pass.                                                                                                                                                                        |
| [devops-engineer](../skills/devops-engineer/SKILL.md)                     | Replaces generic deployment mandates and long templates with repository-owned CI, image, release and infrastructure procedures.                                                      | Source-only editing does not claim publication/rollout; a requested release retains immutable-image and caller-path evidence. Eight references revised.                                                                                                                                                                                                              |
| [kubernetes-specialist](../skills/kubernetes-specialist/SKILL.md)         | Follows resource ownership through mounted config, endpoints, policy and caller behavior; preserves storage, requested ports and controller-owned replicas.                          | A Pending PVC or policy-denied NodePort is investigated without generic deletion or PDB bypass. Eleven references revised.                                                                                                                                                                                                                                           |
| [sre-engineer](../skills/sre-engineer/SKILL.md)                           | Defines service-specific indicators, budgets, incident evidence and bounded automation without inventing organizational policy.                                                      | An SLO audit does not launch chaos, restart a workload or send a notification; requested experiments require measured recovery. Five references revised.                                                                                                                                                                                                             |
| [dynamo-docs](../skills/dynamo-docs/SKILL.md)                             | Resolves documentation paths and schemas from the requested revision instead of retaining a stale tree snapshot.                                                                     | A page move includes navigation, incoming links, redirects and applicable translations/catalogs; local validation cannot claim publication.                                                                                                                                                                                                                          |
| [dynamo-recipe-runner](../skills/dynamo-recipe-runner/SKILL.md)           | Separates recipe preparation, authorized bring-up, actual model output and optional interconnect evidence.                                                                           | An unresolved recipe placeholder returns a nonzero validation status. No production skill-script execution is assumed.                                                                                                                                                                                                                                               |
| [dynamo-router-starter](../skills/dynamo-router-starter/SKILL.md)         | Preserves the requested mode, verifies version-specific options, and validates completion content/model/finish state.                                                                | HTTP 200 with empty, erroneous or wrong-model content fails; a valid requested-model completion passes. Discovery-only checks are labeled.                                                                                                                                                                                                                           |
| [dynamo-troubleshoot](../skills/dynamo-troubleshoot/SKILL.md)             | Uses read-only diagnosis and identifies unstarted platform/model failures before application connectivity claims.                                                                    | Bundle command, enumeration and current-log failures mark collection incomplete; absent previous logs are recorded as optional. Credential-pattern redaction is tested and explicitly best-effort.                                                                                                                                                                   |
| [dynamo-interconnect-check](../skills/dynamo-interconnect-check/SKILL.md) | Separates available devices/configuration, selected transport, peer transfer and performance. Unset selectors can use valid defaults.                                                | Missing tools are inconclusive; the inspection helper never claims an unperformed transfer. DMA-BUF and backend-specific paths replace blanket module/env requirements.                                                                                                                                                                                              |
| [dynamo-frontend-benchmark](../skills/dynamo-frontend-benchmark/SKILL.md) | Limits conclusions to mock-worker frontend measurement; freezes workload/arms and retains failed attempts. Cleanup tracks task process identities and restores exact CPU properties. | Real local dummy-process tests preserve unrelated/reused PIDs and terminate surviving children. Fake-service lifecycle tests cover startup, duplicate start, stop and failed discovery. SSE fixtures reject incomplete streams. Raw metrics report cancellations, malformed/missing records and ambiguous runs. CPU restoration is tested with mocked systemd state. |
| [dynamo-kv-replay-parity](../skills/dynamo-kv-replay-parity/SKILL.md)     | Moves the full campaign to an on-demand reference while preserving determinism, lifecycle matrix, semantic exceptions, five warmups and 60 paired samples per row.                   | A partial preflight cannot claim the full campaign; historical seeds require requalification; supplied traces and reproducibility artifacts are retained.                                                                                                                                                                                                            |
| [espn-fantasy-football](../skills/espn-fantasy-football/SKILL.md)         | Keeps a single self-contained, scoring-aware workflow with explicit league/team/season, snake and salary-cap drafts, waivers/FAAB, lineup and trade analysis.                        | Two leagues never share roster identifiers or scoring assumptions; recommendations do not execute transactions. Compacted evidence is recovered before exact decisions.                                                                                                                                                                                              |
| [image-creation](../skills/image-creation/SKILL.md)                       | Aligns GPT Image 2.5 Sunburst chat and Create requests to shared briefs/options while preserving the requested medium, exact text, references and explicit output choices.           | Exact guidance preserves literal prompts; illustrations/logos are not forced into photography; chat uses automatic quality while Create supports all Sunburst quality levels; legacy fidelity options are omitted. Shared image contract tests pass.                                                                                                                 |
| [unifi-network](../skills/unifi-network/SKILL.md)                         | Replaces legacy plugin calls with actual integration-API leaf tools, pagination, UUIDs and field-aware read/change verification.                                                     | Multiple sites require an explicit resolved target; exact fleet counts need all pages; changes use runtime approval and post-read evidence.                                                                                                                                                                                                                          |
| [unifi-network-setup](../skills/unifi-network-setup/SKILL.md)             | Diagnoses Daedalus MCP authentication separately from controller API authentication, TLS and routing. Uses the actual server/chart ownership.                                        | A shared bearer failure does not request a controller password in chat; successful authenticated information/site reads establish the repaired application path.                                                                                                                                                                                                     |
| [network-health-check](../skills/network-health-check/SKILL.md)           | Reports current integration-API inventory/details/statistics without imaginary alarms or numeric state mappings.                                                                     | Missing pages prevent complete fleet counts; firmware availability is maintenance information; unavailable WAN/VPN observations cannot establish an all-clear.                                                                                                                                                                                                       |

## Measured instruction footprint

Across the 18 `SKILL.md` files, entrypoints changed from 3,661 to 1,621 lines and
23,915 to 12,223 whitespace-separated words (about 49% fewer words). These counts
include frontmatter. The full replay campaign and frontend study protocol remain
available on demand. Detailed creative methods and the Daily renderer/validator
remain bundled. This measures instruction size, not latency or model quality.

## Validation

The focused suite passes **254 tests**:

```bash
builder/.venv/bin/python -m pytest -q \
  builder/tests/test_skill_parser.py \
  builder/tests/test_agent_skills_function.py \
  builder/tests/test_backend_config_contracts.py \
  builder/tests/test_daily_summary_renderer.py \
  builder/tests/test_daily_summary_validator.py \
  builder/tests/test_image_brief.py \
  builder/tests/test_llm_sandbox.py \
  builder/tests/test_skill_catalog.py \
  builder/tests/test_skill_helpers.py
```

The catalog test discovers all 18 skills and round-trips every visible bundled
text resource through the actual parser/dispatcher functions. Test fixtures
stub the NAT framework boundary; this is not a container/runtime deployment.
It also checks cross-skill loading, traversal rejection and cache/signature
filtering. Helper tests use fixtures, mocked host services and disposable local
processes; they do not contact a controller or cluster or generate model load.

All 18 entrypoints pass skill frontmatter validation. All 10 Python helpers
parse and all nine Bash helpers pass `bash -n`. The local link checker covers
resource paths, cross-skill Markdown links and heading anchors:

```bash
python3 scripts/check_skill_links.py
```

Pre-commit covers the changed files, including formatting, syntax, secrets,
Python lint/security checks and local skill links. The Bash hook now matches
shell extensions correctly and checks every supplied file. No cluster mutation,
model benchmark, external publication or deployment is part of this review.
Live routing quality and model-following behavior still require a separately
scoped application evaluation; the imported historical reports are not that proof.
