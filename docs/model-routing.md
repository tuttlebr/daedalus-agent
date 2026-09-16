# Interactive model routing

The interactive Responses agent supports the profiles `default`, `deep`, and
`deep_max`. The default model still comes from `TOOL_CALLING_LLM_MODEL_MODEL`.
All profiles use that model's existing OpenAI Responses transport, endpoint,
credential, timeout and retry settings. The gateway owns provider IDs, reasoning
and sampling defaults.

Submit an explicit selection through the existing chat API:

```json
{
  "messages": [{ "role": "user", "content": "Analyze these results." }],
  "additionalProps": { "model_profile": "deep" }
}
```

Direct `/v1/chat/completions` backend callers use `additional_props` instead of
`additionalProps`. Streaming and single-response calls use the same policy.
Omit `model_profile` to enable automatic selection. Explicit `default` pins the
default alias; it does not force the gateway's weak target. Explicit selections
are locked for the invocation. Null, empty, unknown and unconfigured profiles
fail validation. Unrelated additional properties remain intact.

## Configuration

`backend/local-chat-config.yaml` stays a standalone single-model configuration.
The home deployment's `backend/tool-calling-config.yaml` adds:

```yaml
workflow:
  model_routes:
    deep: ${DAEDALUS_LLM_DEEP_MODEL:-daedalus/deep}
    deep_max: ${DAEDALUS_LLM_DEEP_MAX_MODEL:-daedalus/max}
  request_model_profiles:
    daily_summary: deep
  skill_model_profiles:
    daily-summary: deep
    fantasy-football-recap: deep
    sre-engineer: deep
    kubernetes-specialist: deep
```

These fields are optional and empty by default in the workflow class. Automatic
mappings accept only `default` and `deep`; deep mappings require a deep alias.
Skill names must exist in an enabled dispatcher catalog when the workflow is
built. Loading a mapped skill's main instructions promotes the next model call;
listing, resource reads, missing skills and failed loads do not. Promotions only
move default to deep. Maximum reasoning always requires explicit selection.

Set route aliases in the Compose environment file or Helm `backend.default.env`
and its referenced Secret, alongside the existing endpoint and credential. The
Helm allowlist accepts `DAEDALUS_LLM_*`. The aliases are model values, not URL
paths. `deep_max` maps to `daedalus/max`, not `daedalus/deep_max`.

## Lifetime and diagnostics

Selection belongs to an invocation, including its bounded daily-summary
synthesis retry. Research budgets and allowed tools are independent of the
selection. The next user request resolves anew. The durable job request stores
the caller selection in `additionalProps`; it never stores an automatic
promotion as a conversation default. OAuth resumes the existing invocation.
Approval execution uses the existing direct tool endpoint and makes no model
call. Neither path gains permissions from a profile. Interrupted work retains
its existing partial-result recovery behavior and is not automatically replayed.

`daedalus.agent.model_route` trace events record requested/effective profiles,
selection source, promotion count, triggering skill and outgoing alias for each
main-agent call. `daedalus.agent.outcome` includes final routing state with the
existing outcome and model/tool counts. `daedalus.agent.model_response` records
the provider-reported model when exposed by the client. That value may itself
be a route alias; correlate the run and request timing with gateway logs to
establish the actual selected target. Missing target, usage or cache data is
unknown. Helper calls keep their own model configuration and accounting.

Stream chunks identify the outgoing alias. The toolkit's configured
`workflow_alias` remains the workflow's display name; it is not provider-target
evidence. Routing diagnostics contain no prompt, tool payload, reasoning text or
credential. Full-history Responses requests preserve prior tool associations,
image inputs and reasoning items; they do not use cross-model response IDs.
Live gateway acceptance of those items remains a deployment verification gate.

## Rollout and rollback

Follow [the SRD rollout gates](model-routing-srd.md#9-rollout-and-rollback).
First verify all three gateway aliases and provider defaults, retaining
`capable_first`. Build and verify the backend before deploying the new fields
alongside the API/worker update; older images do not support them. Exercise
explicit profiles and then automatic daily-summary and skill promotion using
captured requests and gateway target evidence. Only after those checks pass,
change the default Switchyard route to `efficient_first`, retaining threshold
`0.5` and window `3`. Explicit deep routes remain passthrough routes.

Remove request/skill mappings to disable automatic selection while retaining
explicit profiles. For full rollback, restore the desired gateway picker, stop
callers sending explicit deep profiles, and remove all three optional maps
before reverting the backend image. Finish or cancel active requests normally;
do not replay their tools. No database or Redis migration is needed.

## Verification

Policy and dispatcher regression tests run with the builder suite. The backend
image build checks immutable per-call binding against the installed LangChain
client and preserves the existing agent-loop/failure contracts. To check actual
backend HTTP requests, run the recording-upstream fixture with an isolated Redis
instance reachable from the container:

```bash
docker run --rm --network host --entrypoint python \
  -e REDIS_URL=redis://127.0.0.1:16379 \
  YOUR_BACKEND_IMAGE /workspace/model_routing_http_check.py
```

This uses synthetic skills and an in-process Responses HTTP server, with no
provider credentials or external actions. It checks default-only operation,
all profiles, streaming and single-response calls, invalid selections, promotion,
parallel requests, image/reasoning/tool history, synthesis retry, route failure,
and configuration rollback. It does not establish real provider compatibility,
latency, quality or cost. Those require the SRD's separate gateway smoke and
frozen workload evaluation before enabling the production policy.

The [verification report](model-routing-validation.md) records the built image,
acceptance evidence, provider results and remaining deployment gates. Reproducible
live smoke and controlled workload commands are in the
[evaluation README](../evaluation/model-routing/README.md#reproduce).
