---
name: mas-procedure
description: Multi-Agent System (MAS) execution procedures for centralized and decentralized architectures. Load this skill when mas_evaluate recommends MAS.
---

# MAS Execution Procedures

Follow the procedure matching the architecture.type returned by mas_evaluate.

## Global Execution Budget

- Default to bounded execution. Do not turn MAS into an open-ended web crawl unless the user explicitly asks for exhaustive research.
- Keep centralized MAS to 2-4 streams, one primary query per stream, and at most one fallback when a source is missing or blocked.
- Stop after 8 external retrieval/search/scrape calls unless continuing is required to satisfy an explicit user constraint.
- Never verify placeholder URLs, example.com URLs, or claims copied from search snippets. Verify only exact final claims tied to real cited sources.
- If a source class is likely paid or inaccessible, such as bank analyst notes, try one targeted search. If accessible notes are not found, use accessible analyst commentary or state the limitation instead of retrying across many similar queries.
- Do not call add_memory for ordinary user answers unless the user asks to remember/log the result or the task is an autonomous maintenance cycle.

## centralized_mas_with_verifier (structured analysis tasks)

1. Decompose the task into 2-4 independent information-gathering streams based on the task's natural facets. Each stream should target a distinct data source or analysis angle (e.g., primary company source, competitor primary source, analyst/commentary source, internal document source).
2. Execute all streams using appropriate tools. Prioritize non-overlapping sources and avoid repeating the same query across tools.
   - For public earnings or financial-comparison tasks with no explicit competitor, use AMD as the default semiconductor competitor and state that assumption.
   - For "latest" earnings, prefer the company's investor-relations quarterly-results page or official newsroom release before transcript aggregators.
   - For analyst notes, prefer accessible public analyst commentary when proprietary bank notes are unavailable.
3. Synthesize findings from all streams into a unified response. Resolve contradictions by preferring primary sources.
4. Before responding, perform an internal self-check against the original task: confirm each requested facet is addressed, cited claims are supported by gathered sources, assumptions are named, and the answer is concise.
5. Persist via add_memory only for autonomous cycles, explicit architecture audits, or when the user asks to log the outcome.

## decentralized_mas (exploratory / web research tasks)

1. Launch broad parallel exploration: search, retrieve, and scrape across multiple sources simultaneously. Cast a wide net, but keep each stream to one primary query plus one fallback.
2. Cross-validate: compare results across sources, flag contradictions, verify key claims through independent paths.
3. Synthesize validated findings. Note confidence levels for contested points.
4. Before responding, perform an internal self-check against the original task and the independent leads gathered: remove weak leads, mark contested claims, and keep only patterns supported by multiple sources or clearly labeled as tentative.
5. Persist via add_memory only for autonomous cycles, explicit architecture audits, or when the user asks to log the outcome.
