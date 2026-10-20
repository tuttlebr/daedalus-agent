# Repository Guidelines

## Project Structure & Module Organization

Daedalus is a self-hosted assistant with a Next.js/TypeScript frontend, a Rust
agent runtime, and a Python tool service.

- `frontend/`: UI components, hooks, API routes, stream worker, and WebSocket server;
  static assets live in `public/`, unit tests in `__tests__/`, browser tests in `e2e/`.
- `builder/`: Rust agent runtime in `runtime/`, Python tools and API adapters,
  runtime image, and `tests/`.
- `backend/`: workflow YAML; `local-chat-config.yaml` provides the starting configuration.
- `protocol/`: shared schemas; regenerate types with `python3 scripts/generate_protocol_types.py`.
- `skills/`: runtime agent instructions; follow its local `AGENTS.md` when editing.
- `.agents/skills/`: maintenance skills for coding agents working on this repository;
  see Maintenance Skills.
- `helm/daedalus/`, `scripts/`, and `docs/`: deployment chart, utilities, and architecture/operations guides.

## Build, Test, and Development Commands

Use Node.js 22, Python 3.12 with `uv`, Rust 1.95, and Helm 3 (CI pins v3.22.1),
matching CI. Run from the repository root unless shown otherwise.

- `uv venv builder/.venv --python 3.12`: initialize the Python test environment.
- `make builder`: install test dependencies and run pytest with coverage.
- `make runtime`: check Rust, build the backend image, and exercise it over HTTP.
- `cd frontend && npm ci --legacy-peer-deps && npm run dev`: install dependencies
  and start Next.js on port 5000. Follow `frontend/README.md` for backing services.
- `make frontend`: install dependencies, lint, typecheck, run coverage, and build.
- `make test-integration`: exercise Python/frontend persistence against disposable Redis.
- `make frontend-e2e`: run Playwright browser workflows.
- `make helm`: lint and render Helm manifests, then check rendered pod security.
- `make help`: list checks; `make ci` runs the automatic CI suite, including infrastructure checks.

## Coding Style & Naming Conventions

Use four-space Python indentation, `snake_case` functions/modules, and `PascalCase`
classes. Follow Ruff formatting/linting and isort hooks. TypeScript uses two-space
indentation, single quotes, trailing commas, `PascalCase` components, and
`useSomething` hooks. ESLint and Prettier enforce frontend conventions.
Before submitting, run the hooks on Python 3.12 as CI does:
`uvx --from pre-commit==3.6.2 --python 3.12 pre-commit run --files <changed-files>`.
Python hook results depend on the interpreter that runs pre-commit.

## Testing Guidelines

Name pytest files `test_*.py`, Vitest tests `*.test.ts`/`*.test.tsx` (build and CI
scripts under `frontend/scripts/` keep `*.test.mjs` beside them), and Playwright
specs `*.spec.ts`. Preserve the 65% Python coverage floor and frontend thresholds
in `frontend/vitest.config.ts`. Add regression tests for behavior changes.
Tool registration/provider changes also require a request against the built
backend image; stub-based tests alone do not validate runtime integration.

## Maintenance Skills

`.agents/skills/` holds repository workflows for coding agents, such as
`daedalus-review-and-remediate`. They are never packaged into images. Codex
discovers them there. For Claude Code, keep `.claude/` ignored and link each skill
locally from the repository root:
`mkdir -p .claude/skills && ln -s ../../.agents/skills/<name> .claude/skills/<name>`.
Remove same-named personal copies: Claude Code prefers a personal skill over the
repository version, and Codex lists both.

Keep these skills current with the code they describe. When a change moves,
renames, or retires an entry point; shifts ownership between the frontend, Rust
runtime, and Python tools; or changes CI jobs, Make targets, hooks, test layout,
toolchain versions, or coverage floors, update the affected skill in the same
change. Keep repository facts in a skill's `references/` and the workflow in its
`SKILL.md`. The `maintenance-skills` pre-commit hook runs on every commit and
fails when a referenced path or Make target disappears; it cannot detect
outdated descriptions.

## Commit & Pull Request Guidelines

Documentation describes current behavior, supported contracts, and repeatable
development or operational procedures. Keep dated change narratives, audit
results, deployment histories, and one-off test totals in pull requests or local
review artifacts. Preserve useful guidance when removing historical reports;
retain dates when they are part of a contract or fixture provenance.

Prefer focused, imperative subjects, such as `Fix conversation deletion`; history
also uses occasional `fix:` prefixes. Follow `.github/pull_request_template.md`:
explain the problem, resulting behavior, validation results, untested areas, and
configuration or maintenance impact. Link relevant issues. Discuss substantial
features or dependencies in an issue first; see `CONTRIBUTING.md`.

## Security & Configuration Tips

Start local configuration from `.env.example`. Keep credentials, conversations,
and personal deployment data out of commits, logs, and fixtures. Report
vulnerabilities privately as described in `CONTRIBUTING.md`.
