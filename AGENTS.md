# Repository Guidelines

## Project Structure & Module Organization

Daedalus is a deployable AI agent platform. `backend/` contains the NeMo Agent Toolkit workflow config. `builder/` holds Python tool packages and services; tests are in `builder/tests/`. `frontend/` is the Next.js TypeScript UI; tests are in `frontend/__tests__/`. `evals/` contains runners, evaluators, and YAML datasets. Deployment lives in `helm/daedalus/`, `nginx/`, `docker-compose.yaml`, `custom-values.yaml`, and `deploy.sh`. Local agent skills live in `skills/`. Follow nested guides in `builder/AGENTS.md` and `frontend/AGENTS.md`.

## Agent-Specific Instructions

For NeMo Agent Toolkit work, read `skills/nat-user-rules/SKILL.md` first, then the relevant `skills/nat-*` guide for workflow YAML, tools, evals, telemetry, MCP, or serving.

## Build, Test, and Development Commands

Use the root `Makefile` as the local CI mirror.

- `make ci`: runs builder, frontend, Helm, Docker, security, and eval checks.
- `make builder`: installs builder test dependencies and runs pytest with coverage.
- `make frontend`: runs install, lint, typecheck, Vitest, and build.
- `make helm`: lints and renders the Helm chart.
- `make docker`: validates Compose config and builds runtime images.
- `make evals`: compiles the eval harness and validates datasets.
- `docker compose up --build`: starts the local stack after creating `.env`.

## Coding Style & Naming Conventions

Python targets 3.11+ and is formatted by Ruff, Ruff format, isort, and pyupgrade. Name Python tests `test_*.py`. Frontend code uses TypeScript, React, Prettier, ESLint, and Tailwind; components are PascalCase and utilities/hooks are camelCase. Keep changes scoped and avoid unrelated formatting churn.

## Testing Guidelines

Run focused tests before the full target, then use the matching `make` target before a PR. Builder tests use pytest and existing fakes instead of real external services. Frontend tests use Vitest in `jsdom`; name files `*.test.ts` or `*.test.tsx`. Update eval datasets when routing, factuality, or workflow behavior changes.

## Commit & Pull Request Guidelines

Recent commits use short, imperative subjects such as `Fix optional Exa search config validation`. PRs should include the problem, implementation summary, linked issue, and exact verification commands. Include screenshots for UI changes and call out changes to env vars, auth, Redis state, MCP config, or deployment manifests.

## Security & Configuration Tips

Do not commit secrets, `.env` contents, local virtualenvs, coverage files, or scan artifacts. Use `.env.template`, `frontend/env.example`, and `frontend/auth-passwords.json.template` as references. Run `pre-commit run --all-files` before broad changes; it checks formatting, syntax, secrets, shell, Ruff, Bandit, and Helm.
