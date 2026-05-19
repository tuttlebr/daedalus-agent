# Repository Guidelines

## Project Structure & Module Organization

Daedalus is a full-stack agent platform. The Next.js UI lives in `frontend/`: routes in `frontend/pages/`, components in `frontend/components/`, shared logic in `frontend/utils/`, `frontend/services/`, and `frontend/hooks/`, and Vitest tests in `frontend/__tests__/`. Python NeMo Agent Toolkit tools live under `builder/`, with shared tests in `builder/tests/`. Runtime backend config is in `backend/tool-calling-config.yaml`. Helm assets are in `helm/daedalus/`, nginx config is in `nginx/`, evals are in `evals/`, and skills are in `skills/`.

## Build, Test, and Development Commands

- `cp .env.template .env`: create local configuration; never commit populated secrets.
- `docker compose up --build`: start the local stack; by default Compose mounts `backend/tool-calling-config.yaml`, or use `BACKEND_CONFIG_FILE=./path/to/config.yaml` to override it.
- `cd frontend && npm ci --legacy-peer-deps`: install frontend dependencies; use Node.js 22.
- `cd frontend && npm run dev`: run the frontend on port `5000`.
- `cd frontend && npm run lint && npm test -- --run && npm run build`: validate lint, Vitest tests, and production build.
- `cd builder && python3 -m pytest`: run builder tests from `builder/pytest.ini`.
- `./run-eval.sh --dataset routing`: run the eval harness against a configured backend.
- `helm lint helm/daedalus`: validate chart templates.

## Coding Style & Naming Conventions

Frontend code uses TypeScript `strict` mode, Next.js ESLint, and Prettier. Use single quotes, trailing commas, sorted imports, Tailwind class sorting, and the `@/*` path alias when useful. Name React components in PascalCase, hooks as `useSomething`, and tests as `*.test.ts` or `*.test.tsx`. Python targets 3.11+, is formatted by Ruff and isort, and uses `test_*.py` pytest naming.

## Testing Guidelines

Put frontend tests under the matching `frontend/__tests__/pages`, `hooks`, `services`, or `utils` area. Put Python tests in `builder/tests/` and follow `test_<behavior>.py`. Run checks for the area changed; use `npm run coverage` for coverage-sensitive UI changes and `python3 -m pytest -k <name>` for focused builder validation.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries such as `Fix RSS feed tool schema validation`. Keep commits focused and avoid unrelated formatting churn. Pull requests should describe the behavior change, link issues, list validation, include screenshots for UI changes, and update docs when config, deployment, or public APIs change.

## Security & Configuration Tips

Do not commit `.env`, generated runtime state, API keys, or private credentials. Use `.env.template` for new variables, generate production `SESSION_SECRET` values with `openssl rand -base64 32`, and run `pre-commit run --all-files` before broad changes.
