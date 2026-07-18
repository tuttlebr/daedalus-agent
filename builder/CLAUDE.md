# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Scope

`builder/` holds the Python NeMo Agent Toolkit (NAT) tools for Daedalus. It is one component of a larger full-stack monorepo (repo root is the parent dir, which also contains `frontend/`, `backend/`, `evals/`, `helm/`, `skills/`). The repo-root `AGENTS.md` covers the full stack and `skills/nat-*/` hold NAT implementation guides; read those for frontend, deployment, or NAT-framework questions. This file is builder-scoped.

## Commands

All commands run from `builder/` unless noted. NAT itself is **not** installable locally (it comes from a git ref baked into the container), so tests rely on mocks — see Test harness below.

```bash
# Install test deps (creates/uses builder/.venv via uv)
uv pip install -e ".[test]"

# Run all tests (CI-equivalent, with coverage)
pytest --cov --cov-report=xml --cov-report=term-missing

# Plain run
python3 -m pytest tests

# Single file / focused
python3 -m pytest tests/test_webscrape_utils.py
python3 -m pytest tests -k smart_milvus

# Lint/format — configured in repo-root .pre-commit-config.yaml, run from repo root.
# ruff (--fix), ruff-format, isort (black profile), pyupgrade --py311-plus, bandit.
cd .. && pre-commit run --all-files

# Local CI mirror for just this component (from repo root)
cd .. && make builder
```

Python target is 3.11+ (container runs 3.12). When CI (`.github/workflows/ci.yml`) changes, the repo-root `Makefile` must be updated in the same commit — it is the local mirror.

## Architecture

### Each top-level dir is a standalone NAT plugin package

Every package (`webscrape/`, `smart_milvus/`, `visual_media/`, …) is independently `pip install -e`-able with the layout `src/<pkg>/`, its own `pyproject.toml`, and a `configs/config.yml`. Packages expose a `nat.components` entry point pointing at `<pkg>.register`:

```toml
[project.entry-points.'nat.components']
webscrape = "webscrape.register"
```

`register.py` just imports the function module(s) for their import-time side effects. The real wiring is the `@register_function` decorator pattern:

```python
class WebscrapeFunctionConfig(FunctionBaseConfig, name="webscrape"):  # name= is the YAML _type
    ...

@register_function(config_type=WebscrapeFunctionConfig)
async def webscrape_function(config, builder):
    async def _fn(...): ...
    yield FunctionInfo.from_fn(_fn, description="...")
```

The `name=` on the config class is the `_type` referenced in workflow YAML. The `smart_milvus` package exposes `domain_retriever` as a normal registered function while retaining `MilvusRetriever` as its shared implementation.

### Tools are composed into a workflow elsewhere — not here

These packages only _register_ tools. They are assembled into a running agent by `backend/tool-calling-config.yaml` (repo root), whose `workflow._type` is `daedalus_per_user_tool_calling_agent`, with leaf tools and MCP function groups listed under `tool_names`. The adapter delegates to NAT's pinned tool-calling implementation, but NAT builds and idle-caches it per authenticated user so OAuth MCP schemas never come from a shared bootstrap. The agent seeds its graph with the full inbound `messages` list (trimmed to the last `max_history`), preserving in-chat history; `tool_calling_llm` uses Chat Completions, not the Responses API (the Responses API is only supported via `responses_api_agent`, which takes a single input string and so drops all turns but the last). That config also defines MCP servers, embedders, retrievers, and the system prompt. To trace how a tool is used at runtime, match its config `name=` against the `_type:` entries in that file.

### Runtime entrypoint and adapter ordering (entrypoint.py)

The container runs `python entrypoint.py`, which replaces `nat serve` so that **pre-import patches survive**. Order is load-bearing — these run before any NAT import:

1. Assert the exact NAT 1.7.0 and Starlette `<1` runtime contracts.
2. Redact request credentials from NAT telemetry and configure Phoenix headers.
3. `llm_diagnostics.patch()` — forces timeout/`max_retries` on every OpenAI client and enriches retry/connection-error logs with base_url + status (works around NAT passing `timeout=None`).
4. `mcp_patches.patch(config_path=...)` loads exact MCP authorization policy and endpoint identities from the deployed workflow YAML, bounds shared MCP startup, gives skipped requested groups one five-second shared recovery pass, rejects OAuth schema discovery outside authenticated per-user context, and installs the fail-closed **approval gate**.

### Expanding an MCP tool surface

`function_groups.<server>.include` controls what the agent may discover; it
does not authorize a call as read-only. For each new MCP tool, first decide
whether it is reviewed read-only or approval-gated:

- A read-only tool needs an exact entry in the YAML `include` list and an exact
  `tool_overrides.<tool>.approval_policy: read_only` declaration. The runtime
  builds its normalized authorization registry from that YAML; do not add a
  second authorization list in Python.
- Omitted policies and `approval_policy: approval_required` fail closed and
  require the exact, single-use credential issued by `confirm_action`. Unknown
  policy values or policies for tools outside `include` fail startup.
