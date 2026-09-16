# Model routing implementation verification

Verified on 2026-09-16 against source baseline `270d4cf`. The implementation
supports optional request profiles, daily-summary initial selection, trusted
main-skill promotion, per-call alias binding, queue preservation and routing
traces. Production has not been changed. This report separates implementation
checks from provider compatibility and candidate quality.

## Source and integration checks

| Check                                             | Result                                     |
| ------------------------------------------------- | ------------------------------------------ |
| Full builder suite                                | 1,590 passed, 4 skipped; 86.97% coverage   |
| Final focused backend suite                       | 165 passed                                 |
| Full frontend suite                               | 902 passed, 179 skipped; 102 passing files |
| Disposable Redis integration                      | 4 Python and 200 frontend tests passed     |
| Frontend lint, TypeScript and production build    | Passed with Node 22                        |
| Helm lint/render                                  | Passed                                     |
| Shared protocol generation check                  | Passed                                     |
| Installed-client runtime and agent-loop contracts | Passed                                     |

The full builder, frontend and integration suites require the historical
`test-fixtures/code-audit-independent-20260909.json.gz`, which baseline commit
`270d4cf` deleted. Validation temporarily restored the exact prior blob
(SHA-256 `0700a111dd1937392a908dc03f369439ec560de78117b6c31687f9dbf5c3dee7`)
and removed it afterward. This feature does not reverse that deletion. A fresh
checkout retains that pre-existing suite prerequisite. Browser end-to-end and
production deployment checks were not run.

Scoped pre-commit hooks and the diff whitespace check passed.

## Built image and deterministic acceptance

The locally built image is `daedalus-routing:verification`, image ID
`sha256:5c8eaedc49aef360c6af272c34a73e3dc142957deb6bffd2205104d05faa696b`.
The runtime implementation and HTTP checker match the source hashes recorded in
[provenance.json](../evaluation/model-routing/provenance.json).

The real backend entrypoint, installed NAT/LangChain stack and HTTP API passed
56 scenarios against a recording Responses upstream and disposable Redis.
[Recorded results](../evaluation/model-routing/http-image-results.json) include
single-response and streaming requests, concurrent users, invalid selections,
default-only startup, configured routing and rollback. A separate host run also
passed all 56. Provider calls in these checks are synthetic.

| SRD criteria                                                          | Evidence                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01, AC-18: optional config and rollback                            | HTTP checker starts default-only, routed, then default-only workflows; unconfigured deep requests fail before upstream calls                                                                                                                              |
| AC-02–AC-04: explicit, initial and skill selection                    | Captured outbound aliases for both response modes; policy precedence and dispatcher tests                                                                                                                                                                 |
| AC-05, AC-08: unsuccessful/resource/historical loads and next request | Dispatcher success/error tests; HTTP nonpromotion and reused-session cases                                                                                                                                                                                |
| AC-06, AC-07: concurrency and shared client                           | Concurrent tool/request HTTP scenarios; ContextVar policy checks; installed-client immutable binding checks                                                                                                                                               |
| AC-09, AC-10: invalid requests and config                             | API and Pydantic tests; catalog validation; invalid HTTP calls produce zero upstream requests                                                                                                                                                             |
| AC-11: durable request and authorization continuity                   | Real Redis enqueue/read/claim/ack for every enum and omission; API forwarding and OAuth pause/resume keep explicit maximum without another backend invocation; approval execution remains the existing direct tool path                                   |
| AC-12, AC-14: bindings and history                                    | Captured instructions, tool schemas, parallel-tool flag, full call/result pairs, reasoning and image inputs; real provider smoke below                                                                                                                    |
| AC-13: restricted synthesis                                           | Actual 30-second research-budget expiry and existing bounded synthesis retry retain route and restricted tools                                                                                                                                            |
| AC-15: failures and completion                                        | Native agent-loop contract covers provider errors, incomplete responses, cancellation, repeated tool errors, iteration limits and validated artifacts under automatic/explicit maximum selection; existing authorization and persistence regressions pass |
| AC-16: payload and telemetry                                          | HTTP payloads reject injected reasoning/sampling/response-ID fields; installed NAT trace events retain outcome/call counts; route alias and provider-reported model are separate fields                                                                   |
| AC-17: other models unchanged                                         | Binding is scoped to the main agent's copied client; installed-client checks retain the cached transport; existing helper/image/autonomous configuration and regression tests pass                                                                        |

One compatibility finding changed the implementation detail: NAT 1.9's cached
OpenAI client enables `use_previous_response_id`. The adapter now copies its
configurable wrapper and client, disabling continuation IDs only for main-agent
execution. This sends full local history across route changes and leaves the
cached client and helper clients unchanged. Payload checks cover this behavior.

## Live provider compatibility

All eight smoke scenarios passed through the deployed gateway, with default,
deep and maximum aliases, streaming/nonstreaming, tool results, reasoning history
and images. Its `capable_first` default selected the strong target in these
probes, so those results alone do not establish cross-model compatibility.

