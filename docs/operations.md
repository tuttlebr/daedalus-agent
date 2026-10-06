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

Existing sessions, Redis conversations, tool output caches, and Google grants
are retained. The backend image and frontend must be rolled out together to
enable the steering composer. Existing custom YAML overlays must use
`workflow._type: daedalus_rust_agent`, `tools`, `daily_summary_tools`, and
`daily_summary_final_tools`; the old `general.front_end` runner is removed.
MCP connection recovery occurs before subsequent calls; the runtime never
replays a `tools/call` whose remote result is uncertain.

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
