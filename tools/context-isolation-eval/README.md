# Context isolation evaluation

This directory freezes a synthetic workload and compares **observed** baseline
and candidate briefing runs. `evaluate.py` gates existing measurements;
`run.py --execute` runs real models through a built runtime image. Neither
manufactures measurements or establishes privacy from a model's assertion.
Runtime/provider captures and reviewed traces supply privacy evidence; editorial
review supplies scored claims, omissions and citations. Keep live private data
out of this evaluator.

`workload.json` covers heavy personal context, public-only work, conflicting
sources, long private context, sparse sources, unavailable sources, worker
recovery and renderer recovery, with three repetitions each. `attachment_repeat`
is no longer used by the v2 fixtures: the long case contains 900 distinct private
archive records, including current actions and conflicting revisions near the
beginning, middle and end. The heavy case supplies email, calendar, memory and
document revisions with distinct contact IDs. See [the v2 fixture contract and
delivery preflight](workload-v2.md). Its fixed source documents, clock, faults,
required facts, repetitions and margins are part of the digest. Baseline and
candidate must use the same digest. Freeze this file before running either
configuration; a changed workload requires fresh measurements of both
configurations.

The initial acceptance margins preserve aggregate and paired-case factuality,
source correctness, required-fact coverage and completion. Every case must
complete its supported output, including a sourced fallback when appropriate.
Candidate p95 end-to-end latency may increase by at most 10%. A benefit requires
at least a 10% reduction in measured total cost or p95 latency. Unknown costs
cannot prove a cost benefit. Publish failures and all attempts, including retries,
alongside successful runs. These conservative margins are part of the frozen
workload, not a quality guarantee for any model profile.

Get the canonical workload digest:

```bash
python3 tools/context-isolation-eval/evaluate.py --digest
```

Record separate baseline and candidate JSON measurements with this structure:

```json
{
  "schema_version": 1,
  "workload_sha256": "canonical digest from --digest",
  "configuration": {
    "runtime_image": "immutable image digest",
    "gateway_image": "immutable gateway digest or verified direct route version",
    "model_versions": {
      "local": "actual model version",
      "public": "actual model version"
    },
    "config_sha256": "digest of the effective configuration without credentials"
  },
  "privacy_evidence": {
    "artifact_sha256": "reviewed capture artifact digest",
    "reviewer": "review identity",
    "AC-01": true,
    "AC-02": true,
    "AC-03": true,
    "AC-04": true,
    "AC-05": true,
    "AC-06": true,
    "AC-07": true,
    "AC-08": true
  },
  "cases": [
    {
      "case_id": "personal-heavy",
      "repetition": 0,
      "successful": true,
      "output_contract_passed": true,
      "latency_ms": 12000,
      "factuality": { "supported_claims": 4, "total_claims": 4 },
      "omissions": { "missing_required": 0, "total_required": 3 },
      "sources": { "correct_citations": 2, "total_citations": 2 },
      "attempt_count": 1,
      "attempts": [
        {
          "id": "opaque-attempt-id",
          "phase": "public_comparison",
          "profile": "high",
          "target": "configured-destination-id",
          "outcome": "success",
          "latency_ms": 2000,
          "cost_usd": null,
          "usage": {
            "input_tokens": 200,
            "output_tokens": 100,
            "cached_input_tokens": null
          }
        }
      ]
    }
  ]
}
```

The example is a schema illustration, not a complete result or measured run.
Include every case/repetition exactly once and every model attempt. Each
omission denominator must match that case's frozen `required_facts`; independently
review each fact. Count unsupported claims and incorrect citations rather than
omitting them from denominators. Zero citation opportunities are permissible in
an unavailable-source case; an entire unscored workload is rejected. A successful
fallback still needs output-contract review. Capture tool/model/cache latency
separately in the supporting artifact; `latency_ms` in each case is wall-clock
completion latency, including tool waits, failures and retries.

