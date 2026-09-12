# Contributing to Daedalus

I maintain Daedalus for myself and my wife. Useful bug reports, clearer setup
instructions, and focused fixes are welcome. I review contributions as time
allows; there is no release schedule or guaranteed response time. Larger
features need to fit a project that one person can understand and maintain.

## Start small

Read the [README](README.md) and [code map](docs/architecture.md), then try the
local chat configuration. You can fork the app, adapt a tool, or use a component
without adopting my home deployment. The repository uses the [Apache 2.0
license](LICENSE).

For a bug, include the commit, setup you used, steps to reproduce, expected
behavior, and actual behavior. Mention which backend configuration and optional
services are involved. Redact credentials and personal content from logs.
For security issues, see [SECURITY.md](SECURITY.md).

For a substantial feature or new dependency, open an issue describing the use
case and proposed approach before investing in a large implementation. Small
fixes and documentation improvements can go straight to a pull request.

## Development and checks

Use Node.js 22 for the frontend and Python 3.12 with `uv` for Python work, matching
CI. Run commands from the repository root unless a command changes directory.

For the Python test environment:

```bash
uv venv builder/.venv --python 3.12
cd builder
uv pip install --python .venv/bin/python -e ".[test]"
.venv/bin/python -m pytest -q
```

This installs the lightweight test dependencies. Most builder tests use
framework stubs; passing them does not prove that a toolkit plugin loads in the
runtime image. Workflow and toolkit adapter changes also need a request against
the backend image built from the pinned runtime dependencies in
[`builder/Dockerfile`](builder/Dockerfile).

For the frontend:

```bash
cd frontend
npm ci --legacy-peer-deps
npm run lint
npx tsc --noEmit --incremental false
SESSION_SECRET=local-test-session-secret npm test -- --run
SESSION_SECRET=local-test-session-secret npm run build
```

For development server wiring, see the [frontend guide](frontend/README.md).
For browser tests with disposable services and a mock backend, see the
[browser test guide](frontend/e2e/README.md).

Choose checks that exercise your change:

| Change                         | Useful validation                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Documentation                  | Check paths, commands, and formatting; record any setup steps you could not run             |
| Python tools or backend routes | Relevant builder tests, plus a runtime request when registration or provider wiring changes |
| Frontend behavior              | Lint, types, relevant unit tests, build; browser tests for affected user flows              |
| Redis state or job lifecycle   | `make test-integration` and affected recovery/browser tests                                 |
| Helm or deployment             | `make helm`; applicable image and deployment checks                                         |

`make help` lists the CI counterparts. `make ci` runs the full suite, including
container builds, scans, and a disposable Kubernetes test cluster. You do not
need every infrastructure tool to improve a README or work on a frontend unit
test. The pull request still runs the repository's CI checks.

Optional local hooks: install `pre-commit`, run `pre-commit install`, and use
`pre-commit run --files <changed-files>` once frontend dependencies are installed.

## Pull requests

Explain the problem, the resulting behavior, and how you verified it. Keep the
change focused and call out any new service, credential, migration, or recurring
maintenance requirement. Say which checks passed and which you could not run.
Keep credentials, private conversations, and personal deployment data out of
fixtures. Prefer examples that another developer can run with their own setup.
