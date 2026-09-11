# Daily briefing iteration-limit investigation — 2026-09-11

The morning briefing failed because the model generated malformed edition JSON
and entered a prolonged repair loop. The sandbox and canonical renderer behaved
correctly. The application relies on the model to obey the skill's repair limit;
its graph only enforces the overall 128-iteration limit.

## Runtime evidence

- Request: `Run my daily briefing.`
- Time: September 11, 2026, 10:06:11–10:19:41 America/Detroit (EDT).
- Duration: 809.7 seconds, approximately 13 minutes 30 seconds.
- Phoenix trace: `db0e6238da904d43b4a4e0343535d6e8`.
- Workflow run: `705c711f-4fa2-46eb-874f-96815cc529d4`.
- Backend pod: `daedalus-backend-default-6569488f84-kptvk`.
- Backend image: `sha256:6f70e6e8447a91fa13ad7d21bbc717e505cb5b49ee69f9e246a2415c0120581f`.
- Installed runtime: NVIDIA NeMo Agent Toolkit 1.8.0, langchain-openai 1.3.5,
  langgraph 1.2.9.
- The mounted workflow matches the checkout except for its final newline. The
  deployed `per_user_tool_calling.py` matches the checkout byte for byte.
- Switchyard recorded 129 streaming requests selecting
  `accounts/fireworks/routers/glm-5p3-fast`, all with HTTP 200. The two configured
  routing targets use this same model identifier; these logs do not establish
  which reasoning-effort target each request used.
- Phoenix recorded 144 tool executions, including 113 sandbox calls:
  105 `execute`, seven `write_file`, and one `list_commands`.

The ordinary Kubernetes log endpoint had rotated past the incident. The
investigation recovered the retained node log segments and the complete
workflow/tool trace from Phoenix. Raw material and replay inputs are restricted
to `/tmp/daedalus-loop-investigation/`; private briefing content is omitted here.

## Failure sequence

| Local time  | Evidence                                                                                                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10:06–10:08 | The model read the daily-summary skill, personal sources, operational state, and public reporting.                                                                                                                                              |
| 10:08:20    | First `edition.json` write already contained invalid JSON: missing colon at character 15583.                                                                                                                                                    |
| 10:08:51    | Replacement JSON still failed parsing, now at character 16991.                                                                                                                                                                                  |
| 10:09–10:12 | The model copied the template, validator, and renderer through tool arguments. These three resources total 83,650 bytes and match the canonical files exactly. One renderer write failed because it also supplied command/argv, then succeeded. |
| 10:12:49    | The first renderer execution rejected `edition.json` with `Expecting ',' delimiter: line 1 column 16992 (char 16991)`.                                                                                                                          |
| 10:12–10:19 | The model made 104 additional sandbox calls, inspecting slices, adding/removing delimiters, and trying structural repairs.                                                                                                                      |
| 10:14:54    | A second renderer attempt returned the same JSON error.                                                                                                                                                                                         |
| 10:18:43    | A third renderer attempt reached schema validation but failed with `edition.editors_note must be a string`; the repairs had changed the document structure.                                                                                     |
| 10:19:41    | The workflow returned the configured 128-iteration failure message. No validated briefing was delivered.                                                                                                                                        |

Of the 113 sandbox calls, 101 returned exit code 0, nine returned exit code 1,
and three returned tool-level errors. Many successful commands only inspected
the same broken document or printed a caught parser error. Counting consecutive
nonzero exits or identical argument strings would therefore miss this loop.
The sandbox spans total approximately 11.4 seconds; sandbox execution itself
does not explain the 13.5-minute run.

## Reproduction and isolation

The original `file_content` in the second write's tool arguments is malformed
before the sandbox receives it. Running the checkout's canonical renderer on
that captured string reproduces the exact production error and character offset.

The document omitted `]}` between the Outdoors and Sports departments. Inserting
those two delimiters, without changing any story text, makes the captured JSON
parse. Serializing that object and running both canonical gates locally gives:

- Renderer: `passed: true`, no errors, nine coverage items, five departments,
  and 19 sources.
- HTML validator: `passed: true`, no errors, all nine policy desks represented.

The loaded skill instructions match the checkout after accounting for the
loader stripping frontmatter and appending its resource listing. The copied
policy is semantically identical to the canonical policy. Neither a stale skill
nor corrupted renderer/template copying explains this incident.

These checks establish the syntax defect and repair-loop mechanism. They do
not independently verify every factual claim in the captured briefing or prove
whether the model provider's behavior has changed more broadly.

## Recommended implementation

1. **Move briefing assembly into a typed backend tool.** Accept the edition as
   a nested object with validated fields, serialize it with `json.dumps`, and
   stage the canonical policy/template/renderer/validator directly into the
   existing isolated sandbox. Run the renderer and HTML validator there and
   return the exact validated artifact. This removes JSON-inside-a-string
   generation and the model's repeated copying of fixed resources. Return
   concise field-path errors for invalid edition data.
2. **Enforce the existing repair policy in code.** Permit an initial render
   and one corrected submission, then terminate with the skill's compact HTML
   error edition. Bound auxiliary repair work too, so unlimited inspection
   calls cannot consume the run between render attempts. Track the budget per
   invocation and phase, preserving isolation between concurrent conversations
   and reused per-user workflows.
3. **Add a general guard against tool loops that make no progress.** Use
   structured outcomes, artifact state, and normalized error fingerprints in
   addition to call counts. Changing a script or returning exit code 0 must not
   automatically reset the budget. Keep the global 128 limit as a final guard;
   legitimate long research runs should not inherit a small briefing-specific
   budget. Route an exhausted run to a bounded final response and a terminal
   graph state.
4. **Record an explicit failure outcome.** This trace's root status is `OK`
   because the graph-limit exception becomes ordinary response text. Emit a
   terminal reason such as `repair_budget_exceeded` or `iteration_limit`, with
   iteration/tool counts and a run correlation ID. Replace repeated full-history
   verbose logging with concise progress events; the retained final minutes
   alone contained approximately 45 MB of backend logs.

The first two changes address this incident directly. A prompt-only adjustment
would leave the same enforcement gap: the current skill already permits only
one repair. Increasing 128 would allow more of the same failed work. LangGraph
provides explicit graph-step and remaining-step handling for graceful
termination; see its [graph API guidance](https://docs.langchain.com/oss/python/langgraph/use-graph-api).

## Acceptance checks for the proposed change

- Preserve both malformed input cases as sanitized regression fixtures.
- Reject malformed or schema-invalid submissions with concise structured errors.
- Verify canonical resource transfer without model transcription.
- Permit one correction and force the fallback after budget exhaustion, including
  when auxiliary commands return success or their arguments change.
- Verify successful editions still pass both existing gates.
- Verify streaming completion, accurate terminal telemetry, and independent
  budgets for concurrent conversations and subsequent turns.

The investigation and original local replay made no application or deployment
changes. The subsequent authorized implementation is documented in
[Agent loop recovery](agent-loop-recovery.md). Production deployment remains a
separate step.