AC-01 through AC-08 refer to the [SRD](../../docs/context-isolation-srd.md).
Review prompt bodies, structured source fields, summaries of private meanings,
provider/session/cache metadata, tool subcalls and telemetry in the **capture
artifact**. Exact-string scans alone do not establish these checks. Reviewer and
digest fields bind the report to evidence but are not an unforgeable approval;
retain artifacts in the appropriate trusted local storage. The synthetic legacy
baseline may record known privacy failures; they remain visible in the report.
Every candidate privacy check must pass. Never use live private inputs to measure
an unrestricted legacy/cloud baseline.

Compare the measurements:

```bash
python3 tools/context-isolation-eval/evaluate.py \
  --baseline .cache/context-isolation/baseline.json \
  --candidate .cache/context-isolation/candidate.json \
  --output .cache/context-isolation/comparison.json
python3 -m unittest discover -s tools/context-isolation-eval/tests
```

Exit status zero means this measured comparison passed its recorded gates.
It does not prove deployment, real model quality beyond the frozen workload,
non-node LAN access, or rollback. Those checks remain separate rollout gates.
No baseline or candidate measurements are bundled: enabling the feature requires
actual runs against the intended model and configuration versions.

## Check frozen source delivery without inference

Before paying for a comparison, exercise both baseline and candidate transport
with the heavy-personal and long-context cases through an immutable runtime:

```bash
python3 tools/context-isolation-eval/preflight_runtime_delivery.py \
  --image REGISTRY/daedalus@sha256:PLATFORM_MANIFEST_DIGEST \
  --redis-image redis:7-alpine \
  --output .cache/context-isolation/source-delivery-preflight
```

All model-shaped HTTP responses are scripted on loopback. The four case/variant
runs capture the actual built runtime's first message and attachment, personal
mail/calendar/tool evidence, memory and existing derived summary. Long-corpus
start/middle/end anchors are checked against the frozen manifest. Reports mark
the run `mock_only` and empirical model-window fit false; no editorial result,
provider attention, context capacity, cost or latency benefit is established.
Run the real comparison separately after reviewing this transport evidence.

The private memory fixture represents existing authorized source state. Exact
memory bytes span at most two knowledge pages. Each page has a `pipe-v1` byte
frame so native page trimming preserves boundary whitespace: remove exactly one
outer pipe on each side, then reconstruct the original ordered source bytes.
Part numbers, nonoverlapping character offsets, chunk hashes, actual page-read
receipts and the complete frozen field hash must all match. The already supplied
private derived summary is returned as an existing `experience` recall record;
it is not newly generated reflection. Its exact text and actual pure-recall
receipt must appear in the captured native automatic-memory context.

Native bounds remain unchanged: two page bodies of at most 1,800 characters,
1,000 characters per fact, and a 6,000-character serialized automatic-memory
payload. Framing uses two characters within each page's existing limit.
The automatic page-search GET uses a 3,000-character retrieval hint; the full
authorized input and attachment remain in the coordinator request, and the pure
recall POST retains the full query. This avoids producer URL-parser truncation
without changing model context or the source bodies delivered by the fixture.
Unsupported source sizes, unsplittable lines, malformed frames, changed bytes,
missing reads and unexpected private fields in the public-only case fail
instead of truncating or suppressing evidence. Both variants receive the same
source state. Workload bytes, facts, guides, deadlines, repetitions and margins
remain frozen; prior captures retain their original diagnostic status.

## Collect real model measurements

`run.py` executes the built runtime image with disposable loopback fixture
services. Its default command only prints a plan and uses no Docker or provider
connection:

```bash
python3 tools/context-isolation-eval/run.py
```

The separate image check uses a scripted loopback Chat provider and disposable
Redis, with no real generation:

```bash
python3 builder/context_isolation_chat_check.py \
  --image sha256:BUILT_RUNTIME_IMAGE \
  --output .cache/context-isolation/chat-budget-check
```

It captures the protected runtime's numeric thinking budget, output cap, local
private context and metadata restrictions. It does not evaluate briefing quality
or the Responses rejection path. `check(image, redis_image, output=None)` also
returns the complete report for use by the broader built-image harness.

