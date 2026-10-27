# Context isolation configuration and operation

Context isolation is opt-in through `workflow.context_isolation.enabled` in
`backend/tool-calling-config.yaml`. Configure and verify direct provider
destinations before enabling it. The coordinator processes the complete
authorized context locally; isolated public work uses runtime-approved desk
templates and public evidence. Model-generated summaries and worker proposals
do not release private context.

## Destination configuration

Register each actual provider endpoint in `llms`, then reference those entries
from `workflow.context_isolation.destinations`. The coordinator destination must
have `trust: trusted_local` and `transport: direct`. Public workers can reference
explicitly registered `approved_cloud` destinations. Profile names select
capability within this registry; names such as `local` or `deep` do not establish
provider trust. Verify that a direct local endpoint serves the local model and
has no upstream cloud fallback. An unverified gateway is not a direct local
provider merely because it uses a LAN address.

The following illustrates the shape; replace endpoints and model identifiers
with independently verified deployment values, and keep credentials in the
existing secret mechanism:

```yaml
llms:
  local_coordinator:
    _type: openai
    api_type: responses
    base_url: http://verified-local-model.model-serving.svc.cluster.local:8000/v1
    model_name: actual-local-model-id
    api_key: ${LOCAL_MODEL_API_KEY}
  public_worker:
    _type: openai
    api_type: responses
    base_url: https://approved-provider.example/v1
    model_name: actual-public-model-id
    api_key: ${PUBLIC_MODEL_API_KEY}
workflow:
  context_isolation:
    enabled: true
    policy_version: context-isolation-v1
    coordinator: local
    # Optional public city centroid; replace with an approved public location.
    public_weather:
      latitude: 42.0
      longitude: -83.0
      days: 4
    # Optional existing MCP group; register its actual configured local URL.
    trusted_local_mcp_groups:
      k8s_mcp_server: http://verified-k8s.tools.svc.cluster.local:8000/mcp
    trusted_local_services:
      hindsight: http://verified-hindsight.memory.svc.cluster.local:8888
      sandbox: http://verified-sandbox.tools.svc.cluster.local:8000
      redis: rediss://verified-redis.state.svc.cluster.local:6379/0
    destinations:
      local:
        llm: local_coordinator
        trust: trusted_local
        transport: direct
      cloud:
        llm: public_worker
        trust: approved_cloud
        transport: direct
    worker_profiles:
      low: cloud
      medium: cloud
      high: cloud
      xhigh: cloud
      max: cloud
```

Every distinct profile may reference a different registered destination/model;
the example maps all profiles to one model only to show the configuration
structure. Evaluate actual candidates before selecting these assignments.
Private requests always stay on the coordinator destination, including explicit
high-capability preferences, late skill loads and provider retries. Legacy
`request_model_profiles` and `skill_model_profiles` remain the behavior outside
isolation mode; they do not override its destination boundary.
For a verified Chat backend that supports it, destination `extra_body` may include
`thinking_token_budget`, a JSON integer from 0 through 8192. This bounds reasoning
within the existing output-token and workflow limits; it grants no context or
routing authority. Responses transport rejects this extension. Check the actual
backend API before configuring it.
For a verified legacy Dynamo Chat backend, the alternative is
`extra_body.nvext: {max_thinking_tokens: 128}`. This exact object accepts only
`max_thinking_tokens`, a JSON integer from 1 through 8192. Responses rejects it,
and it cannot be combined with root `thinking_token_budget`. The runtime preserves
the selected namespace; it does not translate controls between backends. Dynamo
applies this control to a reasoning span, and counting can reset for another
span. It is not an aggregate hard ceiling on reasoning across the response or
workflow. Existing total output-token limits, shared call budgets and workflow
deadlines still apply. Verify the deployed backend's parser and enforcement
before using either control; typed acceptance alone does not establish model
quality or exact reasoning-token counts.
Compatible Chat templates may also accept boolean `enable_thinking` and
`medium_effort` in `extra_body.chat_template_kwargs`. The latter requests efficient
reasoning; it is a soft model control and does not replace output-token limits.
An explicit `deep` preference uses `xhigh` for eligible public worker work;
`deep_max` requires `max`. Configure those profiles when offering them. If the
requested public capability has no permitted destination, the runtime returns a
limitation rather than silently choosing a cheaper profile. The private
coordinator still uses the configured local alternative.

