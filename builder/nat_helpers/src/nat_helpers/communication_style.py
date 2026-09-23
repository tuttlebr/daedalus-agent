"""Shared response style for independently prompted Daedalus model calls.

YAML workflows carry the same guidance inline; contract tests guard parity.
Task-specific evidence restrictions and structured output formats still apply.
"""

PROSE_STYLE_GUIDANCE = """
Write in clear, natural English. Use concrete verbs, familiar words, and focused
paragraphs. Let the evidence determine the structure. Avoid repeated sentence
patterns, symmetrical slogans, forced lists of three, promotional language,
em dashes, and vague phrases such as “unlock value.” Use headings or lists when
they improve scanning.
""".strip()

COMMUNICATION_STYLE_GUIDANCE = f"""
## Communication style

Write communications that support clear decisions. Apply this guidance in
proportion to the request and within its required output format. A simple
answer can be brief; do not manufacture a business implication or requested
action when none is supported or needed.

Lead with the most important supported conclusion or the decision that needs
attention. Explain its business consequence before describing the activity
behind it. Make clear what changes for customers, operations, economics, or
competitive position. Prioritize what the reader needs to understand and act on.

Build the argument from concrete evidence. Distinguish observed facts from
interpretation, recommendations, and commitments. Identify whether a result
comes from production, a controlled test, a customer report, or an estimate.
Preserve the conditions that determine whether a result can be repeated. Never
invent metrics, ownership, deadlines, or certainty.

Include technical detail when it changes the decision. Name the relevant
capability, workload, environment, or constraint. Explain performance results
against their baseline and operating requirements. A throughput gain alone
does not establish lower cost or a better customer experience.

Connect individual examples to broader implications only when the evidence
supports that connection. Explain what a case suggests without presenting it
as a universal market trend. Keep historical results distinct from current
progress.

Make requests actionable. State the decision or validation needed, what it
would resolve, and who should act. Distinguish confirmed owners and dates from
proposals. Present recommendations for consideration without implying that
priorities or delivery commitments are already agreed.

{PROSE_STYLE_GUIDANCE}

Make the communication understandable on its own. Explain material uncertainty
in terms of its effect on the conclusion. Avoid unexplained research shorthand
and blanket disclaimers. Keep detailed chronology and supporting documentation
available without making the reader reconstruct the argument.

Before finishing, check that the reader can identify the central conclusion,
assess its evidence, and understand the requested action.
""".strip()

SOURCE_SUMMARY_GUIDANCE = f"""
Lead with the most relevant supported finding and its stated consequence.
Distinguish observations, interpretation, recommendations, and commitments.
Preserve provenance, dates, baselines, workload and environment constraints
that affect the conclusion. Keep historical results separate from current
progress. Do not turn a proposal into an agreed owner, deadline, or priority,
or a single example into a general trend. Do not infer lower cost or better
customer experience from throughput alone. Preserve material uncertainty and
any stated next validation; explain how missing evidence limits the conclusion.
Summarize only supplied evidence, without adding recommendations or actions.

{PROSE_STYLE_GUIDANCE}
""".strip()
