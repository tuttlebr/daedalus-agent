# Humanizer provenance

The user supplied `SKILL.md` version 3.1.0, licensed under MIT, and requested its
use for UI prose during the 2026-11-08 Autonomy review. An upstream repository
URL was not supplied. The skill attributes its patterns to Wikipedia's
[Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).
Its supplied instructions and license metadata are unchanged.

Daedalus loads the skill through `agent_skills_tool`. Autonomous tasks use its
embedded mode to edit prose within the required result schema. The skill does
not change execution permissions or require a separate editing run.

Validation covers catalog discovery, loading the instructions, and task prompt
routing. Deterministic tests do not measure live model writing quality.