Register auxiliary services that receive private context in
`trusted_local_services`, matching the effective `HINDSIGHT_API_URL`,
`LLM_SANDBOX_BASE_URL`, any non-loopback `DAEDALUS_TOOLS_URL`, and configured
telemetry endpoint exactly. Use `hindsight`, `sandbox`, `tool_executor`, and
`telemetry` respectively. Register only verified
local services; URLs must not contain credentials, queries or fragments. The
runtime validates these endpoints alongside the model registry, because memory
reflection, renderer subcalls and tool execution also process private inputs.

Protected automatic memory preparation performs bounded recall and reads of
existing knowledge pages. It does not bootstrap a bank, create pages, read a
synthesis cache, invoke reflection, or enqueue background generation. Missing
memory is a source limitation; it never switches to the legacy preparation path.
Automatic knowledge-page search uses at most the first 3,000 characters as its
GET retrieval hint, keeping percent-encoded URLs within producer parser limits.
The recall POST query and the coordinator's original input and attachments retain
their complete authorized content.

The durable workflow budget is restored before catalogue discovery and memory
reads. Expired or completed jobs fail before either operation; preparation uses
the original total deadline rather than starting a new allowance afterward.
Successful search, page and recall responses are cached separately as local-only
completed reads, scoped to the authenticated owner, conversation, workflow,
context policy, registered memory origin and exact request. A resumed job can
retry a failed page without repeating its successful reads. Excluding workspace
sources also excludes this recovery cache. Once research closes, preparation may
reuse completed evidence but cannot issue an uncached memory request. These are
raw read responses, not a generated session brief or permission to export memory.

Hindsight's HTTP origin alone does not establish transitive locality. Before
allowing protected text mutations, verify its main, retention, reflection,
consolidation and mental-model-refresh model routes, including retries and
fallbacks, and its embedding/reranking endpoints. They must process text locally.
The deployed retention extractor must select attachments only from validated
item content, not saved missions or other prompt scaffolding. An attachment
marker in saved instructions must not select a separate vision provider.

After verifying that complete contract, set the backend's operator-only
`DAEDALUS_HINDSIGHT_LOCAL_TEXT_ORIGIN` to the exact local Hindsight HTTP(S)
origin, for example `http://hindsight-api.daedalus.svc.cluster.local:8888`.
It must have no credentials, path prefix, query or fragment. Leave it absent
until verification; this is a deployment trust assertion, not a runtime proof
or permission supplied by a model, request header or stored memory. It does not
attest vision processing. Withdraw it before reverting to an unverified backend.
The deployment script and Helm Secret allowlist both support this variable.

The shared Hindsight transport checks permanent owner enrollment even when the
workflow flag is off or absent. Every protected request requires the exact
registered service origin or matching reviewed text-origin assertion, and uses
a proxy-free client with no automatic retries or redirects. Pure reads use
bounded known endpoints. Text mutations additionally require the assertion and
strict text request shapes. File/image forms, reserved attachment placeholders
anywhere in a request, and operations whose modality cannot be established are
rejected before dispatch. Existing unrelated direct vision clients keep their
separately configured vision route; it is not a route for protected text.

A protected operation retry currently returns HTTP 403 with
`memory_retry_modality_unknown`, because an older queued job may contain media.
Operation status reads remain available. Other unsupported operations/modalities
also return typed 403 responses. Missing processing trust or unavailable policy
storage returns typed 503 for ordinary memory APIs and 502 for completed-turn
retention, preserving its existing retry queue. Disabled memory retains its
existing terminal 503 behavior. These restrictions persist for enrolled owners
across restarts, new conversations and configuration rollback.

Always register the private workflow store as `trusted_local_services.redis`.
Use the actual local Redis scheme, hostname, effective port and database, for
example `rediss://verified-redis.storage.svc.cluster.local:6379/0`. The runtime
uses the same `REDIS_URL` and `REDIS_PORT` precedence as storage: an explicit
URL port wins over the fallback port. Omitted ports normalize to 6379 and an
omitted database normalizes to 0. Keep credentials and query options out of the
registration. They remain in the operational connection URL; credentials and
TLS CA options do not change its registered transport identity. External Redis
hosts, missing registration and mismatched hosts, ports or databases prevent
enabling isolation before private workflow evidence can be written.

