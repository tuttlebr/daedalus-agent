# Hindsight memory integration and rollout

This runbook is the engineering contract for Daedalus durable memory. Hindsight
is deployed separately in namespace `daedalus-hindsight`; Daedalus keeps user
identity, recall injection, retention timing, and user controls in the Agent
backend and frontend.

## User-visible behavior

For every authenticated user, Daedalus:

1. recalls a bounded set of relevant facts before an interactive turn;
2. labels recalled facts as untrusted context, never as instructions;
3. lets the current user message override conflicting memory;
4. selectively extracts durable facts from the latest user text after a
   successful response;
5. does not automatically retain assistant output, tool traces, autonomy runs,
   or internal control messages; and
6. provides a Memory Center to search, edit, forget, inspect source text, delete
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
HINDSIGHT_API_URL=http://hindsight-api.daedalus-hindsight.svc.cluster.local:8888
HINDSIGHT_API_KEY=<same value as HINDSIGHT_API_TENANT_API_KEY>
HINDSIGHT_API_TIMEOUT_SECONDS=20
DAEDALUS_MEMORY_MODE=shadow
```

`deploy.sh` requires a Hindsight key of at least 32 characters for `shadow` or
`hindsight`. It applies `DAEDALUS_MEMORY_MODE` as an explicit pod override, so
the `.env` rollout setting is not hidden by the chart's safe `shadow` default.
The tenant key stays in the backend Secret and is never passed through Helm
values.

## Authority modes

| Mode        | Reads and explicit writes                                                          | Automatic lifecycle                                                        | Readiness                                   |
| ----------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| `disabled`  | No durable-memory reads or writes                                                  | Off                                                                        | Hindsight not checked                       |
| `redis`     | Legacy Redis is authoritative                                                      | Hindsight recall and retention are off                                     | Hindsight not checked                       |
| `shadow`    | Redis is authoritative; explicit and profile writes also go to Hindsight           | User turns retain to Hindsight; recalls are measured but not injected      | Hindsight failure is degraded, not unready  |
| `hindsight` | Hindsight is authoritative; explicit and profile writes keep a Redis rollback copy | Bounded recall is injected and successful user turns retain asynchronously | Hindsight failure makes the backend unready |

Automatic recall and automatic retention fail open for chat availability.
Explicit writes fail if the authoritative store fails. In `hindsight` mode,
Redis copy failures are logged but do not turn a completed Hindsight write into
a false failure.

## Runtime flow

```text
authenticated browser
  -> Next.js internal-auth proxy
  -> Daedalus backend derives opaque user bank
     -> before interactive turn: Hindsight recall (8 facts, 800-token request)
     -> Responses agent receives [MEMORY_CONTEXT] immediately before user text
     -> successful finalization retains latest user text once
     -> Hindsight selectively extracts facts and keeps the raw source document
```

The finalization journal records `memoryRetentionAttemptedAt`. The deterministic
job ID becomes the Hindsight operation ID, so a crash or retry cannot enqueue a
second extraction for the same completed turn. Retention accepts at most 12,000
characters and rejects Daedalus internal control prefixes.

## Migration

The backend image includes `/workspace/migrate_redis_memory_to_hindsight.py`.
It scans only owned `nat:memory:*` records, derives deterministic source IDs,
uses synchronous Hindsight retain, and never prints memory text or raw user IDs.
Dry-run is the default.

```bash
kubectl -n daedalus exec deployment/daedalus-backend-default -- \
  python /workspace/migrate_redis_memory_to_hindsight.py

kubectl -n daedalus exec deployment/daedalus-backend-default -- \
  python /workspace/migrate_redis_memory_to_hindsight.py --execute
```

Use `--user-id <exact-authenticated-id>` only for diagnosis. The release is not
canaried by user; promotion applies to all authenticated users.

Clear-all epochs and source tombstones live in Redis. The migration skips older
or undated records after a clear and skips deleted sources, preventing a later
migration from resurrecting forgotten data. Re-running the migration is safe:
the same Redis record maps to the same Hindsight document and replaces it
idempotently.

## Rollout

1. In `daedalus-hindsight`, configure the database password, LLM credential,
   tenant API key, and control-plane access key. Run `make validate`, then the
   separately approved `make deploy`.
2. Put the same tenant key in the Daedalus `.env`, set
   `DAEDALUS_MEMORY_MODE=shadow`, and deploy the Agent.
3. Verify `GET /health/ready` reports `memory.state=shadow` and
   `memory.hindsight=ready`.
4. Complete turns for at least two authenticated test users. Confirm each
   user's Memory Center contains only that user's sources and facts. Confirm
   shadow recall counts are logged without `[MEMORY_CONTEXT]` injection.
5. Run the migration dry run. Review counts, execute it, and repeat the dry run
   to confirm the eligible set is stable.
6. Exercise edit, single-fact forget, source deletion, and clear-all with test
   data. Confirm deleted data does not return after another migration run.
7. Set `DAEDALUS_MEMORY_MODE=hindsight` and deploy once for all authenticated
   users. Do not delete Redis or Hindsight data during promotion.
8. Verify live recall improves a follow-up response, user isolation still holds,
   and a retain/recall survives a Hindsight API pod restart.

## Rollback

Set `DAEDALUS_MEMORY_MODE=redis` and redeploy Daedalus. Do not clear Hindsight,
delete its PVC, or reverse the migration. Redis keeps pre-cutover memory plus
the explicit/profile rollback copies written during Hindsight authority.
Automatic facts learned only by Hindsight after promotion are not reconstructed
in Redis.

After rollback, verify backend readiness, one legacy Redis recall, one explicit
memory write, and normal chat finalization. Diagnose and repair Hindsight while
the retained Hindsight data remains intact.

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
