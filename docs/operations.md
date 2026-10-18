# Operating Daedalus

Use this page to configure accounts, protect stored data, deploy to Kubernetes,
and diagnose a running installation. For your first text-chat installation,
follow the [README local setup](../README.md#local-setup). The
[architecture guide](architecture.md) explains how to add capabilities.

Prerequisites for Kubernetes deployment: a working cluster and `kubectl`
context, Helm 3, Git, Make, Bash, Docker Compose with BuildKit/buildx and registry
push access, Python 3.12 with `uv` and PyYAML available to `python3`, and Trivy
for image scans. The signed release
path also needs Cosign and the GitHub CLI. The Docker build supplies Node.js 22 and Rust
1.95; host versions are needed only for the source checks described in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Login configuration

Set `SESSION_SECRET` and either one `AUTH_USERNAME` / `AUTH_PASSWORD_HASH` /
`AUTH_NAME` account or consecutively numbered accounts. Generate each bcrypt
hash using the [README command](../README.md#2-build-and-create-your-login-hash).
Keep hashes single-quoted in `.env` so Compose does not interpolate `$`.

For two accounts, replace the single-user entries with the following structure,
substituting each account's generated hash for the placeholder:

```dotenv
AUTH_USER_1_USERNAME=alex
AUTH_USER_1_PASSWORD_HASH='<bcrypt hash for Alex>'
AUTH_USER_1_NAME=Alex
AUTH_USER_2_USERNAME=sam
AUTH_USER_2_PASSWORD_HASH='<bcrypt hash for Sam>'
AUTH_USER_2_NAME=Sam
```

Validate the file without printing credentials:

```bash
python3 scripts/validate_auth_env.py .env
```

The command reports the configured account count. After restarting the frontend,
sign in with each account and verify its conversation list. User ownership checks
apply to conversations, uploads, jobs, and private state; the operator controls
the underlying services and data.

> **Migrating an existing login:** plaintext `AUTH_PASSWORD` and
> `AUTH_USER_N_PASSWORD` are no longer accepted. Hash each user's current password
> and replace those keys with `AUTH_PASSWORD_HASH` or
> `AUTH_USER_N_PASSWORD_HASH`. Keep the username, password, and `SESSION_SECRET`
> unchanged to preserve existing logins and sessions. This changes the stored
> verifier; it does not add MFA or reset passwords.

## Exposure and storage

Local Compose uses plaintext HTTP and development Redis/object-store credentials.
It publishes nginx on the configured host port (8080 in `.env.example`) and the
frontend on port 3000. The backend and Redis bind to host loopback ports 8000 and 6379. The backend's internal-auth opt-out is specific to this local stack. Use
TLS, scoped Secrets, and the chart's network policies when exposing a deployment.

Compose persists Redis under `redis/data/` and document objects in the
`document_objects` Docker volume. `docker compose down` keeps both; deleting
that directory or removing volumes discards their contents. A root-only init
container prepares the Redis volume, then Redis runs as UID 977/GID 988 with a
read-only root filesystem.

Kubernetes storage and credentials are defined in the
[Helm storage and Secret reference](../helm/daedalus/README.md). Retain Redis
persistence across upgrades: it holds conversations, sessions, queued jobs, and
private state. Back up that storage before storage migrations. Document objects
have a separate expiry contract; configure the bucket's lifecycle for the
selected prefix and retention period.

## Deploy to Kubernetes

Run commands from the repository root. First adapt your own configuration:

- Use [.env.template](../.env.template) as an integration reference and keep the
  deployment credential file private. Configure registry access and login
  hashes; a local `.env.example` is not a complete Kubernetes configuration.
- Review [custom-values.yaml](../custom-values.yaml) as a home-specific example.
  Supply values for your image repositories, hostnames/TLS, storage class and
  ownership, node placement, enabled services, and network rules.
- Select a workflow YAML and provision the services it references. See the
  [Helm Secret contracts](../helm/daedalus/README.md#secrets) for model, MCP,
  Redis, retrieval, and document-storage credentials. The default deployment
  mirrors authoritative Milvus/MinIO Secrets from the `daedalus` namespace;
  adapt those sources or provision release-local Secrets for your installation.

Inspect the supported flags and validate chart rendering:

```bash
./deploy.sh --help
make helm
```

The canonical command uses `.env`, `custom-values.yaml`, and
`backend/tool-calling-config.yaml` by default. With your selected files in place,
preview the steps:

```bash
make deploy DEPLOY_ARGS='--dry-run'
```

To select different files, add `--env-file`, `--values`, and `--backend-config`
to `DEPLOY_ARGS`; `--release` and `--namespace` select the Kubernetes target.
Use the same selections for preview and deployment. The preview validates login
configuration and prints deployment intent; it does not build images, apply
resources, or exercise live service preflights. Use `make helm` for the separate
chart-rendering check. A successful preview is not a successful rollout.

Deploy the reviewed, committed source:

```bash
make deploy
```

This builds and publishes application and Redis images, scans them, resolves
immutable references, prepares [Content Credentials](content-credentials.md),
synchronizes scoped Secrets, checks configured service access, and upgrades the
release with `--wait --atomic`. It verifies deployments and then follows backend
logs; stop log following with Ctrl+C after the rollout finishes.

The command rejects uncommitted source. The development override is
`DEPLOY_ARGS='--allow-dirty-source'`; review all pending changes before using it.
`DEPLOY_IMAGE_ARGS` defaults to allowing unsigned development images. For a
signed prebuilt release, use the [release evidence procedure](../helm/daedalus/README.md#release-evidence),
which checks the source commit, successful CI, scans, signatures, and provenance.

### Verify a rollout

For the default release and namespace (substitute yours if different):

```bash
kubectl -n daedalus get deployments -l app.kubernetes.io/instance=daedalus
kubectl -n daedalus rollout status deployment/daedalus-backend-default
kubectl -n daedalus port-forward service/daedalus-backend-default 18000:8000
```

In a second shell while the port-forward runs:

```bash
curl -fsS http://127.0.0.1:18000/health/ready
```

Check the returned dependency status as well as HTTP success. With degraded RAG
readiness, chat can remain ready while retrieval is unavailable. If retrieval
is part of this installation, verify its dependency reports ready. Then open
your public frontend, sign in, run the clock request, and reload saved history.
Exercise each newly configured capability with a small request of its own.

## Runtime configuration

For offline experiments, provision the separate exploration service before
enabling its workflow tool. The chart defaults `exploration.enabled` to true and
expects the `exploration-grants` Secret in the backend namespace. Installations
without that service should disable the chart setting and remove its workflow
registration. See [sandbox exploration](sandbox-exploration.md) for setup,
artifact publication, async recovery and built-image checks.

`DAEDALUS_CONFIG_FILE` replaces `NAT_CONFIG_FILE` inside the backend container.
Helm injects its mounted configuration path and `DAEDALUS_PORT`. Compose continues
to select the host YAML using `BACKEND_CONFIG_FILE`. The supervisor reserves
loopback `DAEDALUS_TOOLS_PORT` (8001 by default) for Python. Do not expose it as a
separate Service. Optional runtime logging uses `RUST_LOG` and `LOG_LEVEL`.
Existing frontend `NAT_*` transport settings remain compatibility settings.

## Runtime ownership and rollback

Rust preparation and MCP authorization are now the default.
`DAEDALUS_PREPARATION=python` selects both retained Python implementations;
`DAEDALUS_AUTHORIZATION=python` retains just Python MCP/OAuth with Rust
preparation. Select an implementation for an entire deployment; never retry a
failed run through it automatically. Put selectors in the deployment `.env`
file; both Compose and `make deploy` pass them to the backend. Direct Helm
deployments can use `backend.default.env.data` or the existing backend Secret.
Leave authorization unset when selecting Python preparation, or explicitly set
it to `python` as well. The full image still needs Python for
unmigrated native tools, APIs and the autonomous worker. For clock/text and MCP
profiles, build Docker target
`rust-minimal` and provide `DAEDALUS_CONFIG_FILE`, the internal token and model
settings; its direct binary entrypoint requires no Python service. Required
unsupported tools fail startup. Run `daedalus-runtime --check-config` to validate
the parsed Rust configuration without starting services. See the
[migration record](rust-migration.md) for image, rollback and validation commands.
OAuth callbacks, resets and approval execution/polling now terminate in Axum.
Keep callback and execution polling affinity to their originating process; drain
active runs and OAuth/approval waits before changing implementations. Grant keys,
refresh locks and receipt formats remain compatible with the rollback image.

## Timeouts and tool concurrency

`DAEDALUS_LLM_TIMEOUT` sets the model request timeout in seconds, from 1 to 3600.
The runtime also enforces a separate 30-minute deadline for the entire agent
run, including model and tool calls. Invalid configuration logs identify fields
and validation categories while omitting configured values and credentials.

`functions.source_verifier_tool.max_concurrency` and
`functions.webscrape_tool.max_concurrency` control independent claim checks and
scrapes (integer 1–8, default 1). The shipped workflow enables two verifications
and four scrapes. Set either to `1` to restore its serial dispatch;
`workflow.parallel_tool_calls: false` serializes all dispatch within each run.
Each Python tool instance also enforces its limit across concurrent runs. Scrape
admission covers robots checks, retrieval and conversion. Other stateful tools
retain their existing serialization. `make migration` includes the built-image
retrieval, result-binding, concurrency, steering, and cancellation checks in
`builder/migration/leaf_check.py`.

Existing sessions, Redis conversations, tool output caches, and Google grants
are retained. The backend image and frontend must be rolled out together to
enable the steering composer. Existing custom YAML overlays must use
`workflow._type: daedalus_rust_agent`, `tools`, `daily_summary_tools`, and
`daily_summary_final_tools`; the old `general.front_end` runner is removed.
MCP connection recovery occurs before subsequent calls; the runtime never
replays a `tools/call` whose remote result is uncertain.

## MCP discovery

Large MCP groups can set `defer_discovery: true` and a nonempty
`discovery_description` explaining their capabilities. Each request initially
exposes the group's `__connect` tool; connecting adds the original allowed tools
and argument schemas for the rest of that request. Readiness still discovers
the complete catalogue, and authentication, per-user sessions, local allowlists,
and approval policies continue to apply to each call.
An optional `initial_tools` list keeps commonly used operations exposed without
the discovery round trip; these must belong to the group's local allowlist.
When initial tools are configured, discovery advertises the remaining allowed
operation names so the model can find specialized operations without their
full schemas. Tool names and schemas added after connecting use the same
per-user catalogue and allowlist.
The home configuration enables deferred Hue discovery with these settings in
`function_groups.hue_mcp_server`:

```yaml
defer_discovery: true
initial_tools:
  [get_bridge_status, list_resources, get_resource, set_light_state]
```

This keeps bridge status, resource lookup, and basic light control exposed while
loading additional operations on demand. Keep the configured
`discovery_description` to explain the remaining capabilities.
Clear `initial_tools` and set `defer_discovery: false` to restore eager exposure.
Measure Hue workflows as well as unrelated tasks: first use of a deferred
operation adds a model round trip for discovery.

## Validate a runtime change

Validate a built backend against local scripted model/MCP peers:

```bash
python3 builder/runtime_http_check.py --image YOUR_BACKEND_IMAGE
```

The harness needs `httpx` and `pyyaml` on the host and Docker for image mode. It
starts only disposable local services and covers real provider streaming,
native tool invocation, incomplete responses, and steering across model and MCP
waits. Use `--redis-image YOUR_REDIS_IMAGE` to also exercise exact approvals with
a disposable Redis instance. `make runtime` builds and checks both runtime
languages; `make helm` validates chart rendering. These checks do not measure
live provider latency. Benchmark representative conversations before claiming
an end-to-end speed improvement.

For model/context growth, tool scheduling, interruption semantics and repeatable
measurement commands, see the [long-running workflow review](long-running-workflows.md).

## Runtime logs

Backend application logs are JSON lines on stdout. They record run start/end,
preparation, model attempts and retries, time to the first model event, tool
execution, steering, cancellation, approval waits, and process lifecycle. A final
run summary includes elapsed time, model/tool call counts, and reported token
usage. Failures include their stage, category, and HTTP status when available.
Prompts, answers, tool arguments/results, user identities, credentials, raw
provider errors, and OAuth URLs are excluded from these application logs.

`LOG_LEVEL=INFO` is the default for both processes; `DEBUG` also logs MCP
discovery timings, and `WARN`/`ERROR` reduce progress output. Rust additionally
honors `RUST_LOG` when set. Use `daedalus_runtime=debug` to scope Rust diagnostics
to application events. Uvicorn and other dependencies retain their own log
formats. No Phoenix collector is needed to see application logs.

Follow the backend with:

```bash
kubectl -n daedalus logs -f deployment/daedalus-backend-default -c backend
```

The Rust `span.run_id` and Python `fields.run_id` identify the same frontend job.
To inspect one run with `jq`, filtering out non-JSON server messages:

```bash
kubectl -n daedalus logs deployment/daedalus-backend-default -c backend --since=30m |
  jq -R 'fromjson? | select((.span.run_id // .fields.run_id) == "RUN_ID")'
```

For local Compose, use `docker compose logs --tail=100 backend stream-worker frontend`.
When diagnosing a failed response, correlate the frontend job ID with the
backend run ID and inspect the failure stage before changing model or retry
settings. Completed output can survive a failed run; it is not evidence that
all requested actions finished. See [tool contracts](tool-correctness.md) and
[recovery limits](long-running-workflows.md) before retrying a task with external
side effects.
