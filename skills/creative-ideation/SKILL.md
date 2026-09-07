---
name: creative-ideation
description: >-
  Use for brainstorming, idea refinement, or option selection through a named
  creative method. Produces directions, not finished deliverables.
license: MIT
metadata:
  author: SHL0MS <author@example.com>
  version: 2.1.0
  title: Creative Ideation — Routed Library of Creative Methods
  platforms: [linux, macos, windows]
  tags:
    - creative
    - ideation
    - brainstorming
    - methods
  hermes:
    tags: [Creative, Ideation, Brainstorming, Methods, Inspiration]
    category: creative
    requires_toolsets: []
---

# Creative ideation

Generate, refine or select ideas using a method that fits the user's phase,
domain and constraints. Ordinary implementation requests should proceed to
implementation; do not insert a brainstorming exercise before a clear task.

## Choose and apply a method

1. Reuse the supplied goal, audience, constraints and existing material. If a
   consequential choice is unclear, ask one focused question while continuing
   independent work; otherwise make a reasonable stated assumption.
2. Honor a named method before mood/domain defaults. For an open request,
   choose one method from the table below and load only that resource through
   `agent_skills_tool(operation=load_skill, skill_name=creative-ideation,
resource=references/methods/<method>.md)`.
3. Apply its mechanism to this situation. Method examples and suggested counts
   are optional scaffolding; preserve the user's requested count, tone and
   constraints. Add a second method only when it solves a distinct need, such
   as generating options and then comparing finalists.
4. Give concrete mechanisms, meaningful differences, tradeoffs and a feasible
   first step. Use real evidence for factual names, numbers, market claims and
   costs; distinguish fictional premises or speculation. Do not fabricate
   attribution or historical detail to make an idea feel specific.
5. Once the user chooses a direction, continue the requested work. Carry the
   selected brief and constraints into the relevant implementation skill.

| Need                           | Resource                                                             |
| ------------------------------ | -------------------------------------------------------------------- |
| No starting direction          | [constraint library](references/full-prompt-library.md)              |
| Variations on an existing idea | [SCAMPER](references/methods/scamper.md)                             |
| Many ideas quickly             | [volume generation](references/methods/volume-generation.md)         |
| Choose or pressure-test        | [premortem/inversion](references/methods/premortem-and-inversion.md) |
| Unblock work                   | [oblique strategies](references/methods/oblique-strategies.md)       |
| Surprising directions          | [lateral provocations](references/methods/lateral-provocations.md)   |
| Refine familiar material       | [defamiliarization](references/methods/defamiliarization.md)         |
| Organize observations          | [affinity diagrams](references/methods/affinity-diagrams.md)         |
| Engineering contradiction      | [TRIZ](references/methods/triz-principles.md)                        |
| Product need                   | [jobs to be done](references/methods/jobs-to-be-done.md)             |
| Research question              | [compression progress](references/methods/compression-progress.md)   |
| Another domain/method          | [method catalog](references/method-catalog.md)                       |

The catalog links all 22 methods. Use [heuristics](references/heuristics.md)
for ambiguous cases, [anti-slop](references/anti-slop.md) for a quality check,
and [exercises](references/exercises.md) for a requested time-boxed practice.
Do not load the whole library or describe internal discarded drafts.

## Collaboration and output

For an image deliverable, load
[gpt-image-2-photography](../gpt-image-2-photography/SKILL.md) and supply the
chosen concept to its image brief. For implementation, load the relevant
DevOps/Kubernetes skill only if the task calls for it. Use
[bubblewrap-agent-workflow](../bubblewrap-agent-workflow/SKILL.md) for a
requested isolated text artifact/command task.

Keep output proportional: name the method when useful, present the requested
options or decision, and state the next concrete action. Do not stop at ideas
when the user also requested a finished deliverable. Conversely, idea selection
alone does not authorize building, publishing, deploying or contacting people.

The constraint library is adapted from
[wttdotm's prompts](https://wttdotm.com/prompts.html); individual methods retain
attribution in their references.