Optional `public_weather` releases one operator-approved literal NWS location
and request template. Explicit latitude and longitude are required; omitted
`days` and `include_observations` default to 4 and false. The existing weather
argument schema validates bounds, and additional fields are rejected. The model
invokes the weather tool with `{}`; the runtime supplies the approved template.
Private addresses, inferred coordinates and rewritten tool arguments cannot
replace that release policy.

Optional `trusted_local_mcp_groups` maps existing MCP group names to their actual
local `function_groups.<group>.server.url`. Registration grants no new tools or
permissions. The runtime retains existing per-user authorization, tool inclusion
and read-only dispatch policies. Use this for explicitly authorized private
operational reads; unregistered or externally hosted groups remain unavailable
under isolation. Changing a group's configured endpoint requires its trust
registration to match before enabling the feature.

This direct-provider contract avoids relying on an unknown gateway to honor a
new request field. A future Switchyard integration must negotiate and
authenticate a versioned restriction contract and intersect classifier,
candidate, retry and fallback destinations before any protected context reaches
that gateway. Do not configure an unrestricted routing gateway as a direct
provider to bypass that requirement.

## Daily-summary boundary

An initially protected daily-summary request with automatic tool choice first
exposes only a native full load of `daily-summary`. The actual successful load
supplies the guide, all four required references and a fresh trusted clock.
Listing skills, reading an individual resource or returning a model-authored
claim of readiness cannot unlock source work. Source, worker, renderer and clock
calls proposed alongside the full load wait for a subsequent model round.
Missing, disabled or ambiguous native loaders return an explicit limitation.
This bootstrap phase grants no additional memory access. Protected automatic
preparation uses the read-only path above. Explicit tool choices, general chat,
later skill selection and user steering keep their existing bootstrap behavior. Resumed automatic briefings obtain a fresh full bundle
without renewing their persisted budgets or repeating completed source reads.

The local coordinator establishes time and source policy, completes Gmail and
Calendar authorization, and reuses completed personal-source reads. Only then
may it invoke `public_briefing_worker` for a supported public desk. Worker input
comes from fixed public desk templates and runtime-registered evidence. It does
not include the coordinator history, memory, attachments, personal-source
results, private instructions, provider response references or conversation IDs.
Public tools and workers cannot retrieve coordinator state or change policy.
After a successful explicit clock read, a protected briefing reuses that clock
and removes the datetime tool from its research menu. Steering permits a fresh
clock, and a resumed run starts with a fresh clock phase. These phase changes do
not renew the persisted research or model budgets. General chat keeps its usual
clock access.
During protected briefing planning, automatic tool choice requires a tool result
so the coordinator can advance the workflow. After an authorized renderer attempt,
automatic choice resumes for bounded correction or sourced text recovery.
Explicit tool choices and general chat retain their existing behavior.
User steering restores ordinary automatic choice so a redirected request can
answer without tools.

The frontend assigns an authenticated job UUID as `context_workflow_id`,
overriding client-supplied values. A direct API caller resuming an interrupted
workflow must reuse that UUID (or the original `x-daedalus-request-id` when no
workflow UUID was supplied). A new explicit request gets a new workflow identity.
The resource budget and completion tombstone are scoped to the authenticated
user, conversation and workflow UUID, independently of configured policy.
Changing policy invalidates cached evidence while preserving the original shared
counters, deadlines and completion status. A new explicit UUID starts a new
workflow. Provider sessions are rebuilt separately and never resume private
context externally.

Each protected request places an opaque, runtime-owned namespace before its
existing message/instruction content: a prefix on the first Chat system/developer content,
or on Responses `instructions`. Chat requests without a leading instruction
message receive a first system message containing only the namespace. Existing
instruction text, content parts and message order are preserved. The prefix
precedes application instructions and task
evidence. Public workers have no tools or source-bearing template preamble and
derive their namespace from authenticated user/run,
task identity, evidence and context/destination policy; retries retain it, while
a changed scope receives a different prefix. The provider `user` field carries
the same opaque value for affinity; it alone is not a cache boundary. Caller
cache keys, continuation IDs and arbitrary metadata remain forbidden.

