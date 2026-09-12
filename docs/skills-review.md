# Skill review records

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
