# Repository Guidelines

## Project Structure & Module Organization

Daedalus is a self-hosted assistant with a Next.js/TypeScript frontend and Python
NeMo Agent Toolkit backend.

- `frontend/`: UI components, hooks, API routes, stream worker, and WebSocket server;
  static assets live in `public/`, unit tests in `__tests__/`, browser tests in `e2e/`.
- `builder/`: Python tools, toolkit adapters, runtime image, and `tests/`.
- `backend/`: workflow YAML; `local-chat-config.yaml` provides the starting configuration.
- `protocol/`: shared schemas; regenerate types with `python3 scripts/generate_protocol_types.py`.
- `skills/`: runtime agent instructions; follow its local `AGENTS.md` when editing.
- `helm/daedalus/`, `scripts/`, and `docs/`: deployment chart, utilities, and architecture/operations guides.

## Build, Test, and Development Commands

Use Node.js 22 and Python 3.12 with `uv`, matching CI. Run from the repository root
unless shown otherwise.

- `uv venv builder/.venv --python 3.12`: initialize the Python test environment.
- `make builder`: install test dependencies and run pytest with coverage.
- `cd frontend && npm ci --legacy-peer-deps && npm run dev`: install dependencies
  and start Next.js on port 5000. Follow `frontend/README.md` for backing services.
- `make frontend`: install dependencies, lint, typecheck, run coverage, and build.
- `make test-integration`: exercise Python/frontend persistence against disposable Redis.
- `make frontend-e2e`: run Playwright browser workflows.
- `make helm`: lint and render Helm manifests.
- `make help`: list checks; `make ci` runs the full suite, including infrastructure checks.

## Coding Style & Naming Conventions

Use four-space Python indentation, `snake_case` functions/modules, and `PascalCase`
classes. Follow Ruff formatting/linting and isort hooks. TypeScript uses two-space
indentation, single quotes, trailing commas, `PascalCase` components, and
`useSomething` hooks. ESLint and Prettier enforce frontend conventions.
Run `pre-commit run --files <changed-files>` before submitting.

## Testing Guidelines

Name pytest files `test_*.py`, Vitest tests `*.test.ts`/`*.test.tsx`, and Playwright
specs `*.spec.ts`. Preserve the 65% Python coverage floor and frontend thresholds
in `frontend/vitest.config.ts`. Add regression tests for behavior changes.
Toolkit registration/provider changes also require a request against the built
backend image; stub-based tests alone do not validate runtime integration.

## Commit & Pull Request Guidelines

Prefer focused, imperative subjects, such as `Fix conversation deletion`; history
also uses occasional `fix:` prefixes. Follow `.github/pull_request_template.md`:
explain the problem, resulting behavior, validation results, untested areas, and
configuration or maintenance impact. Link relevant issues. Discuss substantial
features or dependencies in an issue first; see `CONTRIBUTING.md`.

## Security & Configuration Tips

Start local configuration from `.env.example`. Keep credentials, conversations,
and personal deployment data out of commits, logs, and fixtures. Follow
`SECURITY.md` for vulnerability reports.