The runner derives its skill and four complete guides from reviewed canonical
sources. It preserves authorization, source policy, freshness, clock, research
budgets, editorial rules, desk keys, schema, and bounded renderer recovery.
Reader identity, location, holdings, contacts and personal topic selections are
replaced with independently fictional preferences, including civic archives,
stargazing and bread fermentation. Renderer scripts, HTML template and JSON
schema are copied byte for byte. Source hashes fail closed when canonical
resources or the production workflow configuration change before a new review.
Host-only provenance and workflow settings live outside the loadable skill.

Production global instructions and tool descriptions are retained with the
same fictional reader substitutions. The fixture uses production history limits
(50 messages / 32,000 tokens), compaction and output retrieval, three configured
model retries, and the selected iteration ceiling. Missing specialist skills
are removed from fixture model mappings and recorded as unavailable.

Gmail, Calendar, memory, public search/scraping and unavailable-source behavior
come only from the frozen workload. The fixture does not implement production
curated feeds, weather, fantasy accounts, repository, Kubernetes or network
sources. Its mail endpoint returns frozen threads in a fixture envelope rather
than reproducing real search/thread retrieval and pagination. These are source
and transport limits: results cannot establish full-production coverage,
latency or savings. Missing observations remain unavailable, not verified quiet.
The runner does not connect real accounts or fetch live articles.
Native runtime deadlines remain real; matched datetime-tool results and the
trusted daily-summary skill clock presented to models use the frozen workload
clock, with each fixture transformation recorded. User and public source dates
remain unchanged.
Provider request capture is additional evidence, not a replacement for runtime
privacy enforcement. Candidate outbound violations stop before forwarding.

The baseline retains `verify_claim`, `plan_sources` and `audit_citations`.
Evaluation-only verifier hooks accept exactly the frozen public URL ledger and
fetch its content from loopback; other URLs fail before network access or DNS.
This explicitly substitutes placeholder/audit checks and source transport,
never the verification verdict. The actual configured Python critic generates
its answer through the captured proxy. Its retries are labeled
`internal_tool_verification`, counted in `internal_verification_model_attempts`,
and included in the attempt ceiling. Captures record the hook hash and URL-ledger
digest. The protected candidate exposes only `plan_sources`; verification and
citation auditing remain blocked by its production dispatcher. Its renderer
owns briefing quality gates. The baseline's three operations retain the frozen
URL guards described above.

Supply a local JSON configuration with exactly these five route roles. Each
route uses an existing direct provider origin or an operator-established
loopback-only forward to local inference. Credentials are environment-variable
references; literal keys, credential-bearing URLs, arbitrary prompt overrides,
and a cloud destination for the local coordinator are rejected.

```json
{
  "schema_version": 1,
  "routes": {
    "baseline": {
      "base_url": "https://provider.example/v1",
      "api_type": "responses",
      "model_name": "existing-deep-model-version",
      "api_key_env": "EVAL_BASELINE_API_KEY",
      "trust": "approved_cloud",
      "extra_body": { "reasoning": { "effort": "xhigh" } },
      "model_revision": null
    },
    "local": {
      "base_url": "http://127.0.0.1:18000/v1",
      "api_type": "chat",
      "model_name": "verified-local-model-version",
      "api_key_env": "EVAL_LOCAL_API_KEY",
      "trust": "trusted_local",
      "model_revision": null
    },
    "medium": {
      "base_url": "https://provider.example/v1",
      "api_type": "responses",
      "model_name": "candidate-medium-version",
      "api_key_env": "EVAL_PUBLIC_API_KEY",
      "trust": "approved_cloud",
      "extra_body": { "reasoning": { "effort": "medium" } }
    },
    "high": {
      "base_url": "https://provider.example/v1",
      "api_type": "responses",
      "model_name": "candidate-high-version",
      "api_key_env": "EVAL_PUBLIC_API_KEY",
      "trust": "approved_cloud",
      "extra_body": { "reasoning": { "effort": "high" } }
    },
    "xhigh": {
      "base_url": "https://provider.example/v1",
      "api_type": "responses",
      "model_name": "candidate-xhigh-version",
      "api_key_env": "EVAL_PUBLIC_API_KEY",
      "trust": "approved_cloud",
      "extra_body": { "reasoning": { "effort": "xhigh" } }
    }
  }
}
```

