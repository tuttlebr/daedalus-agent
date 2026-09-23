# Response communication style

Daedalus leads with the most important supported conclusion or decision and
explains its consequence before recounting activity. The response should make
its evidence, material uncertainty, and any needed action understandable on
their own. Simple questions still receive simple answers; required JSON and
HTML formats remain in force.

The shared Python guidance is in
`builder/nat_helpers/src/nat_helpers/communication_style.py`. The interactive
workflow and standalone retrieval example carry the complete guidance inline
because their YAML is consumed directly by the toolkit. Contract tests compare
both YAML copies with the shared constant. No runtime file lookup is needed.

## Maintained prompt surfaces

| Surface                                                                         | Application of the guidance                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/tool-calling-config.yaml`                                              | Full communication contract in the canonical Responses workflow instructions.                                                                                                                                    |
| `builder/autonomous_agent/src/autonomous_agent/prompt.py`                       | Shared contract in the runtime overlay after mutable workspace notes; feed field descriptions emphasize supported outcomes, consequences, and uncertainty.                                                       |
| `builder/smart_milvus/src/smart_milvus/configs/config.yml`                      | Same full contract in the standalone retrieval assistant.                                                                                                                                                        |
| `builder/content_distiller/src/content_distiller/content_distiller_function.py` | Shared source-summary guidance preserves evidence, proposals, baselines, and limitations without adding recommendations to source material.                                                                      |
| `builder/source_verifier/src/source_verifier/critic.py`                         | Shared prose style for explanatory JSON fields; decisive evidence or gaps lead the explanation. Quotes and verdict schema retain their existing contracts.                                                       |
| `builder/visual_media/src/visual_media/visual_media_function.py`                | Full contract for image/video analysis, with explicit separation of visible observations from interpretation. Existing reasoning-mode flags are preserved.                                                       |
| `builder/nat_helpers/src/nat_helpers/image_brief.py`                            | Shared prose style for descriptive brief fields; requested art style, fiction, and exact lettering take precedence. Exact-prompt mode still bypasses preparation.                                                |
| `builder/nat_helpers/src/nat_helpers/hindsight_memory_context.py`               | Shared source-summary guidance for new knowledge-page queries and session reflection. Existing stored pages and cached briefs are not rewritten by a source change.                                              |
| `builder/nat_helpers/src/nat_helpers/daily_summary_runtime.py`                  | Final-synthesis and recovery guidance preserves the editorial style in both HTML and sourced text fallback.                                                                                                      |
| `skills/daily-summary/`                                                         | Main skill, editorial reference, and edition-format examples apply the conclusion/evidence/action standard across every prose field and fallback. Renderer schema, layout, sourcing, and delivery remain intact. |

Frontend chat strips client system messages and delegates model instructions
to the backend. Helm embeds the selected backend configuration; it does not
maintain another authored tone prompt. Tool schemas, source-policy messages,
memory-retention rules, and image-generation recipes retain their task-specific
data and execution constraints.

## Skill review

All 20 skill entrypoints were reviewed. Sixteen now contain explicit reporting
or editorial adaptations:

- `daily-summary`: consequence-led reporting, evidence provenance, reproducible
  comparisons, actionable requests, plain language, and a final editorial check.
- `fantasy-football-recap` and `espn-fantasy-football`: supported league or roster
  consequences, facts versus projections, proposed actions, and restrained prose.
- `creative-ideation` and `image-creation`: concrete explanations with a clear
  boundary between evidence and imagined content; preserve requested art and text.
- `sre-engineer`, `devops-engineer`, `kubernetes-specialist`, and
  `network-health-check`: operational or user impact first, causal uncertainty,
  useful next validation, and confirmed versus proposed owners and dates.
- `dynamo-docs`, `dynamo-frontend-benchmark`, `dynamo-kv-replay-parity`,
  `dynamo-router-starter`, `dynamo-recipe-runner`, `dynamo-troubleshoot`, and
  `dynamo-interconnect-check`: supported conclusions before setup details,
  measurement scope, reproducibility conditions, and limits on broader claims.

`bubblewrap-agent-workflow`, `unifi-network`, `unifi-network-setup`, and
`use-hue-api` already distinguish verified outcomes, proposals, and unavailable
evidence. They inherit the runtime style without another copy of the prose rules.
Historical evaluation reports and attributed creative-method examples are
reference material, not new tone instructions for factual reporting.

## Review cases

These are editorial acceptance cases, not assertions that a live model has
already passed them:

| Supplied evidence                                                                     | Expected communication                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A controlled test improves throughput; production latency and cost were not measured. | Lead with the measured gain and its test scope. Retain baseline, workload, environment, and operating requirements; do not claim cost or customer benefit. Name the validation needed for those conclusions. |
| One customer reports improvement; no wider sample exists.                             | Attribute the report and explain what it suggests. Do not present it as a market trend or a production measurement.                                                                                          |
| A rollout is proposed for Friday; no owner or date is agreed.                         | Label the proposal, explain the decision it needs, and avoid an invented commitment.                                                                                                                         |
| All cluster nodes are Ready; the application request path was not tested.             | Report node readiness and its scope. Explain that application completion remains unverified.                                                                                                                 |
| Last month's result appears alongside an unresolved current issue.                    | Keep the dates and evidence separate; do not imply that the historical result resolves the current issue.                                                                                                    |
| A source is incomplete or contradictory.                                              | Explain how the gap changes the conclusion and which check would resolve it, instead of adding a blanket disclaimer.                                                                                         |
| A simple factual question or exact image lettering request.                           | Answer proportionately or preserve the exact text; do not force a business memo, slogan rewrite, or artificial action.                                                                                       |

Prompt-delivery tests establish that each relevant model call receives the
guidance. Parser, renderer, and schema tests establish integration and format
compatibility. Neither proves future model adherence. A deployment and sampled
model evaluation are separate from these source changes. Existing Hindsight
knowledge pages keep their stored source queries; the updated template applies
when a missing page is created, while new session reflections use the new guidance.
