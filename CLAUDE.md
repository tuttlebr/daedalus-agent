# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Daedalus is a full-stack AI agent platform built on the **NVIDIA NeMo Agent Toolkit (NAT)**. It ships as one deployable stack — Next.js chat UI, NAT agent backend, Redis-backed memory/state, document retrieval, and an autonomous background worker — runnable locally via Docker Compose or at scale on Kubernetes via Helm.

This is a polyglot monorepo. Each major component has its own scoped guidance — **read the component file before working in that area:**

| Path             | What it is                                                                                  | Scoped guide                               |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `frontend/`      | Next.js 14 TypeScript app (auth, chat orchestration, uploads, real-time sync, PWA)          | [`frontend/CLAUDE.md`](frontend/CLAUDE.md) |
| `builder/`       | Python NAT tool packages + tests (one `pip install -e`-able plugin per subdir)              | [`builder/CLAUDE.md`](builder/CLAUDE.md)   |
| `backend/`       | Runtime NAT workflow config — `tool-calling-config.yaml` wires builder tools into the agent | README "Backend Workflows"                 |
| `evals/`         | Local eval harness (routing / factuality / workflow audit)                                  | [`evals/README.md`](evals/README.md)       |
| `helm/daedalus/` | Helm chart (backend, frontend, nginx, redis, autonomous worker, policies)                   | `helm/daedalus/README.md`                  |
| `skills/`        | Agent runtime skills + upstream NAT v1.7 coding skills (`nat-*`)                            | see "NAT skills" below                     |
| `nginx/`         | Reverse proxy config                                                                        | —                                          |

## Commands

The [`Makefile`](Makefile) mirrors CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) job-for-job. **When you change CI, update the Makefile in the same commit** — it is the local gate. `make` with no target lists jobs.

```bash
make ci          # run every CI job sequentially (fail-fast)
make builder     # builder pytest + coverage
make frontend    # frontend lint, tsc --noEmit, vitest, next build
make helm        # helm lint + template render
make docker      # docker compose config + build runtime images
make security    # gitleaks + trivy fs scans
make evals       # eval harness compile + dataset validation
make tools-check # verify required binaries are installed
```

Per-component (full details in the scoped guides):

```bash
# Builder (Python 3.11+, container runs 3.12; uses uv + builder/.venv)
cd builder && uv pip install -e ".[test]"
cd builder && python3 -m pytest tests                       # all
cd builder && python3 -m pytest tests/test_smart_milvus.py  # one file
cd builder && python3 -m pytest tests -k smart_milvus       # focused

# Frontend (Node.js 22; legacy-peer-deps required)
cd frontend && npm ci --legacy-peer-deps
cd frontend && npm run dev                                   # dev server on :5000
cd frontend && npm test -- --run                            # full suite once
cd frontend && npm test -- --run __tests__/utils/app/backendApi.test.ts  # one file
cd frontend && npm test -- -t "rejects expired"             # one test by name
```

Linting/formatting is centralized in [`.pre-commit-config.yaml`](.pre-commit-config.yaml) — run `pre-commit run --all-files` from repo root. It covers ruff (`--fix`), ruff-format, isort (black profile), pyupgrade (`--py311-plus`), bandit (Python), and Prettier (frontend, applied repo-wide).

## Local stack

```bash
cp .env.template .env          # then set NVIDIA_API_KEY, SESSION_SECRET, AUTH_* (see README)
docker compose up --build      # frontend, backend, nginx, redis (+ builder utility container)
```

App via nginx at `http://localhost`; frontend `:3000`, backend `:8000`, RedisInsight `:8001`. Compose mounts `backend/tool-calling-config.yaml` as the backend config; override with `BACKEND_CONFIG_FILE=...`. **Local Compose does not start Milvus, NV-Ingest, or Phoenix** — those need external services or a cluster. Kubernetes deploys via [`deploy.sh`](deploy.sh) (build, push, secrets, MCP pre-flight, Helm).

## Cross-component architecture

The pieces only make sense together — this is the big picture that spans multiple files.