This is a configuration illustration, not an evaluated model assignment.
`model_revision` is operator-supplied provenance; unknown revisions remain null.
For a Chat endpoint supporting a reasoning-token budget, route `extra_body` accepts
a root-level `"thinking_token_budget": 256` alongside
`"chat_template_kwargs": {"enable_thinking": true}`. The budget must be an
integer from 0 through 8192; booleans, floats, strings and nested budgets are
rejected. Responses routes reject this Chat-only option. The candidate passes
this option into its registered runtime route
configuration, so capture can verify the runtime itself emits it. This option
does not increase the independent output-token ceiling or model-attempt budget.
Chat template options require boolean `enable_thinking` and accept optional
boolean `medium_effort`. For a template supporting this setting,
`"chat_template_kwargs": {"enable_thinking": true, "medium_effort": true}`
requests its efficient reasoning mode without a numeric thinking-token cut.
Both booleans pass through the registered runtime route. Unknown template keys,
non-booleans, and any template kwargs on Responses routes are rejected; the
8192-token output ceiling and declared attempt/deadline limits remain separate.
The baseline runs the shared-history workflow using its configured fixed deep
profile. The candidate runs the local coordinator and bounded public workers.
Use the current baseline's actual model and capability options. This direct
provider comparison does not measure an automatic gateway's hidden classifier,
retries, or cache behavior; those require separately captured gateway evidence.
Production's Python verifier retains its static main model while a loaded skill
can promote the coordinator. This fixture routes both baseline coordinator and
critic through the configured fixed deep route. When internal critic calls occur,
their cost and latency may exceed automatic production routing; report their
count and do not infer production savings from that difference. If the count is
zero, this distinction does not affect the measured runs.

Review the pilot configuration before enabling forwarding. Execution requires
an explicit global model-attempt ceiling, a per-attempt output-token ceiling,
and a finite global deadline.
They cover both variants, all repetitions, retries, and synthetic fault attempts.
This example limits a two-run plumbing pilot to 32 model attempts; it does not
run the complete frozen evaluation or establish a benefit:

```bash
uv run --no-project --python 3.12 --with httpx --with pyyaml --with redis \
  python tools/context-isolation-eval/run.py \
  --execute --image sha256:BUILT_RUNTIME_IMAGE \
  --routes /trusted/local/evaluation-routes.json \
  --case sparse-sources --repetitions 1 --max-iterations 16 \
  --max-model-attempts 32 --max-output-tokens-per-attempt 8192 \
  --timeout-seconds 900 \
  --output .cache/context-isolation/model-pilot
```

The output directory must be new and is created with mode `0700`. Real provider
keys remain in the forwarding process, are replaced if echoed in diagnostics,
and are never written to the runtime configuration or capture artifacts.
Each case has a private, redacted `capture.journal.jsonl`; admitted provider
attempts are durable before dispatch. `progress.json` checkpoints observed rows.
A `case.complete.json` marker binds finalized output, capture and journal hashes
for review while collection continues. Interrupted journals preserve partial
evidence, including unknown provider outcomes; they do not establish completion
or permit resuming, merging or replacing runs in the frozen comparison.
The runner starts only disposable test containers and loopback peers; it does
not deploy workloads or change LAN exposure, ingress, ports, or authentication.
Supply any required local model forward beforehand; the runner does not create
one. No generation occurs without `--execute`.
The forwarding layer clamps output-token limits for both variants to the
declared ceiling, preserves smaller runtime limits, and records the exact
transformation. The example pilot reserves at most 262,144 output tokens across
32 attempts; input tokens and provider reasoning billing remain separate.
For quoted dotenv credentials, `--credential-env-file /trusted/local/.env`
loads values into host process memory without invoking a shell. Already set
environment variables take precedence. Do not put key values in route JSON.