- Static API-key MCP providers log only `configured=True|False` at startup for
  their expected environment variable. That confirms injection without
  exposing a secret; it does not prove the remote server accepted the key.
- Shared API-key MCPs stay on `_type: mcp_client`; per-user OAuth MCPs use
  `_type: per_user_mcp_client` with `allow_default_user_id_for_tool_calls:
false`. Never use `confirm_action` as an authentication fallback.
- Every per-user OAuth provider must reference a distinct durable object store.
  Daedalus uses `daedalus_redis_object_store` with the secret `REDIS_URL` so
  ACL credentials and verified TLS are honored. Distinct buckets are required
  because NAT hashes only the user id when forming a token key.
- OAuth state remains owned by the backend process that opened the flow. The
  stream worker writes `state -> backendBaseUrl` to Redis, nginx sends
  `/auth/redirect` through the frontend, and the frontend proxies the callback
  to that exact pod. The chat UI renders the resulting `oauth_required` event
  as a Connect/Reopen button. Preserve this path when changing backend
  discovery or scaling; if the approval gate blocks the initial read-only call,
  the provider challenge and frontend reauthorization option never occur.

Then it sets `sys.argv` to `nat serve --config_file=$NAT_CONFIG_FILE …` and calls `run_cli()` in-process.

NAT application composition uses its supported `general.front_end.runner_class` hook. `nat_helpers.front_end.DaedalusFastApiFrontEndPluginWorker` attaches the backend-wide auth middleware, readiness route, and Daedalus routers to NAT's application only.

### HTTP routes that bypass the agent loop

`image_api.py` (`/v1/images/*`) and `document_ingest_api.py` (`/v1/documents/*`) are plain FastAPI routers composed into NAT's app by the configured Daedalus runner. They exist so the frontend can hit image generation and **bulk document ingest** directly with structured JSON, instead of making an LLM copy hundreds of refs into a tool call. They reuse the same code as the agent tools (`nat_helpers.openai_images`, `nat_nv_ingest`).

### Redis is the shared data plane

Uploaded documents (`document:<sessionId>:<documentId>`, 7-day TTL), generated images (returned as `/api/generated-image/{id}` markdown refs), and the autonomous-agent queue all live in Redis. Tools fetch refs from Redis rather than receiving blobs through the LLM.

### autonomous_agent runs as a separate worker

`autonomous_agent/` is not a NAT tool — it's a long-running worker Deployment (`worker.py`) that polls a Redis queue (`store.py`), calls the agent over HTTP (`backend_client.py`), and surfaces results/approvals to the Autonomy dashboard.

### Test harness (conftest.py) — read before writing tests

`conftest.py` makes the whole suite runnable without NAT or heavy deps installed:

- Adds every `*/src` to `sys.path`, so tests import e.g. `from webscrape.webscrape_function import _fn` directly.
- Installs `MagicMock` modules for the entire `nat.*` framework plus `pymilvus`, `openai`, `redis`, `markitdown`, `optuna`, `kubernetes`, `fastapi`, etc. `FunctionBaseConfig`/`FunctionInfo`/`register_function` get lightweight fakes; `httpx` and `pymilvus...Hit` get **real** classes because code does `isinstance()` on them.

Consequence: unit tests exercise the **pure helper functions** inside each `*_function.py`, not NAT registration. `register.py` and `agent_skills_function.py` are excluded from coverage (`.coveragerc`). Keep testable logic in standalone helpers, not buried in the `@register_function` generator.

## Package catalog

- **Search/web**: `webscrape` (pinned public HTTP fetch + local-file MarkItDown conversion, robots-aware, challenge-page detection), `perplexity_search`, `rss_feed` (feed → rerank → pinned fetch → local-file MarkItDown conversion).
- **Retrieval/ingest**: `smart_milvus` (Milvus retriever + `domain_retriever` domain→collection routing), `nat_nv_ingest` (`user_document_tool` ingest/search/list; NvIngest → Milvus; shared vs user collection scoping).
- **Media**: `visual_media` (one tool, `operation=generate|edit|analyze`; OpenAI images API + VLM).
- **Transcripts**: `vtt_interpreter`.
- **Agent infra**: `agent_skills` (Anthropic-style progressive-disclosure skills from `/skills`; strips secret env vars before running skill scripts), `user_interaction` (HITL approval tokens), `source_verifier`, `content_distiller`.
- **`nat_helpers`**: shared utilities for identity, memory, Redis media storage, OpenAI images, and URL validation imported by the packages and HTTP routes above.

## Conventions

- A package's user-facing contract usually lives in its `README.md` and `src/<pkg>/configs/config.yml` — check both before changing a tool's signature or config fields.
- Tools generally return human-readable strings (often `Error: <reason>` on failure) rather than raising, because the agent consumes the text.
- Config field names map directly to env-var interpolation in the backend YAML; adding a field means adding it to the package config class _and_ threading it through `config.yml`/the backend config.
