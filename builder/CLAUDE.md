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

The `name=` on the config class is the `_type` referenced in workflow YAML. Retrievers (`smart_milvus`) use `register_retriever_client`/`register_retriever_provider` analogously.

### Tools are composed into a workflow elsewhere — not here

These packages only *register* tools. They are assembled into a running agent by `backend/tool-calling-config.yaml` (repo root), whose `workflow._type` is `tool_calling_agent_resilient` — a custom resilient agent registered by **`json_repair_agent/`** (`resilient_agent_register.py`), not a stock NAT agent. That config also defines MCP servers, embedders, retrievers, and the system prompt. To trace how a tool is used at runtime, match its config `name=` against the `_type:` entries in that file.

### Runtime entrypoint and monkeypatch ordering (entrypoint.py)

The container runs `python entrypoint.py`, which replaces `nat serve` so that **pre-import patches survive**. Order is load-bearing — these run before any NAT import:

1. Seed optional env defaults (e.g. `EXA_API_KEY`) so NAT `${...}` interpolation doesn't emit `None`.
2. `_patch_starlette_compat` — re-adds `add_event_handler`/`add_route`/`add_websocket_route` removed in Starlette 1.0 but still called by NAT 1.4.x/1.7.
3. `_patch_fastapi_daedalus_routes` — wraps `FastAPI.__init__` to `include_router` the Daedalus HTTP routers (below) onto NAT's app.
4. `llm_diagnostics.patch()` — forces timeout/`max_retries` on every OpenAI client and enriches retry/connection-error logs with base_url + status (works around NAT passing `timeout=None`).
5. `mcp_patches.patch()` — overrides NAT's 30s MCP connect timeout to fail fast, adds MCP tool-call logging, and installs the **approval-gate** behavior for guarded MCP tools.

Then it sets `sys.argv` to `nat serve --config_file=$NAT_CONFIG_FILE …` and calls `run_cli()` in-process.

### HTTP routes that bypass the agent loop

`image_api.py` (`/v1/images/*`) and `document_ingest_api.py` (`/v1/documents/*`) are plain FastAPI routers injected into NAT's app by entrypoint patch #3. They exist so the frontend can hit image generation and **bulk document ingest** directly with structured JSON, instead of making an LLM copy hundreds of refs into a tool call. They reuse the same code as the agent tools (`nat_helpers.openai_images`, `nat_nv_ingest`).

### Redis is the shared data plane

Uploaded documents (`document:<sessionId>:<documentId>`, 7-day TTL), generated images (returned as `/api/generated-image/{id}` markdown refs), and the autonomous-agent queue all live in Redis. Tools fetch refs from Redis rather than receiving blobs through the LLM.

### autonomous_agent runs as a separate worker

`autonomous_agent/` is not a NAT tool — it's a long-running worker Deployment (`worker.py`) that polls a Redis queue (`store.py`), calls the agent over HTTP (`backend_client.py`), and surfaces results/approvals to the Autonomy dashboard.

### Test harness (conftest.py) — read before writing tests

`conftest.py` makes the whole suite runnable without NAT or heavy deps installed:
- Adds every `*/src` to `sys.path`, so tests import e.g. `from webscrape.webscrape_function import _fn` directly.
- Installs `MagicMock` modules for the entire `nat.*` framework plus `pymilvus`, `playwright`, `openai`, `redis`, `markitdown`, `optuna`, `kubernetes`, `fastapi`, etc. `FunctionBaseConfig`/`FunctionInfo`/`register_function` get lightweight fakes; `httpx` and `pymilvus...Hit` get **real** classes because code does `isinstance()` on them.

Consequence: unit tests exercise the **pure helper functions** inside each `*_function.py`, not NAT registration. `register.py`, `resilient_agent*.py`, and `agent_skills_function.py` are excluded from coverage (`.coveragerc`). Keep testable logic in standalone helpers, not buried in the `@register_function` generator.

## Package catalog

- **Search/web**: `webscrape` (httpx + Playwright fallback, robots-aware, challenge-page detection), `serpapi_search`, `rss_feed` (feed → rerank → MarkItDown scrape).
- **Retrieval/ingest**: `smart_milvus` (Milvus retriever + `domain_retriever` domain→collection routing), `nat_nv_ingest` (`user_document_tool` ingest/search/list; NvIngest → Milvus; shared vs user collection scoping).
- **Media**: `visual_media` (one tool, `operation=generate|edit|analyze`; OpenAI images API + VLM).
- **Transcripts**: `vtt_interpreter`.
- **Agent infra**: `json_repair_agent` (JSON repair + the resilient workflow agent), `mas_optimizer` (multi-agent-system architecture gate/verifier, paper-derived), `agent_skills` (Anthropic-style progressive-disclosure skills from `/skills`; strips secret env vars before running skill scripts), `user_interaction` (HITL approval tokens), `source_verifier`, `content_distiller`.
- **`nat_helpers`**: shared, non-NAT utilities (Redis image storage, OpenAI images client, result scraping, geolocation) imported by the packages and HTTP routes above.

## Conventions

- A package's user-facing contract usually lives in its `README.md` and `src/<pkg>/configs/config.yml` — check both before changing a tool's signature or config fields.
- Tools generally return human-readable strings (often `Error: <reason>` on failure) rather than raising, because the agent consumes the text.
- Config field names map directly to env-var interpolation in the backend YAML; adding a field means adding it to the package config class *and* threading it through `config.yml`/the backend config.