For the full comparison omit `--case` and `--repetitions`. The frozen workload
requires 48 runs. A 128-iteration ceiling allows 6,144 coordinator iterations;
provider retries and internal tool critics can add model attempts. Choose a
justified global model-attempt ceiling after the pilot. Every failure remains
a measured failure. A global stop leaves the
unexecuted cases explicit, and the comparator cannot approve an incomplete set.
Output reports remain **unreviewed**, with null quality/privacy decisions and
unknown cost/cache usage retained as null. Neither a model's success response
nor a renderer pass establishes factuality or source correctness.

Each case writes its exact delivered output and capture. `artifacts.json` binds
their digests, the generated skill bundle, workload, stop ceiling, and pilot
scope. The runner also writes `baseline.raw.json` / `candidate.raw.json` and
matching editable review templates. An independent reviewer must inspect all
factual claims and citations, score every frozen required fact, examine the
privacy captures, and record reasons and evidence references. Public references
use frozen source IDs; private references use `local.email`, `local.calendar`,
or another supplied `local_inputs` field. A supported claim needs a reference.
Citation observations use `url` for a public source or `tool_ref` for an actually
observed connected tool; a personal tool reference is not a public URL.
Do not discard unsupported claims or incorrect citations from review counts.
Set `all_claims_and_citations_reviewed` only after reviewing the complete output.

Availability claims have two reserved evidence identities. `fixture.manifest`
identifies the archived frozen case, including supplied inputs, source inventory
and declared faults. `capture.source_calls` identifies the actual case capture:
inspect both the recorded source calls and their provider-visible tool results
before asserting that a read succeeded or returned a particular status. An
invocation alone is not a successful read. Neither identity turns missing
fixture data or an empty result into evidence of an empty real account or a
complete real-world search. Use these references for source limitations instead
of attributing an unavailable forecast or personal source to an unrelated news
article. Factual reporting still needs its actual source evidence.

New raw reports include `review_evidence` descriptors with workload, case,
capture and source-call hashes, bound to `artifacts.json`. Arbitrary evidence
references remain rejected. For an existing pending report collected before
these identities were added, create a separate annotated report and fresh review
template in the same artifact directory:

```bash
python3 tools/context-isolation-eval/run.py \
  --bind-review-evidence \
  --measurements .cache/context-isolation/model-pilot/baseline.raw.json \
  --output .cache/context-isolation/model-pilot/baseline.bound.raw.json
```

This reads only the archived workload, manifest and captures. It verifies their
hashes, preserves the original raw report, and creates
`baseline.bound.raw.review.json`. It does not run a model, rewrite captures,
invent source observations or change measured configuration, attempts, usage,
latency or quality decisions. The annotation records the original measurement
digest and the postprocessor source hash separately from the original runner
identity. The annotated measurement has a new digest, so use its fresh review
template; an earlier review cannot approve it. Review application rechecks the
local archive bindings. Keep the annotated report beside its original artifacts.

Apply a completed, hash-bound review to create comparator input:

```bash
python3 tools/context-isolation-eval/run.py \
  --measurements .cache/context-isolation/model-evaluation/candidate.raw.json \
  --review .cache/context-isolation/model-evaluation/candidate.review.json \
  --output .cache/context-isolation/model-evaluation/candidate.reviewed.json
```

The review must match the raw measurement digest and each output digest.
It cannot override an observed candidate export violation or a failed canonical
output contract. These bindings make stale reviews fail closed; they do not
turn human judgments into an unforgeable approval. Retain the supporting local
artifacts and run `evaluate.py` on the two reviewed full-workload reports.
The frozen quality workload does not itself exercise every forged-policy,
gateway-negotiation, or authorization fault. Privacy review must also cite the
separate built-image fault/policy captures for the same runtime image, including
their digests and the checks they support in `privacy_evidence.additional_artifacts`.
Do not mark an unexercised acceptance check true from a successful briefing alone.
