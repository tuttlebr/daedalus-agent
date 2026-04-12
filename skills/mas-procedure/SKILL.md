---
name: mas-procedure
description: Multi-Agent System (MAS) execution procedures for centralized and decentralized architectures. Load this skill when mas_evaluate recommends MAS.
---

# MAS Execution Procedures

Follow the procedure matching the architecture.type returned by mas_evaluate.

## centralized_mas_with_verifier (structured analysis tasks)

1. Decompose the task into 2-4 independent information-gathering streams based on the task's natural facets. Each stream should target a distinct data source or analysis angle (e.g., one stream queries retrievers, another searches the web, another checks GitHub or cluster state).
2. Execute all streams using appropriate tools. Prioritize breadth: each stream should cover different ground, not repeat the same query across tools.
3. Synthesize findings from all streams into a unified response. Resolve contradictions by preferring primary sources.
4. Call mas_verify with the draft, original task, and task type. If verification fails, apply revision notes and re-verify once.
5. Call mas_log_outcome with metrics (include turn_count for coordination tracking), then persist via add_memory.

## decentralized_mas (exploratory / web research tasks)

1. Launch broad parallel exploration: search, retrieve, and scrape across multiple sources simultaneously. Cast a wide net.
2. Cross-validate: compare results across sources, flag contradictions, verify key claims through independent paths.
3. Synthesize validated findings. Note confidence levels for contested points.
4. Call mas_verify with the draft, original task, and task type.
5. Call mas_log_outcome with metrics, then persist via add_memory.