This is logical separation of content-bearing prompt prefixes. It relies on a
prefix cache deriving later block keys from preceding token blocks, so a
different first namespace prevents reuse of the following task content. A
provider's static template, reasoning instruction or configured tool catalog
may still share blocks before the first application message. Public workers
expose no tool catalog, so their evidence follows the discriminator. This does
not partition a task-specific or private catalog that a coordinator template
renders before the first message; stronger separation for such a catalog needs
separately verified backend cache controls. This does not claim physical cache
deletion, dedicated provider tenancy, or verified propagation of a vendor-specific
cache salt. No instruction-following by the model is needed for the prefix
separation.

Redis policy enrollment is checked before preparation on every request, including
when the isolation stanza is absent or disabled. Unavailable policy storage
stops the request. The retained Python preparation path cannot process an enabled
isolated workflow or a previously protected conversation through unrestricted
routing. Preserve policy keys alongside conversation backups.

First enrollment atomically records a permanent `stable-budget-v2` era marker
alongside the existing `local-only-v1` privacy labels. An already protected owner
without that marker requires an operator-reviewed migration before enabled
workflows can run. Legacy budget keys include an opaque policy-dependent scope;
changing policy cannot safely discover or adopt those keys. The runtime leaves
legacy counters and completion tombstones untouched and never infers a fresh
budget. Check for legacy protected owners before upgrading; if any exist, retain
their state and review migration compatibility before rollout. Unknown era or
privacy versions fail closed. Disabling the feature and standalone owner privacy
checks continue to honor the original privacy labels.

Enrollment also protects the authenticated owner across new conversation and run
identifiers. Turning isolation off cannot reopen cloud access by starting a new
conversation. Drain existing unrestricted runs before enrolling a canary account;
keep that account on the verified local path or stop its requests during rollback.

Optional photographs must use exact URLs observed in the runtime's public
collector evidence. A coordinator-created URL or a URL containing private query
parameters is rejected before the renderer can fetch it. A public-only source
policy skips personal-source reads rather than requiring new authorization.

The coordinator treats validated public findings as untrusted evidence and
combines them with personal material locally. Existing briefing budgets include
worker work and retries; reaching final synthesis closes public research.
The total workflow deadline also bounds preparation, model/tool and renderer
waits, steering and OAuth notifications, and client output backpressure. Cloned
event emitters retain the same absolute deadline.
Heartbeats and steering do not extend it, and expired workflows cannot deliver
late results.
The source verifier exposes only network-free source planning. Claim
verification and citation auditing are unavailable because their URL checks can
resolve model-supplied hostnames through DNS.
Skill discovery and resource loading remain available; arbitrary skill script
execution is disabled even when the general tool configuration enables it.
`briefing_renderer_tool` retains the canonical schema, two-attempt correction
limit, exact inline HTML and sourced text fallback. An unavailable public worker
is a source limitation, not permission to invent reporting or export the local
edition for recovery.

## Evaluation and rollout

Run the runtime capture tests and the frozen
[evaluation workload](../tools/context-isolation-eval/README.md) before enabling
external workers. Preserve image/model/configuration versions and all attempts.
Measure factuality, required-fact omissions, citation correctness, completion,
cost and end-to-end latency; unknown usage and cost remain unknown. Synthetic
capture tests establish boundary behavior but do not establish real model
quality or a savings claim.

The built-image transport fixture exercises local coordination, personal-source
reads, public collection, independently routed worker phases, retry/session
isolation, canonical renderer correction, and protected-session rollback:

```bash
uv run --no-project --python 3.12 --with httpx --with pyyaml --with redis \
  python builder/context_isolation_http_check.py \
  --image daedalus:runtime-check --redis-image redis:7.4-alpine \
  --report .cache/context-isolation/http-capture.json
```

The same command runs the protected Chat transport check in
`builder/context_isolation_chat_check.py`, including a numeric thinking budget,
the independent output cap and private-context/session isolation.

Build the backend image with the repository's skills build context first, as
`make runtime` does. The report records the running container's immutable image
ID and a separately labeled host source snapshot, and captures
synthetic request bodies locally. Its public scraper fixture substitutes the
external HTTP transport; canonical tool dispatch and rendering still run inside
the image. This test proves the direct-provider route contract. It does not
certify an unimplemented gateway policy contract or a real model comparison.

