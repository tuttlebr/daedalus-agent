---
name: mas-procedure
description: Multi-Agent System (MAS) execution procedures for centralized_mas_with_verifier (structured analysis tasks decomposed into 2–4 streams) and decentralized_mas (exploratory web research with parallel branches). Defines stream budgets, source-priority rules, synthesis steps, and the self-check before responding. Load this skill whenever `mas_evaluate` returns a MAS architecture recommendation (SAS skips this), or when the user explicitly requests a multi-agent / multi-stream / multi-source synthesis workflow.
---

# MAS Execution Procedures

Follow the procedure matching the architecture.type returned by mas_evaluate.

## Global Execution Budget

- Default to bounded execution. Do not turn MAS into an open-ended web crawl unless the user explicitly asks for exhaustive research.
- Keep centralized MAS to 2-4 streams, one primary query per stream, and at most one fallback when a source is missing or blocked.
- Stop after 8 external retrieval/search/scrape calls unless continuing is required to satisfy an explicit user constraint.
- **Budget arithmetic**: 4 streams × (1 primary + 1 fallback) = 8 calls — the hard cap with no slack. Reserve headroom for verification by either using fewer streams (2-3) or skipping fallbacks when the primary succeeds.
- Never verify placeholder URLs, example.com URLs, or claims copied from search snippets. Verify only exact final claims tied to real cited sources.
- If a source class is likely paid or inaccessible, such as bank analyst notes, try one targeted search. If accessible notes are not found, use accessible analyst commentary or state the limitation instead of retrying across many similar queries.
- Do not call add_memory for ordinary user answers unless the user asks to remember/log the result or the task is an autonomous maintenance cycle.

## centralized_mas_with_verifier (structured analysis tasks)

1. Decompose the task into 2-4 independent information-gathering streams based on the task's natural facets. Each stream should target a distinct data source or analysis angle (e.g., primary company source, competitor primary source, analyst/commentary source, internal document source). **Stream-count guidance**: prefer one stream per distinct source class. Collapse facets that share a source class (e.g., two competitor questions answered by the same competitor's 10-K should be one stream, not two). When facets share the same source, fewer streams means more budget for verification.
2. Execute all streams using appropriate tools. Prioritize non-overlapping sources and avoid repeating the same query across tools.
   - For public earnings or financial-comparison tasks with no explicit competitor, use AMD as the default semiconductor competitor and state that assumption. **If a competitor is named explicitly in the task, do not also state the AMD-default assumption** — it's redundant and reads as confused.
   - For "latest" earnings, prefer the company's investor-relations quarterly-results page or official newsroom release before transcript aggregators.
   - For analyst notes, prefer accessible public analyst commentary when proprietary bank notes are unavailable.
3. Synthesize findings from all streams into a unified response. Resolve contradictions by preferring primary sources.
4. Before responding, run this **self-check** (treat as a literal checklist, not prose):
   - [ ] Every requested facet from the task is addressed
   - [ ] Every cited claim is supported by a source you actually gathered (no snippet-only claims, no fabricated URLs)
   - [ ] Assumptions (AMD-default, primary-source preference, etc.) are named explicitly
   - [ ] The answer is concise — lead with the answer, detail after
   - [ ] Budget was respected (≤ 8 external calls; declared deviation if exceeded)
   - [ ] No spurious `add_memory` calls — only for autonomous cycles or explicit log requests
5. Persist via add_memory only for autonomous cycles, explicit architecture audits, or when the user asks to log the outcome.

## decentralized_mas (exploratory / web research tasks)

1. Launch broad parallel exploration: search, retrieve, and scrape across multiple sources simultaneously. Cast a wide net, but keep each stream to one primary query plus one fallback.
2. Cross-validate: compare results across sources, flag contradictions, verify key claims through independent paths.
3. Synthesize validated findings. Note confidence levels for contested points.
4. Before responding, perform an internal self-check against the original task and the independent leads gathered: remove weak leads, mark contested claims, and keep only patterns supported by multiple sources or clearly labeled as tentative.
5. Persist via add_memory only for autonomous cycles, explicit architecture audits, or when the user asks to log the outcome.