### Redis is the shared data plane between frontend and backend

There is no direct request/response coupling for the main chat path. The frontend writes job/session/conversation/autonomy state to Redis; the backend reads/writes memory, uploaded documents, generated images, and the autonomous queue in the _same_ Redis. Tools fetch large payloads (document refs, images) from Redis by id rather than receiving blobs through the LLM. Both `frontend/server/session/redis.ts` and the Python packages assume this.

### The chat path is async + streamed, not request/response

`frontend/pages/api/chat/async.ts` (`POST /api/chat/async`) stores job metadata, returns a `jobId` immediately, then opens a _pinned_ backend stream (`/v1/chat/completions`, or `/v1/documents/ingest/stream` for ingest) and persists tokens/steps/status to Redis. Backend tokens fan out via Redis Pub/Sub → WebSocket sidecar → browser, with HTTP polling (`GET /api/chat/async?jobId=`) as fallback. The legacy synchronous `pages/api/chat.ts` returns HTTP 410.

### The backend is _assembled by config_, not by code in `backend/`

`builder/` packages only _register_ NAT tools (via `@register_function`; the config class `name=` is the YAML `_type`). They are composed into a running agent entirely by [`backend/tool-calling-config.yaml`](backend/tool-calling-config.yaml), which also defines MCP servers, embedders, retrievers, auth, and the system prompt. To trace how a tool runs, match its `name=` against `_type:` in that file. The top-level `workflow._type` is `responses_api_agent`, with NAT graph tools listed under `nat_tools` and OpenAI Responses API enabled through `tool_calling_llm.api_type: responses`.

### The backend container runs a custom entrypoint, not `nat serve`

The image runs `python entrypoint.py` (`builder/entrypoint.py`), which applies **load-bearing, order-dependent** pre-import monkeypatches (Starlette compat shims, FastAPI route injection for `image_api.py`/`document_ingest_api.py`, OpenAI client timeout/logging via `llm_diagnostics.py`, MCP timeout + approval-gate via `mcp_patches.py`) _before_ invoking NAT in-process. See `builder/CLAUDE.md` for the exact ordering before touching startup.

### Routing: single Responses agent with direct tools

The backend workflow is one top-level Responses API agent with direct leaf tools. It does not route through nested specialist agents or architecture optimizers; broad research uses the deep-research prompt path with source planning and approval.

### The autonomous worker is a separate process

`builder/autonomous_agent/worker.py` runs as its own Deployment (`python -m autonomous_agent.worker`), polling a Redis queue, calling the agent over HTTP, and surfacing runs/feed/approvals to the frontend Autonomy dashboard. It is not a NAT tool. Destructive/irreversible/credential/send/delete actions pause for UI approval.

## NAT (NeMo Agent Toolkit) work

For any NAT _framework_ implementation work (workflow YAML, custom functions/tools, evals, telemetry, MCP, serving), **read [`skills/nat-user-rules/SKILL.md`](skills/nat-user-rules/SKILL.md) first** — it routes to the focused `nat-*` skill for the task. NAT is **not** pip-installable locally (it comes from a git ref baked into the container), so builder tests run against mocks defined in `builder/conftest.py`; keep testable logic in standalone helpers, not inside `@register_function` generators.

## Conventions

- **Secrets:** never commit `.env` (or `frontend/auth-passwords.json`). Add new vars to `.env.template`. Generate `SESSION_SECRET` with `openssl rand -base64 32`; it signs identity cookies and must be unique per deployment. `DAEDALUS_INTERNAL_API_TOKEN` protects trusted frontend→backend identity headers (Helm manages it automatically).
- **A tool's contract** lives in its package `README.md` and `src/<pkg>/configs/config.yml`, and a config field maps to env-var interpolation in `backend/tool-calling-config.yaml` — changing a field means updating the package config class _and_ threading it through both YAMLs.
- **Commits:** short imperative summaries (e.g. `Fix optional Exa search config validation`); keep them scoped, avoid unrelated formatting churn. Do not add AI/bot attribution to commit messages.
