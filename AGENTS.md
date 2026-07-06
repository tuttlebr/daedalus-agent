# Repository Guidelines

## Project Structure & Module Organization

Daedalus is a full-stack AI agent platform. The Next.js UI lives in `frontend/`, with pages, API handlers, components, hooks, state, tests, and static assets. Python NeMo Agent Toolkit packages and the shared pytest harness live in `builder/`; most packages keep source under `src/<package>/` and tests under `builder/tests/`. Backend workflow configuration is in `backend/`. Deployment assets include `docker-compose.yml`, `helm/daedalus/`, `nginx/`, `custom-values.yaml`, and `deploy.sh`. Evaluation datasets, evaluators, and results are in `evals/`; docs and automation are in `docs/` and `scripts/`. Follow `frontend/AGENTS.md` and `builder/AGENTS.md` when editing those trees. For NeMo Agent Toolkit framework work, read `skills/nat-user-rules/SKILL.md` first, then follow the focused `nat-*` skill it routes to.

## Build, Test, and Development Commands

- `make ci`: runs the local CI mirror for builder, frontend, Helm, Docker, security, and evals.
- `make builder`: installs builder test dependencies with `uv` and runs pytest with coverage.
- `make frontend`: runs `npm ci`, lint, TypeScript checks, Vitest, and the Next.js build.
- `make test-integration`: runs opt-in Redis-backed integration tests; set `REDIS_URL` if needed.
- `docker compose up --build`: starts the local stack after creating `.env` from `.env.template`.
- `cd frontend && npm run dev`: starts the standalone frontend on port `5000`.
- `pre-commit run --all-files`: runs formatting, lint, and secret checks.

## Coding Style & Naming Conventions

Python targets 3.11+ and is formatted by Ruff, isort with the Black profile, and pyupgrade. Name Python tests `test_*.py`. Frontend code is TypeScript/React with Prettier formatting, sorted imports, and Tailwind class sorting; use PascalCase for components and camelCase for hooks/utilities. Keep feature code near its owning package or UI domain.

## Testing Guidelines

Use pytest for `builder/tests/`; mark service-dependent tests with `integration`. Use Vitest for `frontend/__tests__/`, with names such as `*.test.ts` or `*.test.tsx`. Run focused tests during development, then the relevant `make <job>` target before a PR. Use `make evals` after changing evaluation datasets, evaluators, or runner behavior.

## Commit & Pull Request Guidelines

Recent history uses short, verb-led summaries such as `Update image tooling and autonomy goals` or `Fix Google OAuth prompt race`. Keep commits scoped and avoid unrelated formatting churn. PRs should explain the problem and solution, link issues, list verification commands, and include screenshots or recordings for visible UI changes.

## Security & Configuration Tips

Do not commit secrets, tokens, local `.env` values, virtualenvs, coverage files, or scan artifacts. Document new environment variables in the relevant template or deployment docs, and keep Helm, Compose, and backend workflow config in sync when behavior depends on deployment settings.
