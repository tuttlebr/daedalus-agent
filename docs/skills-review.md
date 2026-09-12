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