Before a canary, inventory the existing frontend/API, ingress, NodePort and
service-to-service client paths. Back up effective durable and live configuration
to trusted local storage and retain the deployed image digests. Make no exposure,
port or authentication change for this feature. Exercise application/API paths
from an ordinary non-node LAN client as well as inside the cluster, including
OAuth pause/resume, steering, cancellation, renderer recovery and unavailable
sources. Capture a normal personalized edition and verify its existing output
contract. Record actual checks and measured results in local review artifacts;
configuration examples and unit tests do not prove a deployed client path.

Rollback disables external workers while retaining the verified local
coordinator: keep isolation enabled, remove public profile mappings and cloud
destinations, and preserve persisted policy labels. If the local-only path is
unavailable, stop the affected feature. Do not return protected sessions to the
legacy unrestricted shared-history route by turning isolation off or restoring
an old image that cannot enforce their restrictions. Restore the backed-up
network configuration only if it changed, and recheck ordinary LAN clients.
Neither rollout nor rollback requires changing established LAN endpoints.

### Text-fallback publication check

Protected canonical editions also validate citation URL provenance before the
renderer executes. News source links must exactly match successfully ingested
collector evidence or a separately recorded URL literal from an authenticated
user message. Figure source-page links require collector evidence. A supplied
user link remains `LOCAL_ONLY`: admitting
a link for the user's edition never authorizes worker export or image fetching.
Assistant history, injected memory, model planning, renderer arguments and worker
prose cannot create this local authority. Private source facts can use tool
references without introducing new web links.

Successful configured read-only Gmail and Calendar getters can also establish
separate `LOCAL_ONLY` publication references from recognized thread, message and
event records. Admission requires record identity and meaningful source fields;
only the record's explicit link fields qualify. Query/request echoes, errors,
OAuth responses, arbitrary tool prose and memory summaries cannot mint this
authority. Minimal typed receipts restore the links only within the authorized
workflow and current private-source/getter policy. These references never become
public worker evidence, permitted photos or figure source-page authority.

Native weather links have separate authority from the successful configured
weather adapter's structured result. A weather domain alone grants no authority.
Restoration uses validated workflow-scoped records and the current source policy;
it does not reopen research, fetch a URL, or renew any budget. Unknown links fail
with fixed diagnostics that do not echo private URL values.

After a current renderer failure or native citation-input rejection, the same
full-guide text-fallback check also rejects links without recorded publication
authority. Citation and desk-ledger violations share the single durable local
tool-free correction described below. The complete rejected draft stays in
private history; the runtime does not remove links, edit prose or insert facts.
Generic chat, legacy runs and stale renderer failures remain outside this check.

URL membership proves the recorded origin of a link, not the truth of its claims
or whether an article supports a particular sentence. Editorial factuality,
source support and completion still require the frozen quality evaluation.

After a trusted native full daily-summary load and a renderer-reported failure,
the protected local coordinator checks a completed text fallback for an internal
desk-status ledger before releasing it. This narrow structural check recognizes
a coverage heading followed by multiple Covered, Quiet or Unavailable status
rows. It does not classify ordinary coverage prose or a source limitation beside
a story, and does not validate factual accuracy or citation support. Successful
canonical HTML and other conversations retain their existing paths.

One rejected draft may receive one tool-free local correction using the complete
existing history and shared workflow budgets. An atomic marker on the existing
local workflow budget admits that correction once across replicas, restarts and
policy changes without changing its counters, deadlines or expiry. The draft is withheld, not edited
or stripped. A second invalid draft fails with a fixed publication-contract error.
Steering invalidates an earlier revision's renderer-failure eligibility without
renewing the shared correction allowance. Where the protected text-only fallback timer has
already started, the correction shares that deadline; the workflow's total
budget, model-call limits and two renderer attempts are never extended.

Run the focused built-image check with disposable synthetic peers:

```bash
python builder/context_isolation_fallback_check.py \
  --image "$RUNTIME_IMAGE" \
  --redis-image "$REDIS_IMAGE" \
  --output /tmp/context-isolation-fallback-check.json
```

The eight cases cover desk-ledger and unknown-citation withholding, one shared
correction, repeated invalid text, unchanged valid fallback, ordinary coverage
prose, generic conversation, and a native citation veto followed by an exact
canonical correction using a user-supplied source. They exercise the packaged
native skill and canonical renderer with local HTTP peers; they make no real
model, personal-account or Hindsight calls.
