# Running and deploying Daedalus

Use Node.js 22 and Python 3.12. The Docker build supplies Rust 1.95 and installs
Python dependencies from the hashed Linux architecture locks. A local Rust
build also requires Cargo 1.95. The shipped backend has no NeMo Agent Toolkit
dependency.

For local text chat, copy `.env.example` to `.env`, configure the model and login
as described in the repository README, and build with Docker Compose. The
minimal configuration is `backend/local-chat-config.yaml`. The home integration
configuration remains `backend/tool-calling-config.yaml`.

For Kubernetes, the canonical command remains:

```bash
make deploy
```

It builds and publishes the application images, resolves immutable image
references, validates authentication and service access, prepares Content
Credentials, updates the release, waits for the rollout, and follows backend
logs. Stop log following with Ctrl+C. It rejects uncommitted source unless you
explicitly pass `DEPLOY_ARGS='--allow-dirty-source'`. Review all pending source
before using that development override. `DEPLOY_IMAGE_ARGS` retains the existing
development default allowing unsigned container images; use the signed release
path for a deployment that requires container provenance verification.

Preview using a credential file you own:

```bash
make deploy DEPLOY_ARGS='--dry-run'
```

The preview validates configuration and renders deployment intent; it does not
publish images, change the cluster, or follow live logs. A preview is not proof
that the external model, MCP services, OAuth provider, or rollout will succeed.

`DAEDALUS_CONFIG_FILE` replaces `NAT_CONFIG_FILE` inside the backend container.
Helm injects its mounted configuration path and `DAEDALUS_PORT`. Compose continues
to select the host YAML using `BACKEND_CONFIG_FILE`. The supervisor reserves
loopback `DAEDALUS_TOOLS_PORT` (8001 by default) for Python. Do not expose it as a
separate Service. Optional runtime logging uses `RUST_LOG` and `LOG_LEVEL`.
Existing frontend `NAT_*` transport settings remain compatibility settings.

`DAEDALUS_LLM_TIMEOUT` sets the model request timeout in seconds, from 1 to 3600.
The runtime also enforces a separate 30-minute deadline for the entire agent
run, including model and tool calls. Invalid configuration logs identify fields
and validation categories while omitting configured values and credentials.

Existing sessions, Redis conversations, tool output caches, and Google grants
are retained. The backend image and frontend must be rolled out together to
enable the steering composer. Existing custom YAML overlays must use
`workflow._type: daedalus_rust_agent`, `tools`, `daily_summary_tools`, and
`daily_summary_final_tools`; the old `general.front_end` runner is removed.
MCP connection recovery occurs before subsequent calls; the runtime never
replays a `tools/call` whose remote result is uncertain.

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