All eight also passed through the isolated proposed gateway using the same
Switchyard image and provider configuration, with only the default picker set
to `efficient_first`. Captured provider-reported targets confirm weak-to-strong
transitions across GLM and DeepSeek, including image and tool history. Original
response output items were replayed with their associated tool results; no
reasoning/history fields were stripped to make the probe succeed.

The [baseline smoke](../evaluation/model-routing/baseline-provider-smoke.json),
[proposed smoke](../evaluation/model-routing/proposed-provider-smoke.json) and
[sanitized configuration provenance](../evaluation/model-routing/provenance.json)
contain bounded metadata without credentials or user content. Alias acceptance
does not establish task quality or production application latency.

## Workload measurement

See the [frozen workload](../evaluation/model-routing/README.md) for tasks,
predeclared gates, prices, collection method and limitations. The comparison
uses the same installed new main-agent graph for every candidate. The baseline
candidate uses the live deployed gateway policy and no application routing maps.
This controls application/tool differences but is not a measurement of the
deployed old application through its UI, queue, memory and external services.

[Raw results](../evaluation/model-routing/results.json) contain all 144 completed
samples: 24 tasks × two repetitions × three candidates. The proposed policy
**failed the predeclared quality gate**: 45/48 correct is below 95% and below the
baseline's 46/48. Do not enable the proposed production picker on this evidence.
This is an answer-quality result; the deterministic routing/isolation checks
passed. The alternate policy matched baseline correctness in this small sample,
which does not establish superiority.

| Metric                                 | Baseline gateway         | Proposed GLM/DeepSeek   | DeepSeek low/high                      |
| -------------------------------------- | ------------------------ | ----------------------- | -------------------------------------- |
| Exact correct                          | 46/48 (95.8%)            | 45/48 (93.8%)           | 46/48 (95.8%)                          |
| Valid JSON/schema                      | 46/48                    | 47/48                   | 47/48                                  |
| Median first text                      | 3.52 s                   | 3.99 s                  | 3.78 s                                 |
| Median completion                      | 3.61 s                   | 4.16 s                  | 4.06 s                                 |
| Observed completion range              | 1.59–17.19 s             | 1.89–21.44 s            | 1.91–31.21 s                           |
| Exploratory completion p95             | 10.07 s                  | 14.72 s                 | 15.11 s                                |
| Main model calls                       | 132                      | 126                     | 132 + unknown interrupted attempt      |
| Tool calls / extra calls               | 84 / 0                   | 86 / 2                  | 84 / 0, plus unmeasured interruption   |
| Transport retries in completed samples | 0                        | 0                       | 0                                      |
| Input / cached / output tokens         | 72,046 / 45,938 / 11,170 | 58,544 / 25,600 / 7,083 | 72,032 / 45,016 / 11,213, plus unknown |
| Estimated cost per correct task        | $0.00029212              | $0.00022438             | Unknown                                |

Cached tokens are a subset of input tokens. Costs include incorrect completed
attempts and count output tokens once, including reasoning already represented
there. No fixture tool called another model. The DeepSeek candidate had one
interrupted, unmeasured attempt during an evaluator schema correction; its total
cost remains unknown. Its observed token cost is a lower bound of $0.01365921.
The 20 completed samples preceding that correction were unaffected and retained.
No failed samples were discarded or rerun to improve these scores.

All completed samples read the required evidence. The proposed policy made two
extra skill calls (`synthesis-cost` and `reasoning-combinations`, repetition 2).
Every baseline provider response reported the strong target. Proposed responses
reported 58 weak and 68 strong selections; the alternate reported 60 weak and
72 strong selections, with both alternate targets configured as DeepSeek.

The proposed policy answered `reasoning-combinations` incorrectly in both
repetitions and failed the strict JSON contract for `briefing-priority` in
repetition 2. Baseline failed that contract for `briefing-budget` and
`reasoning-combinations` in repetition 2. The alternate failed it for
`synthesis-conflict` and answered `reasoning-combinations` incorrectly in
repetition 2. Independent exhaustive enumeration confirms the committee-count
reference answer is 256 and the assignment puzzle has exactly one solution.
Final model text was not retained, so the report distinguishes schema versus
answer failures without inferring unobserved causes.

First-text latency is a proxy for first useful output, not a human usefulness
rating. Full newspaper renderer validation was not measured. There are only two
repetitions of each task, with correlated samples, warmed caches, differing
gateway placement and uncontrolled provider load. Tail estimates are exploratory;
the numerical cost difference is not a reliable savings or quality claim.

## Remaining deployment gates

Production rollout is a separate operation. Before enabling the new deployment
policy, review workload quality, deploy compatible backend/API/worker/config
together, then exercise real authorized application workflows and rendered
artifacts. Measure end-to-end latency with the production queue, tools and
authorization path. Only then consider the SRD's `efficient_first` change.
Neither a provider HTTP 200 nor this controlled fixture run closes those gates.

No new retry policy, permission, database migration, autonomous model override or
visible model picker is included. Operator configuration, API examples and
rollback steps are in [model-routing.md](model-routing.md).
