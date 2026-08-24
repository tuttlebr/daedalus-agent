# Hindsight memory integration and rollout

This runbook is the engineering contract for Daedalus durable memory. Hindsight
is deployed as release `hindsight` in the shared `daedalus` namespace; Daedalus
keeps user identity, recall injection, retention timing, and user controls in
the Agent backend and frontend.

## User-visible behavior

For every authenticated user, Daedalus:

1. initializes missing bank defaults and three auto-refreshing Knowledge Pages;
2. reflects once per conversation, searches relevant pages, and uses bounded raw
   recall only for precise history lookups;
3. labels recalled memory as untrusted context, never as instructions;
4. lets the current user message override conflicting memory;
5. selectively extracts durable facts and experience from a sanitized,
   role-labelled user request and final answer after a successful response;
6. does not automatically retain tool traces, autonomy runs, or internal control
   messages; and
7. provides a Memory Center to inspect Knowledge Pages, retention health, search
   advanced facts, edit, forget, inspect source text, delete
   a source, or clear the authenticated user's memory.

Automatic memory is enabled for all authenticated users after promotion. There
is no per-user off switch. Hindsight stores the raw user source text so users
can inspect and delete what produced a fact.

## Trust and identity boundary

The browser and model never supply a Hindsight bank ID. The frontend authenticates
the session, adds `x-user-id`, and proves the internal hop with
`x-daedalus-internal-token`. The backend validates both values and derives a
stable opaque bank ID. It then calls Hindsight REST endpoints with the shared
tenant API key.

Every Memory Center endpoint derives the bank again from the authenticated user.
The API does not accept `bank_id` or `tenant_id`. The backend also strips those
fields from Hindsight responses.

The required runtime values are:

```dotenv
HINDSIGHT_API_URL=http://hindsight-api.daedalus.svc.cluster.local:8888
HINDSIGHT_API_KEY=<same value as HINDSIGHT_API_TENANT_API_KEY>
HINDSIGHT_API_TIMEOUT_SECONDS=20
DAEDALUS_MEMORY_MODE=hindsight
```

`DAEDALUS_MEMORY_MODE` supports `hindsight` and the emergency `disabled` mode.
`deploy.sh` requires a Hindsight key of at least 32 characters for `hindsight`
and applies the mode as an explicit pod override. The tenant key stays in the
backend Secret and is never passed through Helm values.

## Authority modes

| Mode        | Durable-memory behavior                                                     | Readiness                                   |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| `disabled`  | No durable-memory reads or writes                                           | Hindsight not checked                       |
| `hindsight` | Recall, explicit writes, profile imports, user-turn retention, and curation | Hindsight failure makes the backend unready |

Automatic reflection, page lookup, recall, and retention fail open for chat availability.
Explicit writes fail if Hindsight fails. Redis is not registered as a NAT memory
provider and no `nat:memory:*` records are read or written. Redis remains an
application-state store for sessions, history, attachments, OAuth, autonomy,
approvals, rate limits, and idempotency.

Bulk profile imports submit one durable asynchronous Hindsight batch and return
HTTP 202 after Hindsight accepts it. Profile document IDs are deterministic per
authenticated user and entry label, so retrying an import converges on the same
sources even though each submitted batch has a fresh operation ID. Memory Center
sources and extracted facts appear as Hindsight processes the accepted batch.

## Runtime flow

```text
authenticated browser
  -> Next.js internal-auth proxy
  -> Daedalus backend derives opaque user bank
     -> first use: reconcile missing bank defaults and seed three Knowledge Pages
     -> conversation start: bounded Hindsight reflection cached for seven days
     -> each turn: page search, with 600-token recall for precise past lookups
     -> Responses agent receives [MEMORY_CONTEXT] immediately before user text
     -> successful finalization retains sanitized user/final-answer roles once
     -> Redis-backed polling records completed, zero-fact, or failed extraction
```

The finalization journal records the accepted operation receipt and
`memoryRetentionAttemptedAt`. The deterministic job ID becomes the Hindsight
operation ID, so a crash or retry cannot enqueue a second extraction. A failed
operation is retried once; a completed zero-fact turn is never retried. Retention
accepts at most 12,000 characters and removes internal control blocks, embedded
data, internal references, and raw tool traces.

## Rollout

1. In the adjacent `daedalus-hindsight` repository, configure the database
   password, LLM credential, tenant API key, and control-plane access key. Run
   `make validate`, then deploy its `hindsight` release into namespace
   `daedalus` with the separately approved `make deploy`.
2. Put the same tenant key in the Daedalus `.env`, keep
   `DAEDALUS_MEMORY_MODE=hindsight`, and deploy the Agent.
3. Verify `GET /health/ready` reports `memory.state=hindsight` and
   `memory.hindsight=ready`.
4. Complete turns for at least two authenticated test users. Confirm each
   user's Memory Center contains only that user's sources and facts.
5. Exercise edit, single-fact forget, source deletion, and clear-all with test
   data.
6. Verify live recall improves a follow-up response, user isolation still holds,
   and a retain/recall survives a Hindsight API pod restart.

## Rollback

Redis memory rollback is intentionally retired. For an availability incident,
set `DAEDALUS_MEMORY_MODE=disabled` to stop durable-memory operations while chat
continues without memory enrichment. Repair or restore Hindsight PostgreSQL,
then return to `hindsight`. Never delete Hindsight or Redis PVCs as part of an
incident rollback.

## Validation commands

These checks are source-only and do not deploy:

```bash
cd /volume2/daedalus/datasets/daedalus-hindsight
make validate

cd /volume2/daedalus/datasets/daedalus-agent
(cd builder && .venv/bin/python -m pytest -q)
(cd frontend && npx tsc --noEmit --incremental false)
helm lint helm/daedalus
helm template daedalus helm/daedalus -f custom-values.yaml >/tmp/daedalus-rendered.yaml
```

Live approval is separate. A successful render or rollout is not proof of
tenant isolation, persistence, or recall quality.
