# Skill review records

## 2026-09-12: daily-summary token efficiency

Removed the Sources and desk ledger sections, their template CSS, and repeated
coverage explanations/source objects. Coverage now contains desk keys and
statuses, with policy labels derived by the renderer. Public headlines link to
their sources; tool provenance stays in reporting attributes and image credits
stay in captions. Quiet desks have no visible entry, and material source gaps
belong beside affected reporting or in the Editor's Note. These instructions
also apply to the text fallback.

Validation: 205 Python 3.12 tests passed across the renderer, HTML validator,
renderer tool, skill parser/dispatcher, catalog, and backend contracts. The
remaining provider transport test passed on rerun after restoring
`llms.tool_calling_llm.truncation: auto`. Both desktop/mobile Playwright layout
tests passed. The installed NAT runtime loaded all 18 skills and 102 text
resources. Frontmatter and local skill links passed.

The dense fixture's compact JSON input fell from 2,739 to 2,332 tokens (14.9%)
and its rendered HTML from 8,287 to 7,015 (15.3%), measured with `o200k_base`.
These are fixture measurements, not live end-to-end briefing usage. No
deployment or external-source briefing was performed.

## 2026-09-12: daily-summary recovery

The renderer retains the submitted edition on failure and no longer terminates
the whole request with an error-only HTML edition. The skill now tells the agent
to deliver available, sourced reporting as text when its two rendering attempts
are exhausted. Successful HTML still requires canonical validation and exact
inline delivery. Source, read-only, and publication boundaries are unchanged.

Validation: 125 focused builder tests passed, including renderer failures and
configuration/dispatcher contracts. The pinned toolkit runtime loaded all 18
skills and 102 bundled resources; the edited skill passed frontmatter validation
and local link checks. These checks establish the runtime contract, not the
quality of a live briefing from external sources.

## 2026-09-12: daily-summary latency safeguards

The interactive briefing reuses the bounded automatic Hindsight context when
present instead of repeating a 24-result memory recall. A missing automatic
context still permits one explicit recall. The runtime exposes a briefing-only
tool catalog and ends research after five minutes, leaving the renderer and
sourced text fallback as the only final-synthesis paths. Source, read-only,
validation, and OAuth boundaries are unchanged.

Validation: all changed files passed pre-commit; 1,470 builder tests passed with
75.96% coverage (4 integration tests skipped, and the independent-audit test
file could not be collected because its independently generated fixture is
absent from this checkout). The pinned NAT runtime accepted the configuration, registered
the custom telemetry and RSS components, and passed its agent-loop contract,
including a synthetic stalled final stream followed by exactly one bounded
synthesis-only retry. Helm lint/render passed, and backend image
`sha256:6662c208199a6db9add9b68e71a2771041b0cdf73ad870dcd2be19c02a4beb73`
was deployed in Helm revision 36. A live daily summary then completed in 224.0
seconds without an explicit `get_memory` call. Both renderer attempts rejected
invalid input, after which the workflow completed with the required text
fallback. Live Phoenix OTLP requests returned HTTP 200 and the backend recorded
no exporter errors.
